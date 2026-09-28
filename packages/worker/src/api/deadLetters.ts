import { problem } from "@next-cloud-flare/shared/errors";
import type { ListCursorTokens } from "../auth/listCursor";
import type { AccessSession } from "../auth/sessions";
import type { Env } from "../env";
import { listDeadLetters } from "../services/deadLetterRead";

export function deadLetterReadRoute(request: Request): boolean {
  return request.method === "GET" && new URL(request.url).pathname === "/api/v1/admin/dlq";
}

export async function handleDeadLetterReadHttp(
  request: Request,
  env: Pick<Env, "DB" | "APP_ORIGIN">,
  session: AccessSession,
  cursors?: ListCursorTokens,
): Promise<Response> {
  const url = new URL(request.url);
  if (!deadLetterReadRoute(request) || url.origin !== env.APP_ORIGIN || url.hash || request.body)
    return problem(404, "not_found");
  if (session.role !== "app_admin") return problem(403, "forbidden");
  if (!cursors) return problem(503, "not_ready");
  const cursor = url.searchParams.get("cursor") ?? undefined;
  if (
    [...url.searchParams.keys()].some((key) => key !== "cursor") ||
    url.searchParams.getAll("cursor").length > 1 ||
    (cursor !== undefined && (!cursor.length || cursor.length > 4096))
  )
    return problem(400, "bad_request");
  try {
    return Response.json(await listDeadLetters(env.DB, session, cursors, cursor), {
      headers: { "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff" },
    });
  } catch (error) {
    if (error instanceof Error && error.message === "invalid_list_cursor")
      return problem(400, "bad_request");
    if (error instanceof Error && error.message === "admin_access_required")
      return problem(403, "forbidden");
    return problem(503, "not_ready");
  }
}
