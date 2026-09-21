import type { UploadMode } from "@ncf/shared";

import type { AuthenticatedUser } from "../../auth/httpAuth.js";
import type { Env } from "../../env.js";
import { immutableBlobKey } from "../blobs.js";
import { normalizePortableName } from "../fsMutation.js";
import { getOwnedNode, getOwnerWorkspace } from "../nodes.js";
import {
  digestCapability,
  randomUploadId,
  UPLOAD_PART_SIZE,
  UPLOAD_TTL_MS,
  uploadInfo,
  uploadStub,
} from "./common.js";

export async function createUpload(
  env: Env,
  user: AuthenticatedUser,
  input: {
    parentId: string;
    targetNodeId?: string;
    name: string;
    declaredSize: number;
    mode: UploadMode;
  },
) {
  if (!Number.isSafeInteger(input.declaredSize) || input.declaredSize < 0) {
    throw new RangeError("Upload size is invalid");
  }
  if (input.declaredSize === 0 && input.mode !== "single") {
    throw new RangeError("Zero byte uploads must use single mode");
  }
  const normalized = normalizePortableName(input.name);
  const parent = await getOwnedNode(env, user.principal.userId, input.parentId);
  if (parent.kind !== "root" && parent.kind !== "folder") throw new Error("not_a_folder");
  if (input.targetNodeId !== undefined) {
    const target = await getOwnedNode(env, user.principal.userId, input.targetNodeId);
    if (target.kind !== "file" || target.parentId !== parent.id)
      throw new Error("upload_target_invalid");
  }
  const workspace = await getOwnerWorkspace(env, user.principal.userId);
  const control = await env.DB.prepare("SELECT epoch FROM control WHERE singleton=1").first<{
    epoch: number;
  }>();
  if (control === null) throw new Error("control_unavailable");
  const uploadId = randomUploadId("upl");
  const blobId = randomUploadId("blob");
  const capability = randomUploadId("ucp");
  const capabilityDigest = await digestCapability(capability);
  const now = Date.now();
  const expiresAt = now + UPLOAD_TTL_MS;
  await env.DB.batch([
    env.DB.prepare(
      "INSERT INTO _assert(v) SELECT 1 WHERE NOT EXISTS(SELECT 1 FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.id=?1 AND s.user_id=?2 AND s.revoked_at IS NULL AND s.expires_at>(strftime('%s','now')*1000) AND u.disabled_at IS NULL)",
    ).bind(user.principal.sessionId, user.principal.userId),
    env.DB.prepare(
      "UPDATE users SET reserved_bytes=reserved_bytes+?1 WHERE id=?2 AND disabled_at IS NULL AND used_bytes+reserved_bytes+?1<=quota_bytes AND (physical_bytes+reserved_bytes+?1)*10<=quota_bytes*12",
    ).bind(input.declaredSize, user.principal.userId),
    env.DB.prepare("INSERT INTO _assert(v) SELECT 1 WHERE changes()<>1"),
    env.DB.prepare(
      "INSERT INTO uploads(id,owner_id,credential_id,parent_id,target_node_id,blob_id,mode,state,declared_size,reserved_bytes,expires_at,epoch,created_at,updated_at,target_name,target_name_ci,capability_digest,part_size,uploaded_size) SELECT ?1,?2,?3,?4,?5,?6,?7,'created',?8,?8,?9,?10,?11,?11,?12,?13,?14,?15,0 WHERE EXISTS(SELECT 1 FROM nodes WHERE id=?4 AND owner_id=?2 AND space_id=?16 AND kind IN ('root','folder') AND deleted_at IS NULL)",
    ).bind(
      uploadId,
      user.principal.userId,
      user.principal.credentialId,
      input.parentId,
      input.targetNodeId ?? null,
      blobId,
      input.mode,
      input.declaredSize,
      expiresAt,
      control.epoch,
      now,
      normalized.name,
      normalized.nameCi,
      capabilityDigest,
      UPLOAD_PART_SIZE,
      workspace.spaceId,
    ),
    env.DB.prepare("INSERT INTO _assert(v) SELECT 1 WHERE changes()<>1"),
  ]);

  let multipartUploadId: string | undefined;
  if (input.mode === "multipart") {
    const multipart = await env.BLOBS.createMultipartUpload(
      immutableBlobKey(user.principal.userId, blobId),
    );
    multipartUploadId = multipart.uploadId;
  }
  const initialized = await uploadStub(env, uploadId).fetch("https://upload.internal/initialize", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      uploadId,
      mode: input.mode,
      declaredSize: input.declaredSize,
      partSize: UPLOAD_PART_SIZE,
      ...(multipartUploadId === undefined ? {} : { multipartUploadId }),
    }),
  });
  if (!initialized.ok) throw new Error("upload_state_unavailable");
  const row = {
    id: uploadId,
    ownerId: user.principal.userId,
    credentialId: user.principal.credentialId,
    parentId: input.parentId,
    targetNodeId: input.targetNodeId ?? null,
    blobId,
    mode: input.mode,
    state: "created" as const,
    declaredSize: input.declaredSize,
    reservedBytes: input.declaredSize,
    expiresAt,
    epoch: control.epoch,
    name: normalized.name,
    nameCi: normalized.nameCi,
    capabilityDigest,
    partSize: UPLOAD_PART_SIZE,
    uploadedSize: 0,
    r2Etag: null,
  };
  return uploadInfo(env, row, capability);
}
