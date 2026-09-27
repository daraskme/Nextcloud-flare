-- Supplemental success evidence preserves the original timeout/unknown diagnostic.
-- It concerns one abort only; quarantine, part charges and reservation holds stay intact.
-- Legacy native tuples did not encode the scan source. Do not invent it on upgrade.
ALTER TABLE multipart_inventory_handles ADD COLUMN abort_source TEXT
 CHECK(abort_source IS NULL OR (json_valid(abort_source) AND length(abort_source)<=512));
ALTER TABLE multipart_inventory_handles ADD COLUMN abort_token TEXT
 CHECK(abort_token IS NULL OR length(abort_token)=36);
CREATE TRIGGER multipart_inventory_abort_source_insert BEFORE INSERT ON multipart_inventory_handles
WHEN NEW.abort_source IS NOT NULL OR NEW.abort_token IS NOT NULL
BEGIN SELECT RAISE(ABORT,'multipart_inventory_abort_source_unproven'); END;
CREATE TRIGGER multipart_inventory_abort_source_update BEFORE UPDATE ON multipart_inventory_handles
WHEN (NEW.abort_source IS NOT OLD.abort_source OR NEW.abort_token IS NOT OLD.abort_token)
 AND (NEW.state<>'observed' OR NEW.attempts<>OLD.attempts+1
  OR NEW.abort_source IS NULL OR NEW.abort_token IS NULL
  OR NOT EXISTS(SELECT 1 FROM multipart_inventory_scans s JOIN uploads u ON u.id=s.upload_id
   WHERE s.upload_id=NEW.upload_id AND s.source=NEW.abort_source AND u.cleanup_token=NEW.abort_token))
BEGIN SELECT RAISE(ABORT,'multipart_inventory_abort_source_unproven'); END;

CREATE TABLE multipart_bucket_abort_reconciliations(
 attempt_id TEXT NOT NULL PRIMARY KEY REFERENCES multipart_bucket_abort_attempts(id),
 native_id TEXT NOT NULL UNIQUE,
 native_identity BLOB NOT NULL CHECK(length(native_identity)=32),
 epoch INTEGER NOT NULL CHECK(epoch BETWEEN 1 AND 9007199254740991),
 reconciled_at INTEGER NOT NULL CHECK(reconciled_at>=0)
) STRICT;
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
CREATE TRIGGER multipart_bucket_abort_reconciliation_update BEFORE UPDATE ON multipart_bucket_abort_reconciliations
BEGIN SELECT RAISE(ABORT,'immutable_multipart_abort_reconciliation'); END;
CREATE TRIGGER multipart_bucket_abort_reconciliation_delete BEFORE DELETE ON multipart_bucket_abort_reconciliations
BEGIN SELECT RAISE(ABORT,'multipart_abort_reconciliation_required'); END;
CREATE TRIGGER backup_freeze_multipart_bucket_abort_reconciliations_insert BEFORE INSERT ON multipart_bucket_abort_reconciliations
WHEN (SELECT backup_frozen FROM control WHERE singleton=1)=1
BEGIN SELECT RAISE(ABORT,'backup_frozen'); END;
CREATE TRIGGER backup_freeze_multipart_bucket_abort_reconciliations_update BEFORE UPDATE ON multipart_bucket_abort_reconciliations
WHEN (SELECT backup_frozen FROM control WHERE singleton=1)=1
BEGIN SELECT RAISE(ABORT,'backup_frozen'); END;
CREATE TRIGGER backup_freeze_multipart_bucket_abort_reconciliations_delete BEFORE DELETE ON multipart_bucket_abort_reconciliations
WHEN (SELECT backup_frozen FROM control WHERE singleton=1)=1
BEGIN SELECT RAISE(ABORT,'backup_frozen'); END;
CREATE TRIGGER restore_freeze_multipart_bucket_abort_reconciliations_insert BEFORE INSERT ON multipart_bucket_abort_reconciliations
WHEN (SELECT restore_freeze_token FROM control WHERE singleton=1) IS NOT NULL
BEGIN SELECT RAISE(ABORT,'database_restore_frozen'); END;
CREATE TRIGGER restore_freeze_multipart_bucket_abort_reconciliations_update BEFORE UPDATE ON multipart_bucket_abort_reconciliations
WHEN (SELECT restore_freeze_token FROM control WHERE singleton=1) IS NOT NULL
BEGIN SELECT RAISE(ABORT,'database_restore_frozen'); END;
CREATE TRIGGER restore_freeze_multipart_bucket_abort_reconciliations_delete BEFORE DELETE ON multipart_bucket_abort_reconciliations
WHEN (SELECT restore_freeze_token FROM control WHERE singleton=1) IS NOT NULL
BEGIN SELECT RAISE(ABORT,'database_restore_frozen'); END;
