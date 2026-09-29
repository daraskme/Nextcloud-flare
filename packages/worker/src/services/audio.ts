import type {
  AudioPage,
  AudioTrack,
  PlaybackState,
  PlaybackUpdate,
} from "../../../shared/src/audio";
import type { AudioCursorTokens } from "../auth/audioCursor";
import { authorizationAssertion, authorizeNode, type Principal } from "../auth/authorize";
import { assertExists, assertOneChange, atomicBatch, primary } from "../db/primary";
import type { Env } from "../env";
import { AUDIO_CODEC_MIME } from "../media/tracks/audioSql";
import { TRACK_METADATA_GENERATOR } from "../media/tracks/common";
import { acquireAccountMutation, commitAccountMutation } from "./accountMutation";

export const AUDIO_TRACK_LIMIT = 2000;
export const AUDIO_CANDIDATE_LIMIT = 1000;
const ID = /^[A-Za-z0-9_-]{1,128}$/;
export const AUDIO_MATCH = `a.blob_id=n.current_blob_id AND a.generator_version=?4
  AND b.id=a.blob_id AND b.owner_id=n.owner_id AND b.state IN ('committed','gc_candidate')
  AND ${AUDIO_CODEC_MIME}`;

async function authority(db: D1Database, principal: Principal, nodeId: string, write = false) {
  if (
    !ID.test(nodeId) ||
    (write ? principal.kind !== "user" : !["user", "link_share"].includes(principal.kind))
  )
    throw new Error("authorization_denied");
  const spaceId = await primary(db)
    .prepare("SELECT space_id FROM nodes WHERE id=?")
    .bind(nodeId)
    .first<string>("space_id");
  if (!spaceId) throw new Error("authorization_denied");
  const proof = await authorizeNode(db, principal, {
    operation: write ? "playback_state.write" : "audio.read",
    nodeId,
    spaceId,
  });
  if (proof.operation !== "audio.read" && proof.operation !== "playback_state.write")
    throw new Error("authorization_denied");
  if (
    principal.kind === "user" &&
    proof.node.owner_id !== principal.user_id &&
    !principal.selected_share
  )
    throw new Error("authorization_denied");
  return proof;
}

export const AUDIO_METADATA = `json_object('revision',n.revision,
  'extracted',json_object('title',a.title_extracted,'artist',a.artist_extracted,'album',a.album_extracted),
  'overrides',json_object('title',a.title_override,'artist',a.artist_override,'album',a.album_override))`;

export function audioStatement(file: boolean, limit: number, after = false) {
  if (!Number.isInteger(limit) || limit < 1 || limit > 201) throw new Error("invalid_audio_limit");
  const projection = `SELECT n.id,n.name,n.name_ci AS nameCi,n.current_blob_id AS currentBlobId,
    b.mime_sniffed AS mime,a.duration_ms AS durationMs,
    COALESCE(a.title_override,a.title_extracted,n.name) AS title,
    COALESCE(a.artist_override,a.artist_extracted) AS artist,
    COALESCE(a.album_override,a.album_extracted) AS album,a.track_number AS trackNumber,a.disc_number AS discNumber,
    p.position_ms AS positionMs,p.updated_at AS stateUpdatedAt${file ? `,${AUDIO_METADATA} AS metadataJson` : ""}`;
  if (file)
    return `${projection} FROM nodes n
    JOIN node_audio a ON a.node_id=n.id JOIN blobs b ON ${AUDIO_MATCH}
    LEFT JOIN user_playback_state p ON p.user_id=?5 AND p.node_id=n.id AND p.blob_id=n.current_blob_id
    WHERE n.id=?1 AND n.space_id=?2 AND n.owner_id=?3
      AND n.deleted_at IS NULL AND n.hidden=0 AND n.kind='file'
      AND ?6 IS NULL AND ?7 IS NULL
    ORDER BY n.name_ci,n.id LIMIT ${limit}`;
  // Bound before joining/filtering audio metadata. Include one probe for continuation.
  // Separate first/next SQL keeps a late cursor an index seek rather than an OR scan.
  return `WITH candidates AS MATERIALIZED (
    SELECT id,name,name_ci,current_blob_id,owner_id,kind
    FROM nodes INDEXED BY nodes_audio_candidates
    WHERE parent_id=?1 AND space_id=?2 AND owner_id=?3 AND deleted_at IS NULL AND hidden=0
      AND ${after ? "(name_ci,id)>(?6,?7)" : "?6 IS NULL AND ?7 IS NULL"}
    ORDER BY name_ci,id LIMIT ${AUDIO_CANDIDATE_LIMIT + 1}
  ), scanned AS MATERIALIZED (
    SELECT * FROM candidates ORDER BY name_ci,id LIMIT ${AUDIO_CANDIDATE_LIMIT}
  ), page AS MATERIALIZED (
    ${projection} FROM scanned n
    CROSS JOIN node_audio a ON a.node_id=n.id CROSS JOIN blobs b ON ${AUDIO_MATCH}
    LEFT JOIN user_playback_state p ON p.user_id=?5 AND p.node_id=n.id AND p.blob_id=n.current_blob_id
    WHERE n.kind='file' ORDER BY n.name_ci,n.id LIMIT ${limit}
  ) SELECT (SELECT COUNT(*) FROM scanned) AS scanned,
    (SELECT COUNT(*) FROM candidates)>${AUDIO_CANDIDATE_LIMIT} AS moreCandidates,
    (SELECT name_ci FROM scanned ORDER BY name_ci DESC,id DESC LIMIT 1) AS lastNameCi,
    (SELECT id FROM scanned ORDER BY name_ci DESC,id DESC LIMIT 1) AS lastId,
    (SELECT json_group_array(json_object('id',p.id,'name',p.name,'nameCi',p.nameCi,
      'currentBlobId',p.currentBlobId,'mime',p.mime,'durationMs',p.durationMs,'title',p.title,
      'artist',p.artist,'album',p.album,'trackNumber',p.trackNumber,'discNumber',p.discNumber,
      'positionMs',p.positionMs,'stateUpdatedAt',p.stateUpdatedAt))
      FROM (SELECT * FROM page ORDER BY nameCi,id) p) AS items`;
}

export interface AudioScan {
  scanned: number;
  moreCandidates: number;
  lastNameCi: string | null;
  lastId: string | null;
  items: string;
}

export async function listAudio(
  db: D1Database,
  principal: Principal,
  rootId: string,
  tokens: AudioCursorTokens,
  cursor?: string,
): Promise<AudioPage> {
  const proof = await authority(db, principal, rootId),
    root = proof.node;
  const selection =
    principal.kind === "link_share"
      ? { id: principal.share_id, version: principal.share_version }
      : principal.kind === "user"
        ? principal.selected_share
        : undefined;
  const userId = principal.kind === "user" ? principal.user_id : null;
  let lastName: string | null = null,
    lastId: string | null = null,
    emitted = 0;
  if (cursor !== undefined) {
    const c = await tokens.verify(cursor);
    if (
      root.kind === "file" ||
      c.parentId !== rootId ||
      c.spaceId !== root.space_id ||
      c.ownerId !== root.owner_id ||
      c.userId !== userId ||
      c.credentialId !== principal.credential_id ||
      c.epoch !== principal.epoch ||
      c.generation !== root.tree_generation ||
      c.generator !== TRACK_METADATA_GENERATOR ||
      c.shareId !== selection?.id ||
      c.shareVersion !== selection?.version
    )
      throw new Error("invalid_audio_cursor");
    lastName = c.lastNameCi;
    lastId = c.lastId;
    emitted = c.emitted;
  }
  let editProof: Awaited<ReturnType<typeof authorizeNode>> | undefined;
  if (principal.kind === "user") {
    try {
      editProof = await authorizeNode(db, principal, {
        operation: "node.props.write",
        nodeId: rootId,
        spaceId: root.space_id,
      });
    } catch {
      /* A read grant remains usable without editing metadata. */
    }
  }
  const count = Math.min(200, AUDIO_TRACK_LIMIT - emitted);
  const results = await atomicBatch(db, [
    authorizationAssertion(proof),
    ...(editProof ? [authorizationAssertion(editProof)] : []),
    {
      sql: audioStatement(root.kind === "file", count + 1, lastName !== null),
      values: [
        rootId,
        root.space_id,
        root.owner_id,
        TRACK_METADATA_GENERATOR,
        userId,
        lastName,
        lastId,
      ],
    },
  ]);
  type Row = Omit<AudioTrack, "playback"> & {
    nameCi: string;
    metadataJson?: string;
    positionMs: number | null;
    stateUpdatedAt: number | null;
  };
  const records = results.at(-1)!.results;
  const scan = root.kind === "file" ? null : (records[0] as unknown as AudioScan);
  const rows = scan ? (JSON.parse(scan.items) as Row[]) : (records as unknown as Row[]);
  const page = rows.slice(0, count),
    moreTracks = rows.length > count,
    last = moreTracks
      ? page.at(-1)
      : scan?.lastId
        ? { id: scan.lastId, nameCi: scan.lastNameCi! }
        : undefined,
    more = moreTracks || !!scan?.moreCandidates;
  const nextCursor =
    more && last && emitted + page.length < AUDIO_TRACK_LIMIT
      ? await tokens.issue({
          parentId: rootId,
          spaceId: root.space_id,
          ownerId: root.owner_id,
          userId,
          credentialId: principal.credential_id,
          epoch: principal.epoch,
          generation: root.tree_generation,
          generator: TRACK_METADATA_GENERATOR,
          lastNameCi: last.nameCi,
          lastId: last.id,
          emitted: emitted + page.length,
          ...(selection ? { shareId: selection.id, shareVersion: selection.version } : {}),
        })
      : null;
  return {
    rootId,
    treeGeneration: root.tree_generation,
    generator: TRACK_METADATA_GENERATOR,
    items: page.map(({ nameCi: _name, metadataJson, positionMs, stateUpdatedAt, ...item }) => ({
      ...item,
      ...(editProof && metadataJson ? { metadata: JSON.parse(metadataJson) } : {}),
      playback:
        positionMs !== null && stateUpdatedAt !== null
          ? { positionMs, updatedAt: stateUpdatedAt }
          : null,
    })),
    nextCursor,
    limitReached: more && nextCursor === null,
    trackLimit: AUDIO_TRACK_LIMIT,
    canEdit: !!editProof,
  };
}

export class PlaybackConflict extends Error {
  constructor() {
    super("playback_conflict");
  }
}
function validateUpdate(input: PlaybackUpdate) {
  if (
    !input ||
    !ID.test(input.blobId) ||
    input.generator !== TRACK_METADATA_GENERATOR ||
    !Number.isSafeInteger(input.positionMs) ||
    input.positionMs < 0 ||
    (input.previousUpdatedAt !== null &&
      (!Number.isSafeInteger(input.previousUpdatedAt) ||
        input.previousUpdatedAt < 0 ||
        input.previousUpdatedAt >= Number.MAX_SAFE_INTEGER))
  )
    throw new Error("invalid_playback_update");
}
async function currentPlayback(
  db: D1Database,
  principal: Principal,
  nodeId: string,
  input: PlaybackUpdate,
) {
  const proof = await authority(db, principal, nodeId, true);
  if (principal.kind !== "user" || proof.node.current_blob_id !== input.blobId)
    throw new Error("authorization_denied");
  const result = await atomicBatch(db, [
    authorizationAssertion(proof),
    {
      sql: audioStatement(true, 1),
      values: [
        nodeId,
        proof.node.space_id,
        proof.node.owner_id,
        TRACK_METADATA_GENERATOR,
        principal.user_id,
        null,
        null,
      ],
    },
  ]);
  const row = result.at(-1)?.results[0] as
    | { durationMs: number | null; stateUpdatedAt: number | null }
    | undefined;
  if (!row) throw new Error("authorization_denied");
  if (row.durationMs !== null && input.positionMs > row.durationMs)
    throw new Error("invalid_playback_update");
  if (row.stateUpdatedAt !== input.previousUpdatedAt) throw new PlaybackConflict();
  return { proof, duration: row.durationMs };
}

/** A read share may save its user's position, without changing the owner's content or metadata. */
export async function savePlayback(
  env: Pick<Env, "DB" | "CONTROL">,
  principal: Principal,
  nodeId: string,
  input: PlaybackUpdate,
): Promise<PlaybackState> {
  validateUpdate(input);
  const { proof, duration } = await currentPlayback(env.DB, principal, nodeId, input);
  if (principal.kind !== "user") throw new Error("authorization_denied");
  const admission = await acquireAccountMutation(
    env,
    proof.node.owner_id,
    principal.epoch,
    "playback.write",
  );
  const updatedAt = Math.max(Date.now(), (input.previousUpdatedAt ?? -1) + 1);
  try {
    await commitAccountMutation(env.DB, admission, proof.node.owner_id, [
      authorizationAssertion(proof),
      assertExists(
        `SELECT 1 FROM nodes n JOIN node_audio a ON a.node_id=n.id JOIN blobs b ON ${AUDIO_MATCH}
        WHERE n.id=?1 AND n.space_id=?2 AND n.owner_id=?3 AND n.current_blob_id=?5 AND a.duration_ms IS ?6`,
        [
          nodeId,
          proof.node.space_id,
          proof.node.owner_id,
          TRACK_METADATA_GENERATOR,
          input.blobId,
          duration,
        ],
      ),
      {
        sql: "DELETE FROM user_playback_state WHERE user_id=? AND node_id=? AND blob_id<>?",
        values: [principal.user_id, nodeId, input.blobId],
      },
      assertExists(
        "SELECT 1 WHERE COALESCE((SELECT updated_at FROM user_playback_state WHERE user_id=? AND node_id=? AND blob_id=?),-1)=?",
        [principal.user_id, nodeId, input.blobId, input.previousUpdatedAt ?? -1],
      ),
      {
        sql: `INSERT INTO user_playback_state(user_id,node_id,blob_id,position_ms,updated_at) VALUES(?,?,?,?,?)
        ON CONFLICT(user_id,node_id,blob_id) DO UPDATE SET position_ms=excluded.position_ms,updated_at=excluded.updated_at`,
        values: [principal.user_id, nodeId, input.blobId, input.positionMs, updatedAt],
      },
      assertOneChange,
    ]);
  } catch (error) {
    // Recheck live authority before distinguishing a competing save from an unavailable file.
    await currentPlayback(env.DB, principal, nodeId, input);
    throw error;
  }
  return { positionMs: input.positionMs, updatedAt };
}
