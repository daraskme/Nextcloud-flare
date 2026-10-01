import { problem } from "@next-cloud-flare/shared/errors";
import type { CsrfTokens } from "../auth/csrf";
import { createAccessInvite, listAccessInvites, revokeAccessInvite } from "../auth/invites";
import type { AccessSession } from "../auth/sessions";
import type { Env } from "../env";
import { MutationUnavailableError } from "../services/accountMutation";
import { hasEmptyBody } from "./emptyBody";

const BASE = "/api/v1/admin/invites";
const DETAIL = /^\/api\/v1\/admin\/invites\/([0-9a-f-]{36})$/;
const HEADERS = { "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff" };

export function inviteRoute(request: Request): boolean {
  const path = new URL(request.url).pathname;
  return (
    (path === BASE && ["GET", "POST"].includes(request.method)) ||
    (DETAIL.test(path) && request.method === "DELETE")
  );
}

export async function handleInviteHttp(
  request: Request,
  env: Env,
  session: AccessSession,
  csrf: Pick<CsrfTokens, "verify">,
): Promise<Response> {
  if (session.role !== "app_admin") return problem(403, "forbidden");
  const url = new URL(request.url);
  if (url.origin !== env.APP_ORIGIN || url.search || url.hash) return problem(404, "not_found");
  if (url.pathname === BASE && request.method === "GET") {
    try {
      return Response.json(
        { invites: await listAccessInvites(env.DB, session) },
        { headers: HEADERS },
      );
    } catch (error) {
      return error instanceof Error && error.message === "invite_forbidden"
        ? problem(403, "forbidden")
        : unavailable();
    }
  }
  try {
    await csrf.verify(env.DB, request, {
      kind: "access",
      credentialId: session.credential_id,
      epoch: session.epoch,
    });
  } catch {
    return problem(403, "forbidden");
  }
  const detail = DETAIL.exec(url.pathname);
  if (detail && request.method === "DELETE") {
    if (!(await hasEmptyBody(request))) return problem(400, "bad_request");
    try {
      await revokeAccessInvite(env, session, detail[1] ?? "");
      return new Response(null, { status: 204, headers: HEADERS });
    } catch (error) {
      if (error instanceof MutationUnavailableError) return unavailable();
      return error instanceof Error && error.message === "invite_not_found"
        ? problem(404, "not_found")
        : unavailable();
    }
  }
  if (url.pathname !== BASE || request.method !== "POST") return problem(404, "not_found");
  if (request.headers.get("Content-Type") !== "application/json")
    return problem(400, "bad_request");
  let body: unknown;
  try {
    if (!request.body) return problem(400, "bad_request");
    const reader = request.body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      for (;;) {
        const item = await reader.read();
        if (item.done) break;
        size += item.value.byteLength;
        if (size > 4096) throw new Error("invalid_invite_body");
        chunks.push(item.value);
      }
    } finally {
      reader.releaseLock();
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    body = JSON.parse(new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes));
  } catch {
    return problem(400, "bad_request");
  }
  if (
    !body ||
    typeof body !== "object" ||
    Array.isArray(body) ||
    Object.keys(body).length !== 1 ||
    !("email" in body)
  )
    return problem(400, "bad_request");
  try {
    const invite = await createAccessInvite(
      env,
      session,
      (body as { email: unknown }).email,
      env.ACCESS_ISSUER ?? "",
    );
    return Response.json(invite, { status: 201, headers: HEADERS });
  } catch (error) {
    if (error instanceof MutationUnavailableError) return unavailable();
    if (error instanceof Error && error.message === "invalid_invite_email")
      return problem(400, "bad_request");
    if (error instanceof Error && error.message === "invite_conflict")
      return problem(409, "conflict");
    return error instanceof Error && error.message === "invite_forbidden"
      ? problem(403, "forbidden")
      : unavailable();
  }
}

function unavailable() {
  const response = problem(503, "not_ready");
  response.headers.set("Retry-After", "1");
  return response;
}
