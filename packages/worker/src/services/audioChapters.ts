import { type AuthorizedNode, authorizationAssertion, authorizeNode } from "../auth/authorize";
import { assertExists, atomicBatch, primary } from "../db/primary";
import { AUDIO_GENERATOR_VERSION } from "../media/audio";

const ID = /^[A-Za-z0-9_-]{1,128}$/;
const MAX_CHAPTERS = 200;
const MAX_TITLE_BYTES = 256;
const MAX_DURATION_MS = 7 * 24 * 60 * 60 * 1_000;

interface UserPrincipal {
  readonly kind: "user";
  readonly user_id: string;
  readonly credential_id: string;
  readonly epoch: number;
}

export interface AudioChapter {
  readonly id: string;
  readonly positionMs: number;
  readonly title: string;
}

export interface AudioChapterSet {
  readonly nodeId: string;
  readonly blobId: string;
  readonly durationMs: number;
  readonly revision: number;
  readonly chapters: readonly AudioChapter[];
}

interface ChapterRow {
  readonly blobId: string;
  readonly durationMs: number;
  readonly setDurationMs: number | null;
  readonly revision: number | null;
  readonly chapterId: string | null;
  readonly positionMs: number | null;
  readonly title: string | null;
  readonly sortOrder: number | null;
}

type AudioAuthorization = Exclude<AuthorizedNode, { readonly operation: "node.create" }>;
type AudioOperation = "library.read" | "audio_chapters.write";

const AUDIO_CHAPTERS_SELECT = `SELECT n.current_blob_id AS blobId,a.duration_ms AS durationMs,
  s.duration_ms AS setDurationMs,s.revision,
  c.chapter_id AS chapterId,c.position_ms AS positionMs,c.title,c.sort_order AS sortOrder
FROM nodes n
JOIN blobs b ON b.id=n.current_blob_id AND b.owner_id=n.owner_id
JOIN blob_storage bs ON bs.blob_id=b.id AND bs.removed_at IS NULL
JOIN node_audio a ON a.node_id=n.id AND a.blob_id=b.id
  AND a.generator_version=?2 AND a.duration_ms IS NOT NULL
LEFT JOIN user_audio_chapter_sets s
  ON s.user_id=?3 AND s.node_id=n.id AND s.blob_id=b.id
LEFT JOIN user_audio_chapters c ON c.set_id=s.id
WHERE n.id=?1 AND n.deleted_at IS NULL AND n.kind='file'
  AND b.state IN ('committed','gc_candidate')
  AND b.r2_key='u/'||n.owner_id||'/b/'||b.id
  AND bs.bytes=b.size AND bs.r2_etag IS NOT NULL
  AND NOT EXISTS(SELECT 1 FROM blob_encryption e WHERE e.blob_id=b.id)
ORDER BY c.sort_order`;

function validUnicode(value: string): boolean {
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if (code >= 0xd800 && code <= 0xdbff) {
      if (i + 1 >= value.length) return false;
      const next = value.charCodeAt(++i);
      if (next < 0xdc00 || next > 0xdfff) return false;
    } else if (code >= 0xdc00 && code <= 0xdfff) return false;
  }
  return true;
}

export function validateAudioChapters(chapters: readonly AudioChapter[], durationMs: number): void {
  if (
    !Array.isArray(chapters) ||
    chapters.length > MAX_CHAPTERS ||
    !Number.isSafeInteger(durationMs) ||
    durationMs < 0 ||
    durationMs > MAX_DURATION_MS
  )
    throw new Error("invalid_audio_chapters");
  const ids = new Set<string>();
  for (const chapter of chapters) {
    if (
      !chapter ||
      Object.keys(chapter).sort().join(",") !== "id,positionMs,title" ||
      !ID.test(chapter.id) ||
      ids.has(chapter.id) ||
      !Number.isSafeInteger(chapter.positionMs) ||
      chapter.positionMs < 0 ||
      chapter.positionMs > durationMs ||
      typeof chapter.title !== "string" ||
      !validUnicode(chapter.title)
    )
      throw new Error("invalid_audio_chapters");
    const titleBytes = new TextEncoder().encode(chapter.title).byteLength;
    if (titleBytes < 1 || titleBytes > MAX_TITLE_BYTES) throw new Error("invalid_audio_chapters");
    ids.add(chapter.id);
  }
}

async function authorizeAudio(
  db: D1Database,
  principal: UserPrincipal,
  nodeId: string,
  operation: AudioOperation,
): Promise<AudioAuthorization> {
  if (!ID.test(nodeId)) throw new Error("audio_chapters_unavailable");
  const located = await primary(db)
    .prepare("SELECT space_id AS spaceId FROM nodes WHERE id=?")
    .bind(nodeId)
    .first<{ spaceId: string }>();
  if (!located) throw new Error("audio_chapters_unavailable");
  const authorized = await authorizeNode(db, principal, {
    operation,
    nodeId,
    spaceId: located.spaceId,
  });
  if (authorized.operation === "node.create") throw new Error("audio_chapters_unavailable");
  if (authorized.node.kind !== "file" || !authorized.node.current_blob_id)
    throw new Error("audio_chapters_unavailable");
  return authorized;
}

async function loadAudioChapters(
  db: D1Database,
  principal: UserPrincipal,
  nodeId: string,
  operation: AudioOperation,
): Promise<{ authorized: AudioAuthorization; value: AudioChapterSet }> {
  const authorized = await authorizeAudio(db, principal, nodeId, operation);
  const result = await atomicBatch(db, [
    authorizationAssertion(authorized),
    {
      sql: AUDIO_CHAPTERS_SELECT,
      values: [nodeId, AUDIO_GENERATOR_VERSION, principal.user_id],
    },
  ]);
  const rows = result[1]?.results as unknown as ChapterRow[] | undefined;
  const first = rows?.[0];
  if (
    !first ||
    first.blobId !== authorized.node.current_blob_id ||
    !Number.isSafeInteger(first.durationMs) ||
    first.durationMs < 0 ||
    first.durationMs > MAX_DURATION_MS ||
    (first.setDurationMs !== null && first.setDurationMs !== first.durationMs)
  )
    throw new Error("audio_chapters_unavailable");
  const chapters = (rows ?? [])
    .filter(
      (row) =>
        row.chapterId !== null &&
        row.positionMs !== null &&
        row.title !== null &&
        row.sortOrder !== null,
    )
    .map((row) => ({
      id: row.chapterId!,
      positionMs: row.positionMs!,
      title: row.title!,
    }));
  validateAudioChapters(chapters, first.durationMs);
  return {
    authorized,
    value: {
      nodeId,
      blobId: first.blobId,
      durationMs: first.durationMs,
      revision: first.revision ?? 0,
      chapters,
    },
  };
}

export async function readAudioChapters(
  db: D1Database,
  principal: UserPrincipal,
  nodeId: string,
): Promise<AudioChapterSet> {
  return (await loadAudioChapters(db, principal, nodeId, "library.read")).value;
}

export async function writeAudioChapters(
  db: D1Database,
  principal: UserPrincipal,
  nodeId: string,
  blobId: string,
  expectedRevision: number,
  chapters: readonly AudioChapter[],
  now = Date.now(),
): Promise<AudioChapterSet> {
  if (
    !ID.test(blobId) ||
    !Number.isSafeInteger(expectedRevision) ||
    expectedRevision < 0 ||
    expectedRevision >= Number.MAX_SAFE_INTEGER ||
    !Number.isSafeInteger(now) ||
    now < 0
  )
    throw new Error("invalid_audio_chapters");
  const current = await loadAudioChapters(db, principal, nodeId, "audio_chapters.write");
  if (current.value.blobId !== blobId) throw new Error("audio_chapters_unavailable");
  validateAudioChapters(chapters, current.value.durationMs);
  if (current.value.revision !== expectedRevision) throw new Error("audio_chapters_conflict");
  const nextRevision = expectedRevision + 1;
  const setId = crypto.randomUUID();
  const encoded = JSON.stringify(chapters);
  try {
    await atomicBatch(db, [
      authorizationAssertion(current.authorized),
      assertExists(
        `SELECT 1 FROM (${AUDIO_CHAPTERS_SELECT}) projection
         WHERE projection.blobId=?4 AND projection.durationMs=?5`,
        [nodeId, AUDIO_GENERATOR_VERSION, principal.user_id, blobId, current.value.durationMs],
      ),
      assertExists(
        `SELECT 1 WHERE
          (?4=0 AND NOT EXISTS(
            SELECT 1 FROM user_audio_chapter_sets
            WHERE user_id=?1 AND node_id=?2 AND blob_id=?3
          ))
          OR EXISTS(
            SELECT 1 FROM user_audio_chapter_sets
            WHERE user_id=?1 AND node_id=?2 AND blob_id=?3
              AND revision=?4 AND duration_ms=?5
          )`,
        [principal.user_id, nodeId, blobId, expectedRevision, current.value.durationMs],
      ),
      {
        sql: `DELETE FROM user_audio_chapter_sets
          WHERE user_id=? AND node_id=? AND blob_id<>?`,
        values: [principal.user_id, nodeId, blobId],
      },
      {
        sql: `INSERT INTO user_audio_chapter_sets(
            id,user_id,node_id,blob_id,revision,duration_ms,updated_at
          ) VALUES(?,?,?,?,?,?,?)
          ON CONFLICT(user_id,node_id,blob_id) DO UPDATE SET
            revision=excluded.revision,duration_ms=excluded.duration_ms,
            updated_at=excluded.updated_at`,
        values: [
          setId,
          principal.user_id,
          nodeId,
          blobId,
          nextRevision,
          current.value.durationMs,
          now,
        ],
      },
      {
        sql: `DELETE FROM user_audio_chapters WHERE set_id=(
          SELECT id FROM user_audio_chapter_sets
          WHERE user_id=? AND node_id=? AND blob_id=?
        )`,
        values: [principal.user_id, nodeId, blobId],
      },
      {
        sql: `INSERT INTO user_audio_chapters(
            set_id,chapter_id,position_ms,title,sort_order
          )
          SELECT s.id,
            json_extract(ch.value,'$.id'),
            json_extract(ch.value,'$.positionMs'),
            json_extract(ch.value,'$.title'),
            CAST(ch.key AS INTEGER)
          FROM user_audio_chapter_sets s,json_each(?4) ch
          WHERE s.user_id=?1 AND s.node_id=?2 AND s.blob_id=?3`,
        values: [principal.user_id, nodeId, blobId, encoded],
      },
    ]);
  } catch {
    try {
      const refreshed = await loadAudioChapters(db, principal, nodeId, "audio_chapters.write");
      if (refreshed.value.blobId !== blobId) throw new Error("audio_chapters_unavailable");
      if (refreshed.value.revision !== expectedRevision) throw new Error("audio_chapters_conflict");
    } catch (error) {
      if (
        error instanceof Error &&
        ["audio_chapters_unavailable", "audio_chapters_conflict"].includes(error.message)
      )
        throw error;
    }
    throw new Error("audio_chapters_not_ready");
  }
  return {
    ...current.value,
    revision: nextRevision,
    chapters: chapters.map((chapter) => ({ ...chapter })),
  };
}
