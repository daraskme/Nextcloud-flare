import { problem } from "@next-cloud-flare/shared/errors";
import type { Principal } from "../auth/authorize";
import type { SearchCursorTokens } from "../auth/searchCursor";
import type { Env } from "../env";
import { searchNodes } from "../services/search";

export function searchRoute(request: Request): boolean {
  return request.method === "GET" && new URL(request.url).pathname === "/api/v1/search";
}

export async function handleSearchHttp(
  request: Request,
  env: Env,
  principal: Principal,
  cursors?: SearchCursorTokens,
): Promise<Response> {
  const url = new URL(request.url);
  if (!searchRoute(request) || url.origin !== env.APP_ORIGIN || url.hash || request.body)
    return problem(404, "not_found");
  if (!cursors) return problem(503, "not_ready");
  if (
    [...url.searchParams.keys()].some((key) => !["scopeId", "q", "cursor"].includes(key)) ||
    ["scopeId", "q", "cursor"].some((key) => url.searchParams.getAll(key).length > 1)
  )
    return problem(400, "bad_request");
  const scopeId = url.searchParams.get("scopeId") ?? "";
  const q = url.searchParams.get("q") ?? "";
  const cursor = url.searchParams.get("cursor") ?? undefined;
  if (
    !/^[A-Za-z0-9_-]{1,128}$/.test(scopeId) ||
    (cursor !== undefined && (!cursor || cursor.length > 4096))
  )
    return problem(400, "bad_request");
  try {
    return Response.json(await searchNodes(env.DB, principal, scopeId, q, cursors, cursor), {
      headers: { "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff" },
    });
  } catch (error) {
    if (error instanceof Error && error.message === "invalid_search_query")
      return problem(400, "bad_request");
    if (error instanceof Error && error.message === "invalid_search_cursor")
      return problem(409, "conflict");
    return problem(404, "not_found");
  }
}
