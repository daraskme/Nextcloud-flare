-- A stopped upload can own several discovered handles. Never collapse them into r2_upload_id.
CREATE TABLE multipart_inventory_scans(
 upload_id TEXT NOT NULL PRIMARY KEY REFERENCES uploads(id),
 r2_key TEXT NOT NULL CHECK(length(CAST(r2_key AS BLOB)) BETWEEN 1 AND 1024),
 source TEXT NOT NULL CHECK(json_valid(source) AND length(source)<=512),
 epoch INTEGER NOT NULL CHECK(epoch BETWEEN 1 AND 9007199254740991),
 round_id TEXT NOT NULL CHECK(length(round_id)=36),
 cursor_key TEXT, cursor_upload_id TEXT,
 pages INTEGER NOT NULL DEFAULT 0 CHECK(pages>=0),
 completed_at INTEGER CHECK(completed_at IS NULL OR completed_at>=0),
 next_scan_at INTEGER NOT NULL DEFAULT 0 CHECK(next_scan_at>=0),
 last_token TEXT,
 CHECK((cursor_key IS NULL)=(cursor_upload_id IS NULL)),
 CHECK(cursor_key IS NULL OR (cursor_key=r2_key AND length(CAST(cursor_upload_id AS BLOB)) BETWEEN 1 AND 2048)),
 CHECK(completed_at IS NULL OR cursor_key IS NULL)
) STRICT;
CREATE TABLE multipart_inventory_handles(
 id TEXT NOT NULL PRIMARY KEY,
 upload_id TEXT NOT NULL REFERENCES multipart_inventory_scans(upload_id),
 r2_upload_id TEXT NOT NULL CHECK(length(CAST(r2_upload_id AS BLOB)) BETWEEN 1 AND 2048),
 first_source TEXT NOT NULL CHECK(json_valid(first_source) AND length(first_source)<=512),
 initiated_at INTEGER CHECK(initiated_at IS NULL OR initiated_at>=0),
 first_seen_at INTEGER NOT NULL CHECK(first_seen_at>=0),
 last_seen_at INTEGER NOT NULL CHECK(last_seen_at>=first_seen_at),
 last_round_id TEXT,
 state TEXT NOT NULL DEFAULT 'observed' CHECK(state IN ('observed','aborted')),
 attempts INTEGER NOT NULL DEFAULT 0 CHECK(attempts>=0),
 last_attempt_at INTEGER NOT NULL DEFAULT 0 CHECK(last_attempt_at>=0),
 aborted_at INTEGER CHECK(aborted_at IS NULL OR aborted_at>=first_seen_at),
 last_error TEXT,
 UNIQUE(upload_id,r2_upload_id),
 CHECK((state='aborted')=(aborted_at IS NOT NULL)),
 CHECK(state<>'aborted' OR attempts>0)
) STRICT;
CREATE INDEX multipart_inventory_handles_pending ON multipart_inventory_handles(upload_id,state,last_attempt_at,id);

CREATE TRIGGER multipart_inventory_scan_insert BEFORE INSERT ON multipart_inventory_scans
WHEN NOT EXISTS(SELECT 1 FROM uploads u JOIN blobs b ON b.id=u.blob_id
 JOIN reservations r ON r.id=u.reservation_id AND r.owner_id=u.owner_id AND r.state='reserved' WHERE u.id=NEW.upload_id
 AND u.mode='multipart' AND u.multipart_cleanup_started_at IS NOT NULL AND u.cleanup_pending=1
 AND u.multipart_cleanup_closed IS NULL AND b.r2_key=NEW.r2_key AND b.state='orphan' AND b.ref_count=0)
BEGIN SELECT RAISE(ABORT,'multipart_inventory_requires_stop'); END;
CREATE TRIGGER multipart_inventory_scan_update BEFORE UPDATE ON multipart_inventory_scans
WHEN NEW.upload_id<>OLD.upload_id OR NEW.r2_key<>OLD.r2_key OR NEW.epoch<OLD.epoch
 OR (NEW.round_id=OLD.round_id AND (NEW.source<>OLD.source OR NEW.epoch<>OLD.epoch OR NEW.pages<OLD.pages
   OR (OLD.completed_at IS NOT NULL AND NEW.completed_at IS NOT OLD.completed_at)))
 OR (NEW.round_id<>OLD.round_id AND (NEW.pages<>0 OR NEW.cursor_key IS NOT NULL OR NEW.completed_at IS NOT NULL))
BEGIN SELECT RAISE(ABORT,'immutable_multipart_inventory_scan'); END;
CREATE TRIGGER multipart_inventory_handle_update BEFORE UPDATE ON multipart_inventory_handles
WHEN NEW.id<>OLD.id OR NEW.upload_id<>OLD.upload_id OR NEW.r2_upload_id<>OLD.r2_upload_id
 OR NEW.first_source<>OLD.first_source OR NEW.first_seen_at<>OLD.first_seen_at
 OR NEW.last_seen_at<OLD.last_seen_at OR NEW.attempts<OLD.attempts OR NEW.last_attempt_at<OLD.last_attempt_at
 OR (OLD.initiated_at IS NOT NULL AND NEW.initiated_at IS NOT OLD.initiated_at)
 OR (OLD.state='aborted' AND (NEW.state<>'aborted' OR NEW.aborted_at IS NOT OLD.aborted_at))
BEGIN SELECT RAISE(ABORT,'immutable_multipart_inventory_handle'); END;

-- These observations are not a complete absence proof. Future verified closure needs a forward migration.
CREATE TRIGGER multipart_inventory_reservation_hold BEFORE UPDATE OF state ON reservations
WHEN NEW.state<>'reserved' AND EXISTS(SELECT 1 FROM uploads u JOIN multipart_inventory_scans s ON s.upload_id=u.id
 WHERE u.reservation_id=NEW.id)
BEGIN SELECT RAISE(ABORT,'multipart_inventory_closure_required'); END;
CREATE TRIGGER multipart_inventory_upload_hold BEFORE UPDATE ON uploads
WHEN EXISTS(SELECT 1 FROM multipart_inventory_scans WHERE upload_id=OLD.id)
 AND (NEW.cleanup_pending<>1 OR NEW.multipart_cleanup_closed IS NOT NULL OR NEW.state NOT IN ('expired','aborted','failed'))
BEGIN SELECT RAISE(ABORT,'multipart_inventory_closure_required'); END;
CREATE TRIGGER multipart_inventory_scan_delete BEFORE DELETE ON multipart_inventory_scans
BEGIN SELECT RAISE(ABORT,'multipart_inventory_closure_required'); END;
CREATE TRIGGER multipart_inventory_handle_delete BEFORE DELETE ON multipart_inventory_handles
BEGIN SELECT RAISE(ABORT,'multipart_inventory_receipt_required'); END;
