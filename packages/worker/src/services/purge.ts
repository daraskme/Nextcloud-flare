import type { Env } from "../env.js";
import {
  assertChanged,
  auditAndOutbox,
  finishMutation,
  mutationGuards,
  operationStep,
  type UserMutationContext,
} from "./mutation.js";

interface PurgeInput extends UserMutationContext {
  trashOpId: string;
  expectedParentRevision: number;
  expectedTreeGeneration: number;
  gcNotBefore: number;
}

interface BlobReferenceCount {
  blobId: string;
  refCount: number;
}

export async function purgeTrash(env: Env, input: PurgeInput): Promise<number> {
  const trash = await env.DB.prepare(
    "SELECT t.root_node_id rootId,COALESCE(CASE WHEN p.deleted_at IS NULL THEN p.id END,s.root_node_id) parentId,(SELECT COUNT(*) FROM trash_members WHERE trash_op_id=t.op_id) members FROM trash_ops t JOIN nodes n ON n.id=t.root_node_id JOIN spaces s ON s.id=t.space_id LEFT JOIN nodes p ON p.id=n.parent_id WHERE t.op_id=?1 AND t.actor_id=?2 AND t.space_id=?3 AND t.state='trashed'",
  )
    .bind(input.trashOpId, input.userId, input.spaceId)
    .first<{ rootId: string; parentId: string; members: number }>();
  if (trash === null || trash.members < 1) throw new Error("trash_not_found");
  if (trash.members > 1000) throw new Error("purge_limit_exceeded");
  const members = await env.DB.prepare(
    "SELECT node_id id FROM trash_members WHERE trash_op_id=?1 ORDER BY node_id",
  )
    .bind(input.trashOpId)
    .all<{ id: string }>();
  if (members.results.length !== trash.members) throw new Error("trash_membership_changed");
  const encoded = JSON.stringify(members.results.map((row) => row.id));
  const blobRefs = await env.DB.prepare(
    "SELECT blobId,SUM(refs) refCount FROM (SELECT n.current_blob_id blobId,COUNT(*) refs FROM trash_members m JOIN nodes n ON n.id=m.node_id WHERE m.trash_op_id=?1 AND n.current_blob_id IS NOT NULL GROUP BY n.current_blob_id UNION ALL SELECT v.blob_id blobId,COUNT(*) refs FROM trash_members m JOIN node_versions v ON v.node_id=m.node_id WHERE m.trash_op_id=?1 GROUP BY v.blob_id) GROUP BY blobId",
  )
    .bind(input.trashOpId)
    .all<BlobReferenceCount>();
  const now = Date.now();
  const statements: D1PreparedStatement[] = [
    ...mutationGuards(env, input),
    env.DB.prepare(
      "INSERT INTO _assert(v) SELECT 1 WHERE EXISTS(SELECT 1 FROM uploads WHERE state IN ('created','receiving','completing') AND (parent_id IN (SELECT value FROM json_each(?1)) OR target_node_id IN (SELECT value FROM json_each(?1))))",
    ).bind(encoded),
    env.DB.prepare("UPDATE trash_ops SET state='purging' WHERE op_id=?1 AND state='trashed'").bind(
      input.trashOpId,
    ),
    assertChanged(env),
    ...operationStep(env, input.operationId, 1, "trash.purging", input.trashOpId),
    env.DB.prepare(
      "UPDATE nodes SET parent_id=NULL WHERE parent_id IN (SELECT value FROM json_each(?1)) AND deleted_at IS NOT NULL AND deleted_op_id<>?2",
    ).bind(encoded, input.trashOpId),
  ];
  for (const blob of blobRefs.results) {
    statements.push(
      env.DB.prepare(
        "UPDATE blobs SET ref_count=ref_count-?1,last_op_id=?2 WHERE id=?3 AND ref_count>=?1 AND state='committed'",
      ).bind(blob.refCount, input.operationId, blob.blobId),
      assertChanged(env),
      env.DB.prepare(
        "UPDATE users SET used_bytes=used_bytes-(SELECT size FROM blobs WHERE id=?1) WHERE id=?2 AND (SELECT ref_count FROM blobs WHERE id=?1)=0 AND used_bytes>=(SELECT size FROM blobs WHERE id=?1)",
      ).bind(blob.blobId, input.userId),
      env.DB.prepare(
        "UPDATE blobs SET state='gc_candidate' WHERE id=?1 AND ref_count=0 AND state='committed'",
      ).bind(blob.blobId),
      env.DB.prepare(
        "INSERT INTO gc_candidates(blob_id,trash_op_id,state,pinned_by,not_before,last_error,claim_token,claim_expires_at) SELECT id,?1,'candidate',NULL,?2,NULL,NULL,NULL FROM blobs WHERE id=?3 AND state='gc_candidate' ON CONFLICT(blob_id) DO UPDATE SET trash_op_id=excluded.trash_op_id,not_before=MAX(gc_candidates.not_before,excluded.not_before)",
      ).bind(input.trashOpId, input.gcNotBefore, blob.blobId),
    );
  }
  statements.push(
    ...operationStep(env, input.operationId, 2, "blob.refs.release", input.trashOpId),
    env.DB.prepare("DELETE FROM node_tags WHERE node_id IN (SELECT value FROM json_each(?1))").bind(
      encoded,
    ),
    env.DB.prepare(
      "DELETE FROM node_media WHERE node_id IN (SELECT value FROM json_each(?1))",
    ).bind(encoded),
    env.DB.prepare(
      "DELETE FROM node_audio WHERE node_id IN (SELECT value FROM json_each(?1))",
    ).bind(encoded),
    env.DB.prepare(
      "DELETE FROM archive_index WHERE node_id IN (SELECT value FROM json_each(?1))",
    ).bind(encoded),
    env.DB.prepare(
      "DELETE FROM user_reading_state WHERE node_id IN (SELECT value FROM json_each(?1))",
    ).bind(encoded),
    env.DB.prepare(
      "DELETE FROM user_playback_state WHERE node_id IN (SELECT value FROM json_each(?1))",
    ).bind(encoded),
    env.DB.prepare(
      "DELETE FROM share_grants WHERE share_id IN (SELECT id FROM shares WHERE root_node_id IN (SELECT value FROM json_each(?1)))",
    ).bind(encoded),
    env.DB.prepare(
      "DELETE FROM shares WHERE root_node_id IN (SELECT value FROM json_each(?1))",
    ).bind(encoded),
    env.DB.prepare("DELETE FROM locks WHERE node_id IN (SELECT value FROM json_each(?1))").bind(
      encoded,
    ),
    env.DB.prepare(
      "DELETE FROM upload_parts WHERE upload_id IN (SELECT id FROM uploads WHERE parent_id IN (SELECT value FROM json_each(?1)) OR target_node_id IN (SELECT value FROM json_each(?1)))",
    ).bind(encoded),
    env.DB.prepare(
      "DELETE FROM uploads WHERE state IN ('completed','failed','aborted','expired') AND (parent_id IN (SELECT value FROM json_each(?1)) OR target_node_id IN (SELECT value FROM json_each(?1)))",
    ).bind(encoded),
    env.DB.prepare(
      "DELETE FROM bulk_jobs WHERE state IN ('completed','failed') AND destination_parent_id IN (SELECT value FROM json_each(?1))",
    ).bind(encoded),
    env.DB.prepare(
      "DELETE FROM node_versions WHERE node_id IN (SELECT value FROM json_each(?1))",
    ).bind(encoded),
    env.DB.prepare(
      "INSERT INTO search_fts(search_fts,rowid,text_norm,tokens) SELECT 'delete',rowid,text_norm,tokens FROM search_index WHERE node_id IN (SELECT value FROM json_each(?1))",
    ).bind(encoded),
    env.DB.prepare(
      "DELETE FROM search_index WHERE node_id IN (SELECT value FROM json_each(?1))",
    ).bind(encoded),
    env.DB.prepare(
      "DELETE FROM node_stars WHERE node_id IN (SELECT value FROM json_each(?1))",
    ).bind(encoded),
    env.DB.prepare(
      "DELETE FROM library_items WHERE node_id IN (SELECT value FROM json_each(?1))",
    ).bind(encoded),
    env.DB.prepare(
      "DELETE FROM node_props WHERE node_id IN (SELECT value FROM json_each(?1))",
    ).bind(encoded),
    ...operationStep(env, input.operationId, 3, "trash.dependents.purge", input.trashOpId),
    env.DB.prepare("DELETE FROM trash_members WHERE trash_op_id=?1").bind(input.trashOpId),
    assertChanged(env, trash.members),
    ...operationStep(env, input.operationId, 4, "trash.members.purge", input.trashOpId),
    env.DB.prepare(
      "DELETE FROM nodes WHERE id IN (SELECT value FROM json_each(?1)) AND deleted_op_id=?2",
    ).bind(encoded, input.trashOpId),
    assertChanged(env, trash.members),
    ...operationStep(env, input.operationId, 5, "nodes.purge", trash.rootId),
    env.DB.prepare(
      "UPDATE nodes SET revision=revision+1,updated_at=?1,last_op_id=?2 WHERE id=?3 AND owner_id=?4 AND revision=?5 AND deleted_at IS NULL",
    ).bind(now, input.operationId, trash.parentId, input.userId, input.expectedParentRevision),
    assertChanged(env),
    ...operationStep(env, input.operationId, 6, "parent.revision", trash.parentId),
    env.DB.prepare(
      "UPDATE spaces SET tree_generation=tree_generation+1 WHERE id=?1 AND owner_id=?2 AND tree_generation=?3",
    ).bind(input.spaceId, input.userId, input.expectedTreeGeneration),
    assertChanged(env),
    ...operationStep(env, input.operationId, 7, "space.generation", input.spaceId),
    env.DB.prepare(
      "UPDATE trash_ops SET state='purged',checkpoint=?1 WHERE op_id=?2 AND state='purging'",
    ).bind(JSON.stringify({ purged_at: now, members: trash.members }), input.trashOpId),
    assertChanged(env),
    ...auditAndOutbox(env, input, "node.purged", trash.rootId, 8, now),
    ...finishMutation(env, input, { trash_op_id: input.trashOpId, purged: true }, now),
  );
  await env.DB.batch(statements);
  return trash.members;
}
