import type { UploadInfo, UploadMode, UploadPartStatus } from "@ncf/shared";

import type { AuthenticatedUser } from "../../auth/httpAuth.js";
import type { Env } from "../../env.js";

export const UPLOAD_PART_SIZE = 8 * 1024 * 1024;
export const UPLOAD_TTL_MS = 24 * 60 * 60 * 1000;

export interface UploadRow {
  id: string;
  ownerId: string;
  credentialId: string;
  parentId: string;
  targetNodeId: string | null;
  blobId: string;
  mode: UploadMode;
  state: UploadInfo["state"];
  declaredSize: number;
  reservedBytes: number;
  expiresAt: number;
  epoch: number;
  name: string;
  nameCi: string;
  capabilityDigest: string;
  partSize: number;
  uploadedSize: number;
  r2Etag: string | null;
}

export function randomUploadId(prefix: string): string {
  const bytes = new Uint8Array(18);
  crypto.getRandomValues(bytes);
  return `${prefix}_${Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}

export async function digestCapability(capability: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(capability));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function uploadStub(env: Env, uploadId: string): DurableObjectStub {
  return env.UPLOADS.get(env.UPLOADS.idFromName(uploadId));
}

export async function loadUpload(
  env: Env,
  user: AuthenticatedUser,
  uploadId: string,
  capability: string | undefined,
): Promise<UploadRow> {
  if (capability === undefined || capability.length < 32)
    throw new Error("upload_capability_required");
  const digest = await digestCapability(capability);
  const row = await env.DB.prepare(
    "SELECT id,owner_id ownerId,credential_id credentialId,parent_id parentId,target_node_id targetNodeId,blob_id blobId,mode,state,declared_size declaredSize,reserved_bytes reservedBytes,expires_at expiresAt,epoch,target_name name,target_name_ci nameCi,capability_digest capabilityDigest,part_size partSize,uploaded_size uploadedSize,r2_etag r2Etag FROM uploads WHERE id=?1 AND owner_id=?2 AND credential_id=?3 AND capability_digest=?4",
  )
    .bind(uploadId, user.principal.userId, user.principal.credentialId, digest)
    .first<UploadRow>();
  if (row === null) throw new Error("upload_not_found");
  return row;
}

export async function uploadInfo(
  env: Env,
  row: UploadRow,
  capability?: string,
): Promise<UploadInfo> {
  const response = await uploadStub(env, row.id).fetch("https://upload.internal/status");
  const durable: { parts?: UploadPartStatus[] } = response.ok
    ? await response.json()
    : { parts: [] };
  return {
    id: row.id,
    mode: row.mode,
    state: row.state,
    name: row.name,
    declaredSize: row.declaredSize,
    uploadedSize: row.uploadedSize,
    partSize: row.partSize,
    expiresAt: row.expiresAt,
    ...(capability === undefined ? {} : { capability }),
    parts: durable.parts ?? [],
  };
}
