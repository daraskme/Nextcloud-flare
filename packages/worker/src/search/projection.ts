import { searchName } from "../../../shared/src/names";
import type { SqlStatement } from "../db/primary";
import { AUDIO_CODEC_MIME } from "../media/tracks/audioSql";
import { TRACK_METADATA_GENERATOR } from "../media/tracks/common";
import type { MutationStep } from "../services/fsMutation";
import { AUDIO_SEARCH_CURRENT } from "./audio";

export const AUDIO_SEARCH_MATCH = `a.blob_id=n.current_blob_id
  AND a.generator_version='${TRACK_METADATA_GENERATOR}' AND b.id=a.blob_id AND b.owner_id=n.owner_id
  AND b.state IN ('committed','gc_candidate') AND ${AUDIO_CODEC_MIME} AND ${AUDIO_SEARCH_CURRENT}`;

/** Fixed application SQL only. A cache for a previous blob never contributes to a new original. */
export function audioSearchSuffix(
  field: "text_norm" | "tokens",
  node: "si.node_id" | "cm.copied_node_id",
) {
  const separator = field === "text_norm" ? "char(10)" : "' '";
  return `COALESCE((SELECT ${separator}||a.search_${field}
    FROM nodes n JOIN node_audio a ON a.node_id=n.id
    JOIN blobs b ON b.id=a.blob_id AND b.owner_id=n.owner_id
    WHERE n.id=${node} AND n.kind='file' AND a.blob_id=n.current_blob_id
      AND ${AUDIO_SEARCH_MATCH} AND a.search_${field}<>''),'')`;
}

/** Caller holds namespace proofs and updates FTS around this row. Null means a just-incremented restore revision. */
export function updateNodeSearch(
  nodeId: string,
  spaceId: string,
  name: string,
  previousRevision: number | null = null,
): SqlStatement {
  const q = searchName(name);
  return {
    sql: `UPDATE search_index AS si SET text_norm=?1||${audioSearchSuffix("text_norm", "si.node_id")},
      tokens=?2||${audioSearchSuffix("tokens", "si.node_id")},normalization_version=?3,
      revision=(SELECT revision FROM nodes WHERE id=si.node_id)
      WHERE si.node_id=?4 AND si.space_id=?5
        AND si.revision<=COALESCE(?6,(SELECT revision-1 FROM nodes WHERE id=si.node_id))
        AND EXISTS(SELECT 1 FROM nodes WHERE id=si.node_id AND space_id=si.space_id AND name=?7)`,
    values: [q.textNorm, q.tokens, q.version, nodeId, spaceId, previousRevision, name],
  };
}

export function nodeSearchSteps(
  nodeId: string,
  spaceId: string,
  name: string,
  previousRevision: number | null = null,
): MutationStep[] {
  return [
    {
      kind: "search_fts_delete",
      affectedId: nodeId,
      statement: {
        sql: "INSERT INTO search_fts(search_fts,rowid,text_norm,tokens) SELECT 'delete',rowid,text_norm,tokens FROM search_index WHERE node_id=?",
        values: [nodeId],
      },
    },
    {
      kind: "search_index",
      affectedId: nodeId,
      statement: updateNodeSearch(nodeId, spaceId, name, previousRevision),
    },
    {
      kind: "search_fts_insert",
      affectedId: nodeId,
      statement: {
        sql: "INSERT INTO search_fts(rowid,text_norm,tokens) SELECT rowid,text_norm,tokens FROM search_index WHERE node_id=?",
        values: [nodeId],
      },
    },
  ];
}
