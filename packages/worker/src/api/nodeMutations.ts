import { problem } from "@next-cloud-flare/shared/errors";
import type { Principal } from "../auth/authorize";
import type { CsrfTokens } from "../auth/csrf";
import type { Env } from "../env";
import { lookupOperation } from "../jobs/operations";
import { copyNode } from "../services/copyNode";
import { createFolder } from "../services/createFolder";
import { moveNode } from "../services/moveNode";
import { renameNode } from "../services/renameNode";
import { trashNode } from "../services/trashNode";

const ID = /^[A-Za-z0-9_-]{1,128}$/;
const OPERATION = /^\/api\/v1\/operations\/(op_[a-f0-9]{64})$/;
const NODE = /^\/api\/v1\/nodes\/([A-Za-z0-9_-]{1,128})$/;
const NODE_TRANSFER = /^\/api\/v1\/nodes\/([A-Za-z0-9_-]{1,128})\/(move|copy)$/;
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
    (request.method === "DELETE" && NODE.test(path)) ||
    (request.method === "POST" && NODE_TRANSFER.test(path)) ||
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

function trashBody(body: Record<string, unknown>) {
  const lockTokens = body.lockTokens ?? [];
  if (
    Object.keys(body).some((key) => !["spaceId", "lockTokens"].includes(key)) ||
    typeof body.spaceId !== "string" ||
    !ID.test(body.spaceId) ||
    !validLockTokens(lockTokens)
  )
    throw new Error("invalid_trash_body");
  return { spaceId: body.spaceId, lockTokens };
}

function transferBody(
  body: Record<string, unknown>,
  kind: "move",
): {
  spaceId: string;
  destinationParentId: string;
  name: string;
  overwriteTargetId?: string;
  lockTokens: string[];
};
function transferBody(
  body: Record<string, unknown>,
  kind: "copy",
): {
  spaceId: string;
  destinationParentId: string;
  name: string;
  overwriteTargetId?: string;
  lockTokens: string[];
  depth: "0" | "infinity";
};
function transferBody(body: Record<string, unknown>, kind: "move" | "copy") {
  const lockTokens = body.lockTokens ?? [];
  const allowed = [
    "spaceId",
    "destinationParentId",
    "name",
    "overwriteTargetId",
    "lockTokens",
    ...(kind === "copy" ? ["depth"] : []),
  ];
  if (
    Object.keys(body).some((key) => !allowed.includes(key)) ||
    typeof body.spaceId !== "string" ||
    !ID.test(body.spaceId) ||
    typeof body.destinationParentId !== "string" ||
    !ID.test(body.destinationParentId) ||
    typeof body.name !== "string" ||
    (body.overwriteTargetId !== undefined &&
      (typeof body.overwriteTargetId !== "string" || !ID.test(body.overwriteTargetId))) ||
    !validLockTokens(lockTokens) ||
    (kind === "copy" && body.depth !== "0" && body.depth !== "infinity")
  )
    throw new Error(`invalid_${kind}_body`);
  return {
    spaceId: body.spaceId,
    destinationParentId: body.destinationParentId,
    name: body.name,
    ...(typeof body.overwriteTargetId === "string"
      ? { overwriteTargetId: body.overwriteTargetId }
      : {}),
    lockTokens,
    ...(kind === "copy" ? { depth: body.depth as "0" | "infinity" } : {}),
  };
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
  const trash = request.method === "DELETE" ? NODE.exec(url.pathname) : null;
  const transfer = request.method === "POST" ? NODE_TRANSFER.exec(url.pathname) : null;
  if (!folder && !rename && !trash && !transfer) return problem(404, "not_found");
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
      : rename
        ? await renameNode(env, {
            principal,
            idempotencyKey: key,
            nodeId: rename[1] ?? "",
            ...renameBody(body),
          })
        : trash
          ? await trashNode(env, {
              principal,
              requestId: key,
              nodeId: trash[1] ?? "",
              operation: "node.trash",
              ...trashBody(body),
            })
          : transfer?.[2] === "move"
            ? await moveNode(env, {
                principal,
                requestId: key,
                nodeId: transfer[1] ?? "",
                operation: "node.move",
                ...transferBody(body, "move"),
              })
            : await copyNode(env, {
                principal,
                requestId: key,
                sourceNodeId: transfer?.[1] ?? "",
                operation: "node.copy",
                ...transferBody(body, "copy"),
              });
    if (outcome.kind === "commit_unknown") return unknownOperation(outcome.operationId);
    const operation = outcome.operation;
    if (operation.state === "claimed") return unknownOperation(operation.id);
    if (operation.state === "committed")
      return Response.json(operation, {
        status: folder || transfer?.[2] === "copy" ? 201 : 200,
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
        "invalid_trash_body",
        "invalid_move_body",
        "invalid_copy_body",
      ].includes(error.message)
    )
      return problem(400, "bad_request");
    if (error instanceof Error && error.message === "authorization_denied")
      return problem(404, "not_found");
    if (error instanceof Error && error.message === "dav_locked") return problem(423, "locked");
    if (error instanceof Error && error.message === "dav_transfer_too_large")
      return problem(413, "payload_too_large");
    if (
      error instanceof Error &&
      ["name_conflict", "dav_cross_space_move", "dav_cross_space_copy"].includes(error.message)
    )
      return problem(409, "conflict");
    return problem(503, "not_ready");
  }
}
