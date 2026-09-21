import type { AuthenticatedUser } from "../../auth/httpAuth.js";
import type { Env } from "../../env.js";
import { acquireMutation } from "../../api/mutation.js";
import { immutableBlobKey, recordCompletedBlob } from "../blobs.js";
import { createFile, overwriteFile } from "../fileMutations.js";
import { getOwnedNode, getOwnerWorkspace } from "../nodes.js";
import { loadUpload, randomUploadId, uploadInfo, uploadStub } from "./common.js";

interface DurableStatus {
  metadata: { multipartUploadId?: string; state: string } | null;
  parts: { partNumber: number; size: number; etag: string }[];
}

async function durableStatus(env: Env, uploadId: string): Promise<DurableStatus> {
  const response = await uploadStub(env, uploadId).fetch("https://upload.internal/status");
  if (!response.ok) throw new Error("upload_state_unavailable");
  return response.json();
}

async function ensureCompleting(env: Env, uploadId: string): Promise<void> {
  await env.DB.batch([
    env.DB.prepare(
      "UPDATE uploads SET state='completing',updated_at=?1 WHERE id=?2 AND state='receiving' AND uploaded_size=declared_size",
    ).bind(Date.now(), uploadId),
    env.DB.prepare(
      "INSERT INTO _assert(v) SELECT 1 WHERE NOT EXISTS(SELECT 1 FROM uploads WHERE id=?1 AND state='completing')",
    ).bind(uploadId),
  ]);
}

export async function completeUpload(
  env: Env,
  user: AuthenticatedUser,
  uploadId: string,
  capability: string | undefined,
) {
  let upload = await loadUpload(env, user, uploadId, capability);
  if (upload.state === "completed" && upload.targetNodeId !== null) {
    return getOwnedNode(env, user.principal.userId, upload.targetNodeId);
  }
  if (upload.state !== "receiving" && upload.state !== "completing") {
    throw new Error("upload_complete_forbidden");
  }
  let durable = await durableStatus(env, upload.id);
  if (upload.mode === "multipart" && durable.metadata?.state !== "completing") {
    const sealed = await uploadStub(env, upload.id).fetch("https://upload.internal/seal", {
      method: "POST",
    });
    if (!sealed.ok) throw new Error("parts_incomplete");
    durable = await sealed.json();
  }
  await ensureCompleting(env, upload.id);
  upload = { ...upload, state: "completing" };

  let object = await env.BLOBS.head(immutableBlobKey(upload.ownerId, upload.blobId));
  if (object === null && upload.mode === "multipart") {
    const multipartUploadId = durable.metadata?.multipartUploadId;
    if (multipartUploadId === undefined) throw new Error("multipart_state_missing");
    const multipart = env.BLOBS.resumeMultipartUpload(
      immutableBlobKey(upload.ownerId, upload.blobId),
      multipartUploadId,
    );
    try {
      object = await multipart.complete(
        durable.parts.map((part) => ({ partNumber: part.partNumber, etag: part.etag })),
      );
    } catch {
      object = await env.BLOBS.head(immutableBlobKey(upload.ownerId, upload.blobId));
      if (object === null) throw new Error("upload_commit_unknown");
    }
  }
  if (object === null || object.size !== upload.declaredSize) {
    throw new Error("upload_object_inconsistent");
  }
  await recordCompletedBlob(env, {
    id: upload.blobId,
    ownerId: upload.ownerId,
    size: upload.declaredSize,
    r2Etag: object.httpEtag,
  });
  const parent = await getOwnedNode(env, user.principal.userId, upload.parentId);
  const workspace = await getOwnerWorkspace(env, user.principal.userId);
  const target =
    upload.targetNodeId === null
      ? null
      : await getOwnedNode(env, user.principal.userId, upload.targetNodeId);
  const lease = await acquireMutation(env, user, {
    spaceId: workspace.spaceId,
    kind: target === null ? "node.create" : "node.content.write",
    expectedSteps: 7,
    intent: { uploadId: upload.id, blobId: upload.blobId },
    nodeIds: [upload.parentId, ...(target === null ? [] : [target.id])],
  });
  const common = {
    operationId: lease.operationId,
    permitId: lease.permitId,
    epoch: lease.epoch,
    userId: user.principal.userId,
    sessionId: user.principal.sessionId,
    spaceId: workspace.spaceId,
    auditId: lease.auditId,
    outboxId: lease.outboxId,
    parentId: upload.parentId,
    blobId: upload.blobId,
    expectedParentRevision: parent.revision,
    uploadId: upload.id,
  };
  let nodeId: string;
  try {
    if (target === null) {
      nodeId = randomUploadId("nod");
      await createFile(env, {
        ...common,
        nodeId,
        name: upload.name,
        expectedTreeGeneration: workspace.treeGeneration,
      });
    } else {
      nodeId = target.id;
      await overwriteFile(env, {
        ...common,
        nodeId,
        versionId: randomUploadId("ver"),
        expectedNodeRevision: target.revision,
      });
    }
    await lease.release();
  } catch (error) {
    await lease.revoke().catch(() => undefined);
    throw error;
  }
  await uploadStub(env, upload.id).fetch("https://upload.internal/completed", { method: "POST" });
  return getOwnedNode(env, user.principal.userId, nodeId);
}

export async function getUploadStatus(
  env: Env,
  user: AuthenticatedUser,
  uploadId: string,
  capability: string | undefined,
) {
  const upload = await loadUpload(env, user, uploadId, capability);
  const info = await uploadInfo(env, upload);
  return upload.targetNodeId === null ? info : { ...info, nodeId: upload.targetNodeId };
}
