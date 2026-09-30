import { problem } from "@next-cloud-flare/shared/errors";
import type { Principal } from "../auth/authorize";
import type { ListCursorTokens } from "../auth/listCursor";
import type { Env } from "../env";
import { listTrash } from "../services/trashRead";

const ID = /^[A-Za-z0-9_-]{1,128}$/;

export function trashRoute(request: Request): boolean {
  return request.method === "GET" && new URL(request.url).pathname === "/api/v1/trash";
}

export async function handleTrashHttp(
  request: Request,
  env: Env,
  principal: Principal,
  cursors?: ListCursorTokens,
): Promise<Response> {
  const url = new URL(request.url);
  if (
    request.method !== "GET" ||
    url.pathname !== "/api/v1/trash" ||
    url.origin !== env.APP_ORIGIN ||
    url.hash ||
    request.body
  )
    return problem(404, "not_found");
  if (!cursors) return problem(503, "not_ready");
  if (
    [...url.searchParams.keys()].some((key) => key !== "spaceId" && key !== "cursor") ||
    url.searchParams.getAll("spaceId").length !== 1 ||
    url.searchParams.getAll("cursor").length > 1
  )
    return problem(400, "bad_request");
  const spaceId = url.searchParams.get("spaceId") ?? "";
  const cursor = url.searchParams.get("cursor") ?? undefined;
  if (!ID.test(spaceId) || (cursor !== undefined && (cursor.length === 0 || cursor.length > 4096)))
    return problem(400, "bad_request");
  try {
    return Response.json(await listTrash(env.DB, principal, cursors, spaceId, cursor), {
      headers: { "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff" },
    });
  } catch (error) {
    if (error instanceof Error && error.message === "invalid_list_cursor")
      return problem(400, "bad_request");
    return problem(404, "not_found");
  }
}
