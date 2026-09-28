import { problem } from "@next-cloud-flare/shared/errors";
import type { CsrfTokens } from "../auth/csrf";
import type { ListCursorTokens } from "../auth/listCursor";
import type { AccessSession } from "../auth/sessions";
import type { Env } from "../env";
import { listDeadLetters } from "../services/deadLetterRead";
import { requeueDeadLetter } from "../services/requeueDeadLetter";
import { readJsonObject } from "./jsonBody";

const REQUEUE = /^\/api\/v1\/admin\/dlq\/([A-Za-z0-9_-]{1,128})\/requeue$/;
export function deadLetterRoute(request: Request): boolean {
  return (
    deadLetterReadRoute(request) ||
    (request.method === "POST" && REQUEUE.test(new URL(request.url).pathname))
  );
}

export async function handleDeadLetterHttp(
  request: Request,
  env: Env,
  session: AccessSession,
  csrf: Pick<CsrfTokens, "verify">,
  cursors?: ListCursorTokens,
): Promise<Response> {
  if (deadLetterReadRoute(request)) return handleDeadLetterReadHttp(request, env, session, cursors);
  const url = new URL(request.url),
    match = REQUEUE.exec(url.pathname);
  if (
    request.method !== "POST" ||
    !match ||
    url.origin !== env.APP_ORIGIN ||
    url.search ||
    url.hash
  )
    return problem(404, "not_found");
  if (session.role !== "app_admin") return problem(403, "forbidden");
  try {
    await csrf.verify(env.DB, request, {
      kind: "access",
      credentialId: session.credential_id,
      epoch: session.epoch,
    });
  } catch {
    return problem(403, "forbidden");
  }
  const key = request.headers.get("Idempotency-Key");
  if (!key || key.includes(",") || !/^[\x21-\x7e]{1,200}$/.test(key))
    return problem(400, "bad_request");
  let messageId: string;
  try {
    const body = await readJsonObject(request);
    if (
      Object.keys(body).length !== 1 ||
      typeof body.messageId !== "string" ||
      !/^[A-Za-z0-9_-]{1,128}$/.test(body.messageId)
    )
      throw new Error("invalid_body");
    messageId = body.messageId;
  } catch {
    return problem(400, "bad_request");
  }
  try {
    return Response.json(await requeueDeadLetter(env, session, match[1]!, messageId, key), {
      status: 202,
      headers: { "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff" },
    });
  } catch (error) {
    const code = error instanceof Error ? error.message : "";
    if (code === "admin_access_required") return problem(403, "forbidden");
    if (code === "dead_letter_not_found") return problem(404, "not_found");
    if (
      ["requeue_key_conflict", "dead_letter_already_requeued", "requeue_unavailable"].includes(code)
    )
      return problem(409, "conflict");
    const response = problem(503, "not_ready");
    response.headers.set("Retry-After", "1");
    return response;
  }
}

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
