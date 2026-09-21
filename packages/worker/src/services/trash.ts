import type { TrashPage } from "@ncf/shared";

import type { Env } from "../env.js";
import {
  assertChanged,
  auditAndOutbox,
  finishMutation,
  mutationGuards,
  operationStep,
  type UserMutationContext,
} from "./mutation.js";

interface TrashMutationInput extends UserMutationContext {
  trashOpId: string;
  nodeId: string;
  parentId: string;
  expectedNodeRevision: number;
  expectedParentRevision: number;
  expectedTreeGeneration: number;
  purgeAfter: number;
}

export async function trashNode(env: Env, input: TrashMutationInput): Promise<number> {
  const manifest = await env.DB.prepare(
    "WITH RECURSIVE sub(id,depth) AS (SELECT id,0 FROM nodes WHERE id=?1 AND owner_id=?2 AND space_id=?3 AND kind<>'root' AND revision=?4 AND deleted_at IS NULL UNION ALL SELECT n.id,sub.depth+1 FROM nodes n JOIN sub ON n.parent_id=sub.id WHERE n.deleted_at IS NULL AND sub.depth<64 LIMIT 1001) SELECT id FROM sub ORDER BY depth,id",
  )
    .bind(input.nodeId, input.userId, input.spaceId, input.expectedNodeRevision)
    .all<{ id: string }>();
  if (manifest.results.length === 0) throw new Error("node_not_found");
  if (manifest.results.length > 1000) throw new Error("trash_limit_exceeded");
  const ids = manifest.results.map((row) => row.id);
  const encoded = JSON.stringify(ids);
  const now = Date.now();
  await env.DB.batch([
    ...mutationGuards(env, input),
    env.DB.prepare(
      "INSERT INTO trash_ops(op_id,actor_id,space_id,root_node_id,state,reason,created_at,purge_after,checkpoint,epoch) VALUES(?1,?2,?3,?4,'pending','user',?5,?6,NULL,?7)",
    ).bind(
      input.trashOpId,
      input.userId,
      input.spaceId,
      input.nodeId,
      now,
      input.purgeAfter,
      input.epoch,
    ),
    assertChanged(env),
    ...operationStep(env, input.operationId, 1, "trash.insert", input.trashOpId),
    env.DB.prepare(
      "INSERT INTO trash_members(trash_op_id,node_id) SELECT ?1,value FROM json_each(?2)",
    ).bind(input.trashOpId, encoded),
    assertChanged(env, ids.length),
    ...operationStep(env, input.operationId, 2, "trash.members", input.trashOpId),
    env.DB.prepare(
      "UPDATE nodes SET orig_parent_id=parent_id,deleted_at=?1,deleted_op_id=?2,revision=revision+1,updated_at=?1,last_op_id=?3 WHERE id IN (SELECT value FROM json_each(?4)) AND deleted_at IS NULL",
    ).bind(now, input.trashOpId, input.operationId, encoded),
    assertChanged(env, ids.length),
    env.DB.prepare(
      "INSERT INTO search_fts(search_fts,rowid,text_norm,tokens) SELECT 'delete',rowid,text_norm,tokens FROM search_index WHERE node_id IN (SELECT value FROM json_each(?1))",
    ).bind(encoded),
    env.DB.prepare(
      "DELETE FROM search_index WHERE node_id IN (SELECT value FROM json_each(?1))",
    ).bind(encoded),
    ...operationStep(env, input.operationId, 3, "nodes.trash", input.nodeId),
    env.DB.prepare(
      "UPDATE nodes SET revision=revision+1,updated_at=?1,last_op_id=?2 WHERE id=?3 AND owner_id=?4 AND revision=?5 AND deleted_at IS NULL",
    ).bind(now, input.operationId, input.parentId, input.userId, input.expectedParentRevision),
    assertChanged(env),
    ...operationStep(env, input.operationId, 4, "parent.revision", input.parentId),
    env.DB.prepare(
      "UPDATE spaces SET tree_generation=tree_generation+1 WHERE id=?1 AND owner_id=?2 AND tree_generation=?3",
    ).bind(input.spaceId, input.userId, input.expectedTreeGeneration),
    assertChanged(env),
    ...operationStep(env, input.operationId, 5, "space.generation", input.spaceId),
    env.DB.prepare(
      "UPDATE shares SET disabled_at=?1 WHERE disabled_at IS NULL AND root_node_id IN (SELECT value FROM json_each(?2))",
    ).bind(now, encoded),
    env.DB.prepare(
      "UPDATE trash_ops SET state='trashed',checkpoint=?1 WHERE op_id=?2 AND state='pending'",
    ).bind(JSON.stringify({ members: ids.length }), input.trashOpId),
    assertChanged(env),
    ...auditAndOutbox(env, input, "node.trashed", input.nodeId, 6, now),
    ...finishMutation(env, input, { trash_op_id: input.trashOpId, members: ids.length }, now),
  ]);
  return ids.length;
}

export async function listTrash(
  env: Env,
  userId: string,
  afterCreatedAt = Number.MAX_SAFE_INTEGER,
  afterId = "~",
  limit = 100,
): Promise<TrashPage> {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 200)
    throw new RangeError("Page size is invalid");
  const rows = await env.DB.prepare(
    "SELECT t.op_id opId,t.root_node_id nodeId,n.name,n.kind,b.size,n.deleted_at deletedAt,t.purge_after purgeAfter,(SELECT COUNT(*) FROM trash_members m WHERE m.trash_op_id=t.op_id) memberCount,t.created_at createdAt FROM trash_ops t JOIN nodes n ON n.id=t.root_node_id LEFT JOIN blobs b ON b.id=n.current_blob_id WHERE t.actor_id=?1 AND t.state='trashed' AND (t.created_at<?2 OR (t.created_at=?2 AND t.op_id<?3)) ORDER BY t.created_at DESC,t.op_id DESC LIMIT ?4",
  )
    .bind(userId, afterCreatedAt, afterId, limit + 1)
    .all<{
      opId: string;
      nodeId: string;
      name: string;
      kind: "folder" | "file";
      size: number | null;
      deletedAt: number;
      purgeAfter: number | null;
      memberCount: number;
      createdAt: number;
    }>();
  const items = rows.results.slice(0, limit).map((row) => ({
    opId: row.opId,
    nodeId: row.nodeId,
    name: row.name,
    kind: row.kind,
    size: row.size,
    deletedAt: row.deletedAt,
    purgeAfter: row.purgeAfter,
    memberCount: row.memberCount,
  }));
  const last = rows.results.at(limit - 1);
  return {
    items,
    nextCursor:
      rows.results.length > limit && last !== undefined
        ? btoa(JSON.stringify({ createdAt: last.createdAt, id: last.opId }))
        : null,
  };
}
