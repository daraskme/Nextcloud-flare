import { problem } from "@next-cloud-flare/shared/errors";
import { type AppPasswordPepperRing, authenticateAppPassword } from "../auth/appPassword";
import { parseDavPath, resolveDavNode } from "../dav/path";
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
  let path;
  try {
    path = parseDavPath(url.pathname);
  } catch (error) {
    return error instanceof Error && error.message === "dav_shared_not_ready"
      ? problem(503, "not_ready")
      : problem(400, "bad_request");
  }
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
  let principal;
  try {
    principal = await authenticateAppPassword(env.DB, request, env.APP_ORIGIN, epoch, pepper);
  } catch {
    const response = problem(401, "unauthorized");
    response.headers.set("WWW-Authenticate", 'Basic realm="Nextcloud Flare DAV"');
    return response;
  }
  if (
    [
      "OPTIONS",
      "PROPFIND",
      "PROPPATCH",
      "GET",
      "HEAD",
      "DELETE",
      "COPY",
      "MOVE",
      "UNLOCK",
    ].includes(request.method)
  ) {
    try {
      await resolveDavNode(env.DB, principal, path);
    } catch {
      return problem(404, "not_found");
    }
  }
  if (request.method === "OPTIONS")
    return new Response(null, {
      status: 200,
      headers: {
        Allow: "OPTIONS",
        "Cache-Control": "private, no-store",
        DAV: "1",
        "MS-Author-Via": "DAV",
        "X-Content-Type-Options": "nosniff",
      },
    });
  // DAV operation handlers are added only with their node/lock/content proofs.
  return problem(503, "not_ready");
}
