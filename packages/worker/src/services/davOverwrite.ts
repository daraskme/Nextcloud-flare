import type { Env } from "../env.js";
import { assertChanged, operationStep } from "./mutation.js";

export interface DavOverwriteTarget {
  nodeId: string;
  parentId: string;
  expectedRevision: number;
  ids: string[];
  trashOpId: string;
  purgeAfter: number;
}

export async function buildDavOverwriteTarget(
  env: Env,
  input: { nodeId: string; parentId: string; expectedRevision: number },
): Promise<DavOverwriteTarget> {
  const rows = await env.DB.prepare(
    "WITH RECURSIVE sub(id,depth) AS (SELECT id,0 FROM nodes WHERE id=?1 AND parent_id=?2 AND revision=?3 AND kind<>'root' AND deleted_at IS NULL UNION ALL SELECT n.id,sub.depth+1 FROM nodes n JOIN sub ON n.parent_id=sub.id WHERE n.deleted_at IS NULL AND sub.depth<64 LIMIT 1001) SELECT id FROM sub ORDER BY depth,id",
  )
    .bind(input.nodeId, input.parentId, input.expectedRevision)
    .all<{ id: string }>();
  if (rows.results.length === 0) throw new Error("node_not_found");
  if (rows.results.length > 1000) throw new Error("dav_overwrite_limit");
  return {
    ...input,
    ids: rows.results.map((row) => row.id),
    trashOpId: `trash_${crypto.randomUUID().replaceAll("-", "")}`,
    purgeAfter: Date.now() + 35 * 86_400_000,
  };
}

export function davOverwriteStatements(
  env: Env,
  input: {
    overwrite: DavOverwriteTarget;
    operationId: string;
    userId: string;
    spaceId: string;
    epoch: number;
  },
  step: number,
): D1PreparedStatement[] {
  const now = Date.now();
  const ids = JSON.stringify(input.overwrite.ids);
  return [
    env.DB.prepare(
      "INSERT INTO _assert(v) SELECT 1 WHERE NOT EXISTS(SELECT 1 FROM nodes WHERE id=?1 AND parent_id=?2 AND owner_id=?3 AND space_id=?4 AND revision=?5 AND deleted_at IS NULL)",
    ).bind(
      input.overwrite.nodeId,
      input.overwrite.parentId,
      input.userId,
      input.spaceId,
      input.overwrite.expectedRevision,
    ),
    env.DB.prepare(
      "INSERT INTO trash_ops(op_id,actor_id,space_id,root_node_id,state,reason,created_at,purge_after,checkpoint,epoch) VALUES(?1,?2,?3,?4,'pending','dav_overwrite',?5,?6,NULL,?7)",
    ).bind(
      input.overwrite.trashOpId,
      input.userId,
      input.spaceId,
      input.overwrite.nodeId,
      now,
      input.overwrite.purgeAfter,
      input.epoch,
    ),
    assertChanged(env),
    env.DB.prepare(
      "INSERT INTO trash_members(trash_op_id,node_id) SELECT ?1,value FROM json_each(?2)",
    ).bind(input.overwrite.trashOpId, ids),
    assertChanged(env, input.overwrite.ids.length),
    env.DB.prepare(
      "UPDATE nodes SET orig_parent_id=parent_id,deleted_at=?1,deleted_op_id=?2,revision=revision+1,updated_at=?1,last_op_id=?3 WHERE id IN (SELECT value FROM json_each(?4)) AND deleted_at IS NULL",
    ).bind(now, input.overwrite.trashOpId, input.operationId, ids),
    assertChanged(env, input.overwrite.ids.length),
    env.DB.prepare(
      "INSERT INTO search_fts(search_fts,rowid,text_norm,tokens) SELECT 'delete',rowid,text_norm,tokens FROM search_index WHERE node_id IN (SELECT value FROM json_each(?1))",
    ).bind(ids),
    env.DB.prepare(
      "DELETE FROM search_index WHERE node_id IN (SELECT value FROM json_each(?1))",
    ).bind(ids),
    env.DB.prepare(
      "UPDATE shares SET disabled_at=?1 WHERE disabled_at IS NULL AND root_node_id IN (SELECT value FROM json_each(?2))",
    ).bind(now, ids),
    env.DB.prepare("DELETE FROM locks WHERE node_id IN (SELECT value FROM json_each(?1))").bind(
      ids,
    ),
    env.DB.prepare(
      "UPDATE trash_ops SET state='trashed',checkpoint=?1 WHERE op_id=?2 AND state='pending'",
    ).bind(JSON.stringify({ members: input.overwrite.ids.length }), input.overwrite.trashOpId),
    assertChanged(env),
    ...operationStep(env, input.operationId, step, "destination.overwrite", input.overwrite.nodeId),
  ];
}
