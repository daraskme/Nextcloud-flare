-- Predict only unavoidable future work. Unknown/late native results never prove closure.
INSERT INTO _assert(v) SELECT 1 WHERE NOT EXISTS(SELECT 1 FROM control WHERE singleton=1
  AND maintenance=1 AND backup_token IS NULL AND backup_frozen=0 AND restore_freeze_token IS NULL)
  OR EXISTS(SELECT 1 FROM permits WHERE state='open') OR EXISTS(SELECT 1 FROM operations WHERE state='claimed')
  OR EXISTS(SELECT 1 FROM mutation_admissions WHERE state<>'closed');

DROP TRIGGER copy_stop_proof;
CREATE TRIGGER copy_stop_proof BEFORE UPDATE ON bulk_jobs
WHEN NEW.kind='node.copy' AND OLD.stopped_at IS NULL AND
  (NEW.stopped_at IS NOT NULL OR (OLD.state IN ('pending','running') AND NEW.state IN ('cancelled','failed')))
  AND NOT EXISTS(SELECT 1 FROM control c JOIN spaces s ON s.owner_id=NEW.owner_id
    JOIN mutation_admissions a ON a.space_id=s.id JOIN copy_job_manifests m ON m.job_id=NEW.id
    WHERE c.singleton=1 AND a.system=1 AND a.state='active' AND a.epoch=c.epoch AND a.maintenance=c.maintenance
      AND a.permit_id GLOB 'system:copy.stop:*' AND a.expires_at>strftime('%s','now')*1000
      AND OLD.state IN ('pending','running') AND OLD.publish_op_id IS NULL AND NEW.publish_op_id IS NULL
      AND NEW.stopped_at IS NOT NULL AND NEW.stop_epoch=c.epoch
      AND ((NEW.state='cancelled' AND NEW.error_code='copy_cancelled' AND NEW.epoch=c.epoch AND c.maintenance=0)
        OR (NEW.state='failed' AND ((NEW.error_code='copy_expired' AND m.expires_at<=strftime('%s','now')*1000)
          OR (NEW.error_code='stale_epoch' AND NEW.epoch<c.epoch)
          OR (NEW.error_code='copy_budget_exhausted' AND (NOT EXISTS(SELECT 1 FROM job_leases l WHERE l.job_id=NEW.id
      AND l.expires_at>strftime('%s','now')*1000)
    AND (NEW.invocation_count>=200
      OR EXISTS(SELECT 1 FROM job_leases l WHERE l.job_id=NEW.id AND l.attempt>=10)
      OR EXISTS(SELECT 1 FROM (SELECT COALESCE(SUM(CASE WHEN cb.transfer_state='pending' THEN
      CASE WHEN b.size<=8388608 THEN 2 ELSE 2+2*((b.size+94371839)/94371840) END
      WHEN m.state IN ('creating','uploading') THEN 1+2*(m.part_count-(SELECT COUNT(*) FROM copy_multipart_parts p
    WHERE p.destination_blob_id=m.destination_blob_id)) ELSE 0 END),0) AS calls,
    COALESCE(SUM(CASE WHEN cb.transfer_state='pending' THEN
      CASE WHEN b.size<=8388608 THEN 1 ELSE 2+((b.size+94371839)/94371840) END
      WHEN m.state IN ('creating','uploading') THEN 1+(m.part_count-(SELECT COUNT(*) FROM copy_multipart_parts p
    WHERE p.destination_blob_id=m.destination_blob_id)) ELSE 1 END),0) AS steps
    FROM copy_job_blobs cb CROSS JOIN blobs b ON b.id=cb.source_blob_id
    LEFT JOIN copy_multipart_uploads m ON m.destination_blob_id=cb.destination_blob_id
    WHERE cb.job_id=NEW.id AND cb.transfer_state<>'stored') remaining
        WHERE NEW.r2_calls+remaining.calls>20000
          OR remaining.calls>112*(200-NEW.invocation_count)
          OR remaining.steps>64*(200-NEW.invocation_count)))))))))
BEGIN SELECT RAISE(ABORT,'copy_stop_unproven'); END;
