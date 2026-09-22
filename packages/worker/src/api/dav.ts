import { problem } from "@next-cloud-flare/shared/errors";
import { type AppPasswordPepperRing, authenticateAppPassword } from "../auth/appPassword";
import type { Env } from "../env";

const METHODS = new Set([
  "OPTIONS",
  "PROPFIND",
  "PROPPATCH",
  "MKCOL",
  "GET",
  "HEAD",
  "PUT",
  "DELETE",
  "COPY",
  "MOVE",
  "LOCK",
  "UNLOCK",
]);

export function davPath(request: Request): boolean {
  const path = new URL(request.url).pathname;
  return path === "/dav" || path.startsWith("/dav/");
}

/** Apply the shared edge bucket before a Basic secret reaches the password KDF. */
export async function handleDavHttp(
  request: Request,
  env: Env,
  epoch: number,
  pepper: AppPasswordPepperRing | undefined,
): Promise<Response> {
  const url = new URL(request.url);
  if (
    !davPath(request) ||
    !METHODS.has(request.method) ||
    url.protocol !== "https:" ||
    url.origin !== env.APP_ORIGIN ||
    url.search ||
    url.hash
  )
    return problem(404, "not_found");
  if (!pepper) return problem(503, "not_ready");
  let allowed: boolean;
  try {
    const candidate = request.headers.get("CF-Connecting-IP");
    const ip =
      candidate && candidate.length <= 45 && /^[0-9a-fA-F:.]+$/.test(candidate)
        ? candidate
        : "unknown";
    allowed = (await env.EDGE_LIMITER.limit({ key: `dav:${ip}` })).success;
  } catch {
    return problem(503, "not_ready");
  }
  if (!allowed) {
    const response = problem(429, "rate_limited");
    response.headers.set("Retry-After", "60");
    return response;
  }
  try {
    await authenticateAppPassword(env.DB, request, env.APP_ORIGIN, epoch, pepper);
  } catch {
    const response = problem(401, "unauthorized");
    response.headers.set("WWW-Authenticate", 'Basic realm="Nextcloud Flare DAV"');
    return response;
  }
  // DAV operation handlers are added only with their node/lock/content proofs.
  return problem(503, "not_ready");
}
