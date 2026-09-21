import type { AuthenticatedUser } from "../../auth/httpAuth.js";
import type { Env } from "../../env.js";
import { immutableBlobKey } from "../blobs.js";
import { loadUpload, uploadStub } from "./common.js";

interface DurableStatus {
  metadata: { multipartUploadId?: string } | null;
}

export async function abortUpload(
  env: Env,
  user: AuthenticatedUser,
  uploadId: string,
  capability: string | undefined,
): Promise<void> {
  const upload = await loadUpload(env, user, uploadId, capability);
  if (upload.state === "completing") throw new Error("completing_abort_forbidden");
  if (upload.state === "completed") throw new Error("completed_abort_forbidden");
  if (upload.state === "aborted" || upload.state === "expired") return;
  const statusResponse = await uploadStub(env, upload.id).fetch("https://upload.internal/status");
  const durable: DurableStatus = statusResponse.ok
    ? await statusResponse.json()
    : { metadata: null };
  if (upload.mode === "multipart" && durable.metadata?.multipartUploadId !== undefined) {
    await env.BLOBS.resumeMultipartUpload(
      immutableBlobKey(upload.ownerId, upload.blobId),
      durable.metadata.multipartUploadId,
    ).abort();
  } else {
    await env.BLOBS.delete(immutableBlobKey(upload.ownerId, upload.blobId));
  }
  await env.DB.batch([
    env.DB.prepare(
      "DELETE FROM blobs WHERE id=?1 AND owner_id=?2 AND state='staging' AND ref_count=0",
    ).bind(upload.blobId, upload.ownerId),
    env.DB.prepare(
      "UPDATE users SET reserved_bytes=reserved_bytes-?1,physical_bytes=physical_bytes-?2 WHERE id=?3 AND reserved_bytes>=?1 AND physical_bytes>=?2",
    ).bind(upload.reservedBytes, upload.uploadedSize, upload.ownerId),
    env.DB.prepare("INSERT INTO _assert(v) SELECT 1 WHERE changes()<>1"),
    env.DB.prepare(
      "UPDATE uploads SET state='aborted',updated_at=?1 WHERE id=?2 AND state IN ('created','receiving')",
    ).bind(Date.now(), upload.id),
    env.DB.prepare("INSERT INTO _assert(v) SELECT 1 WHERE changes()<>1"),
  ]);
  await uploadStub(env, upload.id).fetch("https://upload.internal/aborted", { method: "POST" });
}
