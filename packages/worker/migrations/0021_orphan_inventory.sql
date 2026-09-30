-- Completed objects absent from every published/staging R2 catalogue are quarantined separately.
-- Keep key tombstones: a later normal upload must never reuse a key that GC may have deleted.
CREATE TABLE orphan_objects(
 r2_key TEXT NOT NULL PRIMARY KEY CHECK(length(CAST(r2_key AS BLOB)) BETWEEN 1 AND 1024 AND substr(r2_key,1,2)='u/'),
 owner_key TEXT, blob_key TEXT, owner_id TEXT REFERENCES users(id),
 bytes INTEGER NOT NULL CHECK(bytes BETWEEN 0 AND 9007199254740991),
 r2_etag TEXT NOT NULL CHECK(length(r2_etag) BETWEEN 1 AND 256),
 r2_version TEXT NOT NULL CHECK(length(r2_version) BETWEEN 1 AND 1024),
 uploaded_at INTEGER NOT NULL CHECK(uploaded_at>=0),
 first_seen_at INTEGER NOT NULL CHECK(first_seen_at>=0),
 last_seen_at INTEGER NOT NULL CHECK(last_seen_at>=first_seen_at),
 epoch INTEGER NOT NULL CHECK(epoch BETWEEN 1 AND 9007199254740991),
 state TEXT NOT NULL DEFAULT 'quarantined' CHECK(state IN ('quarantined','deleting','deleted')),
 removed_at INTEGER CHECK(removed_at>=last_seen_at),
 claim_token TEXT, claim_expires_at INTEGER CHECK(claim_expires_at IS NULL OR claim_expires_at>=0),
 next_check_at INTEGER NOT NULL DEFAULT 0 CHECK(next_check_at>=0),
 r2_calls INTEGER NOT NULL DEFAULT 0 CHECK(r2_calls>=0), last_error TEXT,
 CHECK((owner_key IS NULL)=(blob_key IS NULL)),
 CHECK(owner_key IS NULL OR (length(owner_key) BETWEEN 1 AND 128 AND instr(owner_key,'/')=0
  AND length(blob_key) BETWEEN 1 AND 128 AND instr(blob_key,'/')=0
  AND r2_key='u/'||owner_key||'/b/'||blob_key)),
 CHECK(owner_id IS NULL OR owner_id=owner_key),
 CHECK((state='deleted')=(removed_at IS NOT NULL)),
 CHECK((claim_token IS NULL)=(claim_expires_at IS NULL)),
 CHECK(claim_token IS NULL OR state='deleting')
) STRICT;
CREATE INDEX orphan_objects_owner ON orphan_objects(owner_id);
CREATE INDEX orphan_objects_owner_key ON orphan_objects(owner_key);
CREATE INDEX orphan_objects_due ON orphan_objects(next_check_at,first_seen_at,r2_key) WHERE state<>'deleted';
CREATE INDEX derivative_results_r2_inventory ON derivative_results(r2_key);
CREATE INDEX target_sets_r2_inventory ON target_sets(manifest_ref);

CREATE TABLE r2_inventory_scan(
 singleton INTEGER NOT NULL PRIMARY KEY CHECK(singleton=1),
 epoch INTEGER NOT NULL CHECK(epoch BETWEEN 1 AND 9007199254740991),
 cursor TEXT NOT NULL DEFAULT '' CHECK(length(cursor)<=8192),
 lease_token TEXT, lease_expires_at INTEGER,
 next_scan_at INTEGER NOT NULL DEFAULT 0 CHECK(next_scan_at>=0),
 last_token TEXT, pages INTEGER NOT NULL DEFAULT 0 CHECK(pages>=0),
 CHECK((lease_token IS NULL)=(lease_expires_at IS NULL))
) STRICT;
INSERT INTO r2_inventory_scan(singleton,epoch) SELECT 1,epoch FROM control WHERE singleton=1;

CREATE TRIGGER orphan_objects_no_catalogue BEFORE INSERT ON orphan_objects
WHEN EXISTS(SELECT 1 FROM blobs WHERE r2_key=NEW.r2_key)
 OR EXISTS(SELECT 1 FROM derivative_results WHERE r2_key=NEW.r2_key)
 OR EXISTS(SELECT 1 FROM archive_index WHERE r2_key=NEW.r2_key)
 OR EXISTS(SELECT 1 FROM target_sets WHERE manifest_ref=NEW.r2_key)
BEGIN SELECT RAISE(ABORT,'orphan_key_referenced'); END;
CREATE TRIGGER orphan_objects_identity BEFORE UPDATE ON orphan_objects
WHEN NEW.r2_key<>OLD.r2_key OR NEW.owner_key IS NOT OLD.owner_key OR NEW.blob_key IS NOT OLD.blob_key
 OR (OLD.owner_id IS NOT NULL AND NEW.owner_id IS NOT OLD.owner_id)
 OR NEW.first_seen_at<OLD.first_seen_at OR NEW.last_seen_at<OLD.last_seen_at OR NEW.epoch<OLD.epoch
 OR (OLD.state='deleting' AND NEW.state='quarantined')
 OR (NEW.r2_version=OLD.r2_version AND NEW.r2_etag=OLD.r2_etag AND NEW.bytes=OLD.bytes
   AND NEW.uploaded_at=OLD.uploaded_at AND OLD.state<>'deleted' AND NEW.first_seen_at<>OLD.first_seen_at)
 OR ((NEW.r2_version<>OLD.r2_version OR NEW.r2_etag<>OLD.r2_etag OR NEW.bytes<>OLD.bytes
   OR NEW.uploaded_at<>OLD.uploaded_at OR (OLD.state='deleted' AND NEW.state<>'deleted'))
   AND (NEW.first_seen_at<>NEW.last_seen_at OR NEW.claim_token IS NOT NULL))
 OR (OLD.state='deleted' AND NEW.state='deleted' AND NEW.removed_at IS NOT OLD.removed_at)
BEGIN SELECT RAISE(ABORT,'invalid_orphan_transition'); END;
CREATE TRIGGER orphan_objects_delete_guard BEFORE DELETE ON orphan_objects
BEGIN SELECT RAISE(ABORT,'orphan_key_tombstone_required'); END;

-- Physical facts are charged even above quota, exactly once, including owners restored later.
CREATE TRIGGER orphan_objects_charge AFTER INSERT ON orphan_objects
WHEN NEW.owner_id IS NOT NULL AND NEW.state<>'deleted'
BEGIN
 UPDATE users SET physical_bytes=physical_bytes+NEW.bytes WHERE id=NEW.owner_id;
 SELECT CASE WHEN changes()<>1 THEN RAISE(ABORT,'orphan_physical_drift') END;
END;
CREATE TRIGGER orphan_objects_reconcile_charge AFTER UPDATE ON orphan_objects
WHEN (OLD.owner_id IS NOT NULL AND OLD.state<>'deleted') OR (NEW.owner_id IS NOT NULL AND NEW.state<>'deleted')
BEGIN
 UPDATE users SET physical_bytes=physical_bytes
   -(OLD.owner_id IS NOT NULL AND OLD.state<>'deleted')*OLD.bytes
   +(NEW.owner_id IS NOT NULL AND NEW.state<>'deleted')*NEW.bytes
 WHERE id=COALESCE(NEW.owner_id,OLD.owner_id);
 SELECT CASE WHEN changes()<>1 THEN RAISE(ABORT,'orphan_physical_drift') END;
END;
CREATE TRIGGER users_attach_orphan_storage AFTER INSERT ON users
BEGIN
 UPDATE orphan_objects SET owner_id=NEW.id WHERE owner_key=NEW.id AND owner_id IS NULL AND state<>'deleted';
END;

-- Whichever D1 insert wins owns the key. An orphan is never a reusable namespace blob.
CREATE TRIGGER blobs_orphan_key BEFORE INSERT ON blobs
WHEN EXISTS(SELECT 1 FROM orphan_objects WHERE r2_key=NEW.r2_key)
BEGIN SELECT RAISE(ABORT,'orphan_key_quarantined'); END;
CREATE TRIGGER derivatives_orphan_key_insert BEFORE INSERT ON derivative_results
WHEN EXISTS(SELECT 1 FROM orphan_objects WHERE r2_key=NEW.r2_key)
BEGIN SELECT RAISE(ABORT,'orphan_key_quarantined'); END;
CREATE TRIGGER derivatives_orphan_key_update BEFORE UPDATE OF r2_key ON derivative_results
WHEN EXISTS(SELECT 1 FROM orphan_objects WHERE r2_key=NEW.r2_key)
BEGIN SELECT RAISE(ABORT,'orphan_key_quarantined'); END;
CREATE TRIGGER archive_orphan_key_insert BEFORE INSERT ON archive_index
WHEN EXISTS(SELECT 1 FROM orphan_objects WHERE r2_key=NEW.r2_key)
BEGIN SELECT RAISE(ABORT,'orphan_key_quarantined'); END;
CREATE TRIGGER archive_orphan_key_update BEFORE UPDATE OF r2_key ON archive_index
WHEN EXISTS(SELECT 1 FROM orphan_objects WHERE r2_key=NEW.r2_key)
BEGIN SELECT RAISE(ABORT,'orphan_key_quarantined'); END;
CREATE TRIGGER target_sets_orphan_key_insert BEFORE INSERT ON target_sets
WHEN EXISTS(SELECT 1 FROM orphan_objects WHERE r2_key=NEW.manifest_ref)
BEGIN SELECT RAISE(ABORT,'orphan_key_quarantined'); END;
CREATE TRIGGER target_sets_orphan_key_update BEFORE UPDATE OF manifest_ref ON target_sets
WHEN EXISTS(SELECT 1 FROM orphan_objects WHERE r2_key=NEW.manifest_ref)
BEGIN SELECT RAISE(ABORT,'orphan_key_quarantined'); END;
