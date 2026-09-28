import { assertExists, type SqlStatement } from "./primary";
import type { R2WriteRequest } from "./r2Write";

// Aliases cb/j/b/m/c are shared by the selection and dispatch proofs. A prepared
// operation with missing history is unknown, even when its lease has expired.
export const COPY_MULTIPART_ABORT_READY = `
  (j.state IN ('cancelled','failed') AND j.stopped_at IS NOT NULL AND j.stop_epoch<=c.epoch AND j.publish_op_id IS NULL)
  AND (cb.transfer_mode='multipart' AND cb.transfer_state='claimed' AND m.init_attempt=cb.transfer_attempt AND m.init_claim=cb.transfer_claim)
  AND (b.owner_id=j.owner_id AND b.r2_key='u/'||j.owner_id||'/b/'||cb.destination_blob_id AND b.state='staging' AND b.ref_count=0)
  AND (m.state IN ('uploading','completing') AND m.r2_upload_id IS NOT NULL)
  AND NOT EXISTS(SELECT 1 FROM blob_storage WHERE blob_id=b.id)
  AND NOT EXISTS(SELECT 1 FROM orphan_objects WHERE r2_key=b.r2_key)
  AND NOT EXISTS(SELECT 1 FROM r2_write_attempts WHERE r2_key=b.r2_key AND state='pending')
  AND NOT EXISTS(SELECT 1 FROM r2_write_attempts WHERE r2_key=b.r2_key AND state<>'not_started'
    AND kind NOT IN ('copy.multipart.create','copy.multipart.part','multipart.abort'))
  AND EXISTS(SELECT 1 FROM r2_write_attempts w INDEXED BY r2_write_source
    WHERE w.kind='copy.multipart.create' AND w.source_ref=json_array(cb.job_id,cb.source_blob_id,m.init_attempt)
      AND w.state='succeeded' AND w.state<>'not_started' AND w.r2_key=b.r2_key AND w.owner_id=j.owner_id AND w.epoch=j.epoch)
  AND NOT EXISTS(SELECT 1 FROM copy_multipart_parts part WHERE part.destination_blob_id=m.destination_blob_id
    AND NOT(EXISTS(SELECT 1 FROM r2_write_attempts w INDEXED BY r2_write_source
      WHERE w.kind='copy.multipart.part' AND w.source_ref=json_array(cb.job_id,cb.source_blob_id,part.attempt_id)
        AND w.state='succeeded' AND w.state<>'not_started' AND w.r2_key=b.r2_key AND w.owner_id=j.owner_id AND w.epoch=j.epoch)
      OR EXISTS(SELECT 1 FROM r2_write_attempts w INDEXED BY r2_write_not_started_source
        WHERE w.kind='copy.multipart.part' AND w.source_ref=json_array(cb.job_id,cb.source_blob_id,part.attempt_id)
          AND w.state='not_started' AND w.r2_key=b.r2_key AND w.owner_id=j.owner_id AND w.epoch=j.epoch)))
  AND (m.complete_attempt IS NULL OR EXISTS(SELECT 1 FROM r2_write_attempts w INDEXED BY r2_write_not_started_source
    WHERE w.kind='copy.multipart.complete' AND w.source_ref=json_array(cb.job_id,cb.source_blob_id,m.complete_attempt)
      AND w.state='not_started' AND w.r2_key=b.r2_key AND w.owner_id=j.owner_id AND w.epoch=j.epoch))`;

export const COPY_MULTIPART_ABORT_FROM = `FROM copy_job_blobs cb JOIN bulk_jobs j ON j.id=cb.job_id
  JOIN blobs b ON b.id=cb.destination_blob_id JOIN copy_multipart_uploads m ON m.destination_blob_id=b.id
  JOIN control c ON c.singleton=1`;

export function copyAbortWriteProof(request: R2WriteRequest): SqlStatement {
  const p = request.abort!;
  return assertExists(
    `SELECT 1 ${COPY_MULTIPART_ABORT_FROM} WHERE cb.job_id=? AND cb.source_blob_id=?
      AND j.owner_id=? AND b.r2_key=? AND m.r2_upload_id=? AND m.abort_attempt=?
      AND m.abort_epoch=? AND c.epoch=m.abort_epoch AND m.abort_deadline>=?
      AND ${COPY_MULTIPART_ABORT_READY}`,
    [
      p.jobId!,
      p.sourceBlobId!,
      request.ownerId,
      request.key,
      p.r2UploadId,
      p.attemptId,
      request.epoch,
      request.deadline,
    ],
  );
}
