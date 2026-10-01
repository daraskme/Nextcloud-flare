import {
  type AuthorizedNode,
  authorizationAssertion,
  authorizeNode,
  type Principal,
} from "../auth/authorize";
import { assertExists, atomicBatch, primary } from "../db/primary";
import { AUDIO_GENERATOR_VERSION } from "../media/audio";
import { EPUB_INDEX_GENERATOR } from "../media/epub/index";
import { VIDEO_METADATA_GENERATOR } from "../media/video";

const ID = /^[A-Za-z0-9_-]{1,128}$/;
const MAX_PLAYBACK_MS = 7 * 24 * 60 * 60 * 1_000;
const MAX_READING_PROGRESS = 10_000;
interface UserPrincipal {
  readonly kind: "user";
  readonly user_id: string;
  readonly credential_id: string;
  readonly epoch: number;
}
type AuthorizedExistingNode = Exclude<AuthorizedNode, { readonly operation: "node.create" }>;

export interface PlaybackState {
  readonly nodeId: string;
  readonly blobId: string;
  readonly durationMs: number;
  readonly positionMs: number | null;
  readonly updatedAt: number | null;
}

export interface ReadingPosition {
  readonly spineIndex: number;
  readonly progress: number;
}

export interface ReadingState {
  readonly nodeId: string;
  readonly blobId: string;
  readonly pageCount: number;
  readonly position: ReadingPosition | null;
  readonly updatedAt: number | null;
}

interface PlaybackRow {
  readonly blobId: string;
  readonly durationMs: number;
  readonly positionMs: number | null;
  readonly updatedAt: number | null;
}

interface ReadingRow {
  readonly blobId: string;
  readonly pageCount: number;
  readonly positionJson: string | null;
  readonly updatedAt: number | null;
}

async function authorizeMedia(
  db: D1Database,
  principal: UserPrincipal,
  nodeId: string,
): Promise<AuthorizedExistingNode> {
  if (!ID.test(nodeId)) throw new Error("media_state_unavailable");
  const located = await primary(db)
    .prepare("SELECT space_id AS spaceId FROM nodes WHERE id=?")
    .bind(nodeId)
    .first<{ spaceId: string }>();
  if (!located) throw new Error("media_state_unavailable");
  const authorized = await authorizeNode(db, principal, {
    operation: "library.read",
    nodeId,
    spaceId: located.spaceId,
  });
  if (authorized.operation === "node.create") throw new Error("media_state_unavailable");
  if (authorized.node.kind !== "file" || !authorized.node.current_blob_id)
    throw new Error("media_state_unavailable");
  return authorized;
}

const PLAYBACK_SELECT = `SELECT n.current_blob_id AS blobId,
  CASE
    WHEN a.node_id IS NOT NULL THEN a.duration_ms
    WHEN m.node_id IS NOT NULL THEN m.duration_ms
  END AS durationMs,
  s.position_ms AS positionMs,s.updated_at AS updatedAt
FROM nodes n
JOIN blobs b ON b.id=n.current_blob_id AND b.owner_id=n.owner_id
JOIN blob_storage bs ON bs.blob_id=b.id AND bs.removed_at IS NULL
LEFT JOIN node_audio a ON a.node_id=n.id AND a.blob_id=b.id
  AND a.generator_version=?2 AND a.duration_ms IS NOT NULL
LEFT JOIN node_media m ON m.node_id=n.id AND m.blob_id=b.id
  AND m.generator_version=?3 AND m.projection_state='ready' AND m.error_code IS NULL
  AND m.video_codec='av1' AND m.container IN ('mp4','webm') AND m.duration_ms IS NOT NULL
LEFT JOIN user_playback_state s ON s.user_id=?4 AND s.node_id=n.id AND s.blob_id=b.id
WHERE n.id=?1 AND n.deleted_at IS NULL AND n.kind='file'
  AND b.state IN ('committed','gc_candidate')
  AND b.r2_key='u/'||n.owner_id||'/b/'||b.id
  AND bs.bytes=b.size AND bs.r2_etag IS NOT NULL
  AND (a.node_id IS NOT NULL OR m.node_id IS NOT NULL)`;

async function playbackRow(
  db: D1Database,
  authorized: AuthorizedExistingNode,
  userId: string,
): Promise<PlaybackRow> {
  const result = await atomicBatch(db, [
    authorizationAssertion(authorized),
    {
      sql: PLAYBACK_SELECT,
      values: [authorized.node.id, AUDIO_GENERATOR_VERSION, VIDEO_METADATA_GENERATOR, userId],
    },
  ]);
  const row = result[1]?.results[0] as PlaybackRow | undefined;
  if (
    !row ||
    row.blobId !== authorized.node.current_blob_id ||
    !Number.isSafeInteger(row.durationMs) ||
    row.durationMs < 0 ||
    row.durationMs > MAX_PLAYBACK_MS
  )
    throw new Error("media_state_unavailable");
  return row;
}

export async function readPlaybackState(
  db: D1Database,
  principal: UserPrincipal,
  nodeId: string,
): Promise<PlaybackState> {
  const authorized = await authorizeMedia(db, principal, nodeId);
  const row = await playbackRow(db, authorized, principal.user_id);
  const stored =
    Number.isSafeInteger(row.positionMs) && row.positionMs !== null && row.positionMs >= 0
      ? Math.min(row.positionMs, row.durationMs)
      : null;
  return {
    nodeId,
    blobId: row.blobId,
    durationMs: row.durationMs,
    positionMs: stored,
    updatedAt: stored === null ? null : row.updatedAt,
  };
}

export async function writePlaybackState(
  db: D1Database,
  principal: UserPrincipal,
  nodeId: string,
  blobId: string,
  positionMs: number,
  now = Date.now(),
): Promise<PlaybackState> {
  if (
    !ID.test(blobId) ||
    !Number.isSafeInteger(positionMs) ||
    positionMs < 0 ||
    positionMs > MAX_PLAYBACK_MS ||
    !Number.isSafeInteger(now) ||
    now < 0
  )
    throw new Error("invalid_media_state");
  const authorized = await authorizeMedia(db, principal, nodeId);
  if (authorized.node.current_blob_id !== blobId) throw new Error("media_state_unavailable");
  const current = await playbackRow(db, authorized, principal.user_id);
  const clamped = Math.min(positionMs, current.durationMs);
  await atomicBatch(db, [
    authorizationAssertion(authorized),
    assertExists(
      `SELECT 1 FROM (${PLAYBACK_SELECT}) current
       WHERE current.blobId=?5 AND current.durationMs=?6`,
      [
        nodeId,
        AUDIO_GENERATOR_VERSION,
        VIDEO_METADATA_GENERATOR,
        principal.user_id,
        blobId,
        current.durationMs,
      ],
    ),
    {
      sql: "DELETE FROM user_playback_state WHERE user_id=? AND node_id=? AND blob_id<>?",
      values: [principal.user_id, nodeId, blobId],
    },
    {
      sql: `INSERT INTO user_playback_state(user_id,node_id,blob_id,position_ms,updated_at)
        VALUES(?,?,?,?,?)
        ON CONFLICT(user_id,node_id,blob_id)
        DO UPDATE SET position_ms=excluded.position_ms,updated_at=excluded.updated_at`,
      values: [principal.user_id, nodeId, blobId, clamped, now],
    },
  ]);
  return {
    nodeId,
    blobId,
    durationMs: current.durationMs,
    positionMs: clamped,
    updatedAt: now,
  };
}

const READING_SELECT = `SELECT n.current_blob_id AS blobId,l.page_count AS pageCount,
  s.position_json AS positionJson,s.updated_at AS updatedAt
FROM nodes n
JOIN blobs b ON b.id=n.current_blob_id AND b.owner_id=n.owner_id
JOIN blob_storage bs ON bs.blob_id=b.id AND bs.removed_at IS NULL
JOIN library_items l ON l.node_id=n.id AND l.blob_id=b.id AND l.kind='epub'
  AND l.generator_version=?2 AND l.page_count BETWEEN 1 AND 1000
JOIN archive_index a ON a.node_id=n.id AND a.blob_id=b.id
  AND a.generator_version=?2 AND a.entry_count BETWEEN 1 AND 1000
LEFT JOIN user_reading_state s ON s.user_id=?3 AND s.node_id=n.id AND s.blob_id=b.id
WHERE n.id=?1 AND n.deleted_at IS NULL AND n.kind='file'
  AND b.state IN ('committed','gc_candidate')
  AND b.r2_key='u/'||n.owner_id||'/b/'||b.id
  AND bs.bytes=b.size AND bs.r2_etag IS NOT NULL`;

async function readingRow(
  db: D1Database,
  authorized: AuthorizedExistingNode,
  userId: string,
): Promise<ReadingRow> {
  const result = await atomicBatch(db, [
    authorizationAssertion(authorized),
    {
      sql: READING_SELECT,
      values: [authorized.node.id, EPUB_INDEX_GENERATOR, userId],
    },
  ]);
  const row = result[1]?.results[0] as ReadingRow | undefined;
  if (
    !row ||
    row.blobId !== authorized.node.current_blob_id ||
    !Number.isSafeInteger(row.pageCount) ||
    row.pageCount < 1 ||
    row.pageCount > 1_000
  )
    throw new Error("media_state_unavailable");
  return row;
}

function readingPosition(value: string | null, pageCount: number): ReadingPosition | null {
  if (!value || new TextEncoder().encode(value).byteLength > 256) return null;
  try {
    const parsed: unknown = JSON.parse(value);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    const position = parsed as Record<string, unknown>;
    if (
      Object.keys(position).sort().join(",") !== "progress,spineIndex" ||
      !Number.isSafeInteger(position.spineIndex) ||
      typeof position.spineIndex !== "number" ||
      position.spineIndex < 0 ||
      position.spineIndex >= pageCount ||
      !Number.isSafeInteger(position.progress) ||
      typeof position.progress !== "number" ||
      position.progress < 0 ||
      position.progress > MAX_READING_PROGRESS
    )
      return null;
    return { spineIndex: position.spineIndex, progress: position.progress };
  } catch {
    return null;
  }
}

export async function readReadingState(
  db: D1Database,
  principal: UserPrincipal,
  nodeId: string,
): Promise<ReadingState> {
  const authorized = await authorizeMedia(db, principal, nodeId);
  const row = await readingRow(db, authorized, principal.user_id);
  const position = readingPosition(row.positionJson, row.pageCount);
  return {
    nodeId,
    blobId: row.blobId,
    pageCount: row.pageCount,
    position,
    updatedAt: position === null ? null : row.updatedAt,
  };
}

export async function writeReadingState(
  db: D1Database,
  principal: UserPrincipal,
  nodeId: string,
  blobId: string,
  position: ReadingPosition,
  now = Date.now(),
): Promise<ReadingState> {
  if (
    !ID.test(blobId) ||
    !Number.isSafeInteger(position.spineIndex) ||
    position.spineIndex < 0 ||
    position.spineIndex >= 1_000 ||
    !Number.isSafeInteger(position.progress) ||
    position.progress < 0 ||
    position.progress > MAX_READING_PROGRESS ||
    !Number.isSafeInteger(now) ||
    now < 0
  )
    throw new Error("invalid_media_state");
  const authorized = await authorizeMedia(db, principal, nodeId);
  if (authorized.node.current_blob_id !== blobId) throw new Error("media_state_unavailable");
  const current = await readingRow(db, authorized, principal.user_id);
  if (position.spineIndex >= current.pageCount) throw new Error("invalid_media_state");
  const encoded = JSON.stringify({
    progress: position.progress,
    spineIndex: position.spineIndex,
  });
  await atomicBatch(db, [
    authorizationAssertion(authorized),
    assertExists(
      `SELECT 1 FROM (${READING_SELECT}) current
       WHERE current.blobId=?4 AND current.pageCount=?5`,
      [nodeId, EPUB_INDEX_GENERATOR, principal.user_id, blobId, current.pageCount],
    ),
    {
      sql: "DELETE FROM user_reading_state WHERE user_id=? AND node_id=? AND blob_id<>?",
      values: [principal.user_id, nodeId, blobId],
    },
    {
      sql: `INSERT INTO user_reading_state(user_id,node_id,blob_id,position_json,updated_at)
        VALUES(?,?,?,?,?)
        ON CONFLICT(user_id,node_id,blob_id)
        DO UPDATE SET position_json=excluded.position_json,updated_at=excluded.updated_at`,
      values: [principal.user_id, nodeId, blobId, encoded, now],
    },
  ]);
  return {
    nodeId,
    blobId,
    pageCount: current.pageCount,
    position,
    updatedAt: now,
  };
}
