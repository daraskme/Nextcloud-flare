-- Image derivative storage shares existing physical and native-write accounting.
INSERT INTO _assert(v) SELECT 1 WHERE NOT EXISTS(SELECT 1 FROM control WHERE singleton=1 AND maintenance=1 AND backup_token IS NULL AND backup_frozen=0 AND restore_freeze_token IS NULL)
 OR EXISTS(SELECT 1 FROM permits WHERE state='open') OR EXISTS(SELECT 1 FROM operations WHERE state='claimed')
 OR EXISTS(SELECT 1 FROM mutation_admissions WHERE state<>'closed') OR EXISTS(SELECT 1 FROM r2_write_attempts WHERE state='pending')
 OR EXISTS(SELECT 1 FROM kdf_attempts WHERE state='claimed') OR EXISTS(SELECT 1 FROM image_transform_attempts WHERE state='pending');
CREATE TABLE _r2_write_attempts_next(
 id TEXT PRIMARY KEY CHECK(length(id)=36),
 token TEXT NOT NULL UNIQUE CHECK(length(token)=36),
 epoch INTEGER NOT NULL CHECK(epoch>0),
 owner_id TEXT CHECK(owner_id IS NULL OR length(owner_id) BETWEEN 1 AND 128),
 kind TEXT NOT NULL CHECK(kind IN ('empty.put','manifest.put','manifest.delete','blob.delete','orphan.delete','upload.put','multipart.create','multipart.part','multipart.complete','multipart.abort','bucket.abort','probe.put','backups.probe.put','backup.delete','copy.put','image.put','copy.multipart.create','copy.multipart.part','copy.multipart.complete')),
 r2_key TEXT NOT NULL CHECK(length(CAST(r2_key AS BLOB)) BETWEEN 1 AND 1024),
 dispatch_before INTEGER NOT NULL,
 started_at INTEGER NOT NULL CHECK(started_at>=0),
 state TEXT NOT NULL CHECK(state IN ('pending','succeeded','not_started')),
 finished_at INTEGER CHECK(finished_at>=started_at),
 source_ref TEXT CHECK(source_ref IS NULL OR length(source_ref) BETWEEN 1 AND 512),
 CHECK((kind IN ('upload.put','multipart.create','multipart.part','multipart.complete','multipart.abort','bucket.abort','probe.put','backups.probe.put','backup.delete','copy.put','image.put','copy.multipart.create','copy.multipart.part','copy.multipart.complete'))=(source_ref IS NOT NULL)),
 CHECK(dispatch_before>started_at AND dispatch_before<=started_at+5000),
 CHECK((kind IN ('orphan.delete','bucket.abort','probe.put','backups.probe.put','backup.delete'))=(owner_id IS NULL)),
 CHECK((state='pending')=(finished_at IS NULL))
) STRICT;
INSERT INTO _r2_write_attempts_next SELECT * FROM r2_write_attempts;
INSERT INTO _assert(v) SELECT 1 WHERE EXISTS(SELECT * FROM r2_write_attempts EXCEPT SELECT * FROM _r2_write_attempts_next)
 OR EXISTS(SELECT * FROM _r2_write_attempts_next EXCEPT SELECT * FROM r2_write_attempts);
DROP TRIGGER backup_freeze_r2_write_attempts_delete;
DROP TRIGGER backup_freeze_r2_write_attempts_insert;
DROP TRIGGER backup_freeze_r2_write_attempts_update;
DROP TRIGGER copy_abort_dispatch;
DROP TRIGGER copy_abort_prepare;
DROP TRIGGER copy_cleanup_aborted;
DROP TRIGGER copy_cleanup_proof;
DROP TRIGGER copy_cleanup_stored;
DROP TRIGGER copy_cleanup_unwritten;
DROP TRIGGER copy_job_blobs_delete;
DROP TRIGGER copy_job_reservation_hold;
DROP TRIGGER copy_multipart_handle;
DROP TRIGGER copy_multipart_stored;
DROP TRIGGER copy_native_receipt_hold;
DROP TRIGGER copy_part_insert;
DROP TRIGGER copy_part_stored;
DROP TRIGGER copy_publication_ready;
DROP TRIGGER copy_stopped_dispatch;
DROP TRIGGER copy_transfer_stored;
DROP TRIGGER multipart_bucket_abort_reconciliation_insert;
DROP TRIGGER r2_write_blob_gc;
DROP TRIGGER r2_write_dispatch;
DROP TRIGGER r2_write_immutable;
DROP TRIGGER r2_write_keep_receipt;
DROP TRIGGER r2_write_orphan_gc;
DROP TRIGGER r2_write_resume_pending;
DROP TRIGGER r2_write_upload_cleanup;
DROP TRIGGER r2_write_upload_reservation;
DROP TRIGGER restore_freeze_r2_write_attempts_delete;
DROP TRIGGER restore_freeze_r2_write_attempts_insert;
DROP TRIGGER restore_freeze_r2_write_attempts_update;
DROP TRIGGER restore_freeze_r2_write_pending;
DROP TABLE r2_write_attempts;
ALTER TABLE _r2_write_attempts_next RENAME TO r2_write_attempts;
CREATE INDEX r2_write_finished ON r2_write_attempts(finished_at) WHERE state<>'pending';
CREATE INDEX r2_write_key_history ON r2_write_attempts(r2_key,kind,state);
CREATE INDEX r2_write_not_started_source ON r2_write_attempts(kind,source_ref) WHERE state='not_started';
CREATE INDEX r2_write_pending ON r2_write_attempts(state,started_at);
CREATE INDEX r2_write_pending_key ON r2_write_attempts(r2_key) WHERE state='pending';
CREATE UNIQUE INDEX r2_write_source ON r2_write_attempts(kind,source_ref) WHERE source_ref IS NOT NULL AND state<>'not_started';
CREATE TRIGGER backup_freeze_r2_write_attempts_delete BEFORE DELETE ON r2_write_attempts
WHEN (SELECT backup_frozen FROM control WHERE singleton=1)=1
BEGIN SELECT RAISE(ABORT,'backup_frozen'); END;
CREATE TRIGGER backup_freeze_r2_write_attempts_insert BEFORE INSERT ON r2_write_attempts
WHEN (SELECT backup_frozen FROM control WHERE singleton=1)=1
BEGIN SELECT RAISE(ABORT,'backup_frozen'); END;
CREATE TRIGGER backup_freeze_r2_write_attempts_update BEFORE UPDATE ON r2_write_attempts
WHEN (SELECT backup_frozen FROM control WHERE singleton=1)=1
BEGIN SELECT RAISE(ABORT,'backup_frozen'); END;
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
CREATE TRIGGER restore_freeze_r2_write_attempts_delete BEFORE DELETE ON r2_write_attempts
WHEN (SELECT restore_freeze_token FROM control WHERE singleton=1) IS NOT NULL
BEGIN SELECT RAISE(ABORT,'database_restore_frozen'); END;
CREATE TRIGGER restore_freeze_r2_write_attempts_insert BEFORE INSERT ON r2_write_attempts
WHEN (SELECT restore_freeze_token FROM control WHERE singleton=1) IS NOT NULL
BEGIN SELECT RAISE(ABORT,'database_restore_frozen'); END;
CREATE TRIGGER restore_freeze_r2_write_attempts_update BEFORE UPDATE ON r2_write_attempts
WHEN (SELECT restore_freeze_token FROM control WHERE singleton=1) IS NOT NULL
BEGIN SELECT RAISE(ABORT,'database_restore_frozen'); END;
CREATE TRIGGER restore_freeze_r2_write_pending BEFORE UPDATE OF restore_freeze_token ON control
WHEN NEW.restore_freeze_token IS NOT NULL AND EXISTS(SELECT 1 FROM r2_write_attempts WHERE state='pending')
BEGIN SELECT RAISE(ABORT,'restore_freeze_not_drained'); END;

CREATE TABLE image_derivative_objects(
 id TEXT PRIMARY KEY REFERENCES image_transform_attempts(id),
 owner_id TEXT NOT NULL REFERENCES users(id), source_blob_id TEXT NOT NULL REFERENCES blobs(id),
 output_blob_id TEXT NOT NULL UNIQUE REFERENCES blobs(id), result_id TEXT NOT NULL UNIQUE REFERENCES derivative_results(id),
 reservation_id TEXT NOT NULL UNIQUE REFERENCES reservations(id), pin_id TEXT NOT NULL UNIQUE,
 write_attempt_id TEXT NOT NULL UNIQUE CHECK(length(write_attempt_id)=36),
 state TEXT NOT NULL CHECK(state IN ('prepared','stored','published')),
 created_at INTEGER NOT NULL CHECK(created_at>=0)
) STRICT;
CREATE INDEX image_derivative_owner ON image_derivative_objects(owner_id);
CREATE INDEX image_derivative_source ON image_derivative_objects(source_blob_id);
CREATE INDEX image_derivative_state ON image_derivative_objects(state,id);
CREATE TRIGGER image_derivative_start BEFORE INSERT ON image_derivative_objects
WHEN NEW.state<>'prepared' OR NOT EXISTS(
 SELECT 1 FROM image_transform_attempts t JOIN derivative_results d ON d.id=NEW.result_id
 JOIN blobs b ON b.id=NEW.output_blob_id JOIN reservations r ON r.id=NEW.reservation_id
 JOIN blob_pins p ON p.pin_id=NEW.pin_id JOIN control c ON c.singleton=1
 WHERE t.id=NEW.id AND t.state='succeeded' AND t.owner_id=NEW.owner_id AND t.blob_id=NEW.source_blob_id
 AND c.epoch=t.epoch AND c.maintenance=0 AND t.expires_at>strftime('%s','now')*1000+1000
 AND d.id='image_'||t.id AND d.kind='thumbnail' AND d.blob_id=t.blob_id AND d.variant=t.variant
 AND d.generator_version=t.generator_version AND d.state='running' AND d.claim_token=t.claim_token
 AND d.claim_expires_at=t.expires_at AND d.epoch=t.epoch AND d.attempts=1
 AND b.id='image_'||t.id AND b.owner_id=t.owner_id AND b.state='staging'
 AND b.r2_key='u/'||t.owner_id||'/d/'||t.blob_id||'/'||t.generator_version||'/'||t.variant||'/'||t.id
 AND b.size=json_extract(t.output_json,'$.bytes') AND b.size=d.size AND b.r2_key=d.r2_key
 AND b.mime_sniffed='image/webp' AND b.ref_count=1
 AND r.owner_id=t.owner_id AND r.bytes=b.size AND r.state='reserved' AND r.physical_only=1 AND r.epoch=t.epoch AND r.expires_at=t.expires_at
 AND r.share_id IS NULL AND p.blob_id=b.id AND p.purpose='job' AND p.expires_at IS NULL
 AND NOT EXISTS(SELECT 1 FROM blob_storage WHERE blob_id=b.id))
BEGIN SELECT RAISE(ABORT,'image_derivative_unproven'); END;
CREATE TRIGGER image_derivative_identity BEFORE UPDATE ON image_derivative_objects
WHEN NEW.id IS NOT OLD.id OR NEW.owner_id IS NOT OLD.owner_id OR NEW.source_blob_id IS NOT OLD.source_blob_id
 OR NEW.output_blob_id IS NOT OLD.output_blob_id OR NEW.result_id IS NOT OLD.result_id
 OR NEW.reservation_id IS NOT OLD.reservation_id OR NEW.pin_id IS NOT OLD.pin_id
 OR NEW.write_attempt_id IS NOT OLD.write_attempt_id OR NEW.created_at IS NOT OLD.created_at
 OR NOT((OLD.state='prepared' AND NEW.state='stored') OR (OLD.state='stored' AND NEW.state IN ('stored','published')))
BEGIN SELECT RAISE(ABORT,'immutable_image_derivative'); END;
CREATE TRIGGER image_derivative_keep BEFORE DELETE ON image_derivative_objects
BEGIN SELECT RAISE(ABORT,'image_derivative_history_required'); END;
CREATE TRIGGER image_derivative_pin_hold BEFORE DELETE ON blob_pins
WHEN EXISTS(SELECT 1 FROM image_derivative_objects WHERE pin_id=OLD.pin_id)
BEGIN SELECT RAISE(ABORT,'image_derivative_retained'); END;
CREATE TRIGGER image_derivative_reservation_hold BEFORE UPDATE OF state ON reservations
WHEN NEW.state<>OLD.state AND EXISTS(SELECT 1 FROM image_derivative_objects WHERE reservation_id=OLD.id)
 AND (NEW.state<>'released' OR NOT EXISTS(SELECT 1 FROM image_derivative_objects x JOIN derivative_results d ON d.id=x.result_id
 WHERE x.reservation_id=OLD.id AND x.state='published' AND d.state='ready'))
BEGIN SELECT RAISE(ABORT,'image_derivative_unsettled'); END;
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
CREATE TRIGGER image_derivative_publish BEFORE UPDATE OF state ON image_derivative_objects
WHEN NEW.state='published' AND NOT EXISTS(SELECT 1 FROM derivative_results WHERE id=OLD.result_id AND state='ready')
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
CREATE TRIGGER backup_freeze_image_derivative_objects_insert BEFORE INSERT ON image_derivative_objects
WHEN (SELECT backup_frozen FROM control WHERE singleton=1)=1
BEGIN SELECT RAISE(ABORT,'backup_frozen'); END;
CREATE TRIGGER backup_freeze_image_derivative_objects_update BEFORE UPDATE ON image_derivative_objects
WHEN (SELECT backup_frozen FROM control WHERE singleton=1)=1
BEGIN SELECT RAISE(ABORT,'backup_frozen'); END;
CREATE TRIGGER backup_freeze_image_derivative_objects_delete BEFORE DELETE ON image_derivative_objects
WHEN (SELECT backup_frozen FROM control WHERE singleton=1)=1
BEGIN SELECT RAISE(ABORT,'backup_frozen'); END;
CREATE TRIGGER restore_freeze_image_derivative_objects_insert BEFORE INSERT ON image_derivative_objects
WHEN (SELECT restore_freeze_token FROM control WHERE singleton=1) IS NOT NULL
BEGIN SELECT RAISE(ABORT,'database_restore_frozen'); END;
CREATE TRIGGER restore_freeze_image_derivative_objects_update BEFORE UPDATE ON image_derivative_objects
WHEN (SELECT restore_freeze_token FROM control WHERE singleton=1) IS NOT NULL
BEGIN SELECT RAISE(ABORT,'database_restore_frozen'); END;
CREATE TRIGGER restore_freeze_image_derivative_objects_delete BEFORE DELETE ON image_derivative_objects
WHEN (SELECT restore_freeze_token FROM control WHERE singleton=1) IS NOT NULL
BEGIN SELECT RAISE(ABORT,'database_restore_frozen'); END;

-- Derivative reservations consume only physical headroom, never logical file quota.
ALTER TABLE users ADD COLUMN image_reserved_bytes INTEGER NOT NULL DEFAULT 0 CHECK(image_reserved_bytes BETWEEN 0 AND 9007199254740991);
ALTER TABLE reservations ADD COLUMN physical_only INTEGER NOT NULL DEFAULT 0 CHECK(physical_only IN (0,1));
CREATE TRIGGER image_reservation_kind BEFORE INSERT ON reservations
WHEN NEW.physical_only=1 AND (NEW.share_id IS NOT NULL OR NEW.op_id IS NOT NULL OR NEW.bytes>12582912
 OR NOT EXISTS(SELECT 1 FROM image_transform_attempts t WHERE NEW.id='image_'||t.id AND t.owner_id=NEW.owner_id
 AND t.state='succeeded' AND t.epoch=NEW.epoch AND t.expires_at=NEW.expires_at AND json_extract(t.output_json,'$.bytes')=NEW.bytes))
BEGIN SELECT RAISE(ABORT,'invalid_image_reservation'); END;
CREATE TRIGGER reservations_kind_immutable BEFORE UPDATE OF physical_only ON reservations
WHEN NEW.physical_only IS NOT OLD.physical_only
BEGIN SELECT RAISE(ABORT,'immutable_reservation'); END;
DROP TRIGGER reservations_charge;
CREATE TRIGGER reservations_charge AFTER INSERT ON reservations
BEGIN
 UPDATE users SET reserved_bytes=reserved_bytes+NEW.bytes*(1-NEW.physical_only),
  image_reserved_bytes=image_reserved_bytes+NEW.bytes*NEW.physical_only
 WHERE id=NEW.owner_id AND disabled_at IS NULL
  AND (NEW.physical_only=1 OR used_bytes<=quota_bytes-reserved_bytes-NEW.bytes)
  AND physical_bytes<=quota_bytes*6/5-reserved_bytes-image_reserved_bytes-NEW.bytes;
 SELECT CASE WHEN changes()<>1 THEN RAISE(ABORT,'quota_exceeded') END;
 UPDATE shares SET reserved_bytes=reserved_bytes+NEW.bytes WHERE id=NEW.share_id AND owner_id=NEW.owner_id
  AND disabled_at IS NULL AND (expires_at IS NULL OR expires_at>strftime('%s','now')*1000)
  AND reserved_bytes<=reservation_limit-NEW.bytes;
 SELECT CASE WHEN NEW.share_id IS NOT NULL AND changes()<>1 THEN RAISE(ABORT,'share_quota_exceeded') END;
END;
DROP TRIGGER reservations_uncharge;
CREATE TRIGGER reservations_uncharge AFTER UPDATE OF state ON reservations
WHEN OLD.state='reserved' AND NEW.state IN ('consumed','released')
BEGIN
 UPDATE users SET reserved_bytes=reserved_bytes-OLD.bytes*(1-OLD.physical_only),
  image_reserved_bytes=image_reserved_bytes-OLD.bytes*OLD.physical_only
 WHERE id=OLD.owner_id AND (OLD.physical_only=0 AND reserved_bytes>=OLD.bytes OR OLD.physical_only=1 AND image_reserved_bytes>=OLD.bytes);
 SELECT CASE WHEN changes()<>1 THEN RAISE(ABORT,'reservation_counter_drift') END;
 UPDATE shares SET reserved_bytes=reserved_bytes-OLD.bytes WHERE id=OLD.share_id AND reserved_bytes>=OLD.bytes;
 SELECT CASE WHEN OLD.share_id IS NOT NULL AND changes()<>1 THEN RAISE(ABORT,'share_reservation_counter_drift') END;
END;

-- Reinstall freeze guards after the dependent trigger rebuild.
DROP TRIGGER backup_freeze_blob_pins_insert;
CREATE TRIGGER backup_freeze_blob_pins_insert BEFORE INSERT ON blob_pins
WHEN (SELECT backup_frozen FROM control WHERE singleton=1)=1
BEGIN SELECT RAISE(ABORT,'backup_frozen'); END;
DROP TRIGGER backup_freeze_blob_pins_update;
CREATE TRIGGER backup_freeze_blob_pins_update BEFORE UPDATE ON blob_pins
WHEN (SELECT backup_frozen FROM control WHERE singleton=1)=1
BEGIN SELECT RAISE(ABORT,'backup_frozen'); END;
DROP TRIGGER backup_freeze_blob_pins_delete;
CREATE TRIGGER backup_freeze_blob_pins_delete BEFORE DELETE ON blob_pins
WHEN (SELECT backup_frozen FROM control WHERE singleton=1)=1
BEGIN SELECT RAISE(ABORT,'backup_frozen'); END;
DROP TRIGGER restore_freeze_blob_pins_insert;
CREATE TRIGGER restore_freeze_blob_pins_insert BEFORE INSERT ON blob_pins
WHEN (SELECT restore_freeze_token FROM control WHERE singleton=1) IS NOT NULL
BEGIN SELECT RAISE(ABORT,'database_restore_frozen'); END;
DROP TRIGGER restore_freeze_blob_pins_update;
CREATE TRIGGER restore_freeze_blob_pins_update BEFORE UPDATE ON blob_pins
WHEN (SELECT restore_freeze_token FROM control WHERE singleton=1) IS NOT NULL
BEGIN SELECT RAISE(ABORT,'database_restore_frozen'); END;
DROP TRIGGER restore_freeze_blob_pins_delete;
CREATE TRIGGER restore_freeze_blob_pins_delete BEFORE DELETE ON blob_pins
WHEN (SELECT restore_freeze_token FROM control WHERE singleton=1) IS NOT NULL
BEGIN SELECT RAISE(ABORT,'database_restore_frozen'); END;
DROP TRIGGER backup_freeze_blobs_insert;
CREATE TRIGGER backup_freeze_blobs_insert BEFORE INSERT ON blobs
WHEN (SELECT backup_frozen FROM control WHERE singleton=1)=1
BEGIN SELECT RAISE(ABORT,'backup_frozen'); END;
DROP TRIGGER backup_freeze_blobs_update;
CREATE TRIGGER backup_freeze_blobs_update BEFORE UPDATE ON blobs
WHEN (SELECT backup_frozen FROM control WHERE singleton=1)=1
BEGIN SELECT RAISE(ABORT,'backup_frozen'); END;
DROP TRIGGER backup_freeze_blobs_delete;
CREATE TRIGGER backup_freeze_blobs_delete BEFORE DELETE ON blobs
WHEN (SELECT backup_frozen FROM control WHERE singleton=1)=1
BEGIN SELECT RAISE(ABORT,'backup_frozen'); END;
DROP TRIGGER restore_freeze_blobs_insert;
CREATE TRIGGER restore_freeze_blobs_insert BEFORE INSERT ON blobs
WHEN (SELECT restore_freeze_token FROM control WHERE singleton=1) IS NOT NULL
BEGIN SELECT RAISE(ABORT,'database_restore_frozen'); END;
DROP TRIGGER restore_freeze_blobs_update;
CREATE TRIGGER restore_freeze_blobs_update BEFORE UPDATE ON blobs
WHEN (SELECT restore_freeze_token FROM control WHERE singleton=1) IS NOT NULL
BEGIN SELECT RAISE(ABORT,'database_restore_frozen'); END;
DROP TRIGGER restore_freeze_blobs_delete;
CREATE TRIGGER restore_freeze_blobs_delete BEFORE DELETE ON blobs
WHEN (SELECT restore_freeze_token FROM control WHERE singleton=1) IS NOT NULL
BEGIN SELECT RAISE(ABORT,'database_restore_frozen'); END;
DROP TRIGGER backup_freeze_bulk_jobs_insert;
CREATE TRIGGER backup_freeze_bulk_jobs_insert BEFORE INSERT ON bulk_jobs
WHEN (SELECT backup_frozen FROM control WHERE singleton=1)=1
BEGIN SELECT RAISE(ABORT,'backup_frozen'); END;
DROP TRIGGER backup_freeze_bulk_jobs_update;
CREATE TRIGGER backup_freeze_bulk_jobs_update BEFORE UPDATE ON bulk_jobs
WHEN (SELECT backup_frozen FROM control WHERE singleton=1)=1
BEGIN SELECT RAISE(ABORT,'backup_frozen'); END;
DROP TRIGGER backup_freeze_bulk_jobs_delete;
CREATE TRIGGER backup_freeze_bulk_jobs_delete BEFORE DELETE ON bulk_jobs
WHEN (SELECT backup_frozen FROM control WHERE singleton=1)=1
BEGIN SELECT RAISE(ABORT,'backup_frozen'); END;
DROP TRIGGER restore_freeze_bulk_jobs_insert;
CREATE TRIGGER restore_freeze_bulk_jobs_insert BEFORE INSERT ON bulk_jobs
WHEN (SELECT restore_freeze_token FROM control WHERE singleton=1) IS NOT NULL
BEGIN SELECT RAISE(ABORT,'database_restore_frozen'); END;
DROP TRIGGER restore_freeze_bulk_jobs_update;
CREATE TRIGGER restore_freeze_bulk_jobs_update BEFORE UPDATE ON bulk_jobs
WHEN (SELECT restore_freeze_token FROM control WHERE singleton=1) IS NOT NULL
BEGIN SELECT RAISE(ABORT,'database_restore_frozen'); END;
DROP TRIGGER restore_freeze_bulk_jobs_delete;
CREATE TRIGGER restore_freeze_bulk_jobs_delete BEFORE DELETE ON bulk_jobs
WHEN (SELECT restore_freeze_token FROM control WHERE singleton=1) IS NOT NULL
BEGIN SELECT RAISE(ABORT,'database_restore_frozen'); END;
DROP TRIGGER backup_freeze_control_insert;
CREATE TRIGGER backup_freeze_control_insert BEFORE INSERT ON control
WHEN (SELECT backup_frozen FROM control WHERE singleton=1)=1
BEGIN SELECT RAISE(ABORT,'backup_frozen'); END;
DROP TRIGGER backup_freeze_control_delete;
CREATE TRIGGER backup_freeze_control_delete BEFORE DELETE ON control
WHEN (SELECT backup_frozen FROM control WHERE singleton=1)=1
BEGIN SELECT RAISE(ABORT,'backup_frozen'); END;
DROP TRIGGER restore_freeze_control_insert;
CREATE TRIGGER restore_freeze_control_insert BEFORE INSERT ON control
WHEN (SELECT restore_freeze_token FROM control WHERE singleton=1) IS NOT NULL
BEGIN SELECT RAISE(ABORT,'database_restore_frozen'); END;
DROP TRIGGER restore_freeze_control_update;
CREATE TRIGGER restore_freeze_control_update BEFORE UPDATE ON control
WHEN OLD.restore_freeze_token IS NOT NULL AND (NEW.restore_freeze_token IS NOT NULL
 OR NEW.singleton IS NOT OLD.singleton OR NEW.epoch IS NOT OLD.epoch OR NEW.maintenance IS NOT OLD.maintenance OR NEW.gc_paused IS NOT OLD.gc_paused OR NEW.bootstrap_done_at IS NOT OLD.bootstrap_done_at OR NEW.bootstrap_iss IS NOT OLD.bootstrap_iss OR NEW.bootstrap_sub IS NOT OLD.bootstrap_sub OR NEW.backup_barrier_op IS NOT OLD.backup_barrier_op OR NEW.updated_at IS NOT OLD.updated_at OR NEW.admission_revision IS NOT OLD.admission_revision OR NEW.admission_token IS NOT OLD.admission_token OR NEW.gc_operator_paused IS NOT OLD.gc_operator_paused OR NEW.gc_hold_token IS NOT OLD.gc_hold_token OR NEW.gc_hold_operation IS NOT OLD.gc_hold_operation OR NEW.gc_hold_expires_at IS NOT OLD.gc_hold_expires_at OR NEW.kdf_not_before IS NOT OLD.kdf_not_before OR NEW.backup_token IS NOT OLD.backup_token OR NEW.backup_frozen IS NOT OLD.backup_frozen OR NEW.backup_last_op IS NOT OLD.backup_last_op)
BEGIN SELECT RAISE(ABORT,'database_restore_frozen'); END;
DROP TRIGGER restore_freeze_control_delete;
CREATE TRIGGER restore_freeze_control_delete BEFORE DELETE ON control
WHEN (SELECT restore_freeze_token FROM control WHERE singleton=1) IS NOT NULL
BEGIN SELECT RAISE(ABORT,'database_restore_frozen'); END;
DROP TRIGGER backup_freeze_copy_cleanup_receipts_insert;
CREATE TRIGGER backup_freeze_copy_cleanup_receipts_insert BEFORE INSERT ON copy_cleanup_receipts
WHEN (SELECT backup_frozen FROM control WHERE singleton=1)=1
BEGIN SELECT RAISE(ABORT,'backup_frozen'); END;
DROP TRIGGER backup_freeze_copy_cleanup_receipts_update;
CREATE TRIGGER backup_freeze_copy_cleanup_receipts_update BEFORE UPDATE ON copy_cleanup_receipts
WHEN (SELECT backup_frozen FROM control WHERE singleton=1)=1
BEGIN SELECT RAISE(ABORT,'backup_frozen'); END;
DROP TRIGGER backup_freeze_copy_cleanup_receipts_delete;
CREATE TRIGGER backup_freeze_copy_cleanup_receipts_delete BEFORE DELETE ON copy_cleanup_receipts
WHEN (SELECT backup_frozen FROM control WHERE singleton=1)=1
BEGIN SELECT RAISE(ABORT,'backup_frozen'); END;
DROP TRIGGER restore_freeze_copy_cleanup_receipts_insert;
CREATE TRIGGER restore_freeze_copy_cleanup_receipts_insert BEFORE INSERT ON copy_cleanup_receipts
WHEN (SELECT restore_freeze_token FROM control WHERE singleton=1) IS NOT NULL
BEGIN SELECT RAISE(ABORT,'database_restore_frozen'); END;
DROP TRIGGER restore_freeze_copy_cleanup_receipts_update;
CREATE TRIGGER restore_freeze_copy_cleanup_receipts_update BEFORE UPDATE ON copy_cleanup_receipts
WHEN (SELECT restore_freeze_token FROM control WHERE singleton=1) IS NOT NULL
BEGIN SELECT RAISE(ABORT,'database_restore_frozen'); END;
DROP TRIGGER restore_freeze_copy_cleanup_receipts_delete;
CREATE TRIGGER restore_freeze_copy_cleanup_receipts_delete BEFORE DELETE ON copy_cleanup_receipts
WHEN (SELECT restore_freeze_token FROM control WHERE singleton=1) IS NOT NULL
BEGIN SELECT RAISE(ABORT,'database_restore_frozen'); END;
DROP TRIGGER backup_freeze_copy_job_blobs_insert;
CREATE TRIGGER backup_freeze_copy_job_blobs_insert BEFORE INSERT ON copy_job_blobs
WHEN (SELECT backup_frozen FROM control WHERE singleton=1)=1
BEGIN SELECT RAISE(ABORT,'backup_frozen'); END;
DROP TRIGGER backup_freeze_copy_job_blobs_update;
CREATE TRIGGER backup_freeze_copy_job_blobs_update BEFORE UPDATE ON copy_job_blobs
WHEN (SELECT backup_frozen FROM control WHERE singleton=1)=1
BEGIN SELECT RAISE(ABORT,'backup_frozen'); END;
DROP TRIGGER backup_freeze_copy_job_blobs_delete;
CREATE TRIGGER backup_freeze_copy_job_blobs_delete BEFORE DELETE ON copy_job_blobs
WHEN (SELECT backup_frozen FROM control WHERE singleton=1)=1
BEGIN SELECT RAISE(ABORT,'backup_frozen'); END;
DROP TRIGGER restore_freeze_copy_job_blobs_insert;
CREATE TRIGGER restore_freeze_copy_job_blobs_insert BEFORE INSERT ON copy_job_blobs
WHEN (SELECT restore_freeze_token FROM control WHERE singleton=1) IS NOT NULL
BEGIN SELECT RAISE(ABORT,'database_restore_frozen'); END;
DROP TRIGGER restore_freeze_copy_job_blobs_update;
CREATE TRIGGER restore_freeze_copy_job_blobs_update BEFORE UPDATE ON copy_job_blobs
WHEN (SELECT restore_freeze_token FROM control WHERE singleton=1) IS NOT NULL
BEGIN SELECT RAISE(ABORT,'database_restore_frozen'); END;
DROP TRIGGER restore_freeze_copy_job_blobs_delete;
CREATE TRIGGER restore_freeze_copy_job_blobs_delete BEFORE DELETE ON copy_job_blobs
WHEN (SELECT restore_freeze_token FROM control WHERE singleton=1) IS NOT NULL
BEGIN SELECT RAISE(ABORT,'database_restore_frozen'); END;
DROP TRIGGER backup_freeze_copy_multipart_parts_insert;
CREATE TRIGGER backup_freeze_copy_multipart_parts_insert BEFORE INSERT ON copy_multipart_parts
WHEN (SELECT backup_frozen FROM control WHERE singleton=1)=1
BEGIN SELECT RAISE(ABORT,'backup_frozen'); END;
DROP TRIGGER backup_freeze_copy_multipart_parts_update;
CREATE TRIGGER backup_freeze_copy_multipart_parts_update BEFORE UPDATE ON copy_multipart_parts
WHEN (SELECT backup_frozen FROM control WHERE singleton=1)=1
BEGIN SELECT RAISE(ABORT,'backup_frozen'); END;
DROP TRIGGER backup_freeze_copy_multipart_parts_delete;
CREATE TRIGGER backup_freeze_copy_multipart_parts_delete BEFORE DELETE ON copy_multipart_parts
WHEN (SELECT backup_frozen FROM control WHERE singleton=1)=1
BEGIN SELECT RAISE(ABORT,'backup_frozen'); END;
DROP TRIGGER restore_freeze_copy_multipart_parts_insert;
CREATE TRIGGER restore_freeze_copy_multipart_parts_insert BEFORE INSERT ON copy_multipart_parts
WHEN (SELECT restore_freeze_token FROM control WHERE singleton=1) IS NOT NULL
BEGIN SELECT RAISE(ABORT,'database_restore_frozen'); END;
DROP TRIGGER restore_freeze_copy_multipart_parts_update;
CREATE TRIGGER restore_freeze_copy_multipart_parts_update BEFORE UPDATE ON copy_multipart_parts
WHEN (SELECT restore_freeze_token FROM control WHERE singleton=1) IS NOT NULL
BEGIN SELECT RAISE(ABORT,'database_restore_frozen'); END;
DROP TRIGGER restore_freeze_copy_multipart_parts_delete;
CREATE TRIGGER restore_freeze_copy_multipart_parts_delete BEFORE DELETE ON copy_multipart_parts
WHEN (SELECT restore_freeze_token FROM control WHERE singleton=1) IS NOT NULL
BEGIN SELECT RAISE(ABORT,'database_restore_frozen'); END;
DROP TRIGGER backup_freeze_copy_multipart_uploads_insert;
CREATE TRIGGER backup_freeze_copy_multipart_uploads_insert BEFORE INSERT ON copy_multipart_uploads
WHEN (SELECT backup_frozen FROM control WHERE singleton=1)=1
BEGIN SELECT RAISE(ABORT,'backup_frozen'); END;
DROP TRIGGER backup_freeze_copy_multipart_uploads_update;
CREATE TRIGGER backup_freeze_copy_multipart_uploads_update BEFORE UPDATE ON copy_multipart_uploads
WHEN (SELECT backup_frozen FROM control WHERE singleton=1)=1
BEGIN SELECT RAISE(ABORT,'backup_frozen'); END;
DROP TRIGGER backup_freeze_copy_multipart_uploads_delete;
CREATE TRIGGER backup_freeze_copy_multipart_uploads_delete BEFORE DELETE ON copy_multipart_uploads
WHEN (SELECT backup_frozen FROM control WHERE singleton=1)=1
BEGIN SELECT RAISE(ABORT,'backup_frozen'); END;
DROP TRIGGER restore_freeze_copy_multipart_uploads_insert;
CREATE TRIGGER restore_freeze_copy_multipart_uploads_insert BEFORE INSERT ON copy_multipart_uploads
WHEN (SELECT restore_freeze_token FROM control WHERE singleton=1) IS NOT NULL
BEGIN SELECT RAISE(ABORT,'database_restore_frozen'); END;
DROP TRIGGER restore_freeze_copy_multipart_uploads_update;
CREATE TRIGGER restore_freeze_copy_multipart_uploads_update BEFORE UPDATE ON copy_multipart_uploads
WHEN (SELECT restore_freeze_token FROM control WHERE singleton=1) IS NOT NULL
BEGIN SELECT RAISE(ABORT,'database_restore_frozen'); END;
DROP TRIGGER restore_freeze_copy_multipart_uploads_delete;
CREATE TRIGGER restore_freeze_copy_multipart_uploads_delete BEFORE DELETE ON copy_multipart_uploads
WHEN (SELECT restore_freeze_token FROM control WHERE singleton=1) IS NOT NULL
BEGIN SELECT RAISE(ABORT,'database_restore_frozen'); END;
DROP TRIGGER backup_freeze_derivative_results_insert;
CREATE TRIGGER backup_freeze_derivative_results_insert BEFORE INSERT ON derivative_results
WHEN (SELECT backup_frozen FROM control WHERE singleton=1)=1
BEGIN SELECT RAISE(ABORT,'backup_frozen'); END;
DROP TRIGGER backup_freeze_derivative_results_update;
CREATE TRIGGER backup_freeze_derivative_results_update BEFORE UPDATE ON derivative_results
WHEN (SELECT backup_frozen FROM control WHERE singleton=1)=1
BEGIN SELECT RAISE(ABORT,'backup_frozen'); END;
DROP TRIGGER backup_freeze_derivative_results_delete;
CREATE TRIGGER backup_freeze_derivative_results_delete BEFORE DELETE ON derivative_results
WHEN (SELECT backup_frozen FROM control WHERE singleton=1)=1
BEGIN SELECT RAISE(ABORT,'backup_frozen'); END;
DROP TRIGGER restore_freeze_derivative_results_insert;
CREATE TRIGGER restore_freeze_derivative_results_insert BEFORE INSERT ON derivative_results
WHEN (SELECT restore_freeze_token FROM control WHERE singleton=1) IS NOT NULL
BEGIN SELECT RAISE(ABORT,'database_restore_frozen'); END;
DROP TRIGGER restore_freeze_derivative_results_update;
CREATE TRIGGER restore_freeze_derivative_results_update BEFORE UPDATE ON derivative_results
WHEN (SELECT restore_freeze_token FROM control WHERE singleton=1) IS NOT NULL
BEGIN SELECT RAISE(ABORT,'database_restore_frozen'); END;
DROP TRIGGER restore_freeze_derivative_results_delete;
CREATE TRIGGER restore_freeze_derivative_results_delete BEFORE DELETE ON derivative_results
WHEN (SELECT restore_freeze_token FROM control WHERE singleton=1) IS NOT NULL
BEGIN SELECT RAISE(ABORT,'database_restore_frozen'); END;
DROP TRIGGER backup_freeze_multipart_bucket_abort_reconciliations_insert;
CREATE TRIGGER backup_freeze_multipart_bucket_abort_reconciliations_insert BEFORE INSERT ON multipart_bucket_abort_reconciliations
WHEN (SELECT backup_frozen FROM control WHERE singleton=1)=1
BEGIN SELECT RAISE(ABORT,'backup_frozen'); END;
DROP TRIGGER backup_freeze_multipart_bucket_abort_reconciliations_update;
CREATE TRIGGER backup_freeze_multipart_bucket_abort_reconciliations_update BEFORE UPDATE ON multipart_bucket_abort_reconciliations
WHEN (SELECT backup_frozen FROM control WHERE singleton=1)=1
BEGIN SELECT RAISE(ABORT,'backup_frozen'); END;
DROP TRIGGER backup_freeze_multipart_bucket_abort_reconciliations_delete;
CREATE TRIGGER backup_freeze_multipart_bucket_abort_reconciliations_delete BEFORE DELETE ON multipart_bucket_abort_reconciliations
WHEN (SELECT backup_frozen FROM control WHERE singleton=1)=1
BEGIN SELECT RAISE(ABORT,'backup_frozen'); END;
DROP TRIGGER restore_freeze_multipart_bucket_abort_reconciliations_insert;
CREATE TRIGGER restore_freeze_multipart_bucket_abort_reconciliations_insert BEFORE INSERT ON multipart_bucket_abort_reconciliations
WHEN (SELECT restore_freeze_token FROM control WHERE singleton=1) IS NOT NULL
BEGIN SELECT RAISE(ABORT,'database_restore_frozen'); END;
DROP TRIGGER restore_freeze_multipart_bucket_abort_reconciliations_update;
CREATE TRIGGER restore_freeze_multipart_bucket_abort_reconciliations_update BEFORE UPDATE ON multipart_bucket_abort_reconciliations
WHEN (SELECT restore_freeze_token FROM control WHERE singleton=1) IS NOT NULL
BEGIN SELECT RAISE(ABORT,'database_restore_frozen'); END;
DROP TRIGGER restore_freeze_multipart_bucket_abort_reconciliations_delete;
CREATE TRIGGER restore_freeze_multipart_bucket_abort_reconciliations_delete BEFORE DELETE ON multipart_bucket_abort_reconciliations
WHEN (SELECT restore_freeze_token FROM control WHERE singleton=1) IS NOT NULL
BEGIN SELECT RAISE(ABORT,'database_restore_frozen'); END;
DROP TRIGGER backup_freeze_orphan_objects_insert;
CREATE TRIGGER backup_freeze_orphan_objects_insert BEFORE INSERT ON orphan_objects
WHEN (SELECT backup_frozen FROM control WHERE singleton=1)=1
BEGIN SELECT RAISE(ABORT,'backup_frozen'); END;
DROP TRIGGER backup_freeze_orphan_objects_update;
CREATE TRIGGER backup_freeze_orphan_objects_update BEFORE UPDATE ON orphan_objects
WHEN (SELECT backup_frozen FROM control WHERE singleton=1)=1
BEGIN SELECT RAISE(ABORT,'backup_frozen'); END;
DROP TRIGGER backup_freeze_orphan_objects_delete;
CREATE TRIGGER backup_freeze_orphan_objects_delete BEFORE DELETE ON orphan_objects
WHEN (SELECT backup_frozen FROM control WHERE singleton=1)=1
BEGIN SELECT RAISE(ABORT,'backup_frozen'); END;
DROP TRIGGER restore_freeze_orphan_objects_insert;
CREATE TRIGGER restore_freeze_orphan_objects_insert BEFORE INSERT ON orphan_objects
WHEN (SELECT restore_freeze_token FROM control WHERE singleton=1) IS NOT NULL
BEGIN SELECT RAISE(ABORT,'database_restore_frozen'); END;
DROP TRIGGER restore_freeze_orphan_objects_update;
CREATE TRIGGER restore_freeze_orphan_objects_update BEFORE UPDATE ON orphan_objects
WHEN (SELECT restore_freeze_token FROM control WHERE singleton=1) IS NOT NULL
BEGIN SELECT RAISE(ABORT,'database_restore_frozen'); END;
DROP TRIGGER restore_freeze_orphan_objects_delete;
CREATE TRIGGER restore_freeze_orphan_objects_delete BEFORE DELETE ON orphan_objects
WHEN (SELECT restore_freeze_token FROM control WHERE singleton=1) IS NOT NULL
BEGIN SELECT RAISE(ABORT,'database_restore_frozen'); END;
DROP TRIGGER backup_freeze_r2_write_attempts_insert;
CREATE TRIGGER backup_freeze_r2_write_attempts_insert BEFORE INSERT ON r2_write_attempts
WHEN (SELECT backup_frozen FROM control WHERE singleton=1)=1
BEGIN SELECT RAISE(ABORT,'backup_frozen'); END;
DROP TRIGGER backup_freeze_r2_write_attempts_update;
CREATE TRIGGER backup_freeze_r2_write_attempts_update BEFORE UPDATE ON r2_write_attempts
WHEN (SELECT backup_frozen FROM control WHERE singleton=1)=1
BEGIN SELECT RAISE(ABORT,'backup_frozen'); END;
DROP TRIGGER backup_freeze_r2_write_attempts_delete;
CREATE TRIGGER backup_freeze_r2_write_attempts_delete BEFORE DELETE ON r2_write_attempts
WHEN (SELECT backup_frozen FROM control WHERE singleton=1)=1
BEGIN SELECT RAISE(ABORT,'backup_frozen'); END;
DROP TRIGGER restore_freeze_r2_write_attempts_insert;
CREATE TRIGGER restore_freeze_r2_write_attempts_insert BEFORE INSERT ON r2_write_attempts
WHEN (SELECT restore_freeze_token FROM control WHERE singleton=1) IS NOT NULL
BEGIN SELECT RAISE(ABORT,'database_restore_frozen'); END;
DROP TRIGGER restore_freeze_r2_write_attempts_update;
CREATE TRIGGER restore_freeze_r2_write_attempts_update BEFORE UPDATE ON r2_write_attempts
WHEN (SELECT restore_freeze_token FROM control WHERE singleton=1) IS NOT NULL
BEGIN SELECT RAISE(ABORT,'database_restore_frozen'); END;
DROP TRIGGER restore_freeze_r2_write_attempts_delete;
CREATE TRIGGER restore_freeze_r2_write_attempts_delete BEFORE DELETE ON r2_write_attempts
WHEN (SELECT restore_freeze_token FROM control WHERE singleton=1) IS NOT NULL
BEGIN SELECT RAISE(ABORT,'database_restore_frozen'); END;
DROP TRIGGER backup_freeze_reservations_insert;
CREATE TRIGGER backup_freeze_reservations_insert BEFORE INSERT ON reservations
WHEN (SELECT backup_frozen FROM control WHERE singleton=1)=1
BEGIN SELECT RAISE(ABORT,'backup_frozen'); END;
DROP TRIGGER backup_freeze_reservations_update;
CREATE TRIGGER backup_freeze_reservations_update BEFORE UPDATE ON reservations
WHEN (SELECT backup_frozen FROM control WHERE singleton=1)=1
BEGIN SELECT RAISE(ABORT,'backup_frozen'); END;
DROP TRIGGER backup_freeze_reservations_delete;
CREATE TRIGGER backup_freeze_reservations_delete BEFORE DELETE ON reservations
WHEN (SELECT backup_frozen FROM control WHERE singleton=1)=1
BEGIN SELECT RAISE(ABORT,'backup_frozen'); END;
DROP TRIGGER restore_freeze_reservations_insert;
CREATE TRIGGER restore_freeze_reservations_insert BEFORE INSERT ON reservations
WHEN (SELECT restore_freeze_token FROM control WHERE singleton=1) IS NOT NULL
BEGIN SELECT RAISE(ABORT,'database_restore_frozen'); END;
DROP TRIGGER restore_freeze_reservations_update;
CREATE TRIGGER restore_freeze_reservations_update BEFORE UPDATE ON reservations
WHEN (SELECT restore_freeze_token FROM control WHERE singleton=1) IS NOT NULL
BEGIN SELECT RAISE(ABORT,'database_restore_frozen'); END;
DROP TRIGGER restore_freeze_reservations_delete;
CREATE TRIGGER restore_freeze_reservations_delete BEFORE DELETE ON reservations
WHEN (SELECT restore_freeze_token FROM control WHERE singleton=1) IS NOT NULL
BEGIN SELECT RAISE(ABORT,'database_restore_frozen'); END;
DROP TRIGGER backup_freeze_uploads_insert;
CREATE TRIGGER backup_freeze_uploads_insert BEFORE INSERT ON uploads
WHEN (SELECT backup_frozen FROM control WHERE singleton=1)=1
BEGIN SELECT RAISE(ABORT,'backup_frozen'); END;
DROP TRIGGER backup_freeze_uploads_update;
CREATE TRIGGER backup_freeze_uploads_update BEFORE UPDATE ON uploads
WHEN (SELECT backup_frozen FROM control WHERE singleton=1)=1
BEGIN SELECT RAISE(ABORT,'backup_frozen'); END;
DROP TRIGGER backup_freeze_uploads_delete;
CREATE TRIGGER backup_freeze_uploads_delete BEFORE DELETE ON uploads
WHEN (SELECT backup_frozen FROM control WHERE singleton=1)=1
BEGIN SELECT RAISE(ABORT,'backup_frozen'); END;
DROP TRIGGER restore_freeze_uploads_insert;
CREATE TRIGGER restore_freeze_uploads_insert BEFORE INSERT ON uploads
WHEN (SELECT restore_freeze_token FROM control WHERE singleton=1) IS NOT NULL
BEGIN SELECT RAISE(ABORT,'database_restore_frozen'); END;
DROP TRIGGER restore_freeze_uploads_update;
CREATE TRIGGER restore_freeze_uploads_update BEFORE UPDATE ON uploads
WHEN (SELECT restore_freeze_token FROM control WHERE singleton=1) IS NOT NULL
BEGIN SELECT RAISE(ABORT,'database_restore_frozen'); END;
DROP TRIGGER restore_freeze_uploads_delete;
CREATE TRIGGER restore_freeze_uploads_delete BEFORE DELETE ON uploads
WHEN (SELECT restore_freeze_token FROM control WHERE singleton=1) IS NOT NULL
BEGIN SELECT RAISE(ABORT,'database_restore_frozen'); END;
