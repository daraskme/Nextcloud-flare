import type { Env } from "../env.js";
import { immutableBlobKey, markStagedBlobOrphan, recordCompletedBlob } from "../services/blobs.js";
import { uploadStub } from "../services/uploads/common.js";

interface ExpiredUpload {
  id: string;
  ownerId: string;
  blobId: string;
  mode: "single" | "multipart";
  state: "created" | "receiving";
  declaredSize: number;
  reservedBytes: number;
}

interface DurableStatus {
  metadata: { multipartUploadId?: string } | null;
}

export async function reconcileExpiredUploads(
  env: Env,
  now = Date.now(),
  limit = 100,
): Promise<number> {
  const rows = await env.DB.prepare(
    "SELECT id,owner_id ownerId,blob_id blobId,mode,state,declared_size declaredSize,reserved_bytes reservedBytes FROM uploads WHERE state IN ('created','receiving') AND expires_at<=?1 ORDER BY expires_at,id LIMIT ?2",
  )
    .bind(now, limit)
    .all<ExpiredUpload>();
  for (const upload of rows.results) {
    const key = immutableBlobKey(upload.ownerId, upload.blobId);
    const object = await env.BLOBS.head(key);
    if (object !== null) {
      await recordCompletedBlob(env, {
        id: upload.blobId,
        ownerId: upload.ownerId,
        size: object.size,
        r2Etag: object.httpEtag,
      });
      await markStagedBlobOrphan(env, upload.blobId, upload.ownerId);
      await env.DB.batch([
        env.DB.prepare(
          "UPDATE uploads SET state='failed',failure_reason='expired_object_present',updated_at=?1 WHERE id=?2 AND state IN ('created','receiving')",
        ).bind(now, upload.id),
        env.DB.prepare("INSERT INTO _assert(v) SELECT 1 WHERE changes()<>1"),
      ]);
      continue;
    }
    if (upload.mode === "multipart") {
      const response = await uploadStub(env, upload.id).fetch("https://upload.internal/status");
      const status: DurableStatus = response.ok ? await response.json() : { metadata: null };
      if (status.metadata?.multipartUploadId !== undefined) {
        await env.BLOBS.resumeMultipartUpload(key, status.metadata.multipartUploadId).abort();
      }
    }
    await env.DB.batch([
      env.DB.prepare(
        "UPDATE uploads SET state='expired',updated_at=?1 WHERE id=?2 AND state IN ('created','receiving')",
      ).bind(now, upload.id),
      env.DB.prepare("INSERT INTO _assert(v) SELECT 1 WHERE changes()<>1"),
      env.DB.prepare(
        "UPDATE users SET reserved_bytes=reserved_bytes-?1 WHERE id=?2 AND reserved_bytes>=?1",
      ).bind(upload.reservedBytes, upload.ownerId),
      env.DB.prepare("INSERT INTO _assert(v) SELECT 1 WHERE changes()<>1"),
    ]);
    await uploadStub(env, upload.id).fetch("https://upload.internal/aborted", { method: "POST" });
  }
  return rows.results.length;
}
