import type { Env } from "../env.js";
import { setGcPaused } from "./control.js";
import { normalizePortableName } from "./fsMutation.js";
import {
  assertChanged,
  auditAndOutbox,
  finishMutation,
  mutationGuards,
  operationStep,
  type UserMutationContext,
} from "./mutation.js";

interface RestoreInput extends UserMutationContext {
  trashOpId: string;
  destinationParentId: string;
  expectedDestinationRevision: number;
  expectedTreeGeneration: number;
}

async function restoredName(
  env: Env,
  parentId: string,
  original: string,
  excludeNodeId: string,
): Promise<{ name: string; nameCi: string }> {
  for (let index = 0; index <= 100; index += 1) {
    const candidate = index === 0 ? original : `${original} (restored ${index})`;
    const normalized = normalizePortableName(candidate);
    const conflict = await env.DB.prepare(
      "SELECT 1 found FROM nodes WHERE parent_id=?1 AND name_ci=?2 AND id<>?3 AND deleted_at IS NULL",
    )
      .bind(parentId, normalized.nameCi, excludeNodeId)
      .first<{ found: number }>();
    if (conflict === null) return normalized;
  }
  throw new Error("restore_name_conflict");
}

export async function restoreTrash(env: Env, input: RestoreInput): Promise<string> {
  await setGcPaused(env, true);
  try {
    const deleting = await env.DB.prepare(
      "SELECT 1 found FROM gc_candidates WHERE state='deleting' LIMIT 1",
    ).first<{ found: number }>();
    if (deleting !== null) throw new Error("restore_gc_busy");
    const trash = await env.DB.prepare(
      "SELECT t.root_node_id rootId,n.name,(SELECT COUNT(*) FROM trash_members WHERE trash_op_id=t.op_id) members FROM trash_ops t JOIN nodes n ON n.id=t.root_node_id WHERE t.op_id=?1 AND t.actor_id=?2 AND t.space_id=?3 AND t.state='trashed'",
    )
      .bind(input.trashOpId, input.userId, input.spaceId)
      .first<{ rootId: string; name: string; members: number }>();
    if (trash === null || trash.members < 1) throw new Error("trash_not_found");
    const unrecoverable = await env.DB.prepare(
      "SELECT 1 found FROM trash_members m JOIN nodes n ON n.id=m.node_id LEFT JOIN blobs current ON current.id=n.current_blob_id LEFT JOIN node_versions v ON v.node_id=n.id LEFT JOIN blobs version ON version.id=v.blob_id WHERE m.trash_op_id=?1 AND (current.state IN ('deleting','deleted') OR version.state IN ('deleting','deleted')) LIMIT 1",
    )
      .bind(input.trashOpId)
      .first<{ found: number }>();
    if (unrecoverable !== null) throw new Error("blob_unrecoverable");
    const destination = await env.DB.prepare(
      "SELECT id FROM nodes WHERE id=?1 AND owner_id=?2 AND space_id=?3 AND kind IN ('root','folder') AND deleted_at IS NULL",
    )
      .bind(input.destinationParentId, input.userId, input.spaceId)
      .first<{ id: string }>();
    if (destination === null) throw new Error("restore_destination_invalid");
    const name = await restoredName(env, destination.id, trash.name, trash.rootId);
    const now = Date.now();
    await env.DB.batch([
      ...mutationGuards(env, input),
      env.DB.prepare(
        "UPDATE trash_ops SET state='restoring' WHERE op_id=?1 AND state='trashed'",
      ).bind(input.trashOpId),
      assertChanged(env),
      ...operationStep(env, input.operationId, 1, "trash.restoring", input.trashOpId),
      env.DB.prepare(
        "UPDATE nodes SET deleted_at=NULL,deleted_op_id=NULL,revision=revision+1,updated_at=?1,last_op_id=?2 WHERE id IN (SELECT node_id FROM trash_members WHERE trash_op_id=?3) AND id<>?4 AND deleted_op_id=?3",
      ).bind(now, input.operationId, input.trashOpId, trash.rootId),
      assertChanged(env, trash.members - 1),
      ...operationStep(env, input.operationId, 2, "trash.descendants.restore", input.trashOpId),
      env.DB.prepare(
        "UPDATE nodes SET parent_id=?1,name=?2,name_ci=?3,deleted_at=NULL,deleted_op_id=NULL,revision=revision+1,updated_at=?4,last_op_id=?5 WHERE id=?6 AND deleted_op_id=?7 AND EXISTS(SELECT 1 FROM trash_ops WHERE op_id=?7 AND state='restoring')",
      ).bind(
        destination.id,
        name.name,
        name.nameCi,
        now,
        input.operationId,
        trash.rootId,
        input.trashOpId,
      ),
      assertChanged(env),
      ...operationStep(env, input.operationId, 3, "trash.root.restore", trash.rootId),
      env.DB.prepare(
        "UPDATE nodes SET revision=revision+1,updated_at=?1,last_op_id=?2 WHERE id=?3 AND owner_id=?4 AND revision=?5 AND deleted_at IS NULL",
      ).bind(
        now,
        input.operationId,
        destination.id,
        input.userId,
        input.expectedDestinationRevision,
      ),
      assertChanged(env),
      ...operationStep(env, input.operationId, 4, "destination.revision", destination.id),
      env.DB.prepare(
        "UPDATE spaces SET tree_generation=tree_generation+1 WHERE id=?1 AND owner_id=?2 AND tree_generation=?3",
      ).bind(input.spaceId, input.userId, input.expectedTreeGeneration),
      assertChanged(env),
      ...operationStep(env, input.operationId, 5, "space.generation", input.spaceId),
      env.DB.prepare(
        "UPDATE trash_ops SET state='restored',checkpoint=?1 WHERE op_id=?2 AND state='restoring'",
      ).bind(JSON.stringify({ restored_at: now }), input.trashOpId),
      assertChanged(env),
      ...auditAndOutbox(env, input, "node.restored", trash.rootId, 6, now),
      ...finishMutation(env, input, { node_id: trash.rootId, revision: 1 }, now),
    ]);
    return trash.rootId;
  } finally {
    await setGcPaused(env, false);
  }
}
