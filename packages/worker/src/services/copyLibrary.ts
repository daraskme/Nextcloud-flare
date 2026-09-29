import { assertExists, type SqlStatement } from "../db/primary";
import { ARCHIVE_INDEX_SOURCE } from "./archiveRead";

// Only same-owner COW copies can reuse an index: its bytes bind owner, blob, key, size and ETag.
// Evaluate the complete publication proof inside the namespace transaction, never from a cache.
const SOURCE = `FROM copy_members cm JOIN nodes target ON target.id=cm.copied_node_id
  JOIN library_items source ON source.node_id=cm.source_node_id AND source.blob_id=target.current_blob_id
  JOIN archive_index original_index ON original_index.node_id=source.node_id AND original_index.blob_id=source.blob_id
    AND original_index.generator_version=source.generator_version
  WHERE cm.copy_op_id=?1 AND EXISTS(SELECT 1 ${ARCHIVE_INDEX_SOURCE}
    AND (n.id=cm.source_node_id AND n.owner_id=target.owner_id AND n.space_id=target.space_id
      AND n.current_blob_id=target.current_blob_id))`;

/** The enclosing COPY batch already fences source/destination authority and namespace limits. */
export function copyLibrarySteps(op: string, rootCopy: string) {
  const count = (table: "archive_index" | "library_items") =>
    assertExists(
      `SELECT 1 WHERE (SELECT COUNT(*) FROM ${table} WHERE node_id IN
        (SELECT copied_node_id FROM copy_members WHERE copy_op_id=?1))=(SELECT COUNT(*) ${SOURCE})`,
      [op],
    );
  return [
    {
      kind: "archive_index",
      affectedId: rootCopy,
      statement: {
        sql: `INSERT INTO archive_index(id,node_id,blob_id,generator_version,r2_key,sha256,entry_count,json_bytes)
          SELECT 'ai_copy_'||cm.copied_node_id,cm.copied_node_id,source.blob_id,source.generator_version,
            original_index.r2_key,original_index.sha256,original_index.entry_count,original_index.json_bytes ${SOURCE}`,
        values: [op],
      } satisfies SqlStatement,
      assertion: count("archive_index"),
    },
    {
      kind: "library_metadata",
      affectedId: rootCopy,
      statement: {
        sql: `INSERT INTO library_items(node_id,blob_id,kind,generator_version,title_extracted,author_extracted,series_extracted,
          title_override,author_override,series_override,page_count)
          SELECT cm.copied_node_id,source.blob_id,source.kind,source.generator_version,
            CASE WHEN source.title_extracted=(SELECT name FROM nodes WHERE id=cm.source_node_id)
              THEN target.name ELSE source.title_extracted END,
            source.author_extracted,source.series_extracted,source.title_override,source.author_override,source.series_override,
            source.page_count ${SOURCE}`,
        values: [op],
      } satisfies SqlStatement,
      assertion: count("library_items"),
    },
  ];
}
