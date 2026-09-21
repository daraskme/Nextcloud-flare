import type { AuthenticatedUser } from "../../auth/httpAuth.js";
import type { Env } from "../../env.js";
import { acquireMutation } from "../../api/mutation.js";
import { immutableBlobKey, recordCompletedBlob } from "../blobs.js";
import { createFile, overwriteFile } from "../fileMutations.js";
import { normalizePortableName } from "../fsMutation.js";
import { NameConflictError } from "../nameConflict.js";
import { getOwnedNode, getOwnerWorkspace } from "../nodes.js";
import { loadUpload, randomUploadId, uploadInfo, uploadStub } from "./common.js";

interface DurableStatus {
  metadata: { multipartUploadId?: string; state: string } | null;
  parts: { partNumber: number; size: number; etag: string }[];
}

interface CompletionOptions {
  conflictMode?: "overwrite" | "rename";
  expectedRevision?: number;
}

interface ExistingNode {
  id: string;
  revision: number;
  kind: "root" | "folder" | "file";
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

async function conflictingNode(
  env: Env,
  parentId: string,
  nameCi: string,
): Promise<ExistingNode | null> {
  return env.DB.prepare(
    "SELECT id,revision,kind FROM nodes WHERE parent_id=?1 AND name_ci=?2 AND deleted_at IS NULL",
  )
    .bind(parentId, nameCi)
    .first<ExistingNode>();
}

function splitName(name: string): { base: string; extension: string } {
  const dot = name.lastIndexOf(".");
  return dot > 0
    ? { base: name.slice(0, dot), extension: name.slice(dot) }
    : { base: name, extension: "" };
}

async function availableName(env: Env, parentId: string, requested: string): Promise<string> {
  const normalized = normalizePortableName(requested);
  if ((await conflictingNode(env, parentId, normalized.nameCi)) === null) return normalized.name;
  const parts = splitName(normalized.name);
  for (let index = 1; index <= 1000; index += 1) {
    const candidate = normalizePortableName(`${parts.base} (${index})${parts.extension}`);
    if ((await conflictingNode(env, parentId, candidate.nameCi)) === null) return candidate.name;
  }
  throw new Error("name_conflict");
}

function assertOverwriteTarget(
  conflict: ExistingNode | null,
  expectedRevision: number | undefined,
): asserts conflict is ExistingNode & { kind: "file" } {
  if (
    conflict === null ||
    conflict.kind !== "file" ||
    !Number.isSafeInteger(expectedRevision) ||
    expectedRevision !== conflict.revision
  ) {
    if (conflict !== null) throw new NameConflictError(conflict.id, conflict.revision);
    throw new Error("upload_target_changed");
  }
}

export async function completeUpload(
  env: Env,
  user: AuthenticatedUser,
  uploadId: string,
  capability: string | undefined,
  options: CompletionOptions = {},
) {
  let upload = await loadUpload(env, user, uploadId, capability);
  if (upload.state === "completed" && upload.targetNodeId !== null) {
    return getOwnedNode(env, user.principal.userId, upload.targetNodeId);
  }
  if (upload.state !== "receiving" && upload.state !== "completing") {
    throw new Error("upload_complete_forbidden");
  }
  const conflict =
    upload.targetNodeId === null
      ? await conflictingNode(env, upload.parentId, upload.nameCi)
      : null;
  if (upload.targetNodeId === null && options.conflictMode === "overwrite") {
    assertOverwriteTarget(conflict, options.expectedRevision);
  } else if (conflict !== null && options.conflictMode !== "rename") {
    throw new NameConflictError(conflict.id, conflict.revision);
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
  const workspace = await getOwnerWorkspace(env, user.principal.userId);
  const requestedTarget =
    upload.targetNodeId === null
      ? conflict
      : await getOwnedNode(env, user.principal.userId, upload.targetNodeId);
  const target =
    requestedTarget === null
      ? null
      : await getOwnedNode(env, user.principal.userId, requestedTarget.id);
  if (options.conflictMode === "overwrite") {
    assertOverwriteTarget(
      target === null ? null : { id: target.id, revision: target.revision, kind: target.kind },
      options.expectedRevision,
    );
  }
  const lease = await acquireMutation(env, user, {
    spaceId: workspace.spaceId,
    kind:
      target === null || options.conflictMode === "rename" ? "node.create" : "node.content.write",
    expectedSteps: 7,
    intent: {
      uploadId: upload.id,
      blobId: upload.blobId,
      conflictMode: options.conflictMode ?? "fail",
    },
    nodeIds: [upload.parentId, ...(target === null ? [] : [target.id])],
  });
  const parent = await getOwnedNode(env, user.principal.userId, upload.parentId);
  const name =
    options.conflictMode === "rename"
      ? await availableName(env, parent.id, upload.name)
      : upload.name;
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
    if (target === null || options.conflictMode === "rename") {
      const lateConflict = await conflictingNode(
        env,
        upload.parentId,
        normalizePortableName(name).nameCi,
      );
      if (lateConflict !== null)
        throw new NameConflictError(lateConflict.id, lateConflict.revision);
      nodeId = randomUploadId("nod");
      await createFile(env, {
        ...common,
        nodeId,
        name,
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
    if (error instanceof NameConflictError) throw error;
    const lateConflict = await conflictingNode(env, upload.parentId, upload.nameCi);
    if (lateConflict !== null) throw new NameConflictError(lateConflict.id, lateConflict.revision);
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
