import type {
  EpubEntrySummary,
  LibraryItemSummary,
  LibraryKind,
  LibraryRootSummary,
  ReadingPosition,
} from "@ncf/shared";

import type { Env } from "../env.js";
import { extractZipEntry, type ZipEntry } from "../media/archive/zip.js";
import { EPUB_INNER_CSP } from "../media/epub/sanitize.js";
import { isEffectiveLive } from "./effectiveLive.js";
import { getOwnedNode, getOwnerWorkspace } from "./nodes.js";

interface LibraryRow {
  id: string;
  nodeId: string;
  blobId: string;
  kind: LibraryKind;
  title: string | null;
  author: string | null;
  series: string | null;
  tagsJson: string;
  pageCount: number | null;
  coverKey: string | null;
  status: LibraryItemSummary["status"];
  errorCode: string | null;
  metadataJson: string;
  overrideJson: string;
  position: string | null;
  updatedAt: number;
  rootId: string;
  ownerId: string;
}

interface ArchiveEntryRow {
  entryId: string;
  path: string;
  method: 0 | 8;
  flags: number;
  compressedSize: number;
  uncompressedSize: number;
  localHeaderOffset: number;
  dataOffset: number;
  crc32: number;
  contentType: string;
  r2Key: string;
  size: number;
  rootId: string;
  ownerId: string;
  nodeId: string;
  blobId: string;
}

interface EpubMetadata {
  epubEntries?: (EpubEntrySummary & { key: string })[];
}

function parseObject(value: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(value);
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

function parseTags(value: string): string[] {
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed)
      ? parsed.filter((item): item is string => typeof item === "string").slice(0, 64)
      : [];
  } catch {
    return [];
  }
}

function parsePosition(value: string | null): ReadingPosition | null {
  if (value === null) return null;
  try {
    const parsed = JSON.parse(value) as Partial<ReadingPosition>;
    if (
      !Number.isSafeInteger(parsed.page) ||
      (parsed.page ?? -1) < 0 ||
      (parsed.mode !== "single" && parsed.mode !== "spread") ||
      typeof parsed.rtl !== "boolean"
    ) {
      return null;
    }
    return {
      page: parsed.page ?? 0,
      mode: parsed.mode,
      rtl: parsed.rtl,
      ...(typeof parsed.entryId === "string" ? { entryId: parsed.entryId } : {}),
      ...(typeof parsed.cfi === "string" ? { cfi: parsed.cfi } : {}),
    };
  } catch {
    return null;
  }
}

function summary(row: LibraryRow): LibraryItemSummary {
  const override = parseObject(row.overrideJson);
  const title = typeof override.title === "string" ? override.title : (row.title ?? "Untitled");
  const author = typeof override.author === "string" ? override.author : row.author;
  const series = typeof override.series === "string" ? override.series : row.series;
  const tags = Array.isArray(override.tags)
    ? override.tags.filter((value): value is string => typeof value === "string").slice(0, 64)
    : parseTags(row.tagsJson);
  return {
    id: row.id,
    nodeId: row.nodeId,
    blobId: row.blobId,
    kind: row.kind,
    title,
    author,
    series,
    tags,
    pageCount: row.pageCount,
    coverUrl:
      row.coverKey === null ? null : `/api/v1/library/items/${encodeURIComponent(row.id)}/cover`,
    status: row.status,
    errorCode: row.errorCode,
    readingState: parsePosition(row.position),
    updatedAt: row.updatedAt,
  };
}

const itemSelect =
  "SELECT i.id,i.node_id nodeId,i.blob_id blobId,i.kind,i.title,i.author,i.series,i.tags_json tagsJson,i.page_count pageCount,i.cover_key coverKey,i.status,i.error_code errorCode,i.metadata_json metadataJson,i.override_json overrideJson,rs.position,i.updated_at updatedAt,s.root_node_id rootId,n.owner_id ownerId FROM library_items i JOIN nodes n ON n.id=i.node_id JOIN spaces s ON s.id=n.space_id LEFT JOIN user_reading_state rs ON rs.user_id=n.owner_id AND rs.node_id=n.id AND rs.blob_id=i.blob_id";

export async function listLibraryRoots(env: Env, userId: string): Promise<LibraryRootSummary[]> {
  const rows = await env.DB.prepare(
    "SELECT r.node_id nodeId,n.name,r.created_at createdAt FROM library_roots r JOIN nodes n ON n.id=r.node_id WHERE r.user_id=?1 AND n.owner_id=?1 AND n.deleted_at IS NULL ORDER BY r.created_at,r.node_id",
  )
    .bind(userId)
    .all<LibraryRootSummary>();
  return rows.results;
}

export async function addLibraryRoot(env: Env, userId: string, nodeId: string): Promise<void> {
  const node = await getOwnedNode(env, userId, nodeId);
  if (node.kind !== "root" && node.kind !== "folder") throw new Error("not_a_folder");
  await env.DB.prepare(
    "INSERT INTO library_roots(user_id,node_id,created_at) SELECT ?1,?2,?3 WHERE EXISTS(SELECT 1 FROM users WHERE id=?1 AND disabled_at IS NULL) AND EXISTS(SELECT 1 FROM nodes WHERE id=?2 AND owner_id=?1 AND kind IN ('root','folder') AND deleted_at IS NULL) ON CONFLICT(user_id,node_id) DO NOTHING",
  )
    .bind(userId, nodeId, Date.now())
    .run();
}

export async function removeLibraryRoot(env: Env, userId: string, nodeId: string): Promise<void> {
  await env.DB.prepare("DELETE FROM library_roots WHERE user_id=?1 AND node_id=?2")
    .bind(userId, nodeId)
    .run();
}

export async function listLibraryItems(env: Env, userId: string): Promise<LibraryItemSummary[]> {
  const rows = await env.DB.prepare(
    `WITH RECURSIVE scope(user_id,id,depth) AS (SELECT user_id,node_id,0 FROM library_roots WHERE user_id=?1 UNION ALL SELECT scope.user_id,n.id,scope.depth+1 FROM nodes n JOIN scope ON n.parent_id=scope.id WHERE n.deleted_at IS NULL AND scope.depth<64) ${itemSelect} JOIN scope ON scope.id=n.id AND scope.user_id=n.owner_id WHERE n.owner_id=?1 AND n.current_blob_id=i.blob_id AND n.deleted_at IS NULL ORDER BY i.updated_at DESC,i.id LIMIT 500`,
  )
    .bind(userId)
    .all<LibraryRow>();
  const items: LibraryItemSummary[] = [];
  for (const row of rows.results) {
    if (await isEffectiveLive(env, row.nodeId, row.rootId)) items.push(summary(row));
  }
  return items;
}

export async function getLibraryItem(
  env: Env,
  userId: string,
  itemId: string,
): Promise<{ item: LibraryItemSummary; entries: EpubEntrySummary[] }> {
  const row = await env.DB.prepare(
    `${itemSelect} WHERE i.id=?1 AND n.owner_id=?2 AND n.current_blob_id=i.blob_id AND n.deleted_at IS NULL`,
  )
    .bind(itemId, userId)
    .first<LibraryRow>();
  if (row === null || !(await isEffectiveLive(env, row.nodeId, row.rootId))) {
    throw new Error("node_not_found");
  }
  const metadata = parseObject(row.metadataJson) as EpubMetadata;
  const entries = Array.isArray(metadata.epubEntries)
    ? metadata.epubEntries
        .filter(
          (entry): entry is EpubEntrySummary & { key: string } =>
            typeof entry.id === "string" &&
            typeof entry.path === "string" &&
            typeof entry.title === "string" &&
            typeof entry.key === "string",
        )
        .map(({ id, path, title }) => ({ id, path, title }))
    : [];
  return { item: summary(row), entries };
}

export async function updateLibraryItem(
  env: Env,
  userId: string,
  itemId: string,
  override: { title?: string; author?: string; series?: string; tags?: string[] },
): Promise<void> {
  const normalized = {
    ...(override.title === undefined ? {} : { title: override.title.slice(0, 1024) }),
    ...(override.author === undefined ? {} : { author: override.author.slice(0, 1024) }),
    ...(override.series === undefined ? {} : { series: override.series.slice(0, 1024) }),
    ...(override.tags === undefined
      ? {}
      : { tags: override.tags.map((tag) => tag.slice(0, 128)).slice(0, 64) }),
  };
  await env.DB.batch([
    env.DB.prepare(
      "UPDATE library_items SET override_json=?1,updated_at=?2 WHERE id=?3 AND EXISTS(SELECT 1 FROM nodes n WHERE n.id=library_items.node_id AND n.owner_id=?4 AND n.current_blob_id=library_items.blob_id AND n.deleted_at IS NULL)",
    ).bind(JSON.stringify(normalized), Date.now(), itemId, userId),
    env.DB.prepare("INSERT INTO _assert(v) SELECT 1 WHERE changes()<>1"),
  ]);
}

async function archiveEntry(
  env: Env,
  userId: string,
  itemId: string,
  page: number,
): Promise<ArchiveEntryRow> {
  if (!Number.isSafeInteger(page) || page < 0 || page >= 2000) {
    throw new RangeError("Page number is invalid");
  }
  const row = await env.DB.prepare(
    "SELECT a.entry_id entryId,a.path,a.method,a.flags,a.compressed_size compressedSize,a.uncompressed_size uncompressedSize,a.offset localHeaderOffset,a.data_offset dataOffset,a.crc32,a.content_type contentType,b.r2_key r2Key,b.size,s.root_node_id rootId,n.owner_id ownerId,n.id nodeId,n.current_blob_id blobId FROM library_items i JOIN nodes n ON n.id=i.node_id JOIN spaces s ON s.id=n.space_id JOIN blobs b ON b.id=i.blob_id JOIN archive_index a ON a.node_id=i.node_id AND a.blob_id=i.blob_id WHERE i.id=?1 AND i.kind='cbz' AND i.status='indexed' AND n.owner_id=?2 AND n.current_blob_id=i.blob_id AND n.deleted_at IS NULL AND a.page_no=?3",
  )
    .bind(itemId, userId, page)
    .first<ArchiveEntryRow>();
  if (row === null || !(await isEffectiveLive(env, row.nodeId, row.rootId))) {
    throw new Error("node_not_found");
  }
  return row;
}

export async function serveLibraryPage(
  env: Env,
  userId: string,
  itemId: string,
  page: number,
  head: boolean,
): Promise<Response> {
  const row = await archiveEntry(env, userId, itemId, page);
  const headers = new Headers({
    "Cache-Control": "private, no-store",
    "Content-Length": String(row.uncompressedSize),
    "Content-Type": row.contentType,
    ETag: `"page-${row.blobId}-${row.entryId}-${row.crc32}"`,
    "Referrer-Policy": "no-referrer",
    "X-Content-Type-Options": "nosniff",
  });
  if (head) return new Response(null, { headers });
  const entry: ZipEntry = {
    entryId: row.entryId,
    path: row.path,
    method: row.method,
    flags: row.flags,
    compressedSize: row.compressedSize,
    uncompressedSize: row.uncompressedSize,
    localHeaderOffset: row.localHeaderOffset,
    dataOffset: row.dataOffset,
    crc32: row.crc32,
    contentType: row.contentType,
  };
  const bytes = await extractZipEntry(env.BLOBS, row.r2Key, row.size, entry, 20 * 1024 * 1024);
  return new Response(bytes, { headers });
}

export async function serveLibraryCover(
  env: Env,
  userId: string,
  itemId: string,
  head: boolean,
): Promise<Response> {
  const row = await env.DB.prepare(
    "SELECT i.cover_key coverKey,n.id nodeId,n.owner_id ownerId,s.root_node_id rootId FROM library_items i JOIN nodes n ON n.id=i.node_id JOIN spaces s ON s.id=n.space_id WHERE i.id=?1 AND n.owner_id=?2 AND n.current_blob_id=i.blob_id AND n.deleted_at IS NULL AND i.status='indexed' AND i.cover_key IS NOT NULL",
  )
    .bind(itemId, userId)
    .first<{ coverKey: string; nodeId: string; ownerId: string; rootId: string }>();
  if (row === null || !(await isEffectiveLive(env, row.nodeId, row.rootId))) {
    throw new Error("node_not_found");
  }
  const object = head ? await env.BLOBS.head(row.coverKey) : await env.BLOBS.get(row.coverKey);
  if (object === null) throw new Error("derivative_inconsistent");
  const headers = new Headers({
    "Cache-Control": "private, no-store",
    "Content-Length": String(object.size),
    "Content-Type": "image/webp",
    "X-Content-Type-Options": "nosniff",
  });
  return new Response(head ? null : (object as R2ObjectBody).body, { headers });
}

export async function serveEpubEntry(
  env: Env,
  userId: string,
  itemId: string,
  entryId: string,
  head: boolean,
): Promise<Response> {
  const row = await env.DB.prepare(
    `${itemSelect} WHERE i.id=?1 AND i.kind='epub' AND i.status='indexed' AND n.owner_id=?2 AND n.current_blob_id=i.blob_id AND n.deleted_at IS NULL`,
  )
    .bind(itemId, userId)
    .first<LibraryRow>();
  if (row === null || !(await isEffectiveLive(env, row.nodeId, row.rootId))) {
    throw new Error("node_not_found");
  }
  const metadata = parseObject(row.metadataJson) as EpubMetadata;
  const entry = metadata.epubEntries?.find(
    (candidate) => candidate.id === entryId && typeof candidate.key === "string",
  );
  if (entry === undefined) throw new Error("node_not_found");
  const object = head ? await env.BLOBS.head(entry.key) : await env.BLOBS.get(entry.key);
  if (object === null) throw new Error("derivative_inconsistent");
  const headers = new Headers({
    "Cache-Control": "private, no-store",
    "Content-Length": String(object.size),
    "Content-Security-Policy": EPUB_INNER_CSP,
    "Content-Type": "application/xhtml+xml; charset=utf-8",
    "Referrer-Policy": "no-referrer",
    "X-Content-Type-Options": "nosniff",
  });
  return new Response(head ? null : (object as R2ObjectBody).body, { headers });
}

export async function saveReadingState(
  env: Env,
  userId: string,
  itemId: string,
  position: ReadingPosition,
): Promise<void> {
  if (
    !Number.isSafeInteger(position.page) ||
    position.page < 0 ||
    position.page >= 2000 ||
    (position.cfi?.length ?? 0) > 2048 ||
    (position.entryId?.length ?? 0) > 128
  ) {
    throw new RangeError("Reading position is invalid");
  }
  await env.DB.batch([
    env.DB.prepare(
      "INSERT INTO user_reading_state(user_id,node_id,blob_id,position,updated_at) SELECT ?1,i.node_id,i.blob_id,?2,?3 FROM library_items i JOIN nodes n ON n.id=i.node_id WHERE i.id=?4 AND n.owner_id=?1 AND n.current_blob_id=i.blob_id AND n.deleted_at IS NULL ON CONFLICT(user_id,node_id,blob_id) DO UPDATE SET position=excluded.position,updated_at=excluded.updated_at",
    ).bind(userId, JSON.stringify(position), Date.now(), itemId),
    env.DB.prepare("INSERT INTO _assert(v) SELECT 1 WHERE changes()<>1"),
  ]);
}

export async function assertLibraryScope(env: Env, userId: string, nodeId: string): Promise<void> {
  const workspace = await getOwnerWorkspace(env, userId);
  if (!(await isEffectiveLive(env, nodeId, workspace.rootId))) throw new Error("node_not_found");
}
