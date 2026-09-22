import { problem } from "@next-cloud-flare/shared/errors";
import type { Principal } from "../auth/authorize";
import type { CsrfTokens } from "../auth/csrf";
import type { Env } from "../env";
import { lookupOperation } from "../jobs/operations";
import { createFolder } from "../services/createFolder";
import { renameNode } from "../services/renameNode";

const ID = /^[A-Za-z0-9_-]{1,128}$/;
const OPERATION = /^\/api\/v1\/operations\/(op_[a-f0-9]{64})$/;
const NODE = /^\/api\/v1\/nodes\/([A-Za-z0-9_-]{1,128})$/;
const MAX_BODY = 8192;

function unknownOperation(id: string): Response {
  const response = problem(503, "commit_unknown");
  const headers = new Headers(response.headers);
  headers.set("Operation-Id", id);
  headers.set("Retry-After", "1");
  return new Response(response.body, { status: 503, headers });
}

export function nodeMutationRoute(request: Request): boolean {
  const path = new URL(request.url).pathname;
  return (
    (request.method === "POST" && path === "/api/v1/nodes") ||
    (request.method === "PATCH" && NODE.test(path)) ||
    (request.method === "GET" && OPERATION.test(path))
  );
}

async function readBody(request: Request): Promise<Record<string, unknown>> {
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
      if (size > MAX_BODY) throw new Error("invalid_body");
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
  const decoded: unknown = JSON.parse(
    new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes),
  );
  if (!decoded || typeof decoded !== "object" || Array.isArray(decoded))
    throw new Error("invalid_body");
  return decoded as Record<string, unknown>;
}

function validLockTokens(value: unknown): value is string[] {
  return (
    Array.isArray(value) &&
    value.length <= 16 &&
    value.every((token) => typeof token === "string" && token.length >= 1 && token.length <= 256)
  );
}

function folderBody(body: Record<string, unknown>) {
  const lockTokens = body.lockTokens ?? [];
  if (
    Object.keys(body).some(
      (key) => !["kind", "spaceId", "parentId", "name", "lockTokens"].includes(key),
    ) ||
    body.kind !== "folder" ||
    typeof body.spaceId !== "string" ||
    !ID.test(body.spaceId) ||
    typeof body.parentId !== "string" ||
    !ID.test(body.parentId) ||
    typeof body.name !== "string" ||
    !validLockTokens(lockTokens)
  )
    throw new Error("invalid_folder_body");
  return {
    spaceId: body.spaceId,
    parentId: body.parentId,
    name: body.name,
    lockTokens,
  };
}

function renameBody(body: Record<string, unknown>) {
  const lockTokens = body.lockTokens ?? [];
  if (
    Object.keys(body).some((key) => !["spaceId", "name", "lockTokens"].includes(key)) ||
    typeof body.spaceId !== "string" ||
    !ID.test(body.spaceId) ||
    typeof body.name !== "string" ||
    !validLockTokens(lockTokens)
  )
    throw new Error("invalid_rename_body");
  return { spaceId: body.spaceId, name: body.name, lockTokens };
}

/** Private REST bridge for the preexisting operation/permit mutation protocol. */
export async function handleNodeMutationHttp(
  request: Request,
  env: Env,
  principal: Principal,
  csrf: Pick<CsrfTokens, "verify">,
): Promise<Response> {
  const url = new URL(request.url);
  if (url.origin !== env.APP_ORIGIN || url.search || url.hash || principal.kind !== "user")
    return problem(404, "not_found");
  const lookup = request.method === "GET" ? OPERATION.exec(url.pathname) : null;
  if (lookup) {
    try {
      const operation = await lookupOperation(env.DB, principal, lookup[1] ?? "");
      if (!operation) return problem(404, "not_found");
      return Response.json(operation, {
        headers: { "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff" },
      });
    } catch {
      return problem(503, "not_ready");
    }
  }
  const folder = request.method === "POST" && url.pathname === "/api/v1/nodes";
  const rename = request.method === "PATCH" ? NODE.exec(url.pathname) : null;
  if (!folder && !rename) return problem(404, "not_found");
  try {
    await csrf.verify(env.DB, request, {
      kind: "access",
      credentialId: principal.credential_id,
      epoch: principal.epoch,
    });
  } catch {
    return problem(403, "forbidden");
  }
  const key = request.headers.get("Idempotency-Key");
  if (!key || key.includes(",") || !/^[\x21-\x7e]{1,200}$/.test(key))
    return problem(400, "bad_request");
  let body: Record<string, unknown>;
  try {
    body = await readBody(request);
  } catch {
    return problem(400, "bad_request");
  }
  try {
    const outcome = folder
      ? await createFolder(env, { principal, idempotencyKey: key, ...folderBody(body) })
      : await renameNode(env, {
          principal,
          idempotencyKey: key,
          nodeId: rename?.[1] ?? "",
          ...renameBody(body),
        });
    if (outcome.kind === "commit_unknown") return unknownOperation(outcome.operationId);
    const operation = outcome.operation;
    if (operation.state === "claimed") return unknownOperation(operation.id);
    if (operation.state === "committed")
      return Response.json(operation, {
        status: folder ? 201 : 200,
        headers: { "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff" },
      });
    return Response.json(operation, {
      status: 409,
      headers: { "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff" },
    });
  } catch (error) {
    if (error instanceof Error && error.message === "idempotency_conflict")
      return problem(409, "conflict");
    if (
      error instanceof Error &&
      [
        "invalid_name",
        "name_too_long",
        "reserved_name",
        "invalid_folder_body",
        "invalid_rename_body",
      ].includes(error.message)
    )
      return problem(400, "bad_request");
    if (error instanceof Error && error.message === "authorization_denied")
      return problem(404, "not_found");
    return problem(503, "not_ready");
  }
}
