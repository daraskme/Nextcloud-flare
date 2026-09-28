-- Preserve every native write receipt while adding copy PUT dispatch.
INSERT INTO _assert(v) SELECT 1 WHERE NOT EXISTS(
 SELECT 1 FROM control WHERE singleton=1 AND maintenance=1 AND backup_token IS NULL
 AND backup_frozen=0 AND restore_freeze_token IS NULL)
 OR EXISTS(SELECT 1 FROM permits WHERE state='open')
 OR EXISTS(SELECT 1 FROM operations WHERE state='claimed')
 OR EXISTS(SELECT 1 FROM mutation_admissions WHERE state<>'closed');
CREATE TABLE _r2_write_attempts_next(
 id TEXT PRIMARY KEY CHECK(length(id)=36),
 token TEXT NOT NULL UNIQUE CHECK(length(token)=36),
 epoch INTEGER NOT NULL CHECK(epoch>0),
 owner_id TEXT CHECK(owner_id IS NULL OR length(owner_id) BETWEEN 1 AND 128),
 kind TEXT NOT NULL CHECK(kind IN ('empty.put','manifest.put','manifest.delete','blob.delete','orphan.delete','upload.put','multipart.create','multipart.part','multipart.complete','multipart.abort','bucket.abort','probe.put','backups.probe.put','backup.delete','copy.put')),
 r2_key TEXT NOT NULL CHECK(length(CAST(r2_key AS BLOB)) BETWEEN 1 AND 1024),
 dispatch_before INTEGER NOT NULL,
 started_at INTEGER NOT NULL CHECK(started_at>=0),
 state TEXT NOT NULL CHECK(state IN ('pending','succeeded','not_started')),
 finished_at INTEGER CHECK(finished_at>=started_at),
 source_ref TEXT CHECK(source_ref IS NULL OR length(source_ref) BETWEEN 1 AND 512),
 CHECK((kind IN ('upload.put','multipart.create','multipart.part','multipart.complete','multipart.abort','bucket.abort','probe.put','backups.probe.put','backup.delete','copy.put'))=(source_ref IS NOT NULL)),
 CHECK(dispatch_before>started_at AND dispatch_before<=started_at+5000),
 CHECK((kind IN ('orphan.delete','bucket.abort','probe.put','backups.probe.put','backup.delete'))=(owner_id IS NULL)),
 CHECK((state='pending')=(finished_at IS NULL))
) STRICT;
INSERT INTO _r2_write_attempts_next(id,token,epoch,owner_id,kind,r2_key,dispatch_before,started_at,state,finished_at,source_ref) SELECT id,token,epoch,owner_id,kind,r2_key,dispatch_before,started_at,state,finished_at,source_ref FROM r2_write_attempts;
INSERT INTO _assert(v) SELECT 1 WHERE EXISTS(SELECT id,token,epoch,owner_id,kind,r2_key,dispatch_before,started_at,state,finished_at,source_ref FROM r2_write_attempts EXCEPT SELECT id,token,epoch,owner_id,kind,r2_key,dispatch_before,started_at,state,finished_at,source_ref FROM _r2_write_attempts_next)
 OR EXISTS(SELECT id,token,epoch,owner_id,kind,r2_key,dispatch_before,started_at,state,finished_at,source_ref FROM _r2_write_attempts_next EXCEPT SELECT id,token,epoch,owner_id,kind,r2_key,dispatch_before,started_at,state,finished_at,source_ref FROM r2_write_attempts);
DROP TRIGGER restore_freeze_r2_write_pending;
DROP TRIGGER r2_write_resume_pending;
DROP TRIGGER r2_write_blob_gc;
DROP TRIGGER r2_write_orphan_gc;
DROP TRIGGER r2_write_upload_reservation;
DROP TRIGGER r2_write_upload_cleanup;
DROP TRIGGER multipart_bucket_abort_reconciliation_insert;
DROP TABLE r2_write_attempts;
ALTER TABLE _r2_write_attempts_next RENAME TO r2_write_attempts;
CREATE UNIQUE INDEX r2_write_source ON r2_write_attempts(kind,source_ref) WHERE source_ref IS NOT NULL AND state<>'not_started';
CREATE INDEX r2_write_pending ON r2_write_attempts(state,started_at);
CREATE INDEX r2_write_pending_key ON r2_write_attempts(r2_key) WHERE state='pending';
CREATE INDEX r2_write_key_history ON r2_write_attempts(r2_key,kind,state);
CREATE INDEX r2_write_finished ON r2_write_attempts(finished_at) WHERE state<>'pending';
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
CREATE TRIGGER restore_freeze_r2_write_pending BEFORE UPDATE OF restore_freeze_token ON control
WHEN NEW.restore_freeze_token IS NOT NULL AND EXISTS(SELECT 1 FROM r2_write_attempts WHERE state='pending')
BEGIN SELECT RAISE(ABORT,'restore_freeze_not_drained'); END;
CREATE TRIGGER r2_write_resume_pending BEFORE UPDATE OF maintenance ON control
WHEN NEW.maintenance=0 AND OLD.maintenance=1 AND EXISTS(SELECT 1 FROM r2_write_attempts WHERE state='pending')
BEGIN SELECT RAISE(ABORT,'r2_write_unsettled'); END;

ALTER TABLE copy_job_blobs ADD COLUMN transfer_state TEXT NOT NULL DEFAULT 'pending'
  CHECK(transfer_state IN ('pending','claimed','stored'));
ALTER TABLE copy_job_blobs ADD COLUMN transfer_attempt TEXT;
ALTER TABLE copy_job_blobs ADD COLUMN transfer_claim TEXT;
ALTER TABLE copy_job_blobs ADD COLUMN transfer_sha256 TEXT;
ALTER TABLE copy_job_blobs ADD COLUMN transfer_node_id TEXT;
CREATE UNIQUE INDEX copy_blob_transfer_attempt ON copy_job_blobs(transfer_attempt) WHERE transfer_attempt IS NOT NULL;
DROP TRIGGER copy_job_blobs_identity;
CREATE TRIGGER copy_job_blobs_identity BEFORE UPDATE ON copy_job_blobs WHEN
  NEW.job_id<>OLD.job_id OR NEW.source_blob_id<>OLD.source_blob_id OR NEW.destination_blob_id<>OLD.destination_blob_id
  OR NEW.pin_id<>OLD.pin_id OR NEW.reservation_id<>OLD.reservation_id
  OR (OLD.transfer_state<>'pending' AND (NEW.transfer_attempt IS NOT OLD.transfer_attempt
    OR NEW.transfer_claim IS NOT OLD.transfer_claim OR NEW.transfer_sha256 IS NOT OLD.transfer_sha256
    OR NEW.transfer_node_id IS NOT OLD.transfer_node_id))
  OR NOT ((OLD.transfer_state='pending' AND NEW.transfer_state='claimed')
    OR (OLD.transfer_state='claimed' AND NEW.transfer_state='stored') OR NEW.transfer_state=OLD.transfer_state)
BEGIN SELECT RAISE(ABORT,'immutable_copy_hold'); END;
CREATE TRIGGER copy_transfer_initial BEFORE INSERT ON copy_job_blobs WHEN NEW.transfer_state<>'pending'
  OR NEW.transfer_attempt IS NOT NULL OR NEW.transfer_claim IS NOT NULL OR NEW.transfer_sha256 IS NOT NULL OR NEW.transfer_node_id IS NOT NULL
BEGIN SELECT RAISE(ABORT,'invalid_copy_transfer'); END;
CREATE TRIGGER copy_transfer_shape BEFORE UPDATE ON copy_job_blobs WHEN
  (NEW.transfer_state='pending' AND (NEW.transfer_attempt IS NOT NULL OR NEW.transfer_claim IS NOT NULL OR NEW.transfer_sha256 IS NOT NULL OR NEW.transfer_node_id IS NOT NULL))
  OR (NEW.transfer_state<>'pending' AND (NEW.transfer_attempt IS NULL OR length(NEW.transfer_attempt)<>36
    OR NEW.transfer_claim IS NULL OR length(NEW.transfer_claim)<>36 OR NEW.transfer_sha256 IS NULL
    OR length(NEW.transfer_sha256)<>64 OR NEW.transfer_sha256 GLOB '*[^a-f0-9]*'
    OR NEW.transfer_node_id IS NULL OR length(NEW.transfer_node_id) NOT BETWEEN 1 AND 128 OR NEW.transfer_node_id GLOB '*[^A-Za-z0-9_-]*'))
BEGIN SELECT RAISE(ABORT,'invalid_copy_transfer'); END;
CREATE TRIGGER copy_transfer_stored BEFORE UPDATE OF transfer_state ON copy_job_blobs
WHEN NEW.transfer_state='stored' AND NOT EXISTS(
  SELECT 1 FROM blobs b JOIN blob_storage s ON s.blob_id=b.id JOIN bulk_jobs j ON j.id=NEW.job_id
  WHERE b.id=NEW.destination_blob_id AND b.owner_id=j.owner_id AND b.state='staging'
    AND b.sha256_verified=NEW.transfer_sha256 AND s.bytes=b.size AND s.removed_at IS NULL
    AND EXISTS(SELECT 1 FROM r2_write_attempts w WHERE w.kind='copy.put' AND w.state IN ('pending','succeeded')
      AND w.r2_key=b.r2_key AND w.source_ref=json_array(NEW.job_id,NEW.source_blob_id,NEW.transfer_attempt)))
BEGIN SELECT RAISE(ABORT,'copy_write_receipt_required'); END;
CREATE TRIGGER copy_destination_hold BEFORE UPDATE OF state ON blobs
WHEN NEW.state IN ('deleting','deleted') AND EXISTS(SELECT 1 FROM copy_job_blobs WHERE destination_blob_id=NEW.id)
BEGIN SELECT RAISE(ABORT,'copy_destination_held'); END;
CREATE TRIGGER copy_destination_delete BEFORE DELETE ON blobs
WHEN EXISTS(SELECT 1 FROM copy_job_blobs WHERE destination_blob_id=OLD.id)
BEGIN SELECT RAISE(ABORT,'copy_destination_held'); END;
CREATE TRIGGER r2_write_blob_gc BEFORE UPDATE OF state ON blobs
WHEN NEW.state IN ('deleting','deleted') AND EXISTS(SELECT 1 FROM r2_write_attempts WHERE r2_key=NEW.r2_key AND state='pending')
BEGIN SELECT RAISE(ABORT,'r2_write_unsettled'); END;
CREATE TRIGGER r2_write_orphan_gc BEFORE UPDATE OF state ON orphan_objects
WHEN NEW.state IN ('deleting','deleted') AND EXISTS(SELECT 1 FROM r2_write_attempts WHERE r2_key=NEW.r2_key AND state='pending')
BEGIN SELECT RAISE(ABORT,'r2_write_unsettled'); END;
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

-- Neither cleanup nor an expired transfer lease proves all native calls have ended.
CREATE TRIGGER r2_write_upload_reservation BEFORE UPDATE OF state ON reservations
WHEN OLD.state='reserved' AND NEW.state='released' AND EXISTS(
 SELECT 1 FROM uploads u JOIN blobs b ON b.id=u.blob_id JOIN r2_write_attempts w ON w.r2_key=b.r2_key
 WHERE u.reservation_id=OLD.id AND w.state='pending')
BEGIN SELECT RAISE(ABORT,'r2_write_unsettled'); END;
CREATE TRIGGER r2_write_upload_cleanup BEFORE UPDATE OF cleanup_pending ON uploads
WHEN OLD.cleanup_pending=1 AND NEW.cleanup_pending=0 AND EXISTS(
 SELECT 1 FROM blobs b JOIN r2_write_attempts w ON w.r2_key=b.r2_key WHERE b.id=NEW.blob_id AND w.state='pending')
BEGIN SELECT RAISE(ABORT,'r2_write_unsettled'); END;

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

-- Restore the freeze guards after recreating the dependent domain trigger.
DROP TRIGGER backup_freeze_multipart_bucket_abort_reconciliations_insert;
CREATE TRIGGER backup_freeze_multipart_bucket_abort_reconciliations_insert BEFORE INSERT ON multipart_bucket_abort_reconciliations
WHEN (SELECT backup_frozen FROM control WHERE singleton=1)=1
BEGIN SELECT RAISE(ABORT,'backup_frozen'); END;
DROP TRIGGER restore_freeze_multipart_bucket_abort_reconciliations_insert;
CREATE TRIGGER restore_freeze_multipart_bucket_abort_reconciliations_insert BEFORE INSERT ON multipart_bucket_abort_reconciliations
WHEN (SELECT restore_freeze_token FROM control WHERE singleton=1) IS NOT NULL
BEGIN SELECT RAISE(ABORT,'database_restore_frozen'); END;
