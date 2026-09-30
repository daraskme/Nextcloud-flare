-- An abort acknowledgement concerns one handle, not global closure or byte reclamation.
CREATE TABLE multipart_bucket_abort_attempts(
 id TEXT NOT NULL PRIMARY KEY CHECK(length(id)=36),
 handle_id TEXT NOT NULL REFERENCES multipart_bucket_handles(id),
 ordinal INTEGER NOT NULL CHECK(ordinal BETWEEN 1 AND 64),
 epoch INTEGER NOT NULL CHECK(epoch BETWEEN 1 AND 9007199254740991),
 proof_generation INTEGER NOT NULL CHECK(proof_generation BETWEEN 1 AND 9007199254740991),
 scan_round_id TEXT NOT NULL CHECK(length(scan_round_id)=36),
 part_round_id TEXT NOT NULL CHECK(length(part_round_id)=36),
 held_bytes INTEGER NOT NULL CHECK(held_bytes BETWEEN 0 AND 9007199254740991),
 started_at INTEGER NOT NULL CHECK(started_at>=0),
 outcome TEXT NOT NULL DEFAULT 'started' CHECK(outcome IN ('started','confirmed','unconfirmed')),
 finished_at INTEGER CHECK(finished_at>=started_at),
 error TEXT CHECK(error IN ('abort_unconfirmed','abort_timeout')),
 UNIQUE(handle_id,ordinal),
 CHECK((outcome='started')=(finished_at IS NULL)),
 CHECK((outcome='unconfirmed')=(error IS NOT NULL))
) STRICT;

CREATE TRIGGER multipart_bucket_abort_insert BEFORE INSERT ON multipart_bucket_abort_attempts
WHEN NEW.outcome<>'started'
 OR NEW.ordinal<>(SELECT COALESCE(MAX(ordinal),0)+1 FROM multipart_bucket_abort_attempts WHERE handle_id=NEW.handle_id)
 OR NOT EXISTS(
  SELECT 1 FROM multipart_bucket_handles h JOIN multipart_bucket_scan s ON s.singleton=1
   JOIN r2_binding_probe p ON p.singleton=1 JOIN control c ON c.singleton=1
  WHERE h.id=NEW.handle_id AND h.state='quarantined' AND h.source=s.source AND s.source=p.source
   AND c.epoch=NEW.epoch AND s.epoch=c.epoch AND p.epoch=c.epoch AND h.part_epoch=c.epoch
   AND c.maintenance=1 AND c.gc_paused=1 AND p.phase='verified'
   AND p.lease_token IS NOT NULL AND p.lease_expires_at>strftime('%s','now')*1000
   AND p.generation=NEW.proof_generation AND s.round_id=NEW.scan_round_id AND s.completed_at IS NOT NULL
   AND h.part_round_id=NEW.part_round_id AND h.parts_completed_at IS NOT NULL AND h.held_bytes=NEW.held_bytes
   AND NOT EXISTS(SELECT 1 FROM multipart_inventory_scans WHERE r2_key=h.r2_key AND completed_at IS NULL)
   AND NOT EXISTS(SELECT 1 FROM uploads u JOIN blobs b ON b.id=u.blob_id WHERE b.r2_key=h.r2_key
    AND (u.state IN ('created','receiving','uploading','completing','aborting')
     OR COALESCE(u.write_lease_expires_at,0)>strftime('%s','now')*1000
     OR COALESCE(u.multipart_complete_lease,0)>strftime('%s','now')*1000
     OR COALESCE(u.cleanup_lease_expires_at,0)>strftime('%s','now')*1000
     OR EXISTS(SELECT 1 FROM upload_parts up WHERE up.upload_id=u.id
      AND up.state IN ('in_flight','unknown') AND up.lease_expires_at>strftime('%s','now')*1000))))
BEGIN SELECT RAISE(ABORT,'multipart_bucket_abort_not_ready'); END;

CREATE TRIGGER multipart_bucket_abort_update BEFORE UPDATE ON multipart_bucket_abort_attempts
WHEN OLD.outcome<>'started' OR NEW.outcome='started'
 OR NEW.id<>OLD.id OR NEW.handle_id<>OLD.handle_id OR NEW.ordinal<>OLD.ordinal OR NEW.epoch<>OLD.epoch
 OR NEW.proof_generation<>OLD.proof_generation OR NEW.scan_round_id<>OLD.scan_round_id
 OR NEW.part_round_id<>OLD.part_round_id OR NEW.held_bytes<>OLD.held_bytes OR NEW.started_at<>OLD.started_at
 OR NOT EXISTS(SELECT 1 FROM r2_binding_probe p JOIN control c ON c.singleton=p.singleton
   JOIN multipart_bucket_handles h ON h.id=OLD.handle_id
  WHERE p.singleton=1 AND p.source=h.source AND p.generation=OLD.proof_generation AND p.epoch=OLD.epoch
   AND c.epoch=p.epoch AND c.maintenance=1 AND c.gc_paused=1 AND p.phase='verified'
   AND p.lease_token IS NOT NULL AND p.lease_expires_at>strftime('%s','now')*1000)
BEGIN SELECT RAISE(ABORT,'immutable_multipart_bucket_abort'); END;
CREATE TRIGGER multipart_bucket_abort_delete BEFORE DELETE ON multipart_bucket_abort_attempts
BEGIN SELECT RAISE(ABORT,'multipart_bucket_abort_receipt_required'); END;
