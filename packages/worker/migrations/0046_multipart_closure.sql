-- Whole-bucket absence proofs and exact settlement receipts for unknown multipart state.
CREATE TABLE multipart_closure_runs(
  id TEXT NOT NULL PRIMARY KEY,
  source TEXT NOT NULL CHECK(json_valid(source)),
  epoch INTEGER NOT NULL CHECK(epoch>0),
  phase TEXT NOT NULL CHECK(phase IN ('waiting','scanning','proven','stale')),
  generation INTEGER NOT NULL DEFAULT 0 CHECK(generation>=0),
  not_before INTEGER NOT NULL CHECK(not_before>=0),
  scan_round_id TEXT,
  calls INTEGER NOT NULL DEFAULT 0 CHECK(calls BETWEEN 0 AND 10000),
  created_at INTEGER NOT NULL CHECK(created_at>=0),
  updated_at INTEGER NOT NULL CHECK(updated_at>=created_at),
  proven_at INTEGER CHECK(proven_at IS NULL OR proven_at>=created_at),
  CHECK((phase='waiting' AND scan_round_id IS NULL AND proven_at IS NULL)
    OR (phase='scanning' AND scan_round_id IS NOT NULL AND proven_at IS NULL)
    OR (phase='proven' AND scan_round_id IS NOT NULL AND proven_at IS NOT NULL)
    OR (phase='stale' AND proven_at IS NULL))
) STRICT;
CREATE UNIQUE INDEX multipart_closure_active ON multipart_closure_runs((1))
  WHERE phase IN ('waiting','scanning');
CREATE INDEX multipart_closure_epoch ON multipart_closure_runs(epoch,created_at,id);

CREATE TABLE multipart_bucket_handle_settlements(
  handle_id TEXT NOT NULL PRIMARY KEY REFERENCES multipart_bucket_handles(id),
  closure_id TEXT NOT NULL REFERENCES multipart_closure_runs(id),
  owner_id TEXT REFERENCES users(id),
  held_bytes INTEGER NOT NULL CHECK(held_bytes>=0),
  settled_at INTEGER NOT NULL CHECK(settled_at>=0)
) STRICT;
CREATE INDEX multipart_bucket_handle_settlement_closure
  ON multipart_bucket_handle_settlements(closure_id,settled_at,handle_id);
CREATE INDEX multipart_bucket_handle_settlement_owner
  ON multipart_bucket_handle_settlements(owner_id,settled_at,handle_id);

CREATE TABLE multipart_upload_settlements(
  upload_id TEXT NOT NULL PRIMARY KEY REFERENCES uploads(id),
  closure_id TEXT NOT NULL REFERENCES multipart_closure_runs(id),
  owner_id TEXT NOT NULL REFERENCES users(id),
  reservation_id TEXT NOT NULL REFERENCES reservations(id),
  share_id TEXT REFERENCES shares(id),
  token TEXT NOT NULL CHECK(length(token)=36),
  lease_expires_at INTEGER NOT NULL CHECK(lease_expires_at>=0),
  head_calls INTEGER NOT NULL DEFAULT 0 CHECK(head_calls BETWEEN 0 AND 64),
  state TEXT NOT NULL CHECK(state IN ('claimed','settled')),
  object_state TEXT CHECK(object_state IN ('absent','present')),
  object_bytes INTEGER CHECK(object_bytes IS NULL OR object_bytes>=0),
  object_etag TEXT,
  error TEXT,
  claimed_at INTEGER NOT NULL CHECK(claimed_at>=0),
  settled_at INTEGER CHECK(settled_at IS NULL OR settled_at>=claimed_at),
  CHECK((state='claimed' AND object_state IS NULL AND object_bytes IS NULL
      AND object_etag IS NULL AND settled_at IS NULL)
    OR (state='settled' AND object_state IS NOT NULL AND settled_at IS NOT NULL
      AND ((object_state='absent' AND object_bytes IS NULL AND object_etag IS NULL)
        OR (object_state='present' AND object_bytes IS NOT NULL AND object_etag IS NOT NULL))))
) STRICT;
CREATE INDEX multipart_upload_settlement_closure
  ON multipart_upload_settlements(closure_id,state,claimed_at,upload_id);
CREATE INDEX multipart_upload_settlement_owner
  ON multipart_upload_settlements(owner_id,state,claimed_at,upload_id);
CREATE INDEX multipart_upload_settlement_reservation
  ON multipart_upload_settlements(reservation_id);
CREATE INDEX multipart_upload_settlement_share
  ON multipart_upload_settlements(share_id,state,claimed_at,upload_id);

CREATE TRIGGER multipart_closure_run_delete BEFORE DELETE ON multipart_closure_runs
BEGIN SELECT RAISE(ABORT,'multipart_closure_receipt_required'); END;
CREATE TRIGGER multipart_closure_run_identity BEFORE UPDATE ON multipart_closure_runs
WHEN NEW.id<>OLD.id OR NEW.source<>OLD.source OR NEW.epoch<>OLD.epoch
 OR NEW.created_at<>OLD.created_at OR NEW.generation<OLD.generation
 OR NEW.calls<OLD.calls OR NEW.phase='waiting' AND OLD.phase IN ('proven','stale')
 OR OLD.phase IN ('proven','stale') AND (
   NEW.phase<>OLD.phase OR NEW.generation<>OLD.generation OR NEW.not_before<>OLD.not_before
   OR NEW.scan_round_id IS NOT OLD.scan_round_id OR NEW.calls<>OLD.calls
   OR NEW.updated_at<>OLD.updated_at OR NEW.proven_at IS NOT OLD.proven_at)
BEGIN SELECT RAISE(ABORT,'immutable_multipart_closure'); END;

CREATE TRIGGER multipart_bucket_handle_settlement_insert BEFORE INSERT ON multipart_bucket_handle_settlements
WHEN NOT EXISTS(
  SELECT 1 FROM multipart_bucket_handles h
  JOIN multipart_closure_runs c ON c.id=NEW.closure_id
  WHERE h.id=NEW.handle_id AND h.state='quarantined'
    AND h.owner_id IS NEW.owner_id AND h.held_bytes=NEW.held_bytes
    AND h.source=c.source
    AND h.parts_completed_at IS NOT NULL
    AND c.phase='proven' AND c.epoch=(SELECT epoch FROM control WHERE singleton=1)
    AND h.last_round_id<>c.scan_round_id
    AND EXISTS(SELECT 1 FROM multipart_bucket_abort_attempts a
      WHERE a.handle_id=h.id AND a.outcome='confirmed' AND a.finished_at>=h.last_seen_at))
BEGIN SELECT RAISE(ABORT,'invalid_multipart_handle_settlement'); END;
CREATE TRIGGER multipart_bucket_handle_settlement_charge AFTER INSERT ON multipart_bucket_handle_settlements
WHEN NEW.owner_id IS NOT NULL
BEGIN
  UPDATE users SET physical_bytes=physical_bytes-NEW.held_bytes WHERE id=NEW.owner_id;
  INSERT INTO _assert SELECT CASE WHEN changes()=1 THEN 0 ELSE 1 END;
END;
CREATE TRIGGER multipart_bucket_handle_settlement_update BEFORE UPDATE ON multipart_bucket_handle_settlements
BEGIN SELECT RAISE(ABORT,'immutable_multipart_handle_settlement'); END;
CREATE TRIGGER multipart_bucket_handle_settlement_delete BEFORE DELETE ON multipart_bucket_handle_settlements
BEGIN SELECT RAISE(ABORT,'immutable_multipart_handle_settlement'); END;

CREATE TRIGGER multipart_upload_settlement_insert BEFORE INSERT ON multipart_upload_settlements
WHEN NOT EXISTS(
  SELECT 1 FROM uploads u
  JOIN blobs b ON b.id=u.blob_id
  JOIN reservations r ON r.id=u.reservation_id
  JOIN multipart_inventory_scans s ON s.upload_id=u.id
  JOIN multipart_closure_runs c ON c.id=NEW.closure_id
  WHERE u.id=NEW.upload_id AND u.owner_id=NEW.owner_id
    AND u.reservation_id=NEW.reservation_id AND r.owner_id=NEW.owner_id
    AND r.share_id IS NEW.share_id AND r.state='reserved'
    AND (r.share_id IS NULL OR EXISTS(SELECT 1 FROM shares sh
      WHERE sh.id=r.share_id AND sh.owner_id=NEW.owner_id))
    AND u.mode='multipart' AND u.state IN ('expired','aborted','failed')
    AND u.accept_parts=0 AND u.in_flight=0 AND u.cleanup_pending=1
    AND u.multipart_cleanup_started_at IS NOT NULL
    AND COALESCE(u.write_lease_expires_at,0)<=strftime('%s','now')*1000
    AND COALESCE(u.multipart_complete_lease,0)<=strftime('%s','now')*1000
    AND NOT EXISTS(SELECT 1 FROM upload_parts p WHERE p.upload_id=u.id
      AND p.state IN ('in_flight','unknown') AND p.lease_expires_at>strftime('%s','now')*1000)
    AND b.state='orphan' AND b.ref_count=0
    AND NOT EXISTS(SELECT 1 FROM blob_pins WHERE blob_id=b.id)
    AND NOT EXISTS(SELECT 1 FROM gc_candidates WHERE blob_id=b.id)
    AND s.completed_at IS NOT NULL
    AND NOT EXISTS(SELECT 1 FROM multipart_inventory_handles ih
      WHERE ih.upload_id=u.id AND ih.state<>'aborted')
    AND c.phase='proven' AND c.epoch=(SELECT epoch FROM control WHERE singleton=1)
    AND c.source=s.source
    AND NOT EXISTS(SELECT 1 FROM multipart_bucket_handles h
      WHERE h.r2_key=b.r2_key AND h.last_round_id=c.scan_round_id)
    AND NOT EXISTS(SELECT 1 FROM operations o
      WHERE o.state='committed' AND o.kind='upload.complete'
      AND o.credential_id=u.credential_id AND o.epoch=u.epoch AND o.space_id=u.space_id
      AND json_extract(o.operands_json,'$.uploadId')=u.id)
    AND NOT EXISTS(SELECT 1 FROM operation_steps os JOIN operations o ON o.op_id=os.op_id
      WHERE o.kind='upload.complete' AND o.credential_id=u.credential_id
      AND o.epoch=u.epoch AND o.space_id=u.space_id
      AND json_extract(o.operands_json,'$.uploadId')=u.id))
BEGIN SELECT RAISE(ABORT,'invalid_multipart_upload_settlement'); END;
CREATE TRIGGER multipart_upload_settlement_update BEFORE UPDATE ON multipart_upload_settlements
WHEN NEW.upload_id<>OLD.upload_id OR NEW.closure_id<>OLD.closure_id
 OR NEW.owner_id<>OLD.owner_id OR NEW.reservation_id<>OLD.reservation_id
 OR NEW.share_id IS NOT OLD.share_id OR NEW.claimed_at<>OLD.claimed_at
 OR NEW.head_calls<OLD.head_calls OR OLD.state='settled'
 OR (NEW.state='settled' AND (
   NEW.object_state IS NULL OR NEW.settled_at IS NULL OR
   NOT EXISTS(SELECT 1 FROM reservations r WHERE r.id=NEW.reservation_id
     AND r.owner_id=NEW.owner_id AND r.share_id IS NEW.share_id AND r.state='released')))
BEGIN SELECT RAISE(ABORT,'immutable_multipart_upload_settlement'); END;
CREATE TRIGGER multipart_upload_settlement_delete BEFORE DELETE ON multipart_upload_settlements
BEGIN SELECT RAISE(ABORT,'immutable_multipart_upload_settlement'); END;

-- A durable claim binds the exceptional release to this exact upload/owner/share proof.
DROP TRIGGER multipart_inventory_reservation_hold;
CREATE TRIGGER multipart_inventory_reservation_hold BEFORE UPDATE OF state ON reservations
WHEN NEW.state<>'reserved' AND EXISTS(
  SELECT 1 FROM uploads u JOIN multipart_inventory_scans s ON s.upload_id=u.id
  WHERE u.reservation_id=NEW.id)
 AND NOT EXISTS(SELECT 1 FROM multipart_upload_settlements x
  WHERE x.reservation_id=NEW.id AND x.upload_id=(SELECT id FROM uploads WHERE reservation_id=NEW.id)
    AND x.owner_id=NEW.owner_id AND x.share_id IS NEW.share_id AND x.state IN ('claimed','settled'))
BEGIN SELECT RAISE(ABORT,'multipart_inventory_closure_required'); END;

DROP TRIGGER multipart_inventory_upload_hold;
CREATE TRIGGER multipart_inventory_upload_hold BEFORE UPDATE ON uploads
WHEN EXISTS(SELECT 1 FROM multipart_inventory_scans WHERE upload_id=OLD.id)
 AND (NEW.cleanup_pending<>1 OR NEW.multipart_cleanup_closed IS NOT NULL
   OR NEW.state NOT IN ('expired','aborted','failed'))
 AND NOT EXISTS(SELECT 1 FROM multipart_upload_settlements x
   WHERE x.upload_id=OLD.id AND x.owner_id=OLD.owner_id AND x.reservation_id=OLD.reservation_id
     AND x.state IN ('claimed','settled'))
BEGIN SELECT RAISE(ABORT,'multipart_inventory_closure_required'); END;

-- Settled historical handles no longer quarantine a key; their immutable rows remain proof.
DROP TRIGGER blobs_multipart_bucket_insert;
CREATE TRIGGER blobs_multipart_bucket_insert BEFORE INSERT ON blobs
WHEN EXISTS(SELECT 1 FROM multipart_bucket_handles h WHERE h.r2_key=NEW.r2_key
  AND h.state='quarantined' AND NOT EXISTS(
    SELECT 1 FROM multipart_bucket_handle_settlements x WHERE x.handle_id=h.id))
BEGIN SELECT RAISE(ABORT,'multipart_key_quarantined'); END;
DROP TRIGGER blobs_multipart_bucket_commit;
CREATE TRIGGER blobs_multipart_bucket_commit BEFORE UPDATE OF state ON blobs
WHEN NEW.state='committed' AND OLD.state<>'committed'
 AND EXISTS(SELECT 1 FROM multipart_bucket_handles h WHERE h.r2_key=NEW.r2_key
  AND h.state='quarantined' AND NOT EXISTS(
    SELECT 1 FROM multipart_bucket_handle_settlements x WHERE x.handle_id=h.id))
BEGIN SELECT RAISE(ABORT,'multipart_key_quarantined'); END;
DROP TRIGGER derivatives_multipart_bucket_insert;
CREATE TRIGGER derivatives_multipart_bucket_insert BEFORE INSERT ON derivative_results
WHEN EXISTS(SELECT 1 FROM multipart_bucket_handles h WHERE h.r2_key=NEW.r2_key
  AND h.state='quarantined' AND NOT EXISTS(
    SELECT 1 FROM multipart_bucket_handle_settlements x WHERE x.handle_id=h.id))
BEGIN SELECT RAISE(ABORT,'multipart_key_quarantined'); END;
DROP TRIGGER derivatives_multipart_bucket_update;
CREATE TRIGGER derivatives_multipart_bucket_update BEFORE UPDATE OF r2_key ON derivative_results
WHEN EXISTS(SELECT 1 FROM multipart_bucket_handles h WHERE h.r2_key=NEW.r2_key
  AND h.state='quarantined' AND NOT EXISTS(
    SELECT 1 FROM multipart_bucket_handle_settlements x WHERE x.handle_id=h.id))
BEGIN SELECT RAISE(ABORT,'multipart_key_quarantined'); END;
DROP TRIGGER archive_multipart_bucket_insert;
CREATE TRIGGER archive_multipart_bucket_insert BEFORE INSERT ON archive_index
WHEN EXISTS(SELECT 1 FROM multipart_bucket_handles h WHERE h.r2_key=NEW.r2_key
  AND h.state='quarantined' AND NOT EXISTS(
    SELECT 1 FROM multipart_bucket_handle_settlements x WHERE x.handle_id=h.id))
BEGIN SELECT RAISE(ABORT,'multipart_key_quarantined'); END;
DROP TRIGGER archive_multipart_bucket_update;
CREATE TRIGGER archive_multipart_bucket_update BEFORE UPDATE OF r2_key ON archive_index
WHEN EXISTS(SELECT 1 FROM multipart_bucket_handles h WHERE h.r2_key=NEW.r2_key
  AND h.state='quarantined' AND NOT EXISTS(
    SELECT 1 FROM multipart_bucket_handle_settlements x WHERE x.handle_id=h.id))
BEGIN SELECT RAISE(ABORT,'multipart_key_quarantined'); END;
DROP TRIGGER targets_multipart_bucket_insert;
CREATE TRIGGER targets_multipart_bucket_insert BEFORE INSERT ON target_sets
WHEN EXISTS(SELECT 1 FROM multipart_bucket_handles h WHERE h.r2_key=NEW.manifest_ref
  AND h.state='quarantined' AND NOT EXISTS(
    SELECT 1 FROM multipart_bucket_handle_settlements x WHERE x.handle_id=h.id))
BEGIN SELECT RAISE(ABORT,'multipart_key_quarantined'); END;
DROP TRIGGER targets_multipart_bucket_update;
CREATE TRIGGER targets_multipart_bucket_update BEFORE UPDATE OF manifest_ref ON target_sets
WHEN EXISTS(SELECT 1 FROM multipart_bucket_handles h WHERE h.r2_key=NEW.manifest_ref
  AND h.state='quarantined' AND NOT EXISTS(
    SELECT 1 FROM multipart_bucket_handle_settlements x WHERE x.handle_id=h.id))
BEGIN SELECT RAISE(ABORT,'multipart_key_quarantined'); END;

CREATE TRIGGER backup_freeze_multipart_closure_runs_insert BEFORE INSERT ON multipart_closure_runs
WHEN (SELECT backup_frozen FROM control WHERE singleton=1)=1
BEGIN SELECT RAISE(ABORT,'backup_frozen'); END;
CREATE TRIGGER backup_freeze_multipart_closure_runs_update BEFORE UPDATE ON multipart_closure_runs
WHEN (SELECT backup_frozen FROM control WHERE singleton=1)=1
BEGIN SELECT RAISE(ABORT,'backup_frozen'); END;
CREATE TRIGGER backup_freeze_multipart_closure_runs_delete BEFORE DELETE ON multipart_closure_runs
WHEN (SELECT backup_frozen FROM control WHERE singleton=1)=1
BEGIN SELECT RAISE(ABORT,'backup_frozen'); END;
CREATE TRIGGER backup_freeze_multipart_bucket_handle_settlements_insert BEFORE INSERT ON multipart_bucket_handle_settlements
WHEN (SELECT backup_frozen FROM control WHERE singleton=1)=1
BEGIN SELECT RAISE(ABORT,'backup_frozen'); END;
CREATE TRIGGER backup_freeze_multipart_bucket_handle_settlements_update BEFORE UPDATE ON multipart_bucket_handle_settlements
WHEN (SELECT backup_frozen FROM control WHERE singleton=1)=1
BEGIN SELECT RAISE(ABORT,'backup_frozen'); END;
CREATE TRIGGER backup_freeze_multipart_bucket_handle_settlements_delete BEFORE DELETE ON multipart_bucket_handle_settlements
WHEN (SELECT backup_frozen FROM control WHERE singleton=1)=1
BEGIN SELECT RAISE(ABORT,'backup_frozen'); END;
CREATE TRIGGER backup_freeze_multipart_upload_settlements_insert BEFORE INSERT ON multipart_upload_settlements
WHEN (SELECT backup_frozen FROM control WHERE singleton=1)=1
BEGIN SELECT RAISE(ABORT,'backup_frozen'); END;
CREATE TRIGGER backup_freeze_multipart_upload_settlements_update BEFORE UPDATE ON multipart_upload_settlements
WHEN (SELECT backup_frozen FROM control WHERE singleton=1)=1
BEGIN SELECT RAISE(ABORT,'backup_frozen'); END;
CREATE TRIGGER backup_freeze_multipart_upload_settlements_delete BEFORE DELETE ON multipart_upload_settlements
WHEN (SELECT backup_frozen FROM control WHERE singleton=1)=1
BEGIN SELECT RAISE(ABORT,'backup_frozen'); END;
