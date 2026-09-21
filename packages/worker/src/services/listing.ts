import type { ChildrenPage, NodeSummary } from "@ncf/shared";

import type { Env } from "../env.js";
import { isEffectiveLive } from "./effectiveLive.js";
import { getOwnerWorkspace } from "./nodes.js";

interface CursorPayload {
  version: 1;
  userId: string;
  parentId: string;
  treeGeneration: number;
  lastName: string;
  lastId: string;
  issuedAt: number;
}

interface NodeRow {
  id: string;
  parent_id: string | null;
  name: string;
  name_ci: string;
  kind: "root" | "folder" | "file";
  revision: number;
  current_blob_id: string | null;
  size: number | null;
  mime_sniffed: string | null;
  updated_at: number;
}

function encode(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
}

function decode(value: string): Uint8Array {
  const normalized = value.replaceAll("-", "+").replaceAll("_", "/");
  return Uint8Array.from(
    atob(normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "=")),
    (character) => character.charCodeAt(0),
  );
}

async function cursorKey(env: Env): Promise<CryptoKey> {
  if (env.CURSOR_KEY === undefined || env.CURSOR_KEY.length < 32)
    throw new Error("cursor_configuration_invalid");
  return crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(env.CURSOR_KEY),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"],
  );
}

async function signCursor(env: Env, payload: CursorPayload): Promise<string> {
  const body = encode(new TextEncoder().encode(JSON.stringify(payload)));
  const signature = await crypto.subtle.sign(
    "HMAC",
    await cursorKey(env),
    new TextEncoder().encode(body),
  );
  return `${body}.${encode(new Uint8Array(signature))}`;
}

async function verifyCursor(env: Env, token: string): Promise<CursorPayload> {
  const [body, signature, extra] = token.split(".");
  if (body === undefined || signature === undefined || extra !== undefined)
    throw new RangeError("Cursor is invalid");
  const valid = await crypto.subtle.verify(
    "HMAC",
    await cursorKey(env),
    decode(signature),
    new TextEncoder().encode(body),
  );
  if (!valid) throw new RangeError("Cursor is invalid");
  const payload = JSON.parse(new TextDecoder().decode(decode(body))) as {
    version?: unknown;
    userId?: unknown;
    parentId?: unknown;
    treeGeneration?: unknown;
    lastName?: unknown;
    lastId?: unknown;
    issuedAt?: unknown;
  };
  if (
    payload.version !== 1 ||
    typeof payload.userId !== "string" ||
    typeof payload.parentId !== "string" ||
    typeof payload.treeGeneration !== "number" ||
    !Number.isSafeInteger(payload.treeGeneration) ||
    typeof payload.lastName !== "string" ||
    typeof payload.lastId !== "string" ||
    typeof payload.issuedAt !== "number" ||
    !Number.isSafeInteger(payload.issuedAt) ||
    payload.issuedAt + 60 * 60 * 1000 < Date.now()
  ) {
    throw new RangeError("Cursor is invalid");
  }
  return {
    version: 1,
    userId: payload.userId,
    parentId: payload.parentId,
    treeGeneration: payload.treeGeneration,
    lastName: payload.lastName,
    lastId: payload.lastId,
    issuedAt: payload.issuedAt,
  };
}

function summary(row: NodeRow): NodeSummary {
  return {
    id: row.id,
    parentId: row.parent_id,
    name: row.name,
    kind: row.kind,
    revision: row.revision,
    blobId: row.current_blob_id,
    size: row.size,
    mime: row.mime_sniffed,
    updatedAt: row.updated_at,
  };
}

export async function listChildren(
  env: Env,
  userId: string,
  parentId: string,
  cursor?: string,
  limit = 200,
): Promise<ChildrenPage> {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 200)
    throw new RangeError("Page size is invalid");
  const workspace = await getOwnerWorkspace(env, userId);
  if (!(await isEffectiveLive(env, parentId, workspace.rootId))) throw new Error("node_not_found");
  let lastName = "";
  let lastId = "";
  if (cursor !== undefined) {
    const payload = await verifyCursor(env, cursor);
    if (
      payload.userId !== userId ||
      payload.parentId !== parentId ||
      payload.treeGeneration !== workspace.treeGeneration
    ) {
      throw new RangeError("Cursor does not match this listing");
    }
    lastName = payload.lastName;
    lastId = payload.lastId;
  }
  const rows = await env.DB.prepare(
    "SELECT n.id,n.parent_id,n.name,n.name_ci,n.kind,n.revision,n.current_blob_id,b.size,b.mime_sniffed,n.updated_at FROM nodes n INDEXED BY nodes_children_keyset LEFT JOIN blobs b ON b.id=n.current_blob_id WHERE n.parent_id=?1 AND n.owner_id=?2 AND n.deleted_at IS NULL AND (n.name_ci>?3 OR (n.name_ci=?3 AND n.id>?4)) ORDER BY n.name_ci,n.id LIMIT ?5",
  )
    .bind(parentId, userId, lastName, lastId, limit + 1)
    .all<NodeRow>();
  const items = rows.results.slice(0, limit).map(summary);
  const last = rows.results.at(limit - 1);
  return {
    items,
    treeGeneration: workspace.treeGeneration,
    nextCursor:
      rows.results.length > limit && last !== undefined
        ? await signCursor(env, {
            version: 1,
            userId,
            parentId,
            treeGeneration: workspace.treeGeneration,
            lastName: last.name_ci,
            lastId: last.id,
            issuedAt: Date.now(),
          })
        : null,
  };
}
