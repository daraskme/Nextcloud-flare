import type { Env } from "../env.js";
import { normalizePortableName } from "./fsMutation.js";
import {
  assertChanged,
  auditAndOutbox,
  finishMutation,
  mutationGuards,
  operationStep,
  type UserMutationContext,
} from "./mutation.js";

export interface StructuralMutationContext extends UserMutationContext {
  expectedTreeGeneration: number;
}

interface FileCreateInput extends StructuralMutationContext {
  parentId: string;
  expectedParentRevision: number;
  nodeId: string;
  blobId: string;
  name: string;
  uploadId?: string;
  copyJob?: {
    jobId: string;
    pinId: string;
    sourceBlobId: string;
    claimToken: string;
  };
}

export async function createFile(env: Env, input: FileCreateInput): Promise<void> {
  const normalized = normalizePortableName(input.name);
  const now = Date.now();
  await env.DB.batch([
    ...mutationGuards(env, input),
    env.DB.prepare(
      "UPDATE blobs SET state='committed',ref_count=1,last_op_id=?1 WHERE id=?2 AND owner_id=?3 AND state='staging' AND ref_count=0",
    ).bind(input.operationId, input.blobId, input.userId),
    assertChanged(env),
    ...operationStep(env, input.operationId, 1, "blob.commit", input.blobId),
    env.DB.prepare(
      "INSERT INTO nodes(id,space_id,owner_id,parent_id,name,name_ci,kind,current_blob_id,revision,client_mtime,created_at,updated_at,deleted_at,deleted_op_id,orig_parent_id,hidden,last_op_id) SELECT ?1,?2,?3,?4,?5,?6,'file',?7,1,NULL,?8,?8,NULL,NULL,NULL,0,?9 WHERE EXISTS(SELECT 1 FROM nodes p WHERE p.id=?4 AND p.owner_id=?3 AND p.space_id=?2 AND p.kind IN ('root','folder') AND p.deleted_at IS NULL)",
    ).bind(
      input.nodeId,
      input.spaceId,
      input.userId,
      input.parentId,
      normalized.name,
      normalized.nameCi,
      input.blobId,
      now,
      input.operationId,
    ),
    assertChanged(env),
    ...operationStep(env, input.operationId, 2, "node.insert", input.nodeId),
    env.DB.prepare(
      "UPDATE users SET reserved_bytes=reserved_bytes-b.size,used_bytes=used_bytes+b.size FROM blobs b WHERE users.id=?1 AND b.id=?2 AND users.reserved_bytes>=b.size",
    ).bind(input.userId, input.blobId),
    assertChanged(env),
    ...operationStep(env, input.operationId, 3, "quota.commit", input.userId),
    ...(input.uploadId === undefined
      ? []
      : [
          env.DB.prepare(
            "UPDATE uploads SET state='completed',target_node_id=?1,updated_at=?2 WHERE id=?3 AND owner_id=?4 AND blob_id=?5 AND state='completing'",
          ).bind(input.nodeId, now, input.uploadId, input.userId, input.blobId),
          assertChanged(env),
        ]),
    ...(input.copyJob === undefined
      ? []
      : [
          env.DB.prepare("DELETE FROM blob_pins WHERE pin_id=?1 AND blob_id=?2").bind(
            input.copyJob.pinId,
            input.copyJob.sourceBlobId,
          ),
          assertChanged(env),
          env.DB.prepare(
            "UPDATE blobs SET ref_count=ref_count-1,last_op_id=?1 WHERE id=?2 AND ref_count>0 AND state='committed'",
          ).bind(input.operationId, input.copyJob.sourceBlobId),
          assertChanged(env),
          env.DB.prepare(
            "UPDATE bulk_jobs SET state='completed',operation_id=?1,updated_at=?2 WHERE id=?3 AND state='claimed' AND claim_token=?4",
          ).bind(input.operationId, now, input.copyJob.jobId, input.copyJob.claimToken),
          assertChanged(env),
        ]),
    env.DB.prepare(
      "UPDATE nodes SET revision=revision+1,updated_at=?1,last_op_id=?2 WHERE id=?3 AND revision=?4 AND deleted_at IS NULL",
    ).bind(now, input.operationId, input.parentId, input.expectedParentRevision),
    assertChanged(env),
    ...operationStep(env, input.operationId, 4, "parent.revision", input.parentId),
    env.DB.prepare(
      "UPDATE spaces SET tree_generation=tree_generation+1 WHERE id=?1 AND owner_id=?2 AND tree_generation=?3",
    ).bind(input.spaceId, input.userId, input.expectedTreeGeneration),
    assertChanged(env),
    ...operationStep(env, input.operationId, 5, "space.generation", input.spaceId),
    ...auditAndOutbox(env, input, "node.created", input.nodeId, 6, now),
    ...finishMutation(env, input, { node_id: input.nodeId, revision: 1 }, now),
  ]);
}

interface OverwriteInput extends UserMutationContext {
  nodeId: string;
  parentId: string;
  blobId: string;
  versionId: string;
  expectedNodeRevision: number;
  expectedParentRevision: number;
  uploadId?: string;
}

export async function overwriteFile(env: Env, input: OverwriteInput): Promise<void> {
  const now = Date.now();
  await env.DB.batch([
    ...mutationGuards(env, input),
    env.DB.prepare(
      "INSERT INTO _assert(v) SELECT 1 WHERE NOT EXISTS(SELECT 1 FROM blobs WHERE id=?1 AND owner_id=?2 AND state='staging' AND ref_count=0)",
    ).bind(input.blobId, input.userId),
    env.DB.prepare(
      "INSERT INTO node_versions(id,node_id,blob_id,created_at,op_id) SELECT ?1,id,current_blob_id,?2,?3 FROM nodes WHERE id=?4 AND owner_id=?5 AND parent_id=?6 AND kind='file' AND revision=?7 AND deleted_at IS NULL AND current_blob_id IS NOT NULL",
    ).bind(
      input.versionId,
      now,
      input.operationId,
      input.nodeId,
      input.userId,
      input.parentId,
      input.expectedNodeRevision,
    ),
    assertChanged(env),
    ...operationStep(env, input.operationId, 1, "version.insert", input.versionId),
    env.DB.prepare(
      "UPDATE blobs SET state='committed',ref_count=1,last_op_id=?1 WHERE id=?2 AND owner_id=?3 AND state='staging' AND ref_count=0",
    ).bind(input.operationId, input.blobId, input.userId),
    assertChanged(env),
    ...operationStep(env, input.operationId, 2, "blob.commit", input.blobId),
    env.DB.prepare(
      "UPDATE nodes SET current_blob_id=?1,revision=revision+1,updated_at=?2,last_op_id=?3 WHERE id=?4 AND owner_id=?5 AND parent_id=?6 AND revision=?7 AND deleted_at IS NULL",
    ).bind(
      input.blobId,
      now,
      input.operationId,
      input.nodeId,
      input.userId,
      input.parentId,
      input.expectedNodeRevision,
    ),
    assertChanged(env),
    ...operationStep(env, input.operationId, 3, "node.content", input.nodeId),
    env.DB.prepare(
      "UPDATE users SET reserved_bytes=reserved_bytes-b.size,used_bytes=used_bytes+b.size FROM blobs b WHERE users.id=?1 AND b.id=?2 AND users.reserved_bytes>=b.size",
    ).bind(input.userId, input.blobId),
    assertChanged(env),
    ...operationStep(env, input.operationId, 4, "quota.commit", input.userId),
    ...(input.uploadId === undefined
      ? []
      : [
          env.DB.prepare(
            "UPDATE uploads SET state='completed',target_node_id=?1,updated_at=?2 WHERE id=?3 AND owner_id=?4 AND blob_id=?5 AND state='completing'",
          ).bind(input.nodeId, now, input.uploadId, input.userId, input.blobId),
          assertChanged(env),
        ]),
    env.DB.prepare(
      "UPDATE nodes SET revision=revision+1,updated_at=?1,last_op_id=?2 WHERE id=?3 AND owner_id=?4 AND revision=?5 AND deleted_at IS NULL",
    ).bind(now, input.operationId, input.parentId, input.userId, input.expectedParentRevision),
    assertChanged(env),
    ...operationStep(env, input.operationId, 5, "parent.revision", input.parentId),
    ...auditAndOutbox(env, input, "node.content.updated", input.nodeId, 6, now),
    ...finishMutation(
      env,
      input,
      { node_id: input.nodeId, revision: input.expectedNodeRevision + 1, blob_id: input.blobId },
      now,
    ),
  ]);
}

interface MoveInput extends StructuralMutationContext {
  nodeId: string;
  sourceParentId: string;
  destinationParentId: string;
  name: string;
  expectedNodeRevision: number;
  expectedSourceParentRevision: number;
  expectedDestinationParentRevision?: number;
}

export async function moveNode(env: Env, input: MoveInput): Promise<void> {
  const normalized = normalizePortableName(input.name);
  const now = Date.now();
  const sameParent = input.sourceParentId === input.destinationParentId;
  const steps = sameParent ? 5 : 6;
  const statements: D1PreparedStatement[] = [
    ...mutationGuards(env, input),
    env.DB.prepare(
      "INSERT INTO _assert(v) SELECT 1 WHERE EXISTS(WITH RECURSIVE d(id,depth) AS (SELECT id,0 FROM nodes WHERE id=?1 UNION ALL SELECT n.id,d.depth+1 FROM nodes n JOIN d ON n.parent_id=d.id WHERE n.deleted_at IS NULL AND d.depth<64) SELECT 1 FROM d WHERE id=?2)",
    ).bind(input.nodeId, input.destinationParentId),
    env.DB.prepare(
      "INSERT INTO _assert(v) SELECT 1 WHERE NOT EXISTS(SELECT 1 FROM nodes s JOIN nodes d ON d.id=?1 WHERE s.id=?2 AND s.owner_id=?3 AND s.space_id=?4 AND s.kind<>'root' AND s.parent_id=?5 AND s.revision=?6 AND s.deleted_at IS NULL AND d.owner_id=s.owner_id AND d.space_id=s.space_id AND d.kind IN ('root','folder') AND d.deleted_at IS NULL)",
    ).bind(
      input.destinationParentId,
      input.nodeId,
      input.userId,
      input.spaceId,
      input.sourceParentId,
      input.expectedNodeRevision,
    ),
    env.DB.prepare(
      "UPDATE nodes SET parent_id=?1,name=?2,name_ci=?3,revision=revision+1,updated_at=?4,last_op_id=?5 WHERE id=?6 AND revision=?7 AND parent_id=?8 AND deleted_at IS NULL",
    ).bind(
      input.destinationParentId,
      normalized.name,
      normalized.nameCi,
      now,
      input.operationId,
      input.nodeId,
      input.expectedNodeRevision,
      input.sourceParentId,
    ),
    assertChanged(env),
    ...operationStep(env, input.operationId, 1, "node.move", input.nodeId),
    env.DB.prepare(
      "UPDATE nodes SET revision=revision+1,updated_at=?1,last_op_id=?2 WHERE id=?3 AND revision=?4 AND deleted_at IS NULL",
    ).bind(now, input.operationId, input.sourceParentId, input.expectedSourceParentRevision),
    assertChanged(env),
    ...operationStep(env, input.operationId, 2, "source.revision", input.sourceParentId),
  ];
  let nextStep = 3;
  if (!sameParent) {
    if (input.expectedDestinationParentRevision === undefined) {
      throw new RangeError("Destination revision is required");
    }
    statements.push(
      env.DB.prepare(
        "UPDATE nodes SET revision=revision+1,updated_at=?1,last_op_id=?2 WHERE id=?3 AND revision=?4 AND deleted_at IS NULL",
      ).bind(
        now,
        input.operationId,
        input.destinationParentId,
        input.expectedDestinationParentRevision,
      ),
      assertChanged(env),
      ...operationStep(
        env,
        input.operationId,
        nextStep,
        "destination.revision",
        input.destinationParentId,
      ),
    );
    nextStep += 1;
  }
  statements.push(
    env.DB.prepare(
      "UPDATE spaces SET tree_generation=tree_generation+1 WHERE id=?1 AND owner_id=?2 AND tree_generation=?3",
    ).bind(input.spaceId, input.userId, input.expectedTreeGeneration),
    assertChanged(env),
    ...operationStep(env, input.operationId, nextStep, "space.generation", input.spaceId),
    ...auditAndOutbox(env, input, "node.moved", input.nodeId, nextStep + 1, now),
    ...finishMutation(
      env,
      input,
      { node_id: input.nodeId, revision: input.expectedNodeRevision + 1 },
      now,
    ),
  );
  if (nextStep + 2 !== steps) {
    throw new Error("mutation_step_mismatch");
  }
  await env.DB.batch(statements);
}
