import type { AudioPage, AudioTrack } from "../../../shared/src/audio";
import type { AudioCursorTokens } from "../auth/audioCursor";
import { authorizationAssertion, authorizeNode, type Principal } from "../auth/authorize";
import { assertExists, atomicBatch, primary } from "../db/primary";
import { AUDIO_GENERATOR_VERSION } from "../media/audio";

export const AUDIO_TRACK_LIMIT = 2_000;
export const AUDIO_CANDIDATE_LIMIT = 10_000;

function audioStatement(recursive: boolean, limit: number) {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 201)
    throw new Error("invalid_audio_limit");
  return `WITH RECURSIVE walk(id,parent_id,name_ci,kind,depth,entering,visited) AS MATERIALIZED (
    SELECT id,parent_id,name_ci,kind,0,1,1 FROM nodes
      WHERE id=?1 AND space_id=?2 AND owner_id=?3 AND deleted_at IS NULL AND hidden=0
    UNION ALL
    SELECT n.id,n.parent_id,n.name_ci,CASE WHEN n.hidden=0 THEN n.kind ELSE 'file' END,
      w.depth+CASE WHEN n.parent_id=w.id THEN 1 WHEN n.id=w.parent_id THEN -1 ELSE 0 END,
      n.id IS NOT w.parent_id,w.visited+(n.id IS NOT w.parent_id)
    FROM walk w JOIN nodes n ON n.id=COALESCE(
      CASE WHEN w.entering=1 AND w.kind IN ('root','folder') AND w.depth<64 ${recursive ? "" : "AND w.id=?1"} THEN
        (SELECT c.id FROM nodes c INDEXED BY nodes_children_keyset WHERE c.parent_id=w.id
          AND c.deleted_at IS NULL AND c.space_id=?2 AND c.owner_id=?3
          ORDER BY c.name_ci,c.id LIMIT 1) END,
      CASE WHEN w.id<>?1 THEN
        (SELECT c.id FROM nodes c INDEXED BY nodes_children_keyset WHERE c.parent_id=w.parent_id
          AND c.deleted_at IS NULL AND c.space_id=?2 AND c.owner_id=?3
          AND (c.name_ci,c.id)>(w.name_ci,w.id) ORDER BY c.name_ci,c.id LIMIT 1) END,
      CASE WHEN w.id<>?1 THEN w.parent_id END)
      WHERE w.visited<${AUDIO_CANDIDATE_LIMIT} AND n.space_id=?2 AND n.owner_id=?3
        AND n.deleted_at IS NULL
      LIMIT ${AUDIO_CANDIDATE_LIMIT * 2}
  ), scope AS MATERIALIZED (
    SELECT id FROM walk WHERE entering=1 LIMIT ${AUDIO_CANDIDATE_LIMIT}
  )
  SELECT n.id,n.name,n.name_ci AS nameCi,n.current_blob_id AS currentBlobId,
    b.mime_sniffed AS mime,a.duration_ms AS durationMs,a.codec,
    COALESCE(a.title_override,a.title_extracted,n.name) AS title,
    COALESCE(a.artist_override,a.artist_extracted) AS artist,
    COALESCE(a.album_override,a.album_extracted) AS album,
    a.track_number AS trackNumber,a.disc_number AS discNumber
  FROM scope s JOIN nodes n ON n.id=s.id
  JOIN node_audio a ON a.node_id=n.id AND a.blob_id=n.current_blob_id
    AND a.generator_version=?4
  JOIN blobs b ON b.id=n.current_blob_id AND b.owner_id=n.owner_id
    AND b.state IN ('committed','gc_candidate')
  JOIN blob_storage bs ON bs.blob_id=b.id AND bs.removed_at IS NULL
    AND bs.bytes=b.size AND bs.r2_etag IS NOT NULL
  WHERE n.hidden=0 AND n.deleted_at IS NULL AND n.kind='file'
    AND b.mime_sniffed LIKE 'audio/%'
    AND (?5 IS NULL OR (n.name_ci,n.id)>(?5,?6))
  ORDER BY n.name_ci,n.id LIMIT ${limit}`;
}

export async function listAudio(
  db: D1Database,
  principal: Principal,
  rootId: string,
  recursive: boolean,
  tokens: AudioCursorTokens,
  cursor?: string,
): Promise<AudioPage> {
  if (principal.kind !== "user" || !/^[A-Za-z0-9_-]{1,128}$/.test(rootId))
    throw new Error("audio_unavailable");
  const spaceId = await primary(db)
    .prepare("SELECT space_id FROM nodes WHERE id=?")
    .bind(rootId)
    .first<string>("space_id");
  if (!spaceId) throw new Error("audio_unavailable");
  const authorized = await authorizeNode(db, principal, {
    operation: "audio.read",
    nodeId: rootId,
    spaceId,
  });
  if (
    authorized.operation !== "audio.read" ||
    (authorized.node.kind !== "root" && authorized.node.kind !== "folder")
  )
    throw new Error("audio_unavailable");
  let lastNameCi: string | null = null;
  let lastId: string | null = null;
  let emitted = 0;
  if (cursor !== undefined) {
    const claim = await tokens.verify(cursor);
    if (
      claim.rootId !== rootId ||
      claim.spaceId !== spaceId ||
      claim.ownerId !== authorized.node.owner_id ||
      claim.userId !== principal.user_id ||
      claim.credentialId !== principal.credential_id ||
      claim.epoch !== principal.epoch ||
      claim.generation !== authorized.node.tree_generation ||
      claim.recursive !== recursive
    )
      throw new Error("invalid_audio_cursor");
    lastNameCi = claim.lastNameCi;
    lastId = claim.lastId;
    emitted = claim.emitted;
  }
  const pageSize = Math.min(200, AUDIO_TRACK_LIMIT - emitted);
  const results = await atomicBatch(db, [
    authorizationAssertion(authorized),
    assertExists("SELECT 1 FROM control WHERE singleton=1 AND epoch=? AND maintenance=0", [
      principal.epoch,
    ]),
    {
      sql: audioStatement(recursive, pageSize + 1),
      values: [
        rootId,
        spaceId,
        authorized.node.owner_id,
        AUDIO_GENERATOR_VERSION,
        lastNameCi,
        lastId,
      ],
    },
  ]);
  type AudioRow = AudioTrack & { nameCi: string };
  const rows = results.at(-1)?.results as AudioRow[] | undefined;
  if (!rows) throw new Error("audio_unavailable");
  const page = rows.slice(0, pageSize);
  const last = page.at(-1);
  const more = rows.length > pageSize;
  return {
    rootId,
    treeGeneration: authorized.node.tree_generation,
    recursive,
    items: page.map(({ nameCi: _nameCi, ...track }) => track),
    nextCursor:
      more && last && emitted + page.length < AUDIO_TRACK_LIMIT
        ? await tokens.issue({
            rootId,
            spaceId,
            ownerId: authorized.node.owner_id,
            userId: principal.user_id,
            credentialId: principal.credential_id,
            epoch: principal.epoch,
            generation: authorized.node.tree_generation,
            recursive,
            lastNameCi: last.nameCi,
            lastId: last.id,
            emitted: emitted + page.length,
          })
        : null,
    limitReached: more && emitted + page.length >= AUDIO_TRACK_LIMIT,
    trackLimit: AUDIO_TRACK_LIMIT,
  };
}
