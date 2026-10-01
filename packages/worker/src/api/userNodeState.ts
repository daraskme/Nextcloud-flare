import { problem } from "@next-cloud-flare/shared/errors";
import type { Principal } from "../auth/authorize";
import type { CsrfTokens } from "../auth/csrf";
import type { UserNodeCursorTokens } from "../auth/userNodeCursor";
import type { Env } from "../env";
import { MutationUnavailableError } from "../services/accountMutation";
import { listUserNodes, recordNodeOpen, setNodeStar } from "../services/userNodeState";

const NODE_STATE = /^\/api\/v1\/nodes\/([A-Za-z0-9_-]{1,128})\/(star|recent)$/;
const PRIVATE_HEADERS = {
  "Cache-Control": "private, no-store",
  "X-Content-Type-Options": "nosniff",
};

export function userNodeStateRoute(request: Request): boolean {
  const path = new URL(request.url).pathname;
  return (
    (request.method === "GET" && (path === "/api/v1/recent" || path === "/api/v1/starred")) ||
    (request.method === "PUT" && NODE_STATE.test(path))
  );
}

async function body(request: Request): Promise<Record<string, unknown>> {
  if (request.headers.get("Content-Type") !== "application/json" || !request.body)
    throw new Error("invalid_body");
  const reader = request.body.getReader();
  const parts: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      size += next.value.byteLength;
      if (size > 1024) throw new Error("invalid_body");
      parts.push(next.value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const part of parts) {
    bytes.set(part, offset);
    offset += part.byteLength;
  }
  const value: unknown = JSON.parse(
    new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes),
  );
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid_body");
  return value as Record<string, unknown>;
}

export async function handleUserNodeStateHttp(
  request: Request,
  env: Env,
  principal: Principal,
  csrf: Pick<CsrfTokens, "verify">,
  cursors?: UserNodeCursorTokens,
): Promise<Response> {
  const url = new URL(request.url);
  if (!userNodeStateRoute(request) || url.origin !== env.APP_ORIGIN || url.hash)
    return problem(404, "not_found");
  if (request.method === "GET") {
    if (request.body || !cursors)
      return cursors ? problem(404, "not_found") : problem(503, "not_ready");
    if (
      [...url.searchParams.keys()].some((key) => key !== "cursor") ||
      url.searchParams.getAll("cursor").length > 1
    )
      return problem(400, "bad_request");
    const cursor = url.searchParams.get("cursor") ?? undefined;
    if (cursor !== undefined && (!cursor || cursor.length > 4096))
      return problem(400, "bad_request");
    try {
      return Response.json(
        await listUserNodes(
          env.DB,
          principal,
          url.pathname === "/api/v1/recent" ? "recent" : "starred",
          cursors,
          cursor,
        ),
        { headers: PRIVATE_HEADERS },
      );
    } catch (error) {
      if (error instanceof Error && error.message === "invalid_user_node_cursor")
        return problem(409, "conflict");
      return problem(404, "not_found");
    }
  }
  if (url.search) return problem(400, "bad_request");
  const match = NODE_STATE.exec(url.pathname);
  if (!match) return problem(404, "not_found");
  try {
    await csrf.verify(env.DB, request, {
      kind: "access",
      credentialId: principal.credential_id,
      epoch: principal.epoch,
    });
  } catch {
    return problem(403, "forbidden");
  }
  let value: Record<string, unknown>;
  try {
    value = await body(request);
  } catch {
    return problem(400, "bad_request");
  }
  const nodeId = match[1] ?? "";
  const kind = match[2];
  if (
    (kind === "star" &&
      (Object.keys(value).sort().join(",") !== "starred" || typeof value.starred !== "boolean")) ||
    (kind === "recent" && Object.keys(value).length !== 0)
  )
    return problem(400, "bad_request");
  try {
    return Response.json(
      kind === "star"
        ? await setNodeStar(env, principal, nodeId, value.starred as boolean)
        : await recordNodeOpen(env, principal, nodeId),
      { headers: PRIVATE_HEADERS },
    );
  } catch (error) {
    if (error instanceof MutationUnavailableError) {
      const response = problem(503, "not_ready");
      response.headers.set("Retry-After", "1");
      return response;
    }
    return problem(404, "not_found");
  }
}
