import { authorizationAssertion, authorizeNode, type Principal } from "../auth/authorize";
import { assertExists, atomicBatch, primary } from "../db/primary";
import { BOUNDED_SUBTREE_CTE, SUBTREE_NODE_LIMIT } from "./subtree";

interface StatsRow {
  scannedNodes: number;
  fileCount: number;
  folderCount: number;
  totalBytes: number;
  unavailableFiles: number;
  depthLimited: number;
}

/** Account statistics count current logical files, including each copy, only on request. */
export async function readFolderStats(db: D1Database, principal: Principal, scopeId?: string) {
  if (
    principal.kind !== "user" ||
    (scopeId !== undefined && !/^[A-Za-z0-9_-]{1,128}$/.test(scopeId))
  )
    throw new Error("stats_unavailable");
  const space = await primary(db)
    .prepare("SELECT id,root_node_id AS rootId FROM spaces WHERE owner_id=?")
    .bind(principal.user_id)
    .first<{ id: string; rootId: string }>();
  if (!space) throw new Error("stats_unavailable");
  const id = scopeId ?? space.rootId;
  const proof = await authorizeNode(db, principal, {
    operation: "node.read",
    spaceId: space.id,
    nodeId: id,
  });
  if (
    proof.operation !== "node.read" ||
    proof.node.kind === "file" ||
    proof.node.owner_id !== principal.user_id
  )
    throw new Error("stats_unavailable");
  const result = await atomicBatch(db, [
    authorizationAssertion(proof),
    assertExists(
      `SELECT 1 FROM control ctl JOIN spaces sp ON sp.id=?
       JOIN nodes n ON n.space_id=sp.id AND n.owner_id=sp.owner_id
       WHERE ctl.singleton=1 AND ctl.epoch=? AND ctl.maintenance=0
         AND sp.owner_id=? AND n.id=? AND n.kind IN ('root','folder')`,
      [space.id, principal.epoch, principal.user_id, id],
    ),
    {
      sql: `${BOUNDED_SUBTREE_CTE}, entries AS MATERIALIZED (
        SELECT n.kind,b.size FROM scope s CROSS JOIN nodes n ON n.id=s.id
        LEFT JOIN blobs b ON b.id=n.current_blob_id AND b.owner_id=?3
          AND b.state IN ('committed','gc_candidate')
        WHERE s.id<>?1
      ) SELECT (SELECT COUNT(*) FROM scope) AS scannedNodes,
        (SELECT COUNT(*) FROM entries WHERE kind='file') AS fileCount,
        (SELECT COUNT(*) FROM entries WHERE kind='folder') AS folderCount,
        (SELECT COALESCE(SUM(size),0) FROM entries WHERE kind='file') AS totalBytes,
        (SELECT COUNT(*) FROM entries WHERE kind='file' AND size IS NULL) AS unavailableFiles,
        EXISTS(SELECT 1 FROM scope s WHERE s.depth=64 AND s.kind IN ('root','folder')
          AND EXISTS(SELECT 1 FROM nodes c INDEXED BY nodes_children_keyset
            WHERE c.parent_id=s.id AND c.deleted_at IS NULL AND c.space_id=?2 AND c.owner_id=?3
            LIMIT 1)) AS depthLimited`,
      values: [id, space.id, principal.user_id],
    },
  ]);
  const row = result[2]?.results[0] as StatsRow | undefined;
  if (!row || Object.values(row).some((value) => !Number.isSafeInteger(value) || value < 0))
    throw new Error("stats_unavailable");
  return Object.freeze({
    scopeId: id,
    treeGeneration: proof.node.tree_generation,
    fileCount: row.fileCount,
    folderCount: row.folderCount,
    totalBytes: row.totalBytes,
    scannedNodes: row.scannedNodes,
    nodeLimit: SUBTREE_NODE_LIMIT,
    unavailableFiles: row.unavailableFiles,
    truncated: row.scannedNodes >= SUBTREE_NODE_LIMIT || row.depthLimited > 0,
  });
}
