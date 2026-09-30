-- Bucket-wide incomplete-upload observations survive lost application upload rows.
-- These are quarantine/charge records, never absence or closure certificates.
CREATE TABLE multipart_bucket_scan(
 singleton INTEGER NOT NULL PRIMARY KEY CHECK(singleton=1),
 source TEXT NOT NULL CHECK(json_valid(source) AND length(source)<=512),
 epoch INTEGER NOT NULL CHECK(epoch BETWEEN 1 AND 9007199254740991),
 round_id TEXT NOT NULL CHECK(length(round_id)=36),
 cursor_key TEXT, cursor_upload_id TEXT,
 pages INTEGER NOT NULL DEFAULT 0 CHECK(pages BETWEEN 0 AND 9007199254740991),
 completed_at INTEGER CHECK(completed_at>=0),
 calls INTEGER NOT NULL DEFAULT 0 CHECK(calls BETWEEN 0 AND 9007199254740991),
 CHECK((cursor_key IS NULL)=(cursor_upload_id IS NULL)),
 CHECK(cursor_key IS NULL OR (substr(cursor_key,1,2)='u/' AND length(CAST(cursor_key AS BLOB))<=1024
   AND length(CAST(cursor_upload_id AS BLOB)) BETWEEN 1 AND 2048)),
 CHECK(completed_at IS NULL OR cursor_key IS NULL)
) STRICT;

CREATE TABLE multipart_bucket_handles(
 id TEXT NOT NULL PRIMARY KEY CHECK(length(id)=36),
 source TEXT NOT NULL CHECK(json_valid(source) AND length(source)<=512),
 r2_key TEXT NOT NULL CHECK(substr(r2_key,1,2)='u/' AND length(CAST(r2_key AS BLOB)) BETWEEN 2 AND 1024),
 r2_upload_id TEXT NOT NULL CHECK(length(CAST(r2_upload_id AS BLOB)) BETWEEN 1 AND 2048),
 initiated_at INTEGER NOT NULL CHECK(initiated_at>=0),
 owner_key TEXT, blob_key TEXT, owner_id TEXT REFERENCES users(id),
 state TEXT NOT NULL CHECK(state IN ('tracked','quarantined')),
 first_seen_at INTEGER NOT NULL CHECK(first_seen_at>=0),
 last_seen_at INTEGER NOT NULL CHECK(last_seen_at>=first_seen_at),
 epoch INTEGER NOT NULL CHECK(epoch BETWEEN 1 AND 9007199254740991),
 last_round_id TEXT NOT NULL CHECK(length(last_round_id)=36),
 held_bytes INTEGER NOT NULL DEFAULT 0 CHECK(held_bytes BETWEEN 0 AND 9007199254740991),
 part_epoch INTEGER CHECK(part_epoch BETWEEN 1 AND 9007199254740991),
 part_round_id TEXT CHECK(length(part_round_id)=36),
 part_marker INTEGER NOT NULL DEFAULT 0 CHECK(part_marker BETWEEN 0 AND 10000),
 part_pages INTEGER NOT NULL DEFAULT 0 CHECK(part_pages BETWEEN 0 AND 10000),
 parts_completed_at INTEGER CHECK(parts_completed_at>=0),
 part_calls INTEGER NOT NULL DEFAULT 0 CHECK(part_calls BETWEEN 0 AND 9007199254740991),
 UNIQUE(source,r2_key,r2_upload_id),
 CHECK((owner_key IS NULL)=(blob_key IS NULL)),
 CHECK(owner_key IS NULL OR (length(owner_key) BETWEEN 1 AND 128 AND instr(owner_key,'/')=0
   AND length(blob_key) BETWEEN 1 AND 128 AND instr(blob_key,'/')=0
   AND r2_key='u/'||owner_key||'/b/'||blob_key)),
 CHECK(owner_id IS NULL OR owner_id=owner_key),
 CHECK((part_round_id IS NULL)=(part_epoch IS NULL)),
 CHECK(part_round_id IS NOT NULL OR (part_marker=0 AND part_pages=0 AND parts_completed_at IS NULL)),
 CHECK(state='quarantined' OR (held_bytes=0 AND part_round_id IS NULL AND part_calls=0))
) STRICT;
CREATE INDEX multipart_bucket_handles_owner ON multipart_bucket_handles(owner_id);
CREATE INDEX multipart_bucket_handles_owner_key ON multipart_bucket_handles(owner_key);
CREATE INDEX multipart_bucket_handles_key ON multipart_bucket_handles(r2_key);

CREATE TABLE multipart_bucket_parts(
 id TEXT NOT NULL PRIMARY KEY CHECK(length(id)=36),
 handle_id TEXT NOT NULL REFERENCES multipart_bucket_handles(id),
 part_number INTEGER NOT NULL CHECK(part_number BETWEEN 1 AND 10000),
 bytes INTEGER NOT NULL CHECK(bytes BETWEEN 0 AND 9007199254740991),
 observed_bytes INTEGER NOT NULL CHECK(observed_bytes BETWEEN 0 AND bytes),
 etag TEXT NOT NULL CHECK(length(CAST(etag AS BLOB)) BETWEEN 1 AND 1024),
 modified_at INTEGER NOT NULL CHECK(modified_at>=0),
 last_seen_at INTEGER NOT NULL CHECK(last_seen_at>=0),
 last_round_id TEXT NOT NULL CHECK(length(last_round_id)=36),
 UNIQUE(handle_id,part_number)
) STRICT;

CREATE TRIGGER multipart_bucket_scan_update BEFORE UPDATE ON multipart_bucket_scan
WHEN NEW.singleton<>OLD.singleton OR NEW.epoch<OLD.epoch OR NEW.calls<OLD.calls
 OR (NEW.round_id=OLD.round_id AND (NEW.source<>OLD.source OR NEW.epoch<>OLD.epoch OR NEW.pages<OLD.pages
   OR (OLD.completed_at IS NOT NULL AND NEW.completed_at IS NOT OLD.completed_at)))
 OR (NEW.round_id<>OLD.round_id AND (NEW.pages<>0 OR NEW.cursor_key IS NOT NULL OR NEW.completed_at IS NOT NULL))
BEGIN SELECT RAISE(ABORT,'immutable_multipart_bucket_scan'); END;
CREATE TRIGGER multipart_bucket_scan_delete BEFORE DELETE ON multipart_bucket_scan
BEGIN SELECT RAISE(ABORT,'multipart_bucket_inventory_required'); END;

CREATE TRIGGER multipart_bucket_handle_insert BEFORE INSERT ON multipart_bucket_handles
WHEN NEW.held_bytes<>0 OR NEW.part_round_id IS NOT NULL OR NEW.part_calls<>0
 OR (NEW.state='tracked' AND NOT EXISTS(SELECT 1 FROM uploads u JOIN blobs b ON b.id=u.blob_id
   WHERE b.r2_key=NEW.r2_key AND u.r2_upload_id=NEW.r2_upload_id))
BEGIN SELECT RAISE(ABORT,'invalid_multipart_bucket_handle'); END;
CREATE TRIGGER multipart_bucket_handle_update BEFORE UPDATE ON multipart_bucket_handles
WHEN NEW.id<>OLD.id OR NEW.source<>OLD.source OR NEW.r2_key<>OLD.r2_key OR NEW.r2_upload_id<>OLD.r2_upload_id
 OR NEW.initiated_at<>OLD.initiated_at OR NEW.owner_key IS NOT OLD.owner_key OR NEW.blob_key IS NOT OLD.blob_key
 OR (OLD.owner_id IS NOT NULL AND NEW.owner_id IS NOT OLD.owner_id)
 OR NEW.first_seen_at<>OLD.first_seen_at OR NEW.last_seen_at<OLD.last_seen_at OR NEW.epoch<OLD.epoch
 OR (OLD.state='quarantined' AND NEW.state<>'quarantined') OR NEW.held_bytes<OLD.held_bytes
 OR NEW.held_bytes<>(SELECT COALESCE(SUM(bytes),0) FROM multipart_bucket_parts WHERE handle_id=OLD.id)
 OR NEW.part_calls<OLD.part_calls OR (OLD.part_epoch IS NOT NULL AND (NEW.part_epoch IS NULL OR NEW.part_epoch<OLD.part_epoch))
 OR (OLD.part_round_id IS NOT NULL AND NEW.part_round_id IS NULL)
 OR (NEW.part_round_id IS OLD.part_round_id AND (NEW.part_epoch IS NOT OLD.part_epoch OR NEW.part_marker<OLD.part_marker
   OR NEW.part_pages<OLD.part_pages OR (OLD.parts_completed_at IS NOT NULL AND NEW.parts_completed_at IS NOT OLD.parts_completed_at)))
 OR (NEW.part_round_id IS NOT OLD.part_round_id AND (NEW.part_marker<>0 OR NEW.part_pages<>0 OR NEW.parts_completed_at IS NOT NULL))
BEGIN SELECT RAISE(ABORT,'immutable_multipart_bucket_handle'); END;
CREATE TRIGGER multipart_bucket_handle_delete BEFORE DELETE ON multipart_bucket_handles
BEGIN SELECT RAISE(ABORT,'multipart_bucket_closure_required'); END;

CREATE TRIGGER multipart_bucket_part_insert BEFORE INSERT ON multipart_bucket_parts
WHEN NOT EXISTS(SELECT 1 FROM multipart_bucket_handles WHERE id=NEW.handle_id AND state='quarantined'
 AND part_round_id=NEW.last_round_id)
BEGIN SELECT RAISE(ABORT,'multipart_bucket_part_unclaimed'); END;
CREATE TRIGGER multipart_bucket_part_update BEFORE UPDATE ON multipart_bucket_parts
WHEN NEW.id<>OLD.id OR NEW.handle_id<>OLD.handle_id OR NEW.part_number<>OLD.part_number
 OR NEW.bytes<OLD.bytes OR NEW.last_seen_at<OLD.last_seen_at
 OR NOT EXISTS(SELECT 1 FROM multipart_bucket_handles WHERE id=NEW.handle_id AND state='quarantined'
   AND part_round_id=NEW.last_round_id)
BEGIN SELECT RAISE(ABORT,'immutable_multipart_bucket_part'); END;
CREATE TRIGGER multipart_bucket_part_delete BEFORE DELETE ON multipart_bucket_parts
BEGIN SELECT RAISE(ABORT,'multipart_bucket_closure_required'); END;

-- Per-part high-water bytes are a conservative hold, not a point-in-time storage total.
CREATE TRIGGER multipart_bucket_part_charge AFTER INSERT ON multipart_bucket_parts
BEGIN
 UPDATE multipart_bucket_handles SET held_bytes=held_bytes+NEW.bytes WHERE id=NEW.handle_id;
END;
CREATE TRIGGER multipart_bucket_part_recharge AFTER UPDATE OF bytes ON multipart_bucket_parts
BEGIN
 UPDATE multipart_bucket_handles SET held_bytes=held_bytes+NEW.bytes-OLD.bytes WHERE id=NEW.handle_id;
END;
CREATE TRIGGER multipart_bucket_handle_charge AFTER UPDATE OF owner_id,held_bytes ON multipart_bucket_handles
WHEN NEW.owner_id IS NOT NULL
BEGIN
 UPDATE users SET physical_bytes=physical_bytes+NEW.held_bytes
   -(OLD.owner_id IS NOT NULL)*OLD.held_bytes WHERE id=NEW.owner_id;
 SELECT CASE WHEN changes()<>1 THEN RAISE(ABORT,'multipart_bucket_physical_drift') END;
END;
CREATE TRIGGER users_attach_multipart_storage AFTER INSERT ON users
BEGIN
 UPDATE multipart_bucket_handles SET owner_id=NEW.id WHERE owner_key=NEW.id AND owner_id IS NULL;
END;

-- A quarantined key may not be adopted by a new upload or generated object.
CREATE TRIGGER blobs_multipart_bucket_insert BEFORE INSERT ON blobs
WHEN EXISTS(SELECT 1 FROM multipart_bucket_handles WHERE r2_key=NEW.r2_key AND state='quarantined')
BEGIN SELECT RAISE(ABORT,'multipart_key_quarantined'); END;
CREATE TRIGGER blobs_multipart_bucket_commit BEFORE UPDATE OF state ON blobs
WHEN NEW.state='committed' AND OLD.state<>'committed'
 AND EXISTS(SELECT 1 FROM multipart_bucket_handles WHERE r2_key=NEW.r2_key AND state='quarantined')
BEGIN SELECT RAISE(ABORT,'multipart_key_quarantined'); END;
CREATE TRIGGER derivatives_multipart_bucket_insert BEFORE INSERT ON derivative_results
WHEN EXISTS(SELECT 1 FROM multipart_bucket_handles WHERE r2_key=NEW.r2_key AND state='quarantined')
BEGIN SELECT RAISE(ABORT,'multipart_key_quarantined'); END;
CREATE TRIGGER derivatives_multipart_bucket_update BEFORE UPDATE OF r2_key ON derivative_results
WHEN EXISTS(SELECT 1 FROM multipart_bucket_handles WHERE r2_key=NEW.r2_key AND state='quarantined')
BEGIN SELECT RAISE(ABORT,'multipart_key_quarantined'); END;
CREATE TRIGGER archive_multipart_bucket_insert BEFORE INSERT ON archive_index
WHEN EXISTS(SELECT 1 FROM multipart_bucket_handles WHERE r2_key=NEW.r2_key AND state='quarantined')
BEGIN SELECT RAISE(ABORT,'multipart_key_quarantined'); END;
CREATE TRIGGER archive_multipart_bucket_update BEFORE UPDATE OF r2_key ON archive_index
WHEN EXISTS(SELECT 1 FROM multipart_bucket_handles WHERE r2_key=NEW.r2_key AND state='quarantined')
BEGIN SELECT RAISE(ABORT,'multipart_key_quarantined'); END;
CREATE TRIGGER targets_multipart_bucket_insert BEFORE INSERT ON target_sets
WHEN EXISTS(SELECT 1 FROM multipart_bucket_handles WHERE r2_key=NEW.manifest_ref AND state='quarantined')
BEGIN SELECT RAISE(ABORT,'multipart_key_quarantined'); END;
CREATE TRIGGER targets_multipart_bucket_update BEFORE UPDATE OF manifest_ref ON target_sets
WHEN EXISTS(SELECT 1 FROM multipart_bucket_handles WHERE r2_key=NEW.manifest_ref AND state='quarantined')
BEGIN SELECT RAISE(ABORT,'multipart_key_quarantined'); END;
