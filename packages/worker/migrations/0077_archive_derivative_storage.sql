-- Archive indices have their own immutable output proof and reuse native R2/physical accounting.
INSERT INTO _assert(v) SELECT 1 WHERE NOT EXISTS(SELECT 1 FROM control WHERE singleton=1 AND maintenance=1 AND backup_token IS NULL AND backup_frozen=0 AND restore_freeze_token IS NULL)
 OR EXISTS(SELECT 1 FROM permits WHERE state='open') OR EXISTS(SELECT 1 FROM operations WHERE state='claimed')
 OR EXISTS(SELECT 1 FROM mutation_admissions WHERE state<>'closed') OR EXISTS(SELECT 1 FROM r2_write_attempts WHERE state='pending')
 OR EXISTS(SELECT 1 FROM kdf_attempts WHERE state='claimed') OR EXISTS(SELECT 1 FROM image_transform_attempts WHERE state='pending');
CREATE TABLE _r2_write_attempts_next(
 id TEXT PRIMARY KEY CHECK(length(id)=36),
 token TEXT NOT NULL UNIQUE CHECK(length(token)=36),
 epoch INTEGER NOT NULL CHECK(epoch>0),
 owner_id TEXT CHECK(owner_id IS NULL OR length(owner_id) BETWEEN 1 AND 128),
 kind TEXT NOT NULL CHECK(kind IN ('empty.put','manifest.put','manifest.delete','blob.delete','orphan.delete','upload.put','multipart.create','multipart.part','multipart.complete','multipart.abort','bucket.abort','probe.put','backups.probe.put','backup.delete','copy.put','image.put','archive.put','copy.multipart.create','copy.multipart.part','copy.multipart.complete')),
 r2_key TEXT NOT NULL CHECK(length(CAST(r2_key AS BLOB)) BETWEEN 1 AND 1024),
 dispatch_before INTEGER NOT NULL,
 started_at INTEGER NOT NULL CHECK(started_at>=0),
 state TEXT NOT NULL CHECK(state IN ('pending','succeeded','not_started')),
 finished_at INTEGER CHECK(finished_at>=started_at),
 source_ref TEXT CHECK(source_ref IS NULL OR length(source_ref) BETWEEN 1 AND 512),
 CHECK((kind IN ('upload.put','multipart.create','multipart.part','multipart.complete','multipart.abort','bucket.abort','probe.put','backups.probe.put','backup.delete','copy.put','image.put','archive.put','copy.multipart.create','copy.multipart.part','copy.multipart.complete'))=(source_ref IS NOT NULL)),
 CHECK(dispatch_before>started_at AND dispatch_before<=started_at+5000),
 CHECK((kind IN ('orphan.delete','bucket.abort','probe.put','backups.probe.put','backup.delete'))=(owner_id IS NULL)),
 CHECK((state='pending')=(finished_at IS NULL))
) STRICT;
INSERT INTO _r2_write_attempts_next SELECT * FROM r2_write_attempts;
INSERT INTO _assert(v) SELECT 1 WHERE EXISTS(SELECT * FROM r2_write_attempts EXCEPT SELECT * FROM _r2_write_attempts_next)
 OR EXISTS(SELECT * FROM _r2_write_attempts_next EXCEPT SELECT * FROM r2_write_attempts);
DROP TRIGGER "backup_freeze_r2_write_attempts_delete";
DROP TRIGGER "backup_freeze_r2_write_attempts_insert";
DROP TRIGGER "backup_freeze_r2_write_attempts_update";
DROP TRIGGER "copy_abort_dispatch";
DROP TRIGGER "copy_abort_prepare";
DROP TRIGGER "copy_cleanup_aborted";
DROP TRIGGER "copy_cleanup_proof";
DROP TRIGGER "copy_cleanup_stored";
DROP TRIGGER "copy_cleanup_unwritten";
DROP TRIGGER "copy_job_blobs_delete";
DROP TRIGGER "copy_job_reservation_hold";
DROP TRIGGER "copy_multipart_handle";
DROP TRIGGER "copy_multipart_stored";
DROP TRIGGER "copy_native_receipt_hold";
DROP TRIGGER "copy_part_insert";
DROP TRIGGER "copy_part_stored";
DROP TRIGGER "copy_publication_ready";
DROP TRIGGER "copy_stopped_dispatch";
DROP TRIGGER "copy_transfer_stored";
DROP TRIGGER "image_cleanup_block_write";
DROP TRIGGER "image_cleanup_settle";
DROP TRIGGER "image_derivative_put";
DROP TRIGGER "image_derivative_ready";
DROP TRIGGER "image_native_receipt_hold";
DROP TRIGGER "multipart_bucket_abort_reconciliation_insert";
DROP TRIGGER "r2_write_blob_gc";
DROP TRIGGER "r2_write_dispatch";
DROP TRIGGER "r2_write_immutable";
DROP TRIGGER "r2_write_keep_receipt";
DROP TRIGGER "r2_write_orphan_gc";
DROP TRIGGER "r2_write_resume_pending";
DROP TRIGGER "r2_write_upload_cleanup";
DROP TRIGGER "r2_write_upload_reservation";
DROP TRIGGER "restore_freeze_r2_write_attempts_delete";
DROP TRIGGER "restore_freeze_r2_write_attempts_insert";
DROP TRIGGER "restore_freeze_r2_write_attempts_update";
DROP TRIGGER "restore_freeze_r2_write_pending";
DROP TABLE r2_write_attempts;
ALTER TABLE _r2_write_attempts_next RENAME TO r2_write_attempts;
CREATE INDEX r2_write_finished ON r2_write_attempts(finished_at) WHERE state<>'pending';
CREATE INDEX r2_write_key_history ON r2_write_attempts(r2_key,kind,state);
CREATE INDEX r2_write_not_started_source ON r2_write_attempts(kind,source_ref) WHERE state='not_started';
CREATE INDEX r2_write_pending ON r2_write_attempts(state,started_at);
CREATE INDEX r2_write_pending_key ON r2_write_attempts(r2_key) WHERE state='pending';
CREATE UNIQUE INDEX r2_write_source ON r2_write_attempts(kind,source_ref) WHERE source_ref IS NOT NULL AND state<>'not_started';
-- Preserve the existing trigger creation order as well as each guard definition.
CREATE TRIGGER copy_abort_dispatch BEFORE INSERT ON r2_write_attempts
WHEN NEW.kind='multipart.abort' AND NEW.state='pending'
 AND (json_extract(NEW.source_ref,'$[0]')='copy' OR EXISTS(SELECT 1 FROM copy_job_blobs cb JOIN bulk_jobs j ON j.id=cb.job_id
   WHERE NEW.r2_key='u/'||j.owner_id||'/b/'||cb.destination_blob_id))
 AND NOT EXISTS(SELECT 1 FROM copy_job_blobs cb JOIN bulk_jobs j ON j.id=cb.job_id
  JOIN blobs b ON b.id=cb.destination_blob_id JOIN copy_multipart_uploads m ON m.destination_blob_id=b.id
  JOIN control c ON c.singleton=1
 WHERE json_extract(NEW.source_ref,'$[0]')='copy' AND cb.job_id=json_extract(NEW.source_ref,'$[1]')
 AND cb.source_blob_id=json_extract(NEW.source_ref,'$[2]') AND m.abort_attempt=json_extract(NEW.source_ref,'$[3]')
 AND NEW.owner_id=j.owner_id AND NEW.r2_key=b.r2_key AND NEW.epoch=m.abort_epoch AND c.epoch=m.abort_epoch
 AND m.abort_started_at<=NEW.started_at AND m.abort_deadline>=NEW.dispatch_before
 AND
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
      AND w.state='not_started' AND w.r2_key=b.r2_key AND w.owner_id=j.owner_id AND w.epoch=j.epoch)))
BEGIN SELECT RAISE(ABORT,'copy_abort_unproven'); END;
CREATE TRIGGER copy_abort_prepare BEFORE UPDATE OF abort_attempt ON copy_multipart_uploads
WHEN OLD.abort_attempt IS NULL AND NEW.abort_attempt IS NOT NULL AND NOT EXISTS(
 SELECT 1 FROM copy_job_blobs cb JOIN bulk_jobs j ON j.id=cb.job_id
  JOIN blobs b ON b.id=cb.destination_blob_id JOIN copy_multipart_uploads m ON m.destination_blob_id=b.id
  JOIN control c ON c.singleton=1 JOIN spaces s ON s.owner_id=j.owner_id JOIN mutation_admissions a ON a.space_id=s.id
 WHERE m.destination_blob_id=OLD.destination_blob_id AND NEW.abort_epoch=c.epoch
 AND NEW.abort_started_at>=j.stopped_at AND NEW.abort_deadline>strftime('%s','now')*1000
 AND (a.system=1 AND a.state='active' AND a.epoch=c.epoch AND a.maintenance=c.maintenance
   AND a.permit_id GLOB 'system:copy.multipart-abort:*' AND a.expires_at>strftime('%s','now')*1000)
 AND
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
      AND w.state='not_started' AND w.r2_key=b.r2_key AND w.owner_id=j.owner_id AND w.epoch=j.epoch)))
BEGIN SELECT RAISE(ABORT,'copy_abort_unproven'); END;
CREATE TRIGGER copy_cleanup_aborted BEFORE INSERT ON copy_cleanup_receipts
WHEN NEW.disposition='aborted' AND NOT EXISTS(SELECT 1 FROM copy_job_blobs cb JOIN bulk_jobs j ON j.id=cb.job_id
  JOIN blobs b ON b.id=cb.destination_blob_id JOIN copy_multipart_uploads m ON m.destination_blob_id=b.id
  JOIN control c ON c.singleton=1
 WHERE cb.job_id=NEW.job_id AND cb.source_blob_id=NEW.source_blob_id
 AND m.abort_attempt IS NOT NULL AND m.abort_epoch<=c.epoch
 AND EXISTS(SELECT 1 FROM r2_write_attempts w INDEXED BY r2_write_source
   WHERE w.kind='multipart.abort' AND w.source_ref=json_array('copy',cb.job_id,cb.source_blob_id,m.abort_attempt)
     AND w.state='succeeded' AND w.state<>'not_started' AND w.r2_key=b.r2_key AND w.owner_id=j.owner_id AND w.epoch=m.abort_epoch)
 AND
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
      AND w.state='not_started' AND w.r2_key=b.r2_key AND w.owner_id=j.owner_id AND w.epoch=j.epoch)))
BEGIN SELECT RAISE(ABORT,'copy_abort_unconfirmed'); END;
CREATE TRIGGER copy_cleanup_proof BEFORE INSERT ON copy_cleanup_receipts
WHEN NOT EXISTS(SELECT 1 FROM copy_job_blobs cb JOIN bulk_jobs j ON j.id=cb.job_id
  JOIN copy_job_manifests manifest ON manifest.job_id=j.id JOIN blobs source ON source.id=cb.source_blob_id
  JOIN blob_pins pin ON pin.pin_id=cb.pin_id JOIN reservations r ON r.id=cb.reservation_id
  JOIN control c ON c.singleton=1 JOIN spaces sp ON sp.owner_id=j.owner_id
  JOIN mutation_admissions a ON a.space_id=sp.id
  LEFT JOIN blobs b ON b.id=cb.destination_blob_id
  WHERE cb.job_id=NEW.job_id AND cb.source_blob_id=NEW.source_blob_id
    AND (cb.destination_blob_id=NEW.destination_blob_id AND cb.pin_id=NEW.pin_id AND cb.reservation_id=NEW.reservation_id)
    AND (source.size=NEW.bytes AND pin.blob_id=source.id AND pin.purpose='copy' AND pin.expires_at=manifest.expires_at)
    AND (r.state='reserved' AND r.owner_id=j.owner_id AND r.bytes=NEW.bytes AND r.epoch=j.epoch
      AND r.expires_at=manifest.expires_at AND r.share_id IS NULL AND r.op_id IS NULL)
    AND (j.state IN ('cancelled','failed') AND j.stopped_at IS NOT NULL AND j.publish_op_id IS NULL)
    AND (NEW.epoch=c.epoch AND j.stop_epoch<=c.epoch AND NEW.settled_at>=j.stopped_at
      AND a.system=1 AND a.state='active' AND a.epoch=c.epoch AND a.maintenance=c.maintenance
      AND a.permit_id GLOB 'system:copy.cleanup:*' AND a.expires_at>strftime('%s','now')*1000)
    AND (b.id IS NULL OR (b.owner_id=j.owner_id AND b.r2_key='u/'||j.owner_id||'/b/'||b.id
      AND b.state='staging' AND b.ref_count=0 AND b.size=NEW.bytes))
    AND NOT EXISTS(SELECT 1 FROM blob_pins WHERE blob_id=cb.destination_blob_id)
    AND NOT EXISTS(SELECT 1 FROM gc_candidates WHERE blob_id=cb.destination_blob_id)
    AND NOT EXISTS(SELECT 1 FROM r2_write_attempts w WHERE w.r2_key='u/'||j.owner_id||'/b/'||cb.destination_blob_id AND w.state='pending'))
BEGIN SELECT RAISE(ABORT,'copy_cleanup_unproven'); END;
CREATE TRIGGER copy_cleanup_stored BEFORE INSERT ON copy_cleanup_receipts
WHEN NEW.disposition='stored' AND NOT EXISTS(SELECT 1 FROM copy_job_blobs cb JOIN bulk_jobs j ON j.id=cb.job_id
  JOIN blobs b ON b.id=cb.destination_blob_id JOIN blob_storage s ON s.blob_id=b.id
  LEFT JOIN copy_multipart_uploads m ON m.destination_blob_id=b.id
  WHERE cb.job_id=NEW.job_id AND cb.source_blob_id=NEW.source_blob_id AND cb.transfer_state='stored'
    AND s.bytes=b.size AND s.removed_at IS NULL
    AND ((cb.transfer_mode='single' AND b.sha256_verified=cb.transfer_sha256)
      OR (cb.transfer_mode='multipart' AND m.state='stored' AND m.object_etag=s.r2_etag AND b.sha256_verified IS NULL))
    AND EXISTS(SELECT 1 FROM r2_write_attempts w INDEXED BY r2_write_source
      WHERE w.kind=CASE cb.transfer_mode WHEN 'single' THEN 'copy.put' ELSE 'copy.multipart.complete' END
        AND w.source_ref=json_array(cb.job_id,cb.source_blob_id,CASE cb.transfer_mode WHEN 'single' THEN cb.transfer_attempt ELSE m.complete_attempt END)
        AND w.state='succeeded' AND w.state<>'not_started' AND w.r2_key=b.r2_key AND w.owner_id=j.owner_id))
BEGIN SELECT RAISE(ABORT,'copy_stored_unproven'); END;
CREATE TRIGGER copy_cleanup_unwritten BEFORE INSERT ON copy_cleanup_receipts
WHEN NEW.disposition='unwritten' AND NOT EXISTS(SELECT 1 FROM copy_job_blobs cb JOIN bulk_jobs j ON j.id=cb.job_id
  WHERE cb.job_id=NEW.job_id AND cb.source_blob_id=NEW.source_blob_id
    AND NOT EXISTS(SELECT 1 FROM blob_storage WHERE blob_id=cb.destination_blob_id)
    AND NOT EXISTS(SELECT 1 FROM r2_write_attempts w WHERE w.r2_key='u/'||j.owner_id||'/b/'||cb.destination_blob_id AND w.state<>'not_started')
    AND ((cb.transfer_state='pending' AND NOT EXISTS(SELECT 1 FROM blobs WHERE id=cb.destination_blob_id))
      OR (cb.transfer_state='claimed' AND EXISTS(SELECT 1 FROM r2_write_attempts w
        WHERE w.kind=CASE cb.transfer_mode WHEN 'single' THEN 'copy.put' ELSE 'copy.multipart.create' END
          AND w.source_ref=json_array(cb.job_id,cb.source_blob_id,cb.transfer_attempt)
          AND w.r2_key='u/'||j.owner_id||'/b/'||cb.destination_blob_id AND w.state='not_started')))
    AND NOT EXISTS(SELECT 1 FROM copy_multipart_uploads m WHERE m.destination_blob_id=cb.destination_blob_id AND m.state<>'creating')
    AND NOT EXISTS(SELECT 1 FROM copy_multipart_parts WHERE destination_blob_id=cb.destination_blob_id))
BEGIN SELECT RAISE(ABORT,'copy_unwritten_unproven'); END;
CREATE TRIGGER copy_job_blobs_delete BEFORE DELETE ON copy_job_blobs
WHEN (NOT EXISTS(SELECT 1 FROM bulk_jobs j JOIN operations o ON o.op_id=j.publish_op_id
  JOIN blobs b ON b.id=OLD.destination_blob_id JOIN reservations r ON r.id=OLD.reservation_id
  WHERE j.id=OLD.job_id AND j.state='completed' AND o.kind='copy.publish' AND o.state='committed'
    AND b.state='committed' AND b.ref_count>0 AND r.state='released'
    AND NOT EXISTS(SELECT 1 FROM r2_write_attempts w WHERE w.r2_key=b.r2_key AND w.state='pending'))) AND NOT EXISTS(SELECT 1 FROM copy_cleanup_receipts x JOIN reservations r ON r.id=x.reservation_id
 LEFT JOIN blobs b ON b.id=x.destination_blob_id WHERE x.job_id=OLD.job_id AND x.source_blob_id=OLD.source_blob_id
 AND x.destination_blob_id=OLD.destination_blob_id AND x.pin_id=OLD.pin_id AND x.reservation_id=OLD.reservation_id AND r.state='released'
 AND NOT EXISTS(SELECT 1 FROM copy_multipart_uploads WHERE destination_blob_id=x.destination_blob_id)
 AND ((x.disposition IN ('unwritten','aborted') AND (b.id IS NULL OR b.state='deleted')
   AND NOT EXISTS(SELECT 1 FROM blob_storage WHERE blob_id=x.destination_blob_id))
 OR (x.disposition='stored' AND b.state='orphan' AND b.ref_count=0
   AND EXISTS(SELECT 1 FROM gc_candidates g JOIN blob_storage s ON s.blob_id=g.blob_id
     WHERE g.blob_id=b.id AND g.state='candidate' AND s.bytes=x.bytes AND s.removed_at IS NULL))))
BEGIN SELECT RAISE(ABORT,'copy_hold_unsettled'); END;
CREATE TRIGGER copy_job_reservation_hold BEFORE UPDATE ON reservations
WHEN (EXISTS(SELECT 1 FROM copy_job_blobs WHERE reservation_id=OLD.id) AND (
  NEW.id<>OLD.id OR NEW.owner_id<>OLD.owner_id OR NEW.bytes<>OLD.bytes OR NEW.epoch<>OLD.epoch
  OR NEW.expires_at<>OLD.expires_at OR NEW.share_id IS NOT OLD.share_id OR NEW.op_id IS NOT OLD.op_id
  OR (NEW.state<>OLD.state AND NOT EXISTS(
    SELECT 1 FROM copy_job_blobs cb JOIN bulk_jobs j ON j.id=cb.job_id
      JOIN operations o ON o.op_id=j.publish_op_id JOIN permits p ON p.permit_id=o.permit_id
      JOIN blobs b ON b.id=cb.destination_blob_id JOIN control c ON c.singleton=1
    WHERE cb.reservation_id=OLD.id AND cb.transfer_state='stored' AND j.state='running'
      AND OLD.state='reserved' AND NEW.state='released' AND o.kind='copy.publish' AND o.state='claimed'
      AND o.epoch=j.epoch AND c.epoch=j.epoch AND c.maintenance=0
      AND p.state='open' AND p.expires_at>strftime('%s','now')*1000
      AND NOT EXISTS(SELECT 1 FROM r2_write_attempts w WHERE w.r2_key=b.r2_key AND w.state='pending'))))) AND NOT EXISTS(SELECT 1 FROM copy_cleanup_receipts x JOIN copy_job_blobs cb
 ON cb.job_id=x.job_id AND cb.source_blob_id=x.source_blob_id WHERE x.reservation_id=OLD.id AND cb.reservation_id=OLD.id
 AND NEW.id=OLD.id AND NEW.owner_id=OLD.owner_id AND NEW.bytes=OLD.bytes AND NEW.epoch=OLD.epoch
 AND NEW.expires_at=OLD.expires_at AND NEW.share_id IS OLD.share_id AND NEW.op_id IS OLD.op_id
 AND OLD.state='reserved' AND NEW.state='released')
BEGIN SELECT RAISE(ABORT,'copy_reservation_held'); END;
CREATE TRIGGER copy_multipart_handle BEFORE UPDATE OF r2_upload_id ON copy_multipart_uploads WHEN NEW.r2_upload_id IS NOT NULL AND NOT EXISTS(
  SELECT 1 FROM copy_job_blobs cb JOIN blobs b ON b.id=cb.destination_blob_id JOIN r2_write_attempts w ON w.r2_key=b.r2_key
  WHERE cb.destination_blob_id=NEW.destination_blob_id AND w.kind='copy.multipart.create' AND w.state IN ('pending','succeeded')
    AND w.source_ref=json_array(cb.job_id,cb.source_blob_id,NEW.init_attempt))
BEGIN SELECT RAISE(ABORT,'copy_write_receipt_required'); END;
CREATE TRIGGER copy_multipart_stored BEFORE UPDATE OF state ON copy_multipart_uploads
WHEN NEW.state='stored' AND NOT EXISTS(
  SELECT 1 FROM copy_job_blobs cb JOIN blobs b ON b.id=cb.destination_blob_id
    JOIN blob_storage s ON s.blob_id=b.id JOIN r2_write_attempts w ON w.r2_key=b.r2_key
  WHERE cb.destination_blob_id=NEW.destination_blob_id AND b.state='staging'
    AND s.bytes=b.size AND s.r2_etag=NEW.object_etag AND s.removed_at IS NULL
    AND w.kind='copy.multipart.complete' AND w.state IN ('pending','succeeded')
    AND w.source_ref=json_array(cb.job_id,cb.source_blob_id,NEW.complete_attempt))
BEGIN SELECT RAISE(ABORT,'copy_write_receipt_required'); END;
CREATE TRIGGER copy_native_receipt_hold BEFORE DELETE ON r2_write_attempts
WHEN EXISTS(SELECT 1 FROM copy_job_blobs cb JOIN bulk_jobs j ON j.id=cb.job_id
  WHERE OLD.r2_key='u/'||j.owner_id||'/b/'||cb.destination_blob_id)
BEGIN SELECT RAISE(ABORT,'copy_native_receipt_held'); END;
CREATE TRIGGER copy_part_insert BEFORE INSERT ON copy_multipart_parts WHEN NEW.state<>'claimed' OR NOT EXISTS(
  SELECT 1 FROM copy_multipart_uploads m JOIN blobs b ON b.id=m.destination_blob_id
    JOIN copy_job_blobs cb ON cb.destination_blob_id=m.destination_blob_id
  WHERE m.destination_blob_id=NEW.destination_blob_id AND m.state='uploading' AND NEW.part_number<=m.part_count
    AND NEW.expected_size=MIN(m.part_bytes,b.size-(NEW.part_number-1)*m.part_bytes)
    AND NEW.part_number=1+COALESCE((SELECT MAX(part_number) FROM copy_multipart_parts WHERE destination_blob_id=m.destination_blob_id),0)
    AND EXISTS(SELECT 1 FROM r2_write_attempts w WHERE w.kind='copy.multipart.create' AND w.r2_key=b.r2_key
      AND w.source_ref=json_array(cb.job_id,cb.source_blob_id,m.init_attempt) AND w.state='succeeded')
    AND (NEW.part_number=1 OR EXISTS(SELECT 1 FROM copy_multipart_parts p JOIN r2_write_attempts w
      ON w.kind='copy.multipart.part' AND w.source_ref=json_array(cb.job_id,cb.source_blob_id,p.attempt_id)
      WHERE p.destination_blob_id=m.destination_blob_id AND p.part_number=NEW.part_number-1 AND p.state='stored' AND w.state='succeeded')))
BEGIN SELECT RAISE(ABORT,'invalid_copy_part'); END;
CREATE TRIGGER copy_part_stored BEFORE UPDATE OF state ON copy_multipart_parts WHEN NEW.state='stored' AND NOT EXISTS(
  SELECT 1 FROM copy_job_blobs cb JOIN blobs b ON b.id=cb.destination_blob_id JOIN r2_write_attempts w ON w.r2_key=b.r2_key
  WHERE cb.destination_blob_id=NEW.destination_blob_id AND w.kind='copy.multipart.part' AND w.state IN ('pending','succeeded')
    AND w.source_ref=json_array(cb.job_id,cb.source_blob_id,NEW.attempt_id))
BEGIN SELECT RAISE(ABORT,'copy_write_receipt_required'); END;
CREATE TRIGGER copy_publication_ready BEFORE UPDATE OF publish_op_id ON bulk_jobs
WHEN OLD.publish_op_id IS NULL AND NEW.publish_op_id IS NOT NULL AND NOT EXISTS(
  SELECT 1 FROM copy_job_manifests m WHERE m.job_id=NEW.id
    AND NEW.blob_count=(SELECT COUNT(*) FROM copy_job_blobs WHERE job_id=NEW.id)
    AND NOT EXISTS(SELECT 1 FROM copy_job_blobs cb JOIN blobs b ON b.id=cb.destination_blob_id
      JOIN r2_write_attempts w ON w.r2_key=b.r2_key WHERE cb.job_id=NEW.id AND w.state='pending')
    AND NEW.blob_count=(SELECT COUNT(*) FROM copy_job_blobs cb
      JOIN blobs b ON b.id=cb.destination_blob_id JOIN blobs source ON source.id=cb.source_blob_id
      JOIN blob_storage s ON s.blob_id=b.id JOIN blob_pins pin ON pin.pin_id=cb.pin_id
      JOIN reservations r ON r.id=cb.reservation_id LEFT JOIN copy_multipart_uploads mp ON mp.destination_blob_id=b.id
      WHERE cb.job_id=NEW.id AND cb.transfer_state='stored' AND b.state='staging' AND b.ref_count=0
        AND b.owner_id=NEW.owner_id AND b.size=source.size AND s.bytes=b.size AND s.removed_at IS NULL
        AND pin.blob_id=source.id AND pin.purpose='copy' AND pin.expires_at=m.expires_at
        AND r.owner_id=NEW.owner_id AND r.bytes=b.size AND r.state='reserved' AND r.epoch=NEW.epoch
        AND ((cb.transfer_mode='single' AND b.sha256_verified=cb.transfer_sha256)
          OR (cb.transfer_mode='multipart' AND mp.state='stored' AND mp.object_etag=s.r2_etag AND b.sha256_verified IS NULL))
        AND EXISTS(SELECT 1 FROM r2_write_attempts w INDEXED BY r2_write_source
          WHERE w.kind=CASE cb.transfer_mode WHEN 'single' THEN 'copy.put' ELSE 'copy.multipart.complete' END
            AND w.source_ref=json_array(cb.job_id,cb.source_blob_id,CASE cb.transfer_mode WHEN 'single' THEN cb.transfer_attempt ELSE mp.complete_attempt END)
            AND w.state='succeeded' AND w.state<>'not_started' AND w.r2_key=b.r2_key AND w.owner_id=NEW.owner_id)))
BEGIN SELECT RAISE(ABORT,'copy_publication_unproven'); END;
CREATE TRIGGER copy_stopped_dispatch BEFORE INSERT ON r2_write_attempts
WHEN NEW.state='pending' AND NEW.kind IN ('copy.put','copy.multipart.create','copy.multipart.part','copy.multipart.complete')
  AND NOT EXISTS(SELECT 1 FROM copy_job_blobs cb JOIN bulk_jobs j ON j.id=cb.job_id
    WHERE cb.job_id=json_extract(NEW.source_ref,'$[0]') AND cb.source_blob_id=json_extract(NEW.source_ref,'$[1]')
      AND j.state='running' AND j.epoch=NEW.epoch AND j.owner_id=NEW.owner_id
      AND NEW.r2_key='u/'||j.owner_id||'/b/'||cb.destination_blob_id)
BEGIN SELECT RAISE(ABORT,'copy_stopped'); END;
CREATE TRIGGER copy_transfer_stored BEFORE UPDATE OF transfer_state ON copy_job_blobs
WHEN NEW.transfer_state='stored' AND NOT EXISTS(
  SELECT 1 FROM blobs b JOIN blob_storage s ON s.blob_id=b.id JOIN bulk_jobs j ON j.id=NEW.job_id
  WHERE b.id=NEW.destination_blob_id AND b.owner_id=j.owner_id AND b.state='staging' AND s.bytes=b.size AND s.removed_at IS NULL
    AND ((NEW.transfer_mode='single' AND b.sha256_verified=NEW.transfer_sha256 AND EXISTS(
      SELECT 1 FROM r2_write_attempts w WHERE w.kind='copy.put' AND w.state IN ('pending','succeeded')
        AND w.r2_key=b.r2_key AND w.source_ref=json_array(NEW.job_id,NEW.source_blob_id,NEW.transfer_attempt)))
    OR (NEW.transfer_mode='multipart' AND b.sha256_verified IS NULL AND NEW.transfer_sha256 IS NULL AND EXISTS(
      SELECT 1 FROM copy_multipart_uploads m JOIN r2_write_attempts w ON w.r2_key=b.r2_key
      WHERE m.destination_blob_id=b.id AND m.state='stored' AND m.object_etag=s.r2_etag
        AND w.kind='copy.multipart.complete' AND w.state IN ('pending','succeeded')
        AND w.source_ref=json_array(NEW.job_id,NEW.source_blob_id,m.complete_attempt)))))
BEGIN SELECT RAISE(ABORT,'copy_write_receipt_required'); END;
CREATE TRIGGER multipart_bucket_abort_reconciliation_insert BEFORE INSERT ON multipart_bucket_abort_reconciliations
WHEN NOT EXISTS(
 SELECT 1 FROM multipart_bucket_abort_attempts a
 JOIN multipart_bucket_handles h ON h.id=a.handle_id
 JOIN r2_write_attempts r ON r.id=NEW.native_id
 JOIN control c ON c.singleton=1 JOIN r2_binding_probe p ON p.singleton=c.singleton
 WHERE a.id=NEW.attempt_id AND a.outcome IN ('started','unconfirmed')
 AND r.kind='bucket.abort' AND r.owner_id IS NULL AND r.r2_key=h.r2_key
 AND r.source_ref=json_array('bucket',h.id,a.id,NULL) AND r.epoch=a.epoch AND r.state='succeeded'
 AND NEW.epoch=c.epoch AND a.epoch<=c.epoch AND c.maintenance=1 AND c.gc_paused=1
 AND p.epoch=c.epoch AND p.source=h.source AND p.phase='verified'
 AND p.lease_token IS NOT NULL AND p.lease_expires_at>strftime('%s','now')*1000
 AND NOT EXISTS(SELECT 1 FROM r2_write_attempts WHERE state='pending'))
BEGIN SELECT RAISE(ABORT,'multipart_abort_reconciliation_unproven'); END;
CREATE TRIGGER r2_write_blob_gc BEFORE UPDATE OF state ON blobs
WHEN NEW.state IN ('deleting','deleted') AND EXISTS(SELECT 1 FROM r2_write_attempts WHERE r2_key=NEW.r2_key AND state='pending')
BEGIN SELECT RAISE(ABORT,'r2_write_unsettled'); END;
CREATE TRIGGER r2_write_dispatch BEFORE INSERT ON r2_write_attempts
WHEN NEW.state='pending' AND (
 NEW.dispatch_before<=strftime('%s','now')*1000+1000
 OR NOT EXISTS(SELECT 1 FROM control WHERE singleton=1 AND epoch=NEW.epoch
   AND (NEW.kind IN ('manifest.delete','blob.delete','orphan.delete','multipart.abort','bucket.abort','probe.put','backups.probe.put','backup.delete') OR maintenance=0) AND backup_token IS NULL AND backup_frozen=0 AND restore_freeze_token IS NULL)
 OR (NEW.kind='empty.put' AND (EXISTS(SELECT 1 FROM blobs WHERE r2_key=NEW.r2_key AND state IN ('orphan','deleting','deleted'))
   OR EXISTS(SELECT 1 FROM orphan_objects WHERE r2_key=NEW.r2_key)))
 OR (NEW.kind='manifest.put' AND EXISTS(SELECT 1 FROM r2_write_attempts WHERE r2_key=NEW.r2_key))
 OR (SELECT COUNT(*) FROM r2_write_attempts WHERE state='pending')>=32)
BEGIN SELECT RAISE(ABORT,'r2_write_unavailable'); END;
CREATE TRIGGER r2_write_immutable BEFORE UPDATE ON r2_write_attempts
WHEN OLD.state<>'pending' OR NEW.state='pending' OR NEW.id IS NOT OLD.id OR NEW.token IS NOT OLD.token
 OR NEW.epoch IS NOT OLD.epoch OR NEW.owner_id IS NOT OLD.owner_id OR NEW.kind IS NOT OLD.kind
 OR NEW.source_ref IS NOT OLD.source_ref OR NEW.r2_key IS NOT OLD.r2_key OR NEW.dispatch_before IS NOT OLD.dispatch_before OR NEW.started_at IS NOT OLD.started_at
BEGIN SELECT RAISE(ABORT,'immutable_r2_write'); END;
CREATE TRIGGER r2_write_keep_receipt BEFORE DELETE ON r2_write_attempts
WHEN OLD.state='pending' OR OLD.finished_at>strftime('%s','now')*1000-86400000
BEGIN SELECT RAISE(ABORT,'r2_write_receipt_required'); END;
CREATE TRIGGER r2_write_orphan_gc BEFORE UPDATE OF state ON orphan_objects
WHEN NEW.state IN ('deleting','deleted') AND EXISTS(SELECT 1 FROM r2_write_attempts WHERE r2_key=NEW.r2_key AND state='pending')
BEGIN SELECT RAISE(ABORT,'r2_write_unsettled'); END;
CREATE TRIGGER r2_write_resume_pending BEFORE UPDATE OF maintenance ON control
WHEN NEW.maintenance=0 AND OLD.maintenance=1 AND EXISTS(SELECT 1 FROM r2_write_attempts WHERE state='pending')
BEGIN SELECT RAISE(ABORT,'r2_write_unsettled'); END;
CREATE TRIGGER r2_write_upload_cleanup BEFORE UPDATE OF cleanup_pending ON uploads
WHEN OLD.cleanup_pending=1 AND NEW.cleanup_pending=0 AND EXISTS(
 SELECT 1 FROM blobs b JOIN r2_write_attempts w ON w.r2_key=b.r2_key WHERE b.id=NEW.blob_id AND w.state='pending')
BEGIN SELECT RAISE(ABORT,'r2_write_unsettled'); END;
CREATE TRIGGER r2_write_upload_reservation BEFORE UPDATE OF state ON reservations
WHEN OLD.state='reserved' AND NEW.state='released' AND EXISTS(
 SELECT 1 FROM uploads u JOIN blobs b ON b.id=u.blob_id JOIN r2_write_attempts w ON w.r2_key=b.r2_key
 WHERE u.reservation_id=OLD.id AND w.state='pending')
BEGIN SELECT RAISE(ABORT,'r2_write_unsettled'); END;
CREATE TRIGGER restore_freeze_r2_write_pending BEFORE UPDATE OF restore_freeze_token ON control
WHEN NEW.restore_freeze_token IS NOT NULL AND EXISTS(SELECT 1 FROM r2_write_attempts WHERE state='pending')
BEGIN SELECT RAISE(ABORT,'restore_freeze_not_drained'); END;
CREATE TRIGGER image_derivative_ready BEFORE UPDATE OF state ON derivative_results
WHEN NEW.state='ready' AND EXISTS(SELECT 1 FROM image_derivative_objects WHERE result_id=NEW.id)
 AND NOT EXISTS(SELECT 1 FROM image_derivative_objects x JOIN image_transform_attempts t ON t.id=x.id
 JOIN blobs b ON b.id=x.output_blob_id JOIN blob_storage s ON s.blob_id=b.id JOIN blob_pins p ON p.pin_id=x.pin_id
 WHERE x.result_id=NEW.id AND x.state='stored' AND b.state='committed' AND s.removed_at IS NULL
 AND b.size=s.bytes AND b.size=NEW.size AND b.r2_key=NEW.r2_key AND s.r2_etag=b.r2_etag
 AND b.sha256_verified=json_extract(t.output_json,'$.sha256') AND p.blob_id=b.id
 AND EXISTS(SELECT 1 FROM r2_write_attempts w WHERE w.kind='image.put' AND w.state='succeeded'
 AND w.source_ref=json_array(x.id,x.write_attempt_id) AND w.r2_key=b.r2_key AND w.owner_id=x.owner_id AND w.epoch=t.epoch)
 AND NOT EXISTS(SELECT 1 FROM r2_write_attempts WHERE r2_key=b.r2_key AND state='pending'))
BEGIN SELECT RAISE(ABORT,'image_derivative_unproven'); END;
CREATE TRIGGER image_derivative_put BEFORE INSERT ON r2_write_attempts
WHEN NEW.kind='image.put' AND NEW.state='pending' AND (
 NOT EXISTS(SELECT 1 FROM image_derivative_objects x JOIN image_transform_attempts t ON t.id=x.id
 JOIN blobs b ON b.id=x.output_blob_id JOIN reservations r ON r.id=x.reservation_id
 WHERE NEW.source_ref=json_array(x.id,x.write_attempt_id) AND x.state='prepared' AND t.state='succeeded'
 AND x.owner_id=NEW.owner_id AND t.epoch=NEW.epoch AND b.r2_key=NEW.r2_key AND b.state='staging'
 AND r.state='reserved' AND r.physical_only=1 AND r.bytes=b.size AND t.expires_at>=NEW.dispatch_before
 AND NOT EXISTS(SELECT 1 FROM blob_storage WHERE blob_id=b.id))
 OR EXISTS(SELECT 1 FROM r2_write_attempts WHERE r2_key=NEW.r2_key AND state<>'not_started'))
BEGIN SELECT RAISE(ABORT,'image_derivative_write_unavailable'); END;
CREATE TRIGGER image_native_receipt_hold BEFORE DELETE ON r2_write_attempts
WHEN EXISTS(SELECT 1 FROM image_derivative_objects x JOIN blobs b ON b.id=x.output_blob_id
 WHERE b.r2_key=OLD.r2_key)
BEGIN SELECT RAISE(ABORT,'image_native_receipt_held'); END;
CREATE TRIGGER image_cleanup_block_write BEFORE INSERT ON r2_write_attempts
WHEN NEW.kind='image.put' AND NEW.state='pending' AND EXISTS(
 SELECT 1 FROM image_derivative_cleanup WHERE image_id=json_extract(NEW.source_ref,'$[0]') AND retired_at IS NOT NULL)
BEGIN SELECT RAISE(ABORT,'image_derivative_retired'); END;
CREATE TRIGGER image_cleanup_settle BEFORE UPDATE OF settled_at ON image_derivative_cleanup
WHEN NEW.settled_at IS NOT NULL AND NOT EXISTS(
 SELECT 1 FROM image_derivative_objects x JOIN blobs b ON b.id=x.output_blob_id
 JOIN reservations r ON r.id=x.reservation_id JOIN blob_pins p ON p.pin_id=x.pin_id
 JOIN derivative_results d ON d.id=x.result_id JOIN control c ON c.singleton=1
 JOIN spaces sp ON sp.owner_id=x.owner_id JOIN mutation_admissions a ON a.space_id=sp.id
 WHERE x.id=NEW.image_id AND NEW.retired_at IS NOT NULL AND NEW.seal_token IS NOT NULL
 AND NEW.claim_epoch=c.epoch AND NEW.claim_deadline>strftime('%s','now')*1000
 AND a.system=1 AND a.state='active' AND a.epoch=c.epoch AND a.maintenance=c.maintenance
 AND a.permit_id GLOB 'system:image.cleanup:*' AND a.expires_at>strftime('%s','now')*1000
 AND d.state='failed' AND d.error_code='image_retired' AND b.state IN ('staging','committed') AND b.ref_count=1
 AND p.blob_id=b.id AND p.purpose='job' AND p.expires_at IS NULL AND r.physical_only=1 AND r.state IN ('reserved','released')
 AND NOT EXISTS(SELECT 1 FROM r2_write_attempts WHERE r2_key=b.r2_key AND state='pending')
 AND ((NEW.disposition='stored' AND EXISTS(SELECT 1 FROM blob_storage s WHERE s.blob_id=b.id AND s.removed_at IS NULL))
 OR (NEW.disposition='absent' AND NEW.head_token=NEW.claim_token AND NEW.head_calls>0
   AND NOT EXISTS(SELECT 1 FROM blob_storage WHERE blob_id=b.id))))
BEGIN SELECT RAISE(ABORT,'image_cleanup_unproven'); END;
CREATE TRIGGER backup_freeze_r2_write_attempts_insert BEFORE INSERT ON r2_write_attempts
WHEN (SELECT backup_frozen FROM control WHERE singleton=1)=1
BEGIN SELECT RAISE(ABORT,'backup_frozen'); END;
CREATE TRIGGER backup_freeze_r2_write_attempts_update BEFORE UPDATE ON r2_write_attempts
WHEN (SELECT backup_frozen FROM control WHERE singleton=1)=1
BEGIN SELECT RAISE(ABORT,'backup_frozen'); END;
CREATE TRIGGER backup_freeze_r2_write_attempts_delete BEFORE DELETE ON r2_write_attempts
WHEN (SELECT backup_frozen FROM control WHERE singleton=1)=1
BEGIN SELECT RAISE(ABORT,'backup_frozen'); END;
CREATE TRIGGER restore_freeze_r2_write_attempts_insert BEFORE INSERT ON r2_write_attempts
WHEN (SELECT restore_freeze_token FROM control WHERE singleton=1) IS NOT NULL
BEGIN SELECT RAISE(ABORT,'database_restore_frozen'); END;
CREATE TRIGGER restore_freeze_r2_write_attempts_update BEFORE UPDATE ON r2_write_attempts
WHEN (SELECT restore_freeze_token FROM control WHERE singleton=1) IS NOT NULL
BEGIN SELECT RAISE(ABORT,'database_restore_frozen'); END;
CREATE TRIGGER restore_freeze_r2_write_attempts_delete BEFORE DELETE ON r2_write_attempts
WHEN (SELECT restore_freeze_token FROM control WHERE singleton=1) IS NOT NULL
BEGIN SELECT RAISE(ABORT,'database_restore_frozen'); END;

-- Archive artifact records follow.
CREATE TABLE archive_derivative_objects(
 id TEXT PRIMARY KEY CHECK(length(id)=36),
 owner_id TEXT NOT NULL REFERENCES users(id), source_blob_id TEXT NOT NULL REFERENCES blobs(id),
 output_blob_id TEXT NOT NULL UNIQUE REFERENCES blobs(id), result_id TEXT NOT NULL UNIQUE REFERENCES derivative_results(id),
 reservation_id TEXT NOT NULL UNIQUE REFERENCES reservations(id), pin_id TEXT NOT NULL UNIQUE,
 write_attempt_id TEXT NOT NULL UNIQUE CHECK(length(write_attempt_id)=36),
 outbox_id TEXT NOT NULL CHECK(length(outbox_id) BETWEEN 1 AND 128),
 claim_token TEXT NOT NULL CHECK(length(claim_token)=36), epoch INTEGER NOT NULL CHECK(epoch>0),
 source_json TEXT NOT NULL CHECK(json_valid(source_json) AND length(CAST(source_json AS BLOB))<=2048),
 output_json TEXT NOT NULL CHECK(json_valid(output_json) AND length(CAST(output_json AS BLOB))<=512),
 generator_version TEXT NOT NULL CHECK(generator_version='archive-index-v1'),
 created_at INTEGER NOT NULL CHECK(created_at>=0),
 expires_at INTEGER NOT NULL CHECK(expires_at>created_at AND expires_at<=created_at+25000),
 state TEXT NOT NULL CHECK(state IN ('prepared','stored','published')),
 UNIQUE(source_blob_id,generator_version)
) STRICT;
CREATE INDEX archive_derivative_owner ON archive_derivative_objects(owner_id);
CREATE INDEX archive_derivative_outbox ON archive_derivative_objects(outbox_id);
CREATE INDEX archive_derivative_state ON archive_derivative_objects(state,id);
CREATE TRIGGER archive_derivative_start BEFORE INSERT ON archive_derivative_objects
WHEN NEW.state<>'prepared' OR NOT EXISTS(
 SELECT 1 FROM derivative_results d JOIN blobs b ON b.id=NEW.output_blob_id
 JOIN reservations r ON r.id=NEW.reservation_id JOIN blob_pins p ON p.pin_id=NEW.pin_id
 JOIN outbox e ON e.outbox_id=NEW.outbox_id JOIN control c ON c.singleton=1
 WHERE d.id=NEW.result_id AND c.epoch=NEW.epoch AND c.maintenance=0
 AND e.epoch=NEW.epoch AND e.claim_token=NEW.claim_token AND e.claim_expires_at>=NEW.expires_at
 AND e.state IN ('dispatching','sent') AND NEW.expires_at>strftime('%s','now')*1000+1000
 AND d.id='archive_'||NEW.id AND d.kind='archive_index' AND d.blob_id=NEW.source_blob_id
 AND d.variant='index' AND d.generator_version=NEW.generator_version AND d.state='running'
 AND d.claim_token=NEW.claim_token AND d.claim_expires_at=NEW.expires_at AND d.epoch=NEW.epoch AND d.attempts=1
 AND b.id=d.id AND b.owner_id=NEW.owner_id AND b.state='staging' AND b.ref_count=1
 AND b.r2_key='u/'||NEW.owner_id||'/d/'||NEW.source_blob_id||'/'||NEW.generator_version||'/index/'||NEW.id
 AND b.r2_key=d.r2_key AND b.size=d.size AND b.size=json_extract(NEW.output_json,'$.bytes')
 AND b.size BETWEEN 1 AND 8388608 AND b.mime_sniffed='application/json'
 AND r.owner_id=NEW.owner_id AND r.bytes=b.size AND r.state='reserved' AND r.physical_only=1
 AND r.epoch=NEW.epoch AND r.expires_at=NEW.expires_at AND r.share_id IS NULL
 AND p.blob_id=b.id AND p.purpose='job' AND p.expires_at IS NULL
 AND NOT EXISTS(SELECT 1 FROM blob_storage WHERE blob_id=b.id))
BEGIN SELECT RAISE(ABORT,'archive_derivative_unproven'); END;
CREATE TRIGGER archive_derivative_identity BEFORE UPDATE ON archive_derivative_objects
WHEN NEW.id IS NOT OLD.id OR NEW.owner_id IS NOT OLD.owner_id OR NEW.source_blob_id IS NOT OLD.source_blob_id
 OR NEW.output_blob_id IS NOT OLD.output_blob_id OR NEW.result_id IS NOT OLD.result_id
 OR NEW.reservation_id IS NOT OLD.reservation_id OR NEW.pin_id IS NOT OLD.pin_id
 OR NEW.write_attempt_id IS NOT OLD.write_attempt_id OR NEW.outbox_id IS NOT OLD.outbox_id
 OR NEW.claim_token IS NOT OLD.claim_token OR NEW.epoch IS NOT OLD.epoch
 OR NEW.source_json IS NOT OLD.source_json OR NEW.output_json IS NOT OLD.output_json
 OR NEW.generator_version IS NOT OLD.generator_version OR NEW.created_at IS NOT OLD.created_at OR NEW.expires_at IS NOT OLD.expires_at
 OR NOT((OLD.state='prepared' AND NEW.state='stored') OR (OLD.state='stored' AND NEW.state IN ('stored','published')))
BEGIN SELECT RAISE(ABORT,'immutable_archive_derivative'); END;
CREATE TRIGGER archive_derivative_keep BEFORE DELETE ON archive_derivative_objects
BEGIN SELECT RAISE(ABORT,'archive_derivative_history_required'); END;
CREATE TRIGGER archive_derivative_insert_ready BEFORE INSERT ON derivative_results
WHEN NEW.kind='archive_index' AND NEW.state='ready'
BEGIN SELECT RAISE(ABORT,'archive_derivative_unproven'); END;
CREATE TRIGGER archive_derivative_ready BEFORE UPDATE OF state ON derivative_results
WHEN NEW.state='ready' AND EXISTS(SELECT 1 FROM archive_derivative_objects WHERE result_id=NEW.id)
 AND NOT EXISTS(SELECT 1 FROM archive_derivative_objects x
 JOIN blobs b ON b.id=x.output_blob_id JOIN blob_storage s ON s.blob_id=b.id JOIN blob_pins p ON p.pin_id=x.pin_id
 WHERE x.result_id=NEW.id AND x.state='stored' AND b.state='committed' AND s.removed_at IS NULL
 AND b.size=s.bytes AND b.size=NEW.size AND b.r2_key=NEW.r2_key AND s.r2_etag=b.r2_etag
 AND b.sha256_verified=json_extract(x.output_json,'$.sha256') AND p.blob_id=b.id
 AND EXISTS(SELECT 1 FROM r2_write_attempts w WHERE w.kind='archive.put' AND w.state='succeeded'
 AND w.source_ref=json_array(x.id,x.write_attempt_id) AND w.r2_key=b.r2_key AND w.owner_id=x.owner_id AND w.epoch=x.epoch)
 AND NOT EXISTS(SELECT 1 FROM r2_write_attempts WHERE r2_key=b.r2_key AND state='pending'))
BEGIN SELECT RAISE(ABORT,'archive_derivative_unproven'); END;
CREATE TRIGGER archive_derivative_publish BEFORE UPDATE OF state ON archive_derivative_objects
WHEN NEW.state='published' AND NOT EXISTS(SELECT 1 FROM derivative_results WHERE id=OLD.result_id AND state='ready')
BEGIN SELECT RAISE(ABORT,'archive_derivative_unproven'); END;
CREATE TRIGGER archive_derivative_put BEFORE INSERT ON r2_write_attempts
WHEN NEW.kind='archive.put' AND NEW.state='pending' AND (
 NOT EXISTS(SELECT 1 FROM archive_derivative_objects x JOIN blobs b ON b.id=x.output_blob_id
 JOIN reservations r ON r.id=x.reservation_id
 WHERE NEW.source_ref=json_array(x.id,x.write_attempt_id) AND x.state='prepared'
 AND x.owner_id=NEW.owner_id AND x.epoch=NEW.epoch AND b.r2_key=NEW.r2_key AND b.state='staging'
 AND r.state='reserved' AND r.physical_only=1 AND r.bytes=b.size
 AND NOT EXISTS(SELECT 1 FROM blob_storage WHERE blob_id=b.id))
 OR EXISTS(SELECT 1 FROM r2_write_attempts WHERE r2_key=NEW.r2_key AND state<>'not_started'))
BEGIN SELECT RAISE(ABORT,'archive_derivative_write_unavailable'); END;
CREATE TRIGGER archive_native_receipt_hold BEFORE DELETE ON r2_write_attempts
WHEN EXISTS(SELECT 1 FROM archive_derivative_objects x JOIN blobs b ON b.id=x.output_blob_id WHERE b.r2_key=OLD.r2_key)
BEGIN SELECT RAISE(ABORT,'archive_native_receipt_held'); END;
CREATE TRIGGER archive_index_publication BEFORE INSERT ON archive_index
WHEN NOT EXISTS(SELECT 1 FROM archive_derivative_objects x JOIN derivative_results d ON d.id=x.result_id
 JOIN nodes n ON n.id=NEW.node_id JOIN blobs b ON b.id=x.output_blob_id
 WHERE x.state='published' AND x.source_blob_id=NEW.blob_id AND x.generator_version=NEW.generator_version
 AND d.state='ready' AND d.r2_key=NEW.r2_key AND d.size=NEW.json_bytes
 AND b.sha256_verified=NEW.sha256 AND x.owner_id=n.owner_id AND n.current_blob_id=NEW.blob_id
 AND NEW.entry_count=json_extract(x.output_json,'$.entryCount'))
BEGIN SELECT RAISE(ABORT,'archive_index_unproven'); END;

CREATE TABLE archive_derivative_cleanup(
 archive_id TEXT PRIMARY KEY REFERENCES archive_derivative_objects(id),
 next_at INTEGER NOT NULL CHECK(next_at>=0),
 claim_token TEXT CHECK(length(claim_token)=36), claim_epoch INTEGER CHECK(claim_epoch>0),
 claim_deadline INTEGER NOT NULL DEFAULT 0 CHECK(claim_deadline>=0),
 retired_at INTEGER CHECK(retired_at>=0), retired_epoch INTEGER CHECK(retired_epoch>0),
 reason TEXT CHECK(reason IN ('expired','source_deleted')),
 seal_token TEXT UNIQUE CHECK(length(seal_token)=36),
 head_calls INTEGER NOT NULL DEFAULT 0 CHECK(head_calls BETWEEN 0 AND 64),
 head_token TEXT CHECK(length(head_token)=36),
 disposition TEXT CHECK(disposition IN ('stored','absent')), settled_at INTEGER CHECK(settled_at>=retired_at),
 CHECK((claim_token IS NULL)=(claim_epoch IS NULL)),
 CHECK((retired_at IS NULL)=(retired_epoch IS NULL) AND (retired_at IS NULL)=(reason IS NULL)),
 CHECK(seal_token IS NULL OR retired_at IS NOT NULL),
 CHECK((disposition IS NULL)=(settled_at IS NULL)),
 CHECK(settled_at IS NULL OR seal_token IS NOT NULL)
) STRICT;
CREATE INDEX archive_cleanup_due ON archive_derivative_cleanup(next_at,archive_id) WHERE settled_at IS NULL;
INSERT INTO archive_derivative_cleanup(archive_id,next_at) SELECT id,strftime('%s','now')*1000+30000 FROM archive_derivative_objects;
UPDATE archive_derivative_cleanup SET next_at=9007199254740991 WHERE archive_id IN (
 SELECT x.id FROM archive_derivative_objects x JOIN blobs source ON source.id=x.source_blob_id
 WHERE x.state='published' AND source.state NOT IN ('deleting','deleted'));
CREATE TRIGGER archive_cleanup_start BEFORE INSERT ON archive_derivative_cleanup
WHEN NEW.claim_token IS NOT NULL OR NEW.claim_epoch IS NOT NULL OR NEW.claim_deadline<>0
 OR NEW.retired_at IS NOT NULL OR NEW.seal_token IS NOT NULL OR NEW.head_calls<>0
 OR NEW.head_token IS NOT NULL OR NEW.settled_at IS NOT NULL
BEGIN SELECT RAISE(ABORT,'invalid_archive_cleanup'); END;
CREATE TRIGGER archive_cleanup_create AFTER INSERT ON archive_derivative_objects
BEGIN INSERT INTO archive_derivative_cleanup(archive_id,next_at) VALUES(NEW.id,strftime('%s','now')*1000+30000); END;
CREATE TRIGGER archive_cleanup_sleep AFTER UPDATE OF state ON archive_derivative_objects
WHEN NEW.state='published'
BEGIN UPDATE archive_derivative_cleanup SET next_at=9007199254740991 WHERE archive_id=NEW.id AND retired_at IS NULL; END;
CREATE TRIGGER archive_cleanup_wake AFTER UPDATE OF state ON blobs
WHEN OLD.state NOT IN ('deleting','deleted') AND NEW.state IN ('deleting','deleted')
BEGIN UPDATE archive_derivative_cleanup SET next_at=strftime('%s','now')*1000
 WHERE settled_at IS NULL AND archive_id IN (SELECT id FROM archive_derivative_objects WHERE source_blob_id=NEW.id AND state='published'); END;
CREATE TRIGGER archive_cleanup_identity BEFORE UPDATE ON archive_derivative_cleanup
WHEN NEW.archive_id IS NOT OLD.archive_id OR OLD.settled_at IS NOT NULL
 OR (OLD.retired_at IS NOT NULL AND (NEW.retired_at IS NOT OLD.retired_at OR NEW.retired_epoch IS NOT OLD.retired_epoch OR NEW.reason IS NOT OLD.reason))
 OR (OLD.seal_token IS NOT NULL AND NEW.seal_token IS NOT OLD.seal_token)
 OR NEW.head_calls<OLD.head_calls OR NEW.head_calls>OLD.head_calls+1
BEGIN SELECT RAISE(ABORT,'immutable_archive_cleanup'); END;
CREATE TRIGGER archive_cleanup_keep BEFORE DELETE ON archive_derivative_cleanup
BEGIN SELECT RAISE(ABORT,'archive_cleanup_history_required'); END;
CREATE TRIGGER archive_cleanup_retire BEFORE UPDATE OF retired_at ON archive_derivative_cleanup
WHEN OLD.retired_at IS NULL AND NEW.retired_at IS NOT NULL AND NOT EXISTS(
 SELECT 1 FROM archive_derivative_objects x
 JOIN blobs source ON source.id=x.source_blob_id JOIN control c ON c.singleton=1
 JOIN spaces sp ON sp.owner_id=x.owner_id JOIN mutation_admissions a ON a.space_id=sp.id
 WHERE x.id=NEW.archive_id AND NEW.retired_epoch=c.epoch AND NEW.retired_at>=x.created_at
 AND a.system=1 AND a.state='active' AND a.epoch=c.epoch AND a.maintenance=c.maintenance
 AND a.permit_id GLOB 'system:archive.cleanup:*' AND a.expires_at>strftime('%s','now')*1000
 AND ((NEW.reason='expired' AND x.state<>'published' AND (x.epoch<c.epoch OR x.expires_at<=strftime('%s','now')*1000))
   OR (NEW.reason='source_deleted' AND x.state='published' AND source.state IN ('deleting','deleted'))))
BEGIN SELECT RAISE(ABORT,'archive_retirement_unproven'); END;
CREATE TRIGGER archive_cleanup_block_write BEFORE INSERT ON r2_write_attempts
WHEN NEW.kind='archive.put' AND NEW.state='pending' AND EXISTS(
 SELECT 1 FROM archive_derivative_cleanup WHERE archive_id=json_extract(NEW.source_ref,'$[0]') AND retired_at IS NOT NULL)
BEGIN SELECT RAISE(ABORT,'archive_derivative_retired'); END;
CREATE TRIGGER archive_cleanup_seal BEFORE UPDATE OF seal_token ON archive_derivative_cleanup
WHEN NEW.seal_token IS NOT OLD.seal_token AND NOT EXISTS(SELECT 1 FROM mutation_admissions a JOIN control c ON c.singleton=1
 WHERE a.space_id IS NULL AND a.system=1 AND a.state='active' AND a.epoch=c.epoch AND a.maintenance=c.maintenance
 AND a.permit_id GLOB 'global:archives.cleanup-seal:*' AND a.expires_at>strftime('%s','now')*1000)
BEGIN SELECT RAISE(ABORT,'archive_seal_unproven'); END;
CREATE TRIGGER archive_cleanup_block_ready BEFORE UPDATE OF state ON derivative_results
WHEN NEW.state='ready' AND EXISTS(SELECT 1 FROM archive_derivative_objects x JOIN archive_derivative_cleanup c ON c.archive_id=x.id
 WHERE x.result_id=NEW.id AND c.retired_at IS NOT NULL)
BEGIN SELECT RAISE(ABORT,'archive_derivative_retired'); END;
CREATE TRIGGER archive_cleanup_settle BEFORE UPDATE OF settled_at ON archive_derivative_cleanup
WHEN NEW.settled_at IS NOT NULL AND NOT EXISTS(
 SELECT 1 FROM archive_derivative_objects x JOIN blobs b ON b.id=x.output_blob_id
 JOIN reservations r ON r.id=x.reservation_id JOIN blob_pins p ON p.pin_id=x.pin_id
 JOIN derivative_results d ON d.id=x.result_id JOIN control c ON c.singleton=1
 JOIN spaces sp ON sp.owner_id=x.owner_id JOIN mutation_admissions a ON a.space_id=sp.id
 WHERE x.id=NEW.archive_id AND NEW.retired_at IS NOT NULL AND NEW.seal_token IS NOT NULL
 AND NEW.claim_epoch=c.epoch AND NEW.claim_deadline>strftime('%s','now')*1000
 AND a.system=1 AND a.state='active' AND a.epoch=c.epoch AND a.maintenance=c.maintenance
 AND a.permit_id GLOB 'system:archive.cleanup:*' AND a.expires_at>strftime('%s','now')*1000
 AND d.state='failed' AND d.error_code='archive_retired' AND b.state IN ('staging','committed') AND b.ref_count=1
 AND p.blob_id=b.id AND p.purpose='job' AND p.expires_at IS NULL AND r.physical_only=1 AND r.state IN ('reserved','released')
 AND NOT EXISTS(SELECT 1 FROM r2_write_attempts WHERE r2_key=b.r2_key AND state='pending')
 AND ((NEW.disposition='stored' AND EXISTS(SELECT 1 FROM blob_storage s WHERE s.blob_id=b.id AND s.removed_at IS NULL))
 OR (NEW.disposition='absent' AND NEW.head_token=NEW.claim_token AND NEW.head_calls>0
   AND NOT EXISTS(SELECT 1 FROM blob_storage WHERE blob_id=b.id))))
BEGIN SELECT RAISE(ABORT,'archive_cleanup_unproven'); END;
CREATE TRIGGER archive_derivative_pin_hold BEFORE DELETE ON blob_pins
WHEN EXISTS(SELECT 1 FROM archive_derivative_objects x WHERE x.pin_id=OLD.pin_id
 AND NOT EXISTS(SELECT 1 FROM archive_derivative_cleanup c WHERE c.archive_id=x.id AND c.settled_at IS NOT NULL))
BEGIN SELECT RAISE(ABORT,'archive_derivative_retained'); END;
CREATE TRIGGER archive_derivative_reservation_hold BEFORE UPDATE OF state ON reservations
WHEN NEW.state<>OLD.state AND EXISTS(SELECT 1 FROM archive_derivative_objects WHERE reservation_id=OLD.id)
 AND (NEW.state<>'released' OR NOT EXISTS(SELECT 1 FROM archive_derivative_objects x JOIN derivative_results d ON d.id=x.result_id
 LEFT JOIN archive_derivative_cleanup c ON c.archive_id=x.id WHERE x.reservation_id=OLD.id
 AND ((x.state='published' AND d.state='ready') OR (c.settled_at IS NOT NULL AND d.state='failed' AND d.error_code='archive_retired'))))
BEGIN SELECT RAISE(ABORT,'archive_derivative_unsettled'); END;

-- Keep backup/restore freeze guards effective on new and modified tables.
CREATE TRIGGER backup_freeze_archive_derivative_cleanup_insert BEFORE INSERT ON archive_derivative_cleanup
WHEN (SELECT backup_frozen FROM control WHERE singleton=1) =1
BEGIN SELECT RAISE(ABORT,'backup_frozen'); END;
CREATE TRIGGER backup_freeze_archive_derivative_cleanup_update BEFORE UPDATE ON archive_derivative_cleanup
WHEN (SELECT backup_frozen FROM control WHERE singleton=1) =1
BEGIN SELECT RAISE(ABORT,'backup_frozen'); END;
CREATE TRIGGER backup_freeze_archive_derivative_cleanup_delete BEFORE DELETE ON archive_derivative_cleanup
WHEN (SELECT backup_frozen FROM control WHERE singleton=1) =1
BEGIN SELECT RAISE(ABORT,'backup_frozen'); END;
CREATE TRIGGER restore_freeze_archive_derivative_cleanup_insert BEFORE INSERT ON archive_derivative_cleanup
WHEN (SELECT restore_freeze_token FROM control WHERE singleton=1) IS NOT NULL
BEGIN SELECT RAISE(ABORT,'database_restore_frozen'); END;
CREATE TRIGGER restore_freeze_archive_derivative_cleanup_update BEFORE UPDATE ON archive_derivative_cleanup
WHEN (SELECT restore_freeze_token FROM control WHERE singleton=1) IS NOT NULL
BEGIN SELECT RAISE(ABORT,'database_restore_frozen'); END;
CREATE TRIGGER restore_freeze_archive_derivative_cleanup_delete BEFORE DELETE ON archive_derivative_cleanup
WHEN (SELECT restore_freeze_token FROM control WHERE singleton=1) IS NOT NULL
BEGIN SELECT RAISE(ABORT,'database_restore_frozen'); END;
CREATE TRIGGER backup_freeze_archive_derivative_objects_insert BEFORE INSERT ON archive_derivative_objects
WHEN (SELECT backup_frozen FROM control WHERE singleton=1)=1
BEGIN SELECT RAISE(ABORT,'backup_frozen'); END;
CREATE TRIGGER backup_freeze_archive_derivative_objects_update BEFORE UPDATE ON archive_derivative_objects
WHEN (SELECT backup_frozen FROM control WHERE singleton=1)=1
BEGIN SELECT RAISE(ABORT,'backup_frozen'); END;
CREATE TRIGGER backup_freeze_archive_derivative_objects_delete BEFORE DELETE ON archive_derivative_objects
WHEN (SELECT backup_frozen FROM control WHERE singleton=1)=1
BEGIN SELECT RAISE(ABORT,'backup_frozen'); END;
CREATE TRIGGER restore_freeze_archive_derivative_objects_insert BEFORE INSERT ON archive_derivative_objects
WHEN (SELECT restore_freeze_token FROM control WHERE singleton=1) IS NOT NULL
BEGIN SELECT RAISE(ABORT,'database_restore_frozen'); END;
CREATE TRIGGER restore_freeze_archive_derivative_objects_update BEFORE UPDATE ON archive_derivative_objects
WHEN (SELECT restore_freeze_token FROM control WHERE singleton=1) IS NOT NULL
BEGIN SELECT RAISE(ABORT,'database_restore_frozen'); END;
CREATE TRIGGER restore_freeze_archive_derivative_objects_delete BEFORE DELETE ON archive_derivative_objects
WHEN (SELECT restore_freeze_token FROM control WHERE singleton=1) IS NOT NULL
BEGIN SELECT RAISE(ABORT,'database_restore_frozen'); END;

-- Multiple authorized nodes may refer to the same immutable blob/index generation.
CREATE TABLE _archive_index_next(
  id TEXT NOT NULL PRIMARY KEY, node_id TEXT NOT NULL REFERENCES nodes(id), blob_id TEXT NOT NULL REFERENCES blobs(id),
  generator_version TEXT NOT NULL, r2_key TEXT NOT NULL, sha256 TEXT NOT NULL,
  entry_count INTEGER NOT NULL CHECK(entry_count BETWEEN 0 AND 10000),
  json_bytes INTEGER NOT NULL CHECK(json_bytes BETWEEN 0 AND 8388608), UNIQUE(node_id,blob_id,generator_version)
) STRICT;
INSERT INTO _archive_index_next SELECT * FROM archive_index;
INSERT INTO _assert(v) SELECT 1 WHERE EXISTS(SELECT * FROM archive_index EXCEPT SELECT * FROM _archive_index_next) OR EXISTS(SELECT * FROM _archive_index_next EXCEPT SELECT * FROM archive_index);
DROP TRIGGER "archive_binding_key_insert";
DROP TRIGGER "archive_binding_key_update";
DROP TRIGGER "archive_derivative_insert_ready";
DROP TRIGGER "archive_derivative_start";
DROP TRIGGER "archive_index_publication";
DROP TRIGGER "archive_multipart_bucket_insert";
DROP TRIGGER "archive_multipart_bucket_update";
DROP TRIGGER "archive_orphan_key_insert";
DROP TRIGGER "archive_orphan_key_update";
DROP TRIGGER "backup_freeze_archive_index_delete";
DROP TRIGGER "backup_freeze_archive_index_insert";
DROP TRIGGER "backup_freeze_archive_index_update";
DROP TRIGGER "orphan_objects_no_catalogue";
DROP TRIGGER "restore_freeze_archive_index_delete";
DROP TRIGGER "restore_freeze_archive_index_insert";
DROP TRIGGER "restore_freeze_archive_index_update";
DROP TABLE archive_index;
ALTER TABLE _archive_index_next RENAME TO archive_index;
CREATE INDEX archive_index_blob_id_fk ON archive_index(blob_id);
CREATE TRIGGER archive_binding_key_insert BEFORE INSERT ON archive_index
WHEN NEW.r2_key='system/r2-binding-probe-v1'
BEGIN SELECT RAISE(ABORT,'reserved_r2_binding_key'); END;
CREATE TRIGGER archive_binding_key_update BEFORE UPDATE OF r2_key ON archive_index
WHEN NEW.r2_key='system/r2-binding-probe-v1'
BEGIN SELECT RAISE(ABORT,'reserved_r2_binding_key'); END;
CREATE TRIGGER archive_derivative_insert_ready BEFORE INSERT ON derivative_results
WHEN NEW.kind='archive_index' AND NEW.state='ready'
BEGIN SELECT RAISE(ABORT,'archive_derivative_unproven'); END;
CREATE TRIGGER archive_derivative_start BEFORE INSERT ON archive_derivative_objects
WHEN NEW.state<>'prepared' OR NOT EXISTS(
 SELECT 1 FROM derivative_results d JOIN blobs b ON b.id=NEW.output_blob_id
 JOIN reservations r ON r.id=NEW.reservation_id JOIN blob_pins p ON p.pin_id=NEW.pin_id
 JOIN outbox e ON e.outbox_id=NEW.outbox_id JOIN control c ON c.singleton=1
 WHERE d.id=NEW.result_id AND c.epoch=NEW.epoch AND c.maintenance=0
 AND e.epoch=NEW.epoch AND e.claim_token=NEW.claim_token AND e.claim_expires_at>=NEW.expires_at
 AND e.state IN ('dispatching','sent') AND NEW.expires_at>strftime('%s','now')*1000+1000
 AND d.id='archive_'||NEW.id AND d.kind='archive_index' AND d.blob_id=NEW.source_blob_id
 AND d.variant='index' AND d.generator_version=NEW.generator_version AND d.state='running'
 AND d.claim_token=NEW.claim_token AND d.claim_expires_at=NEW.expires_at AND d.epoch=NEW.epoch AND d.attempts=1
 AND b.id=d.id AND b.owner_id=NEW.owner_id AND b.state='staging' AND b.ref_count=1
 AND b.r2_key='u/'||NEW.owner_id||'/d/'||NEW.source_blob_id||'/'||NEW.generator_version||'/index/'||NEW.id
 AND b.r2_key=d.r2_key AND b.size=d.size AND b.size=json_extract(NEW.output_json,'$.bytes')
 AND b.size BETWEEN 1 AND 8388608 AND b.mime_sniffed='application/json'
 AND r.owner_id=NEW.owner_id AND r.bytes=b.size AND r.state='reserved' AND r.physical_only=1
 AND r.epoch=NEW.epoch AND r.expires_at=NEW.expires_at AND r.share_id IS NULL
 AND p.blob_id=b.id AND p.purpose='job' AND p.expires_at IS NULL
 AND NOT EXISTS(SELECT 1 FROM blob_storage WHERE blob_id=b.id))
BEGIN SELECT RAISE(ABORT,'archive_derivative_unproven'); END;
CREATE TRIGGER archive_index_publication BEFORE INSERT ON archive_index
WHEN NOT EXISTS(SELECT 1 FROM archive_derivative_objects x JOIN derivative_results d ON d.id=x.result_id
 JOIN nodes n ON n.id=NEW.node_id JOIN blobs b ON b.id=x.output_blob_id
 WHERE x.state='published' AND x.source_blob_id=NEW.blob_id AND x.generator_version=NEW.generator_version
 AND d.state='ready' AND d.r2_key=NEW.r2_key AND d.size=NEW.json_bytes
 AND b.sha256_verified=NEW.sha256 AND x.owner_id=n.owner_id AND n.current_blob_id=NEW.blob_id
 AND NEW.entry_count=json_extract(x.output_json,'$.entryCount'))
BEGIN SELECT RAISE(ABORT,'archive_index_unproven'); END;
CREATE TRIGGER archive_multipart_bucket_insert BEFORE INSERT ON archive_index
WHEN EXISTS(SELECT 1 FROM multipart_bucket_handles WHERE r2_key=NEW.r2_key AND state='quarantined')
BEGIN SELECT RAISE(ABORT,'multipart_key_quarantined'); END;
CREATE TRIGGER archive_multipart_bucket_update BEFORE UPDATE OF r2_key ON archive_index
WHEN EXISTS(SELECT 1 FROM multipart_bucket_handles WHERE r2_key=NEW.r2_key AND state='quarantined')
BEGIN SELECT RAISE(ABORT,'multipart_key_quarantined'); END;
CREATE TRIGGER archive_orphan_key_insert BEFORE INSERT ON archive_index
WHEN EXISTS(SELECT 1 FROM orphan_objects WHERE r2_key=NEW.r2_key)
BEGIN SELECT RAISE(ABORT,'orphan_key_quarantined'); END;
CREATE TRIGGER archive_orphan_key_update BEFORE UPDATE OF r2_key ON archive_index
WHEN EXISTS(SELECT 1 FROM orphan_objects WHERE r2_key=NEW.r2_key)
BEGIN SELECT RAISE(ABORT,'orphan_key_quarantined'); END;
CREATE TRIGGER backup_freeze_archive_index_delete BEFORE DELETE ON archive_index
WHEN (SELECT backup_frozen FROM control WHERE singleton=1)=1
BEGIN SELECT RAISE(ABORT,'backup_frozen'); END;
CREATE TRIGGER backup_freeze_archive_index_insert BEFORE INSERT ON archive_index
WHEN (SELECT backup_frozen FROM control WHERE singleton=1)=1
BEGIN SELECT RAISE(ABORT,'backup_frozen'); END;
CREATE TRIGGER backup_freeze_archive_index_update BEFORE UPDATE ON archive_index
WHEN (SELECT backup_frozen FROM control WHERE singleton=1)=1
BEGIN SELECT RAISE(ABORT,'backup_frozen'); END;
CREATE TRIGGER orphan_objects_no_catalogue BEFORE INSERT ON orphan_objects
WHEN EXISTS(SELECT 1 FROM blobs WHERE r2_key=NEW.r2_key)
 OR EXISTS(SELECT 1 FROM derivative_results WHERE r2_key=NEW.r2_key)
 OR EXISTS(SELECT 1 FROM archive_index WHERE r2_key=NEW.r2_key)
 OR EXISTS(SELECT 1 FROM target_sets WHERE manifest_ref=NEW.r2_key)
BEGIN SELECT RAISE(ABORT,'orphan_key_referenced'); END;
CREATE TRIGGER restore_freeze_archive_index_delete BEFORE DELETE ON archive_index
WHEN (SELECT restore_freeze_token FROM control WHERE singleton=1) IS NOT NULL
BEGIN SELECT RAISE(ABORT,'database_restore_frozen'); END;
CREATE TRIGGER restore_freeze_archive_index_insert BEFORE INSERT ON archive_index
WHEN (SELECT restore_freeze_token FROM control WHERE singleton=1) IS NOT NULL
BEGIN SELECT RAISE(ABORT,'database_restore_frozen'); END;
CREATE TRIGGER restore_freeze_archive_index_update BEFORE UPDATE ON archive_index
WHEN (SELECT restore_freeze_token FROM control WHERE singleton=1) IS NOT NULL
BEGIN SELECT RAISE(ABORT,'database_restore_frozen'); END;
CREATE INDEX archive_index_key ON archive_index(r2_key);
CREATE TRIGGER archive_index_immutable BEFORE UPDATE ON archive_index BEGIN SELECT RAISE(ABORT,'immutable_archive_index'); END;

-- Unpaid archive output uses the same physical-only counter with its own prepared result proof.
DROP TRIGGER image_reservation_kind;
CREATE TRIGGER image_reservation_kind BEFORE INSERT ON reservations
WHEN NEW.physical_only=1 AND (NEW.share_id IS NOT NULL OR NEW.op_id IS NOT NULL OR NEW.bytes>12582912
 OR NOT (EXISTS(SELECT 1 FROM image_transform_attempts t WHERE NEW.id='image_'||t.id AND t.owner_id=NEW.owner_id
   AND t.state='succeeded' AND t.epoch=NEW.epoch AND t.expires_at=NEW.expires_at AND json_extract(t.output_json,'$.bytes')=NEW.bytes)
 OR EXISTS(SELECT 1 FROM derivative_results d JOIN blobs source ON source.id=d.blob_id
   JOIN spaces sp ON sp.owner_id=source.owner_id JOIN mutation_admissions a ON a.space_id=sp.id
   JOIN control c ON c.singleton=1
   WHERE d.id=NEW.id AND length(d.id)=44 AND substr(d.id,1,8)='archive_' AND source.owner_id=NEW.owner_id
   AND d.kind='archive_index' AND d.variant='index' AND d.generator_version='archive-index-v1'
   AND d.state='running' AND d.attempts=1 AND d.epoch=NEW.epoch AND d.claim_expires_at=NEW.expires_at
   AND d.size=NEW.bytes AND NEW.bytes BETWEEN 1 AND 8388608
   AND d.r2_key='u/'||NEW.owner_id||'/d/'||d.blob_id||'/archive-index-v1/index/'||substr(d.id,9)
   AND a.system=1 AND a.state='active' AND a.epoch=c.epoch AND a.maintenance=0 AND c.maintenance=0
   AND a.permit_id GLOB 'system:archive.prepare:*' AND a.expires_at>strftime('%s','now')*1000)))
BEGIN SELECT RAISE(ABORT,'invalid_image_reservation'); END;
