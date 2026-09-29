import { SEARCH_NAME_VERSION, searchName } from "../../../shared/src/names";
import { assertExists, assertOneChange, primary } from "../db/primary";
import { AUDIO_CODEC_MIME } from "../media/tracks/audioSql";
import { TRACK_METADATA_GENERATOR } from "../media/tracks/common";
import { AUDIO_SEARCH_CURRENT, AUDIO_SEARCH_SOURCE, audioSearchTags } from "../search/audio";
import {
  acquireSystemMutation,
  commitSystemMutation,
  type SystemMutationSource,
} from "../services/systemMutation";

const CLOCK = "strftime('%s','now')*1000";
const FROM = `FROM node_audio a JOIN nodes n ON n.id=a.node_id
  JOIN blobs b ON b.id=a.blob_id LEFT JOIN search_index si ON si.node_id=n.id
  JOIN control c ON c.singleton=1`;
const SOURCE = `n.kind='file' AND a.blob_id=n.current_blob_id AND b.owner_id=n.owner_id
  AND b.state IN ('committed','gc_candidate') AND a.generator_version='${TRACK_METADATA_GENERATOR}'
  AND ${AUDIO_CODEC_MIME}`;
const BOUNDED = ["title", "artist", "album"]
  .map(
    (field) => `length(CAST(COALESCE(a.${field}_override,a.${field}_extracted,'') AS BLOB))<=1024`,
  )
  .join(" AND ");
const NEEDS = `(NOT (${AUDIO_SEARCH_CURRENT}) OR si.node_id IS NULL OR si.normalization_version<>'${SEARCH_NAME_VERSION}')`;
const OPEN = "c.maintenance=0 AND c.backup_token IS NULL AND c.restore_freeze_token IS NULL";

interface Snapshot {
  nodeId: string;
  spaceId: string;
  ownerId: string;
  blobId: string;
  name: string;
  revision: number;
  tags: string | null;
  needs: number;
  indexRevision: number | null;
  indexSpace: string | null;
}
export type AudioReindexResult = "repaired" | "current" | "unavailable";

/** Derived D1 data only. No raw tags, original bytes, namespace revisions or user positions change. */
export async function reindexAudioNode(
  env: SystemMutationSource,
  epoch: number,
  nodeId: string,
  deadline = Date.now() + 5000,
): Promise<AudioReindexResult> {
  if (
    !Number.isSafeInteger(epoch) ||
    epoch < 1 ||
    !/^[A-Za-z0-9_-]{1,128}$/.test(nodeId) ||
    !Number.isSafeInteger(deadline) ||
    deadline <= Date.now() ||
    deadline > Date.now() + 5000
  )
    throw new Error("invalid_audio_reindex");
  // A CASE keeps oversized stored tags out of the Worker, even if an old/imported row is invalid.
  const row = await primary(env.DB)
    .prepare(`SELECT n.id AS nodeId,n.space_id AS spaceId,n.owner_id AS ownerId,
    a.blob_id AS blobId,n.name,n.revision,si.revision AS indexRevision,si.space_id AS indexSpace,
    CASE WHEN ${SOURCE} AND ${BOUNDED} THEN ${AUDIO_SEARCH_SOURCE} ELSE NULL END AS tags,
    ${NEEDS} AS needs ${FROM} WHERE a.node_id=? AND c.epoch=? AND ${OPEN}`)
    .bind(nodeId, epoch)
    .first<Snapshot>();
  if (!row || row.tags === null) return "unavailable";
  if (
    row.indexRevision !== null &&
    (row.indexRevision > row.revision || row.indexSpace !== row.spaceId)
  )
    throw new Error("audio_reindex_index_conflict");
  if (!row.needs) return "current";
  const [title, artist, album] = JSON.parse(row.tags) as [
    string | null,
    string | null,
    string | null,
  ];
  const tags = audioSearchTags({ title, artist, album }),
    name = searchName(row.name);
  const admission = await acquireSystemMutation(env, row.ownerId, "audio.reindex", deadline);
  if (admission.epoch !== epoch || admission.maintenance !== 0 || Date.now() >= deadline)
    throw new Error("audio_reindex_unavailable");
  await commitSystemMutation(env.DB, admission, row.ownerId, [
    assertExists(
      `SELECT 1 ${FROM} WHERE a.node_id=?1 AND c.epoch=?2 AND ${OPEN}
      AND ${SOURCE} AND ${BOUNDED} AND ${NEEDS} AND ${CLOCK}<?3
      AND n.space_id=?4 AND n.owner_id=?5 AND n.name=?6 AND n.revision=?7 AND a.blob_id=?8
      AND ${AUDIO_SEARCH_SOURCE}=?9 AND (si.node_id IS NULL OR (si.space_id=n.space_id AND si.revision<=n.revision))`,
      [
        nodeId,
        epoch,
        deadline,
        row.spaceId,
        row.ownerId,
        row.name,
        row.revision,
        row.blobId,
        row.tags,
      ],
    ),
    {
      sql: "INSERT INTO search_fts(search_fts,rowid,text_norm,tokens) SELECT 'delete',rowid,text_norm,tokens FROM search_index WHERE node_id=?",
      values: [nodeId],
    },
    {
      sql: "UPDATE node_audio SET search_text_norm=?,search_tokens=?,search_source=?,search_version=? WHERE node_id=?",
      values: [tags.textNorm, tags.tokens, tags.source, tags.version, nodeId],
    },
    assertOneChange,
    {
      sql: `INSERT INTO search_index(node_id,space_id,text_norm,tokens,normalization_version,revision) VALUES(?,?,?,?,?,?)
      ON CONFLICT(node_id) DO UPDATE SET text_norm=excluded.text_norm,tokens=excluded.tokens,
        normalization_version=excluded.normalization_version,revision=excluded.revision
      WHERE search_index.space_id=excluded.space_id AND search_index.revision<=excluded.revision`,
      values: [
        nodeId,
        row.spaceId,
        name.textNorm + (tags.textNorm ? "\n" + tags.textNorm : ""),
        name.tokens + (tags.tokens ? " " + tags.tokens : ""),
        name.version,
        row.revision,
      ],
    },
    assertOneChange,
    {
      sql: "INSERT INTO search_fts(rowid,text_norm,tokens) SELECT rowid,text_norm,tokens FROM search_index WHERE node_id=?",
      values: [nodeId],
    },
    assertOneChange,
    {
      sql: "UPDATE spaces SET tree_generation=tree_generation+1 WHERE id=? AND owner_id=?",
      values: [row.spaceId, row.ownerId],
    },
    assertOneChange,
  ]);
  return "repaired";
}
