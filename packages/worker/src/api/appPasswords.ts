import { problem } from "@next-cloud-flare/shared/errors";
import type { AppPasswordPepperRing } from "../auth/appPassword";
import type { CsrfTokens } from "../auth/csrf";
import { KdfUnavailableError } from "../auth/kdf";
import type { AccessSession } from "../auth/sessions";
import type { Env } from "../env";
import {
  type CreateAppPasswordInput,
  createAppPassword,
  listAppPasswords,
  revokeAppPassword,
} from "../services/appPasswords";
import { hasEmptyBody } from "./emptyBody";

const BASE = "/api/v1/app-passwords";
const DETAIL = /^\/api\/v1\/app-passwords\/([^/]+)$/;
const MAX_BODY = 8192;
const PRIVATE_HEADERS = {
  "Cache-Control": "private, no-store",
  "X-Content-Type-Options": "nosniff",
};

export function appPasswordRoute(request: Request): boolean {
  const path = new URL(request.url).pathname;
  return (
    (path === BASE && ["GET", "POST"].includes(request.method)) ||
    (request.method === "DELETE" && DETAIL.test(path))
  );
}

async function createBody(request: Request): Promise<CreateAppPasswordInput> {
  if (request.headers.get("Content-Type") !== "application/json" || !request.body)
    throw new Error("invalid_app_password_request");
  const reader = request.body.getReader();
  const parts: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const part = await reader.read();
      if (part.done) break;
      size += part.value.byteLength;
      if (size > MAX_BODY) throw new Error("invalid_app_password_request");
      parts.push(part.value);
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
  const parsed: unknown = JSON.parse(
    new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes),
  );
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
    throw new Error("invalid_app_password_request");
  const body = parsed as Record<string, unknown>;
  if (
    Object.keys(body).some(
      (key) => !["name", "scopes", "ttlDays", "spaceId", "rootNodeId"].includes(key),
    ) ||
    typeof body.name !== "string" ||
    !Array.isArray(body.scopes) ||
    !body.scopes.every((scope) => typeof scope === "string") ||
    (body.ttlDays !== undefined && typeof body.ttlDays !== "number") ||
    (body.spaceId !== undefined && typeof body.spaceId !== "string") ||
    (body.rootNodeId !== undefined && typeof body.rootNodeId !== "string")
  )
    throw new Error("invalid_app_password_request");
  return {
    name: body.name,
    scopes: body.scopes,
    ...(body.ttlDays === undefined ? {} : { ttlDays: body.ttlDays as number }),
    ...(body.spaceId === undefined ? {} : { spaceId: body.spaceId as string }),
    ...(body.rootNodeId === undefined ? {} : { rootNodeId: body.rootNodeId as string }),
  };
}

export async function handleAppPasswordHttp(
  request: Request,
  env: Env,
  session: AccessSession,
  csrf: Pick<CsrfTokens, "verify">,
  pepper?: AppPasswordPepperRing,
): Promise<Response> {
  const url = new URL(request.url);
  if (url.origin !== env.APP_ORIGIN || url.search || url.hash) return problem(404, "not_found");
  if (url.pathname === BASE && request.method === "GET") {
    try {
      return Response.json(
        { passwords: await listAppPasswords(env.DB, session) },
        { headers: PRIVATE_HEADERS },
      );
    } catch {
      return problem(503, "not_ready");
    }
  }
  const create = url.pathname === BASE && request.method === "POST";
  const detail = request.method === "DELETE" ? DETAIL.exec(url.pathname) : null;
  if (!create && !detail) return problem(404, "not_found");
  try {
    await csrf.verify(env.DB, request, {
      kind: "access",
      credentialId: session.credential_id,
      epoch: session.epoch,
    });
  } catch {
    return problem(403, "forbidden");
  }
  if (detail) {
    if (!(await hasEmptyBody(request))) return problem(400, "bad_request");
    let credentialId: string;
    try {
      credentialId = decodeURIComponent(detail[1] ?? "");
    } catch {
      return problem(404, "not_found");
    }
    try {
      await revokeAppPassword(env.DB, session, credentialId);
      return new Response(null, { status: 204, headers: PRIVATE_HEADERS });
    } catch (error) {
      if (error instanceof Error && error.message === "app_password_not_found")
        return problem(404, "not_found");
      return problem(503, "not_ready");
    }
  }
  if (!pepper) return problem(503, "not_ready");
  let body: CreateAppPasswordInput;
  try {
    body = await createBody(request);
  } catch {
    return problem(400, "bad_request");
  }
  try {
    return Response.json(await createAppPassword(env.DB, session, body, pepper, request.signal), {
      status: 201,
      headers: PRIVATE_HEADERS,
    });
  } catch (error) {
    if (error instanceof KdfUnavailableError) {
      const response = problem(503, "not_ready");
      response.headers.set("Retry-After", "1");
      return response;
    }
    if (error instanceof Error && error.message === "invalid_app_password_request")
      return problem(400, "bad_request");
    if (error instanceof Error && error.message === "invalid_app_password_root")
      return problem(404, "not_found");
    if (error instanceof Error && error.message === "app_password_limit")
      return problem(409, "conflict");
    return problem(503, "not_ready");
  }
}
