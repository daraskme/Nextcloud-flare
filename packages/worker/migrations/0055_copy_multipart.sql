-- Preserve every native write receipt while adding copy multipart dispatch.
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
 kind TEXT NOT NULL CHECK(kind IN ('empty.put','manifest.put','manifest.delete','blob.delete','orphan.delete','upload.put','multipart.create','multipart.part','multipart.complete','multipart.abort','bucket.abort','probe.put','backups.probe.put','backup.delete','copy.put','copy.multipart.create','copy.multipart.part','copy.multipart.complete')),
 r2_key TEXT NOT NULL CHECK(length(CAST(r2_key AS BLOB)) BETWEEN 1 AND 1024),
 dispatch_before INTEGER NOT NULL,
 started_at INTEGER NOT NULL CHECK(started_at>=0),
 state TEXT NOT NULL CHECK(state IN ('pending','succeeded','not_started')),
 finished_at INTEGER CHECK(finished_at>=started_at),
 source_ref TEXT CHECK(source_ref IS NULL OR length(source_ref) BETWEEN 1 AND 512),
 CHECK((kind IN ('upload.put','multipart.create','multipart.part','multipart.complete','multipart.abort','bucket.abort','probe.put','backups.probe.put','backup.delete','copy.put','copy.multipart.create','copy.multipart.part','copy.multipart.complete'))=(source_ref IS NOT NULL)),
 CHECK(dispatch_before>started_at AND dispatch_before<=started_at+5000),
 CHECK((kind IN ('orphan.delete','bucket.abort','probe.put','backups.probe.put','backup.delete'))=(owner_id IS NULL)),
 CHECK((state='pending')=(finished_at IS NULL))
) STRICT;
INSERT INTO _r2_write_attempts_next SELECT * FROM r2_write_attempts;
INSERT INTO _assert(v) SELECT 1 WHERE EXISTS(SELECT * FROM r2_write_attempts EXCEPT SELECT * FROM _r2_write_attempts_next) OR EXISTS(SELECT * FROM _r2_write_attempts_next EXCEPT SELECT * FROM r2_write_attempts);
DROP TRIGGER restore_freeze_r2_write_pending;
DROP TRIGGER r2_write_resume_pending;
DROP TRIGGER copy_transfer_stored;
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
CREATE TRIGGER restore_freeze_r2_write_pending BEFORE UPDATE OF restore_freeze_token ON control
WHEN NEW.restore_freeze_token IS NOT NULL AND EXISTS(SELECT 1 FROM r2_write_attempts WHERE state='pending')
BEGIN SELECT RAISE(ABORT,'restore_freeze_not_drained'); END;
CREATE TRIGGER r2_write_resume_pending BEFORE UPDATE OF maintenance ON control
WHEN NEW.maintenance=0 AND OLD.maintenance=1 AND EXISTS(SELECT 1 FROM r2_write_attempts WHERE state='pending')
BEGIN SELECT RAISE(ABORT,'r2_write_unsettled'); END;
CREATE TRIGGER r2_write_blob_gc BEFORE UPDATE OF state ON blobs
WHEN NEW.state IN ('deleting','deleted') AND EXISTS(SELECT 1 FROM r2_write_attempts WHERE r2_key=NEW.r2_key AND state='pending')
BEGIN SELECT RAISE(ABORT,'r2_write_unsettled'); END;
CREATE TRIGGER r2_write_orphan_gc BEFORE UPDATE OF state ON orphan_objects
WHEN NEW.state IN ('deleting','deleted') AND EXISTS(SELECT 1 FROM r2_write_attempts WHERE r2_key=NEW.r2_key AND state='pending')
BEGIN SELECT RAISE(ABORT,'r2_write_unsettled'); END;
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

-- Existing freeze guard ordering is retained after dependent trigger recreation.
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
DROP TRIGGER backup_freeze_control_insert;
CREATE TRIGGER backup_freeze_control_insert BEFORE INSERT ON control
WHEN (SELECT backup_frozen FROM control WHERE singleton=1)=1
BEGIN SELECT RAISE(ABORT,'backup_frozen'); END;
DROP TRIGGER backup_freeze_control_delete;
CREATE TRIGGER backup_freeze_control_delete BEFORE DELETE ON control
WHEN (SELECT backup_frozen FROM control WHERE singleton=1)=1
BEGIN SELECT RAISE(ABORT,'backup_frozen'); END;
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
DROP TRIGGER restore_freeze_control_update;
CREATE TRIGGER restore_freeze_control_update BEFORE UPDATE ON control
WHEN OLD.restore_freeze_token IS NOT NULL AND (NEW.restore_freeze_token IS NOT NULL
 OR NEW.singleton IS NOT OLD.singleton OR NEW.epoch IS NOT OLD.epoch OR NEW.maintenance IS NOT OLD.maintenance OR NEW.gc_paused IS NOT OLD.gc_paused OR NEW.bootstrap_done_at IS NOT OLD.bootstrap_done_at OR NEW.bootstrap_iss IS NOT OLD.bootstrap_iss OR NEW.bootstrap_sub IS NOT OLD.bootstrap_sub OR NEW.backup_barrier_op IS NOT OLD.backup_barrier_op OR NEW.updated_at IS NOT OLD.updated_at OR NEW.admission_revision IS NOT OLD.admission_revision OR NEW.admission_token IS NOT OLD.admission_token OR NEW.gc_operator_paused IS NOT OLD.gc_operator_paused OR NEW.gc_hold_token IS NOT OLD.gc_hold_token OR NEW.gc_hold_operation IS NOT OLD.gc_hold_operation OR NEW.gc_hold_expires_at IS NOT OLD.gc_hold_expires_at OR NEW.kdf_not_before IS NOT OLD.kdf_not_before OR NEW.backup_token IS NOT OLD.backup_token OR NEW.backup_frozen IS NOT OLD.backup_frozen OR NEW.backup_last_op IS NOT OLD.backup_last_op)
BEGIN SELECT RAISE(ABORT,'database_restore_frozen'); END;
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
DROP TRIGGER restore_freeze_control_insert;
CREATE TRIGGER restore_freeze_control_insert BEFORE INSERT ON control
WHEN (SELECT restore_freeze_token FROM control WHERE singleton=1) IS NOT NULL
BEGIN SELECT RAISE(ABORT,'database_restore_frozen'); END;
DROP TRIGGER restore_freeze_control_delete;
CREATE TRIGGER restore_freeze_control_delete BEFORE DELETE ON control
WHEN (SELECT restore_freeze_token FROM control WHERE singleton=1) IS NOT NULL
BEGIN SELECT RAISE(ABORT,'database_restore_frozen'); END;
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
DROP TRIGGER backup_freeze_multipart_bucket_abort_reconciliations_update;
CREATE TRIGGER backup_freeze_multipart_bucket_abort_reconciliations_update BEFORE UPDATE ON multipart_bucket_abort_reconciliations
WHEN (SELECT backup_frozen FROM control WHERE singleton=1)=1
BEGIN SELECT RAISE(ABORT,'backup_frozen'); END;
DROP TRIGGER backup_freeze_multipart_bucket_abort_reconciliations_delete;
CREATE TRIGGER backup_freeze_multipart_bucket_abort_reconciliations_delete BEFORE DELETE ON multipart_bucket_abort_reconciliations
WHEN (SELECT backup_frozen FROM control WHERE singleton=1)=1
BEGIN SELECT RAISE(ABORT,'backup_frozen'); END;
DROP TRIGGER restore_freeze_multipart_bucket_abort_reconciliations_update;
CREATE TRIGGER restore_freeze_multipart_bucket_abort_reconciliations_update BEFORE UPDATE ON multipart_bucket_abort_reconciliations
WHEN (SELECT restore_freeze_token FROM control WHERE singleton=1) IS NOT NULL
BEGIN SELECT RAISE(ABORT,'database_restore_frozen'); END;
DROP TRIGGER restore_freeze_multipart_bucket_abort_reconciliations_delete;
CREATE TRIGGER restore_freeze_multipart_bucket_abort_reconciliations_delete BEFORE DELETE ON multipart_bucket_abort_reconciliations
WHEN (SELECT restore_freeze_token FROM control WHERE singleton=1) IS NOT NULL
BEGIN SELECT RAISE(ABORT,'database_restore_frozen'); END;
DROP TRIGGER backup_freeze_copy_job_blobs_insert;
CREATE TRIGGER backup_freeze_copy_job_blobs_insert BEFORE INSERT ON copy_job_blobs
WHEN (SELECT backup_frozen FROM control WHERE singleton=1)=1
BEGIN SELECT RAISE(ABORT,'backup_frozen'); END;
DROP TRIGGER restore_freeze_copy_job_blobs_insert;
CREATE TRIGGER restore_freeze_copy_job_blobs_insert BEFORE INSERT ON copy_job_blobs
WHEN (SELECT restore_freeze_token FROM control WHERE singleton=1) IS NOT NULL
BEGIN SELECT RAISE(ABORT,'database_restore_frozen'); END;
DROP TRIGGER backup_freeze_copy_job_blobs_delete;
CREATE TRIGGER backup_freeze_copy_job_blobs_delete BEFORE DELETE ON copy_job_blobs
WHEN (SELECT backup_frozen FROM control WHERE singleton=1)=1
BEGIN SELECT RAISE(ABORT,'backup_frozen'); END;
DROP TRIGGER restore_freeze_copy_job_blobs_delete;
CREATE TRIGGER restore_freeze_copy_job_blobs_delete BEFORE DELETE ON copy_job_blobs
WHEN (SELECT restore_freeze_token FROM control WHERE singleton=1) IS NOT NULL
BEGIN SELECT RAISE(ABORT,'database_restore_frozen'); END;
DROP TRIGGER backup_freeze_multipart_bucket_abort_reconciliations_insert;
CREATE TRIGGER backup_freeze_multipart_bucket_abort_reconciliations_insert BEFORE INSERT ON multipart_bucket_abort_reconciliations
WHEN (SELECT backup_frozen FROM control WHERE singleton=1)=1
BEGIN SELECT RAISE(ABORT,'backup_frozen'); END;
DROP TRIGGER restore_freeze_multipart_bucket_abort_reconciliations_insert;
CREATE TRIGGER restore_freeze_multipart_bucket_abort_reconciliations_insert BEFORE INSERT ON multipart_bucket_abort_reconciliations
WHEN (SELECT restore_freeze_token FROM control WHERE singleton=1) IS NOT NULL
BEGIN SELECT RAISE(ABORT,'database_restore_frozen'); END;

ALTER TABLE copy_job_blobs ADD COLUMN transfer_mode TEXT NOT NULL DEFAULT 'single' CHECK(transfer_mode IN ('single','multipart'));
DROP TRIGGER copy_job_blobs_identity;
CREATE TRIGGER copy_job_blobs_identity BEFORE UPDATE ON copy_job_blobs WHEN
  NEW.job_id<>OLD.job_id OR NEW.source_blob_id<>OLD.source_blob_id OR NEW.destination_blob_id<>OLD.destination_blob_id
  OR NEW.pin_id<>OLD.pin_id OR NEW.reservation_id<>OLD.reservation_id
  OR (OLD.transfer_state<>'pending' AND (NEW.transfer_attempt IS NOT OLD.transfer_attempt
    OR NEW.transfer_claim IS NOT OLD.transfer_claim OR NEW.transfer_sha256 IS NOT OLD.transfer_sha256
    OR NEW.transfer_node_id IS NOT OLD.transfer_node_id OR NEW.transfer_mode<>OLD.transfer_mode))
  OR NOT ((OLD.transfer_state='pending' AND NEW.transfer_state='claimed')
    OR (OLD.transfer_state='claimed' AND NEW.transfer_state='stored') OR NEW.transfer_state=OLD.transfer_state)
BEGIN SELECT RAISE(ABORT,'immutable_copy_hold'); END;
DROP TRIGGER copy_transfer_initial;
CREATE TRIGGER copy_transfer_initial BEFORE INSERT ON copy_job_blobs WHEN NEW.transfer_state<>'pending' OR NEW.transfer_mode<>'single'
  OR NEW.transfer_attempt IS NOT NULL OR NEW.transfer_claim IS NOT NULL OR NEW.transfer_sha256 IS NOT NULL OR NEW.transfer_node_id IS NOT NULL
BEGIN SELECT RAISE(ABORT,'invalid_copy_transfer'); END;
DROP TRIGGER copy_transfer_shape;
CREATE TRIGGER copy_transfer_shape BEFORE UPDATE ON copy_job_blobs WHEN
  (NEW.transfer_state='pending' AND (NEW.transfer_mode<>'single' OR NEW.transfer_attempt IS NOT NULL OR NEW.transfer_claim IS NOT NULL OR NEW.transfer_sha256 IS NOT NULL OR NEW.transfer_node_id IS NOT NULL))
  OR (NEW.transfer_state<>'pending' AND (NEW.transfer_attempt IS NULL OR length(NEW.transfer_attempt)<>36
    OR NEW.transfer_claim IS NULL OR length(NEW.transfer_claim)<>36
    OR (NEW.transfer_mode='single' AND (NEW.transfer_sha256 IS NULL OR length(NEW.transfer_sha256)<>64 OR NEW.transfer_sha256 GLOB '*[^a-f0-9]*'))
    OR (NEW.transfer_mode='multipart' AND NEW.transfer_sha256 IS NOT NULL)
    OR NEW.transfer_node_id IS NULL OR length(NEW.transfer_node_id) NOT BETWEEN 1 AND 128 OR NEW.transfer_node_id GLOB '*[^A-Za-z0-9_-]*'))
BEGIN SELECT RAISE(ABORT,'invalid_copy_transfer'); END;

CREATE TABLE copy_multipart_uploads(
  destination_blob_id TEXT NOT NULL PRIMARY KEY REFERENCES copy_job_blobs(destination_blob_id),
  init_attempt TEXT NOT NULL UNIQUE CHECK(length(init_attempt)=36),
  init_claim TEXT NOT NULL CHECK(length(init_claim)=36),
  part_bytes INTEGER NOT NULL CHECK(part_bytes BETWEEN 8388608 AND 94371840),
  part_count INTEGER NOT NULL CHECK(part_count BETWEEN 1 AND 10000),
  r2_upload_id TEXT CHECK(r2_upload_id IS NULL OR length(r2_upload_id) BETWEEN 1 AND 1024),
  state TEXT NOT NULL CHECK(state IN ('creating','uploading','completing','stored')),
  complete_attempt TEXT UNIQUE CHECK(complete_attempt IS NULL OR length(complete_attempt)=36),
  complete_claim TEXT CHECK(complete_claim IS NULL OR length(complete_claim)=36),
  object_etag TEXT CHECK(object_etag IS NULL OR length(object_etag) BETWEEN 1 AND 256),
  CHECK((state='creating')=(r2_upload_id IS NULL)),
  CHECK((state IN ('completing','stored'))=(complete_attempt IS NOT NULL)),
  CHECK((complete_attempt IS NULL)=(complete_claim IS NULL)),
  CHECK((state='stored')=(object_etag IS NOT NULL))
) STRICT;
CREATE TABLE copy_multipart_parts(
  destination_blob_id TEXT NOT NULL REFERENCES copy_multipart_uploads(destination_blob_id),
  part_number INTEGER NOT NULL CHECK(part_number BETWEEN 1 AND 10000),
  expected_size INTEGER NOT NULL CHECK(expected_size BETWEEN 1 AND 94371840),
  attempt_id TEXT NOT NULL UNIQUE CHECK(length(attempt_id)=36),
  claim_token TEXT NOT NULL CHECK(length(claim_token)=36),
  state TEXT NOT NULL CHECK(state IN ('claimed','stored')),
  sha256 TEXT CHECK(sha256 IS NULL OR (length(sha256)=64 AND sha256 NOT GLOB '*[^a-f0-9]*')),
  etag TEXT CHECK(etag IS NULL OR length(etag) BETWEEN 1 AND 1024),
  PRIMARY KEY(destination_blob_id,part_number),
  CHECK((state='stored')=(sha256 IS NOT NULL)),
  CHECK((sha256 IS NULL)=(etag IS NULL))
) STRICT;
CREATE TRIGGER copy_multipart_insert BEFORE INSERT ON copy_multipart_uploads WHEN NEW.state<>'creating' OR NOT EXISTS(
  SELECT 1 FROM copy_job_blobs cb JOIN bulk_jobs j ON j.id=cb.job_id
  JOIN blobs src ON src.id=cb.source_blob_id JOIN blobs dst ON dst.id=cb.destination_blob_id
  WHERE cb.destination_blob_id=NEW.destination_blob_id AND cb.transfer_mode='multipart' AND cb.transfer_state='claimed'
    AND cb.transfer_attempt=NEW.init_attempt AND cb.transfer_claim=NEW.init_claim
    AND dst.state='staging' AND dst.owner_id=j.owner_id AND dst.size=src.size AND src.size>8388608
    AND NEW.part_count=(src.size+NEW.part_bytes-1)/NEW.part_bytes)
BEGIN SELECT RAISE(ABORT,'invalid_copy_multipart'); END;
CREATE TRIGGER copy_multipart_identity BEFORE UPDATE ON copy_multipart_uploads WHEN
  NEW.destination_blob_id<>OLD.destination_blob_id OR NEW.init_attempt<>OLD.init_attempt OR NEW.init_claim<>OLD.init_claim
  OR NEW.part_bytes<>OLD.part_bytes OR NEW.part_count<>OLD.part_count
  OR (OLD.r2_upload_id IS NOT NULL AND NEW.r2_upload_id IS NOT OLD.r2_upload_id)
  OR (OLD.complete_attempt IS NOT NULL AND (NEW.complete_attempt IS NOT OLD.complete_attempt OR NEW.complete_claim IS NOT OLD.complete_claim))
  OR (OLD.object_etag IS NOT NULL AND NEW.object_etag IS NOT OLD.object_etag)
  OR NOT(OLD.state=NEW.state OR (OLD.state='creating' AND NEW.state='uploading')
    OR (OLD.state='uploading' AND NEW.state='completing') OR (OLD.state='completing' AND NEW.state='stored'))
BEGIN SELECT RAISE(ABORT,'immutable_copy_multipart'); END;
CREATE TRIGGER copy_multipart_handle BEFORE UPDATE OF r2_upload_id ON copy_multipart_uploads WHEN NEW.r2_upload_id IS NOT NULL AND NOT EXISTS(
  SELECT 1 FROM copy_job_blobs cb JOIN blobs b ON b.id=cb.destination_blob_id JOIN r2_write_attempts w ON w.r2_key=b.r2_key
  WHERE cb.destination_blob_id=NEW.destination_blob_id AND w.kind='copy.multipart.create' AND w.state IN ('pending','succeeded')
    AND w.source_ref=json_array(cb.job_id,cb.source_blob_id,NEW.init_attempt))
BEGIN SELECT RAISE(ABORT,'copy_write_receipt_required'); END;
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
CREATE TRIGGER copy_part_identity BEFORE UPDATE ON copy_multipart_parts WHEN
  NEW.destination_blob_id<>OLD.destination_blob_id OR NEW.part_number<>OLD.part_number OR NEW.expected_size<>OLD.expected_size
  OR NEW.attempt_id<>OLD.attempt_id OR NEW.claim_token<>OLD.claim_token
  OR (OLD.state='stored' AND (NEW.state<>OLD.state OR NEW.sha256 IS NOT OLD.sha256 OR NEW.etag IS NOT OLD.etag))
BEGIN SELECT RAISE(ABORT,'immutable_copy_part'); END;
CREATE TRIGGER copy_part_stored BEFORE UPDATE OF state ON copy_multipart_parts WHEN NEW.state='stored' AND NOT EXISTS(
  SELECT 1 FROM copy_job_blobs cb JOIN blobs b ON b.id=cb.destination_blob_id JOIN r2_write_attempts w ON w.r2_key=b.r2_key
  WHERE cb.destination_blob_id=NEW.destination_blob_id AND w.kind='copy.multipart.part' AND w.state IN ('pending','succeeded')
    AND w.source_ref=json_array(cb.job_id,cb.source_blob_id,NEW.attempt_id))
BEGIN SELECT RAISE(ABORT,'copy_write_receipt_required'); END;
CREATE TRIGGER copy_multipart_complete BEFORE UPDATE OF state ON copy_multipart_uploads WHEN NEW.state='completing' AND NOT EXISTS(
  SELECT 1 FROM blobs b WHERE b.id=NEW.destination_blob_id
    AND (SELECT COUNT(*) FROM copy_multipart_parts WHERE destination_blob_id=b.id)=NEW.part_count
    AND (SELECT SUM(expected_size) FROM copy_multipart_parts WHERE destination_blob_id=b.id)=b.size
    AND NOT EXISTS(SELECT 1 FROM copy_multipart_parts p WHERE p.destination_blob_id=b.id
      AND (p.state<>'stored' OR p.part_number>NEW.part_count OR p.expected_size<>MIN(NEW.part_bytes,b.size-(p.part_number-1)*NEW.part_bytes))))
BEGIN SELECT RAISE(ABORT,'copy_parts_incomplete'); END;
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
CREATE TRIGGER copy_multipart_stored BEFORE UPDATE OF state ON copy_multipart_uploads
WHEN NEW.state='stored' AND NOT EXISTS(
  SELECT 1 FROM copy_job_blobs cb JOIN blobs b ON b.id=cb.destination_blob_id
    JOIN blob_storage s ON s.blob_id=b.id JOIN r2_write_attempts w ON w.r2_key=b.r2_key
  WHERE cb.destination_blob_id=NEW.destination_blob_id AND b.state='staging'
    AND s.bytes=b.size AND s.r2_etag=NEW.object_etag AND s.removed_at IS NULL
    AND w.kind='copy.multipart.complete' AND w.state IN ('pending','succeeded')
    AND w.source_ref=json_array(cb.job_id,cb.source_blob_id,NEW.complete_attempt))
BEGIN SELECT RAISE(ABORT,'copy_write_receipt_required'); END;
CREATE TRIGGER copy_multipart_delete BEFORE DELETE ON copy_multipart_uploads
BEGIN SELECT RAISE(ABORT,'copy_multipart_held'); END;
CREATE TRIGGER copy_part_delete BEFORE DELETE ON copy_multipart_parts
BEGIN SELECT RAISE(ABORT,'copy_multipart_held'); END;
-- Copy cancellation must settle the job's own native attempts and holds first.
CREATE TRIGGER copy_multipart_bucket_abort BEFORE INSERT ON multipart_bucket_abort_attempts
WHEN EXISTS(SELECT 1 FROM multipart_bucket_handles h JOIN blobs b ON b.r2_key=h.r2_key
  JOIN copy_job_blobs cb ON cb.destination_blob_id=b.id WHERE h.id=NEW.handle_id)
BEGIN SELECT RAISE(ABORT,'copy_multipart_held'); END;
DROP TRIGGER multipart_bucket_handle_insert;
CREATE TRIGGER multipart_bucket_handle_insert BEFORE INSERT ON multipart_bucket_handles
WHEN NEW.held_bytes<>0 OR NEW.part_round_id IS NOT NULL OR NEW.part_calls<>0
 OR (NEW.state='tracked'
   AND NOT EXISTS(SELECT 1 FROM uploads u JOIN blobs b ON b.id=u.blob_id
     WHERE b.r2_key=NEW.r2_key AND u.r2_upload_id=NEW.r2_upload_id)
   AND NOT EXISTS(SELECT 1 FROM copy_multipart_uploads m JOIN blobs b ON b.id=m.destination_blob_id
     WHERE b.r2_key=NEW.r2_key AND m.r2_upload_id=NEW.r2_upload_id))
BEGIN SELECT RAISE(ABORT,'invalid_multipart_bucket_handle'); END;
CREATE TRIGGER backup_freeze_copy_multipart_uploads_insert BEFORE INSERT ON copy_multipart_uploads
WHEN (SELECT backup_frozen FROM control WHERE singleton=1)=1
BEGIN SELECT RAISE(ABORT,'backup_frozen'); END;
CREATE TRIGGER restore_freeze_copy_multipart_uploads_insert BEFORE INSERT ON copy_multipart_uploads
WHEN (SELECT restore_freeze_token FROM control WHERE singleton=1) IS NOT NULL
BEGIN SELECT RAISE(ABORT,'database_restore_frozen'); END;
CREATE TRIGGER backup_freeze_copy_multipart_uploads_update BEFORE UPDATE ON copy_multipart_uploads
WHEN (SELECT backup_frozen FROM control WHERE singleton=1)=1
BEGIN SELECT RAISE(ABORT,'backup_frozen'); END;
CREATE TRIGGER restore_freeze_copy_multipart_uploads_update BEFORE UPDATE ON copy_multipart_uploads
WHEN (SELECT restore_freeze_token FROM control WHERE singleton=1) IS NOT NULL
BEGIN SELECT RAISE(ABORT,'database_restore_frozen'); END;
CREATE TRIGGER backup_freeze_copy_multipart_uploads_delete BEFORE DELETE ON copy_multipart_uploads
WHEN (SELECT backup_frozen FROM control WHERE singleton=1)=1
BEGIN SELECT RAISE(ABORT,'backup_frozen'); END;
CREATE TRIGGER restore_freeze_copy_multipart_uploads_delete BEFORE DELETE ON copy_multipart_uploads
WHEN (SELECT restore_freeze_token FROM control WHERE singleton=1) IS NOT NULL
BEGIN SELECT RAISE(ABORT,'database_restore_frozen'); END;
CREATE TRIGGER backup_freeze_copy_multipart_parts_insert BEFORE INSERT ON copy_multipart_parts
WHEN (SELECT backup_frozen FROM control WHERE singleton=1)=1
BEGIN SELECT RAISE(ABORT,'backup_frozen'); END;
CREATE TRIGGER restore_freeze_copy_multipart_parts_insert BEFORE INSERT ON copy_multipart_parts
WHEN (SELECT restore_freeze_token FROM control WHERE singleton=1) IS NOT NULL
BEGIN SELECT RAISE(ABORT,'database_restore_frozen'); END;
CREATE TRIGGER backup_freeze_copy_multipart_parts_update BEFORE UPDATE ON copy_multipart_parts
WHEN (SELECT backup_frozen FROM control WHERE singleton=1)=1
BEGIN SELECT RAISE(ABORT,'backup_frozen'); END;
CREATE TRIGGER restore_freeze_copy_multipart_parts_update BEFORE UPDATE ON copy_multipart_parts
WHEN (SELECT restore_freeze_token FROM control WHERE singleton=1) IS NOT NULL
BEGIN SELECT RAISE(ABORT,'database_restore_frozen'); END;
CREATE TRIGGER backup_freeze_copy_multipart_parts_delete BEFORE DELETE ON copy_multipart_parts
WHEN (SELECT backup_frozen FROM control WHERE singleton=1)=1
BEGIN SELECT RAISE(ABORT,'backup_frozen'); END;
CREATE TRIGGER restore_freeze_copy_multipart_parts_delete BEFORE DELETE ON copy_multipart_parts
WHEN (SELECT restore_freeze_token FROM control WHERE singleton=1) IS NOT NULL
BEGIN SELECT RAISE(ABORT,'database_restore_frozen'); END;

DROP TRIGGER backup_freeze_copy_job_blobs_update;
CREATE TRIGGER backup_freeze_copy_job_blobs_update BEFORE UPDATE ON copy_job_blobs
WHEN (SELECT backup_frozen FROM control WHERE singleton=1)=1
BEGIN SELECT RAISE(ABORT,'backup_frozen'); END;

DROP TRIGGER restore_freeze_copy_job_blobs_update;
CREATE TRIGGER restore_freeze_copy_job_blobs_update BEFORE UPDATE ON copy_job_blobs
WHEN (SELECT restore_freeze_token FROM control WHERE singleton=1) IS NOT NULL
BEGIN SELECT RAISE(ABORT,'database_restore_frozen'); END;

DROP TRIGGER backup_freeze_multipart_bucket_handles_insert;
CREATE TRIGGER backup_freeze_multipart_bucket_handles_insert BEFORE INSERT ON multipart_bucket_handles
WHEN (SELECT backup_frozen FROM control WHERE singleton=1)=1
BEGIN SELECT RAISE(ABORT,'backup_frozen'); END;

DROP TRIGGER restore_freeze_multipart_bucket_handles_insert;
CREATE TRIGGER restore_freeze_multipart_bucket_handles_insert BEFORE INSERT ON multipart_bucket_handles
WHEN (SELECT restore_freeze_token FROM control WHERE singleton=1) IS NOT NULL
BEGIN SELECT RAISE(ABORT,'database_restore_frozen'); END;

DROP TRIGGER backup_freeze_multipart_bucket_abort_attempts_insert;
CREATE TRIGGER backup_freeze_multipart_bucket_abort_attempts_insert BEFORE INSERT ON multipart_bucket_abort_attempts
WHEN (SELECT backup_frozen FROM control WHERE singleton=1)=1
BEGIN SELECT RAISE(ABORT,'backup_frozen'); END;

DROP TRIGGER restore_freeze_multipart_bucket_abort_attempts_insert;
CREATE TRIGGER restore_freeze_multipart_bucket_abort_attempts_insert BEFORE INSERT ON multipart_bucket_abort_attempts
WHEN (SELECT restore_freeze_token FROM control WHERE singleton=1) IS NOT NULL
BEGIN SELECT RAISE(ABORT,'database_restore_frozen'); END;
