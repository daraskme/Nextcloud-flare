import { problem } from "@next-cloud-flare/shared/errors";
import type { Principal } from "../auth/authorize";
import type { NodeCursorTokens } from "../auth/nodeCursor";
import type { Env } from "../env";
import { listNodeChildren, readNode, readNodePath } from "../services/nodeRead";

const NODE = /^\/api\/v1\/nodes\/([A-Za-z0-9_-]{1,128})(\/(?:children|path))?$/;

export function nodeReadRoute(request: Request): boolean {
  return request.method === "GET" && NODE.test(new URL(request.url).pathname);
}

export async function handleNodeReadHttp(
  request: Request,
  env: Env,
  principal: Principal,
  cursors?: NodeCursorTokens,
): Promise<Response> {
  const url = new URL(request.url);
  const match = NODE.exec(url.pathname);
  if (
    !match ||
    request.method !== "GET" ||
    url.origin !== env.APP_ORIGIN ||
    url.hash ||
    request.body
  )
    return problem(404, "not_found");
  const nodeId = match[1] ?? "";
  if (match[2] === "/path") {
    if (url.search) return problem(400, "bad_request");
    try {
      return Response.json(await readNodePath(env.DB, principal, nodeId), {
        headers: { "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff" },
      });
    } catch {
      return problem(404, "not_found");
    }
  }
  if (!match[2]) {
    if (url.search) return problem(400, "bad_request");
    try {
      return Response.json(await readNode(env.DB, principal, nodeId), {
        headers: { "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff" },
      });
    } catch {
      return problem(404, "not_found");
    }
  }
  if (!cursors) return problem(503, "not_ready");
  if (
    [...url.searchParams.keys()].some((key) => key !== "cursor") ||
    url.searchParams.getAll("cursor").length > 1
  )
    return problem(400, "bad_request");
  const cursor = url.searchParams.get("cursor") ?? undefined;
  if (cursor !== undefined && (cursor.length === 0 || cursor.length > 4096))
    return problem(400, "bad_request");
  try {
    return Response.json(await listNodeChildren(env.DB, principal, nodeId, cursors, cursor), {
      headers: { "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff" },
    });
  } catch (error) {
    if (error instanceof Error && error.message === "invalid_node_cursor")
      return problem(400, "bad_request");
    return problem(404, "not_found");
  }
}
