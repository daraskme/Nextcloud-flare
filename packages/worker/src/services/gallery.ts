import type { GalleryItem, GalleryPage } from "@ncf/shared";

import type { Env } from "../env.js";
import { getOwnedNode, getOwnerWorkspace } from "./nodes.js";

const CANDIDATE_LIMIT = 50_000;
const GENERATOR_VERSION = "image-v1";

interface GalleryCursor {
  version: 1;
  userId: string;
  rootId: string;
  recursive: boolean;
  treeGeneration: number;
  viewRevision: string;
  capturedAt: number;
  updatedAt: number;
  nodeId: string;
  issuedAt: number;
}

interface GalleryRow {
  id: string;
  name: string;
  blobId: string;
  mime: string;
  size: number;
  width: number | null;
  height: number | null;
  takenAt: number | null;
  capturedAt: number;
  updatedAt: number;
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

async function key(env: Env): Promise<CryptoKey> {
  if (env.CURSOR_KEY === undefined || env.CURSOR_KEY.length < 32) {
    throw new Error("cursor_configuration_invalid");
  }
  return crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(env.CURSOR_KEY),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"],
  );
}

async function signCursor(env: Env, payload: GalleryCursor): Promise<string> {
  const body = encode(new TextEncoder().encode(JSON.stringify(payload)));
  const signature = await crypto.subtle.sign(
    "HMAC",
    await key(env),
    new TextEncoder().encode(body),
  );
  return `${body}.${encode(new Uint8Array(signature))}`;
}

async function verifyCursor(env: Env, value: string): Promise<GalleryCursor> {
  const [body, signature, extra] = value.split(".");
  if (body === undefined || signature === undefined || extra !== undefined) {
    throw new RangeError("Gallery cursor is invalid");
  }
  let valid = false;
  let parsed: unknown;
  try {
    valid = await crypto.subtle.verify(
      "HMAC",
      await key(env),
      decode(signature),
      new TextEncoder().encode(body),
    );
    parsed = JSON.parse(new TextDecoder().decode(decode(body))) as unknown;
  } catch {
    throw new RangeError("Gallery cursor is invalid");
  }
  if (!valid) throw new RangeError("Gallery cursor is invalid");
  if (typeof parsed !== "object" || parsed === null)
    throw new RangeError("Gallery cursor is invalid");
  const cursor = parsed as Partial<GalleryCursor>;
  if (
    cursor.version !== 1 ||
    typeof cursor.userId !== "string" ||
    typeof cursor.rootId !== "string" ||
    typeof cursor.recursive !== "boolean" ||
    !Number.isSafeInteger(cursor.treeGeneration) ||
    typeof cursor.viewRevision !== "string" ||
    cursor.viewRevision.length > 128 ||
    !Number.isSafeInteger(cursor.capturedAt) ||
    !Number.isSafeInteger(cursor.updatedAt) ||
    typeof cursor.nodeId !== "string" ||
    !Number.isSafeInteger(cursor.issuedAt) ||
    (cursor.issuedAt ?? 0) + 3_600_000 < Date.now()
  ) {
    throw new RangeError("Gallery cursor is invalid");
  }
  return cursor as GalleryCursor;
}

async function viewRevision(
  env: Env,
  rootId: string,
  userId: string,
  recursive: boolean,
): Promise<string> {
  const scope = recursive
    ? "WITH RECURSIVE scope(id,depth) AS (SELECT ?1,0 UNION ALL SELECT n.id,scope.depth+1 FROM nodes n JOIN scope ON n.parent_id=scope.id WHERE n.deleted_at IS NULL AND scope.depth<64 LIMIT 50001)"
    : "WITH scope(id,depth) AS (SELECT id,0 FROM nodes WHERE parent_id=?1 AND deleted_at IS NULL)";
  const row = await env.DB.prepare(
    `${scope} SELECT printf('%d:%d:%d:%d',COUNT(*),COALESCE(MAX(n.updated_at),0),COALESCE(SUM(n.revision),0),SUM(CASE WHEN m.node_id IS NULL THEN 0 ELSE 1 END)) value FROM scope JOIN nodes n ON n.id=scope.id LEFT JOIN node_media m ON m.node_id=n.id AND m.blob_id=n.current_blob_id AND m.generator_version=?2 WHERE n.owner_id=?3 AND n.deleted_at IS NULL`,
  )
    .bind(rootId, GENERATOR_VERSION, userId)
    .first<{ value: string }>();
  return row?.value ?? "0:0:0:0";
}

function mediaFilter(): string {
  return "(lower(COALESCE(b.mime_sniffed,'')) LIKE 'image/%' AND lower(COALESCE(b.mime_sniffed,''))<>'image/svg+xml' OR lower(COALESCE(b.mime_sniffed,'')) LIKE 'video/%')";
}

function item(row: GalleryRow): GalleryItem {
  const mediaKind = row.mime.toLowerCase().startsWith("video/") ? "video" : "image";
  return {
    id: row.id,
    name: row.name,
    blobId: row.blobId,
    mediaKind,
    mime: row.mime,
    size: row.size,
    width: row.width,
    height: row.height,
    takenAt: row.takenAt,
    capturedAt: row.capturedAt,
    updatedAt: row.updatedAt,
    thumbUrl: `/api/v1/nodes/${encodeURIComponent(row.id)}/thumb?variant=md768`,
    contentUrl: `/api/v1/nodes/${encodeURIComponent(row.id)}/content`,
  };
}

export async function assertGalleryCandidateLimit(
  env: Env,
  rootId: string,
  limit = CANDIDATE_LIMIT,
): Promise<void> {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > CANDIDATE_LIMIT) {
    throw new RangeError("Gallery candidate limit is invalid");
  }
  const candidates = await env.DB.prepare(
    "WITH RECURSIVE scope(id,depth) AS (SELECT ?1,0 UNION ALL SELECT n.id,scope.depth+1 FROM nodes n JOIN scope ON n.parent_id=scope.id WHERE n.deleted_at IS NULL AND scope.depth<64 LIMIT ?2) SELECT COUNT(*) value FROM scope",
  )
    .bind(rootId, limit + 1)
    .first<{ value: number }>();
  if ((candidates?.value ?? 0) > limit) throw new Error("gallery_scope_too_large");
}

export async function listGallery(
  env: Env,
  input: {
    userId: string;
    rootId: string;
    recursive: boolean;
    cursor?: string;
    limit?: number;
  },
): Promise<GalleryPage> {
  const limit = input.limit ?? 200;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 200) {
    throw new RangeError("Gallery page size is invalid");
  }
  const root = await getOwnedNode(env, input.userId, input.rootId);
  if (root.kind === "file") throw new Error("not_a_folder");
  const workspace = await getOwnerWorkspace(env, input.userId);
  const currentViewRevision = await viewRevision(env, input.rootId, input.userId, input.recursive);
  let capturedAt = Number.MAX_SAFE_INTEGER;
  let updatedAt = Number.MAX_SAFE_INTEGER;
  let nodeId = "~";
  if (input.cursor !== undefined) {
    const cursor = await verifyCursor(env, input.cursor);
    if (
      cursor.userId !== input.userId ||
      cursor.rootId !== input.rootId ||
      cursor.recursive !== input.recursive ||
      cursor.treeGeneration !== workspace.treeGeneration ||
      cursor.viewRevision !== currentViewRevision
    ) {
      throw new RangeError("Gallery cursor does not match this view");
    }
    capturedAt = cursor.capturedAt;
    updatedAt = cursor.updatedAt;
    nodeId = cursor.nodeId;
  }
  if (input.recursive) await assertGalleryCandidateLimit(env, input.rootId);
  const scope = input.recursive
    ? "WITH RECURSIVE scope(id,depth) AS (SELECT ?1,0 UNION ALL SELECT n.id,scope.depth+1 FROM nodes n JOIN scope ON n.parent_id=scope.id WHERE n.deleted_at IS NULL AND scope.depth<64 LIMIT 50001)"
    : "WITH scope(id,depth) AS (SELECT id,0 FROM nodes WHERE parent_id=?1 AND deleted_at IS NULL)";
  const captured = "COALESCE(m.taken_at,n.client_mtime,n.updated_at)";
  const rows = await env.DB.prepare(
    `${scope} SELECT n.id,n.name,n.current_blob_id blobId,COALESCE(b.mime_sniffed,'application/octet-stream') mime,b.size,m.width,m.height,m.taken_at takenAt,${captured} capturedAt,n.updated_at updatedAt FROM scope JOIN nodes n ON n.id=scope.id JOIN blobs b ON b.id=n.current_blob_id AND b.state='committed' LEFT JOIN node_media m ON m.node_id=n.id AND m.blob_id=n.current_blob_id AND m.generator_version=?2 WHERE n.owner_id=?3 AND n.deleted_at IS NULL AND ${mediaFilter()} AND (${captured}<?4 OR (${captured}=?4 AND n.updated_at<?5) OR (${captured}=?4 AND n.updated_at=?5 AND n.id<?6)) ORDER BY ${captured} DESC,n.updated_at DESC,n.id DESC LIMIT ?7`,
  )
    .bind(input.rootId, GENERATOR_VERSION, input.userId, capturedAt, updatedAt, nodeId, limit + 1)
    .all<GalleryRow>();
  const items = rows.results.slice(0, limit).map(item);
  const last = rows.results.at(limit - 1);
  return {
    items,
    recursive: input.recursive,
    candidateLimit: CANDIDATE_LIMIT,
    nextCursor:
      rows.results.length > limit && last !== undefined
        ? await signCursor(env, {
            version: 1,
            userId: input.userId,
            rootId: input.rootId,
            recursive: input.recursive,
            treeGeneration: workspace.treeGeneration,
            viewRevision: currentViewRevision,
            capturedAt: last.capturedAt,
            updatedAt: last.updatedAt,
            nodeId: last.id,
            issuedAt: Date.now(),
          })
        : null,
  };
}

export const galleryGeneratorVersion = GENERATOR_VERSION;
