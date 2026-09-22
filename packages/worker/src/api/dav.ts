import { problem } from "@next-cloud-flare/shared/errors";
import { type AppPasswordPepperRing, authenticateAppPassword } from "../auth/appPassword";
import {
  parseDavPath,
  resolveDavCreateParent,
  resolveDavCredentialPath,
  resolveDavNode,
} from "../dav/path";
import { propfindResponse } from "../dav/propfind";
import { parsePropfindRequest } from "../dav/xml";
import type { Env } from "../env";
import { prepareAuthorizedNodeBlobRead, streamImmutableBlob } from "../services/blobRead";
import { createFolder } from "../services/createFolder";

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
  if (request.method === "MKCOL") {
    if (path.segments.length === 0) return problem(405, "method_not_allowed");
    if (request.body || ![null, "0"].includes(request.headers.get("Content-Length")))
      return problem(415, "unsupported_media_type");
    if (request.headers.has("If") || request.headers.has("Lock-Token"))
      return problem(503, "not_ready");
    const key = request.headers.get("Idempotency-Key");
    if (!key || key.includes(",") || !/^[\x21-\x7e]{1,200}$/.test(key))
      return problem(400, "bad_request");
    const name = path.segments.at(-1)!.name;
    const parentPath = {
      segments: path.segments.slice(0, -1),
      trailingSlash: true,
    } as const;
    try {
      const parent = await resolveDavCreateParent(env.DB, principal, parentPath);
      const outcome = await createFolder(env, {
        principal,
        idempotencyKey: key,
        spaceId: parent.spaceId,
        parentId: parent.parent.id,
        name,
        lockTokens: [],
        operation: "dav.mkcol",
      });
      if (outcome.kind === "commit_unknown" || outcome.operation.state === "claimed") {
        const response = problem(503, "commit_unknown");
        response.headers.set(
          "Operation-Id",
          outcome.kind === "commit_unknown" ? outcome.operationId : outcome.operation.id,
        );
        response.headers.set("Retry-After", "1");
        return response;
      }
      if (outcome.operation.state === "failed")
        return outcome.operation.errorCode === "name_conflict"
          ? problem(405, "method_not_allowed")
          : problem(409, "conflict");
      const location = `/dav/${path.segments
        .map((segment) => encodeURIComponent(segment.name))
        .join("/")}/`;
      return new Response(null, {
        status: 201,
        headers: {
          "Cache-Control": "private, no-store",
          Location: location,
          "X-Content-Type-Options": "nosniff",
        },
      });
    } catch (error) {
      if (
        error instanceof Error &&
        ["invalid_idempotency_key", "invalid_name", "name_too_long", "reserved_name"].includes(
          error.message,
        )
      )
        return problem(400, "bad_request");
      if (error instanceof Error && error.message === "idempotency_conflict")
        return problem(409, "conflict");
      if (error instanceof Error && error.message === "dav_node_unavailable")
        return problem(404, "not_found");
      return problem(503, "not_ready");
    }
  }
  if (
    ["PROPFIND", "PROPPATCH", "GET", "HEAD", "DELETE", "COPY", "MOVE", "UNLOCK"].includes(
      request.method,
    )
  ) {
    try {
      resolved = await resolveDavNode(env.DB, principal, path);
    } catch {
      return problem(404, "not_found");
    }
  }
  if (request.method === "OPTIONS") {
    try {
      await resolveDavCredentialPath(env.DB, principal, path);
    } catch {
      return problem(404, "not_found");
    }
    return new Response(null, {
      status: 200,
      headers: {
        Allow: "OPTIONS, GET, HEAD, PROPFIND, MKCOL",
        "Cache-Control": "private, no-store",
        DAV: "1",
        "MS-Author-Via": "DAV",
        "X-Content-Type-Options": "nosniff",
      },
    });
  }
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
