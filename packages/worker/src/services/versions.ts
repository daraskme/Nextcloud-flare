import type { NodeVersionSummary } from "@ncf/shared";

import type { Env } from "../env.js";
import {
  assertChanged,
  auditAndOutbox,
  finishMutation,
  mutationGuards,
  operationStep,
  type UserMutationContext,
} from "./mutation.js";
import { getOwnedNode } from "./nodes.js";

interface RestoreVersionInput extends UserMutationContext {
  nodeId: string;
  parentId: string;
  versionId: string;
  replacementVersionId: string;
  expectedNodeRevision: number;
  expectedParentRevision: number;
}

export async function listVersions(
  env: Env,
  userId: string,
  nodeId: string,
): Promise<NodeVersionSummary[]> {
  const node = await getOwnedNode(env, userId, nodeId);
  if (node.kind !== "file" || node.blobId === null || node.size === null) {
    throw new Error("not_a_file");
  }
  const history = await env.DB.prepare(
    "SELECT v.id,v.blob_id blobId,b.size,v.created_at createdAt FROM node_versions v JOIN blobs b ON b.id=v.blob_id WHERE v.node_id=?1 AND b.owner_id=?2 AND b.state='committed' ORDER BY v.created_at DESC,v.id DESC LIMIT 200",
  )
    .bind(nodeId, userId)
    .all<{ id: string; blobId: string; size: number; createdAt: number }>();
  return [
    {
      id: null,
      blobId: node.blobId,
      size: node.size,
      createdAt: node.updatedAt,
      current: true,
    },
    ...history.results.map((version) => ({ ...version, current: false })),
  ];
}

export async function restoreFileVersion(env: Env, input: RestoreVersionInput): Promise<void> {
  const now = Date.now();
  await env.DB.batch([
    ...mutationGuards(env, input),
    env.DB.prepare(
      "INSERT INTO node_versions(id,node_id,blob_id,created_at,op_id) SELECT ?1,n.id,n.current_blob_id,?2,?3 FROM nodes n WHERE n.id=?4 AND n.owner_id=?5 AND n.parent_id=?6 AND n.kind='file' AND n.revision=?7 AND n.deleted_at IS NULL AND n.current_blob_id IS NOT NULL AND EXISTS(SELECT 1 FROM node_versions v JOIN blobs b ON b.id=v.blob_id WHERE v.id=?8 AND v.node_id=n.id AND b.owner_id=n.owner_id AND b.state='committed')",
    ).bind(
      input.replacementVersionId,
      now,
      input.operationId,
      input.nodeId,
      input.userId,
      input.parentId,
      input.expectedNodeRevision,
      input.versionId,
    ),
    assertChanged(env),
    ...operationStep(env, input.operationId, 1, "version.insert", input.replacementVersionId),
    env.DB.prepare(
      "UPDATE blobs SET ref_count=ref_count+1,last_op_id=?1 WHERE id=(SELECT blob_id FROM node_versions WHERE id=?2 AND node_id=?3) AND owner_id=?4 AND state='committed'",
    ).bind(input.operationId, input.versionId, input.nodeId, input.userId),
    assertChanged(env),
    ...operationStep(env, input.operationId, 2, "blob.reference", input.versionId),
    env.DB.prepare(
      "UPDATE nodes SET current_blob_id=(SELECT blob_id FROM node_versions WHERE id=?1 AND node_id=?2),revision=revision+1,updated_at=?3,last_op_id=?4 WHERE id=?2 AND owner_id=?5 AND parent_id=?6 AND revision=?7 AND deleted_at IS NULL",
    ).bind(
      input.versionId,
      input.nodeId,
      now,
      input.operationId,
      input.userId,
      input.parentId,
      input.expectedNodeRevision,
    ),
    assertChanged(env),
    env.DB.prepare("UPDATE search_index SET revision=?1 WHERE node_id=?2").bind(
      input.expectedNodeRevision + 1,
      input.nodeId,
    ),
    ...operationStep(env, input.operationId, 3, "node.version.restore", input.nodeId),
    env.DB.prepare(
      "UPDATE nodes SET revision=revision+1,updated_at=?1,last_op_id=?2 WHERE id=?3 AND owner_id=?4 AND revision=?5 AND deleted_at IS NULL",
    ).bind(now, input.operationId, input.parentId, input.userId, input.expectedParentRevision),
    assertChanged(env),
    ...operationStep(env, input.operationId, 4, "parent.revision", input.parentId),
    ...auditAndOutbox(env, input, "node.version.restored", input.nodeId, 5, now),
    ...finishMutation(
      env,
      input,
      { node_id: input.nodeId, revision: input.expectedNodeRevision + 1 },
      now,
    ),
  ]);
}
