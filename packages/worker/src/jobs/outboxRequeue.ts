import { copyBudgetExhaustedSql } from "./copyBudget";
import { COPY_EXECUTION_LIMITS } from "./copyLimits";

/** Read and commit share this predicate. Materialized stages keep D1 expression depth bounded. */
export const OUTBOX_REQUEUE_ELIGIBLE = `WITH event AS MATERIALIZED (
  SELECT b.* FROM outbox b JOIN operations o ON o.op_id=b.op_id
  JOIN control c ON c.singleton=1 WHERE b.outbox_id=? AND b.epoch=? AND c.epoch=b.epoch AND c.maintenance=0
    AND o.state='committed' AND o.epoch=b.epoch AND b.state IN ('pending','dispatching','sent')
    AND (b.dispatch_expires_at IS NULL OR b.dispatch_expires_at<=strftime('%s','now')*1000)
    AND (b.claim_expires_at IS NULL OR b.claim_expires_at<=strftime('%s','now')*1000)
  ), candidate AS MATERIALIZED (
      SELECT j.* FROM event b JOIN bulk_jobs j ON j.id=b.payload_ref AND j.op_id=b.op_id
      JOIN copy_job_manifests m ON m.job_id=j.id
      WHERE b.kind='copy.requested' AND j.kind='node.copy' AND j.epoch=b.epoch
        AND j.state IN ('pending','running') AND j.publish_op_id IS NULL AND m.expires_at>strftime('%s','now')*1000
        AND j.cleanup_expires_at<=strftime('%s','now')*1000
        AND NOT EXISTS(SELECT 1 FROM job_leases l WHERE l.job_id=j.id AND l.expires_at>strftime('%s','now')*1000)
        AND (j.r2_calls<${COPY_EXECUTION_LIMITS.r2Calls} OR NOT EXISTS(SELECT 1 FROM copy_job_blobs WHERE job_id=j.id AND transfer_state<>'stored'))
  ), affordable AS MATERIALIZED (
    SELECT j.id FROM candidate j WHERE NOT ${copyBudgetExhaustedSql("j")}
  ) SELECT 1 FROM event b WHERE b.kind<>'copy.requested' OR EXISTS (
    SELECT 1 FROM candidate j JOIN affordable a ON a.id=j.id WHERE j.id=b.payload_ref
        AND NOT EXISTS(SELECT 1 FROM copy_job_blobs cb JOIN blobs blob ON blob.id=cb.destination_blob_id
          LEFT JOIN copy_multipart_uploads mp ON mp.destination_blob_id=blob.id
          WHERE cb.job_id=j.id AND (
            EXISTS(SELECT 1 FROM r2_write_attempts WHERE r2_key=blob.r2_key AND state='pending')
            OR (cb.transfer_state='claimed' AND NOT (
              (cb.transfer_mode='single' AND EXISTS(SELECT 1 FROM r2_write_attempts w
                WHERE w.kind='copy.put' AND w.source_ref=json_array(cb.job_id,cb.source_blob_id,cb.transfer_attempt)
                  AND w.state='succeeded' AND w.owner_id=j.owner_id AND w.epoch=j.epoch AND w.r2_key=blob.r2_key))
              OR (cb.transfer_mode='multipart' AND mp.abort_attempt IS NULL AND mp.r2_upload_id IS NOT NULL AND (
                (mp.state='uploading' AND NOT EXISTS(SELECT 1 FROM copy_multipart_parts p WHERE p.destination_blob_id=blob.id AND p.state='claimed'))
                OR (mp.state='completing' AND EXISTS(SELECT 1 FROM r2_write_attempts w
                  WHERE w.kind='copy.multipart.complete' AND w.source_ref=json_array(cb.job_id,cb.source_blob_id,mp.complete_attempt)
                    AND w.state='succeeded' AND w.owner_id=j.owner_id AND w.epoch=j.epoch AND w.r2_key=blob.r2_key))
              ))
            ))
          ))
    )`;
