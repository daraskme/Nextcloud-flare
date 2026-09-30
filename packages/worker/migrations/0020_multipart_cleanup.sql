ALTER TABLE uploads ADD COLUMN multipart_cleanup_started_at INTEGER CHECK(multipart_cleanup_started_at IS NULL OR multipart_cleanup_started_at>=0);
ALTER TABLE uploads ADD COLUMN multipart_cleanup_closed TEXT CHECK(multipart_cleanup_closed IN ('aborted','completed'));

-- This permanent stop survives cleanup lease replacement and DO journal loss.
CREATE TRIGGER uploads_multipart_cleanup_insert BEFORE INSERT ON uploads
WHEN (NEW.multipart_cleanup_started_at IS NOT NULL AND (
 NEW.mode<>'multipart' OR NEW.state NOT IN ('expired','aborted','failed') OR NEW.accept_parts<>0 OR NEW.in_flight<>0))
 OR (NEW.multipart_cleanup_closed IS NOT NULL AND (NEW.multipart_cleanup_started_at IS NULL
   OR NEW.r2_upload_id IS NULL OR (NEW.multipart_cleanup_closed='completed' AND NEW.multipart_complete_attempt IS NULL)))
BEGIN SELECT RAISE(ABORT,'invalid_multipart_cleanup'); END;
CREATE TRIGGER uploads_multipart_cleanup_update BEFORE UPDATE ON uploads
WHEN (NEW.multipart_cleanup_started_at IS NOT NULL AND (
 NEW.mode<>'multipart' OR NEW.state NOT IN ('expired','aborted','failed') OR NEW.accept_parts<>0 OR NEW.in_flight<>0))
 OR (NEW.multipart_cleanup_closed IS NOT NULL AND (NEW.multipart_cleanup_started_at IS NULL
   OR NEW.r2_upload_id IS NULL OR (NEW.multipart_cleanup_closed='completed' AND NEW.multipart_complete_attempt IS NULL)))
 OR (OLD.multipart_cleanup_started_at IS NOT NULL AND (
   NEW.multipart_cleanup_started_at IS NOT OLD.multipart_cleanup_started_at
   OR NEW.multipart_complete_attempt IS NOT OLD.multipart_complete_attempt
   OR NEW.multipart_ledger_id IS NOT OLD.multipart_ledger_id
   OR NEW.write_attempt_id IS NOT OLD.write_attempt_id))
 OR (OLD.multipart_cleanup_closed IS NOT NULL AND NEW.multipart_cleanup_closed IS NOT OLD.multipart_cleanup_closed)
BEGIN SELECT RAISE(ABORT,'immutable_multipart_cleanup'); END;

CREATE INDEX uploads_multipart_cleanup_due_idx ON uploads(cleanup_next_at,expires_at,id)
 WHERE mode='multipart' AND state<>'completed' AND upload_name IS NOT NULL;
