INSERT INTO _assert(v) SELECT 1 WHERE NOT EXISTS(SELECT 1 FROM control WHERE singleton=1
  AND maintenance=1 AND backup_token IS NULL AND backup_frozen=0 AND restore_freeze_token IS NULL)
  OR EXISTS(SELECT 1 FROM permits WHERE state='open') OR EXISTS(SELECT 1 FROM operations WHERE state='claimed')
  OR EXISTS(SELECT 1 FROM mutation_admissions WHERE state<>'closed');

-- Missing prepared history remains unknown. Index not-started receipts for a bounded per-part lookup.
CREATE INDEX r2_write_not_started_source ON r2_write_attempts(kind,source_ref) WHERE state='not_started';
ALTER TABLE copy_multipart_uploads ADD COLUMN abort_attempt TEXT CHECK(abort_attempt IS NULL OR length(abort_attempt)=36);
ALTER TABLE copy_multipart_uploads ADD COLUMN abort_epoch INTEGER CHECK(abort_epoch IS NULL OR abort_epoch>0);
ALTER TABLE copy_multipart_uploads ADD COLUMN abort_started_at INTEGER CHECK(abort_started_at IS NULL OR abort_started_at>=0);
ALTER TABLE copy_multipart_uploads ADD COLUMN abort_deadline INTEGER CHECK(abort_deadline IS NULL OR (abort_deadline>abort_started_at AND abort_deadline<=abort_started_at+25000));
CREATE UNIQUE INDEX copy_multipart_abort_attempt ON copy_multipart_uploads(abort_attempt) WHERE abort_attempt IS NOT NULL;
CREATE TRIGGER copy_abort_initial BEFORE INSERT ON copy_multipart_uploads
WHEN NEW.abort_attempt IS NOT NULL OR NEW.abort_epoch IS NOT NULL OR NEW.abort_started_at IS NOT NULL OR NEW.abort_deadline IS NOT NULL
BEGIN SELECT RAISE(ABORT,'invalid_copy_abort'); END;
CREATE TRIGGER copy_abort_identity BEFORE UPDATE ON copy_multipart_uploads
WHEN (OLD.abort_attempt IS NOT NULL AND (NEW.abort_attempt IS NOT OLD.abort_attempt OR NEW.abort_epoch IS NOT OLD.abort_epoch
  OR NEW.abort_started_at IS NOT OLD.abort_started_at OR NEW.abort_deadline IS NOT OLD.abort_deadline))
 OR (NEW.abort_attempt IS NULL)<>(NEW.abort_epoch IS NULL) OR (NEW.abort_attempt IS NULL)<>(NEW.abort_started_at IS NULL)
 OR (NEW.abort_attempt IS NULL)<>(NEW.abort_deadline IS NULL)
BEGIN SELECT RAISE(ABORT,'immutable_copy_abort'); END;
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

-- A distinct receipt records a proven native abort; it is not an unwritten upload.
DROP TRIGGER copy_cleanup_identity;
DROP TRIGGER copy_cleanup_delete;
DROP TRIGGER copy_cleanup_proof;
DROP TRIGGER copy_cleanup_unwritten;
DROP TRIGGER copy_cleanup_stored;
DROP TRIGGER copy_job_reservation_hold;
DROP TRIGGER copy_job_blobs_delete;
DROP TRIGGER copy_multipart_delete;
DROP TRIGGER copy_part_delete;
DROP TRIGGER copy_destination_hold;
DROP TRIGGER backup_freeze_copy_cleanup_receipts_insert;
DROP TRIGGER restore_freeze_copy_cleanup_receipts_insert;
DROP TRIGGER backup_freeze_copy_cleanup_receipts_update;
DROP TRIGGER restore_freeze_copy_cleanup_receipts_update;
DROP TRIGGER backup_freeze_copy_cleanup_receipts_delete;
DROP TRIGGER restore_freeze_copy_cleanup_receipts_delete;
CREATE TABLE _copy_cleanup_receipts_next(
  job_id TEXT NOT NULL REFERENCES copy_job_manifests(job_id),
  source_blob_id TEXT NOT NULL,
  destination_blob_id TEXT NOT NULL UNIQUE,
  pin_id TEXT NOT NULL UNIQUE,
  reservation_id TEXT NOT NULL UNIQUE,
  bytes INTEGER NOT NULL CHECK(bytes BETWEEN 0 AND 536870912000),
  disposition TEXT NOT NULL CHECK(disposition IN ('unwritten','stored','aborted')),
  epoch INTEGER NOT NULL CHECK(epoch>0),
  settled_at INTEGER NOT NULL CHECK(settled_at>=0),
  PRIMARY KEY(job_id,source_blob_id)
) STRICT;
INSERT INTO _copy_cleanup_receipts_next SELECT * FROM copy_cleanup_receipts;
INSERT INTO _assert(v) SELECT 1 WHERE EXISTS(SELECT * FROM copy_cleanup_receipts EXCEPT SELECT * FROM _copy_cleanup_receipts_next)
 OR EXISTS(SELECT * FROM _copy_cleanup_receipts_next EXCEPT SELECT * FROM copy_cleanup_receipts);
DROP TABLE copy_cleanup_receipts;
ALTER TABLE _copy_cleanup_receipts_next RENAME TO copy_cleanup_receipts;
CREATE TRIGGER copy_cleanup_identity BEFORE UPDATE ON copy_cleanup_receipts
BEGIN SELECT RAISE(ABORT,'immutable_copy_cleanup'); END;
CREATE TRIGGER copy_cleanup_delete BEFORE DELETE ON copy_cleanup_receipts
BEGIN SELECT RAISE(ABORT,'copy_cleanup_receipt_required'); END;
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
CREATE TRIGGER copy_multipart_delete BEFORE DELETE ON copy_multipart_uploads
WHEN (OLD.state<>'stored' OR NOT EXISTS(SELECT 1 FROM copy_job_blobs cb JOIN bulk_jobs j ON j.id=cb.job_id
  JOIN operations o ON o.op_id=j.publish_op_id WHERE cb.destination_blob_id=OLD.destination_blob_id
    AND j.state='completed' AND o.kind='copy.publish' AND o.state='committed')) AND NOT EXISTS(SELECT 1 FROM copy_cleanup_receipts x JOIN copy_job_blobs cb
 ON cb.job_id=x.job_id AND cb.source_blob_id=x.source_blob_id WHERE x.destination_blob_id=OLD.destination_blob_id
 AND cb.destination_blob_id=x.destination_blob_id)
BEGIN SELECT RAISE(ABORT,'copy_multipart_held'); END;
CREATE TRIGGER copy_part_delete BEFORE DELETE ON copy_multipart_parts
WHEN (NOT EXISTS(SELECT 1 FROM copy_multipart_uploads m JOIN copy_job_blobs cb ON cb.destination_blob_id=m.destination_blob_id
  JOIN bulk_jobs j ON j.id=cb.job_id JOIN operations o ON o.op_id=j.publish_op_id
  WHERE m.destination_blob_id=OLD.destination_blob_id AND m.state='stored' AND j.state='completed'
    AND o.kind='copy.publish' AND o.state='committed')) AND NOT EXISTS(SELECT 1 FROM copy_cleanup_receipts x JOIN copy_job_blobs cb
 ON cb.job_id=x.job_id AND cb.source_blob_id=x.source_blob_id WHERE x.destination_blob_id=OLD.destination_blob_id
 AND cb.destination_blob_id=x.destination_blob_id)
BEGIN SELECT RAISE(ABORT,'copy_multipart_held'); END;
CREATE TRIGGER copy_destination_hold BEFORE UPDATE OF state ON blobs
WHEN NEW.state IN ('deleting','deleted') AND EXISTS(SELECT 1 FROM copy_job_blobs WHERE destination_blob_id=NEW.id)
 AND NOT EXISTS(SELECT 1 FROM copy_cleanup_receipts x WHERE x.destination_blob_id=NEW.id
   AND x.disposition IN ('unwritten','aborted') AND NEW.state='deleted' AND NEW.ref_count=0
   AND NOT EXISTS(SELECT 1 FROM blob_storage WHERE blob_id=NEW.id))
BEGIN SELECT RAISE(ABORT,'copy_destination_held'); END;
CREATE TRIGGER backup_freeze_copy_cleanup_receipts_insert BEFORE INSERT ON copy_cleanup_receipts
WHEN (SELECT backup_frozen FROM control WHERE singleton=1)=1
BEGIN SELECT RAISE(ABORT,'backup_frozen'); END;
CREATE TRIGGER restore_freeze_copy_cleanup_receipts_insert BEFORE INSERT ON copy_cleanup_receipts
WHEN (SELECT restore_freeze_token FROM control WHERE singleton=1) IS NOT NULL
BEGIN SELECT RAISE(ABORT,'database_restore_frozen'); END;
CREATE TRIGGER backup_freeze_copy_cleanup_receipts_update BEFORE UPDATE ON copy_cleanup_receipts
WHEN (SELECT backup_frozen FROM control WHERE singleton=1)=1
BEGIN SELECT RAISE(ABORT,'backup_frozen'); END;
CREATE TRIGGER restore_freeze_copy_cleanup_receipts_update BEFORE UPDATE ON copy_cleanup_receipts
WHEN (SELECT restore_freeze_token FROM control WHERE singleton=1) IS NOT NULL
BEGIN SELECT RAISE(ABORT,'database_restore_frozen'); END;
CREATE TRIGGER backup_freeze_copy_cleanup_receipts_delete BEFORE DELETE ON copy_cleanup_receipts
WHEN (SELECT backup_frozen FROM control WHERE singleton=1)=1
BEGIN SELECT RAISE(ABORT,'backup_frozen'); END;
CREATE TRIGGER restore_freeze_copy_cleanup_receipts_delete BEFORE DELETE ON copy_cleanup_receipts
WHEN (SELECT restore_freeze_token FROM control WHERE singleton=1) IS NOT NULL
BEGIN SELECT RAISE(ABORT,'database_restore_frozen'); END;
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
