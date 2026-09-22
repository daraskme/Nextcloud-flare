import { problem } from "@next-cloud-flare/shared/errors";
import { type AppPasswordPepperRing, authenticateAppPassword } from "../auth/appPassword";
import { parseDavPath, resolveDavNode } from "../dav/path";
import { propfindResponse } from "../dav/propfind";
import { parsePropfindRequest } from "../dav/xml";
import type { Env } from "../env";
import { prepareAuthorizedNodeBlobRead, streamImmutableBlob } from "../services/blobRead";

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
  let resolved: Awaited<ReturnType<typeof resolveDavNode>> | undefined;
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
      resolved = await resolveDavNode(env.DB, principal, path);
    } catch {
      return problem(404, "not_found");
    }
  }
  if (request.method === "OPTIONS")
    return new Response(null, {
      status: 200,
      headers: {
        Allow: "OPTIONS, GET, HEAD",
        "Cache-Control": "private, no-store",
        DAV: "1",
        "MS-Author-Via": "DAV",
        "X-Content-Type-Options": "nosniff",
      },
    });
  if (request.method === "PROPFIND") {
    if (!resolved) return problem(404, "not_found");
    const depth = request.headers.get("Depth");
    if (depth !== "0" && depth !== "1")
      return new Response(
        '<?xml version="1.0" encoding="utf-8"?><D:error xmlns:D="DAV:"><D:propfind-finite-depth/></D:error>',
        {
          status: 403,
          headers: {
            "Cache-Control": "private, no-store",
            "Content-Type": "application/xml; charset=utf-8",
            "X-Content-Type-Options": "nosniff",
          },
        },
      );
    let propfind;
    try {
      propfind = await parsePropfindRequest(request);
    } catch {
      return problem(400, "bad_request");
    }
    try {
      return await propfindResponse(env.DB, resolved, path, Number(depth) as 0 | 1, propfind);
    } catch (error) {
      return error instanceof Error && error.message === "dav_children_limit"
        ? problem(507, "insufficient_storage")
        : problem(503, "not_ready");
    }
  }
  if (request.method === "GET" || request.method === "HEAD") {
    if (
      !resolved ||
      resolved.node.kind !== "file" ||
      !resolved.node.current_blob_id ||
      path.trailingSlash
    )
      return problem(404, "not_found");
    try {
      const plan = await prepareAuthorizedNodeBlobRead(env.DB, resolved);
      return await streamImmutableBlob(env.BLOBS, plan, request);
    } catch {
      return problem(503, "not_ready");
    }
  }
  // DAV operation handlers are added only with their node/lock/content proofs.
  return problem(503, "not_ready");
}
