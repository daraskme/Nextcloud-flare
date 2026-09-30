ALTER TABLE uploads ADD COLUMN multipart_complete_attempt TEXT;
ALTER TABLE uploads ADD COLUMN multipart_complete_lease INTEGER CHECK(multipart_complete_lease IS NULL OR multipart_complete_lease>=0);
ALTER TABLE uploads ADD COLUMN multipart_object_etag TEXT;
CREATE TRIGGER uploads_multipart_complete_insert BEFORE INSERT ON uploads
WHEN (NEW.multipart_complete_attempt IS NULL)<>(NEW.multipart_complete_lease IS NULL)
 OR (NEW.multipart_complete_attempt IS NOT NULL AND NEW.mode<>'multipart')
 OR (NEW.multipart_object_etag IS NOT NULL AND (NEW.mode<>'multipart' OR NEW.multipart_complete_attempt IS NULL))
BEGIN SELECT RAISE(ABORT,'invalid_multipart_completion'); END;
CREATE TRIGGER uploads_multipart_complete_update BEFORE UPDATE OF multipart_complete_attempt,multipart_complete_lease,multipart_object_etag ON uploads
WHEN (NEW.multipart_complete_attempt IS NULL)<>(NEW.multipart_complete_lease IS NULL)
 OR (NEW.multipart_complete_attempt IS NOT NULL AND NEW.mode<>'multipart')
 OR (NEW.multipart_object_etag IS NOT NULL AND (NEW.mode<>'multipart' OR NEW.multipart_complete_attempt IS NULL))
 OR (OLD.multipart_complete_attempt IS NOT NULL AND (NEW.multipart_complete_attempt IS NOT OLD.multipart_complete_attempt OR NEW.multipart_complete_lease IS NOT OLD.multipart_complete_lease))
 OR (OLD.multipart_object_etag IS NOT NULL AND NEW.multipart_object_etag IS NOT OLD.multipart_object_etag)
BEGIN SELECT RAISE(ABORT,'immutable_multipart_completion'); END;
CREATE TRIGGER upload_parts_completed_immutable BEFORE UPDATE ON upload_parts
WHEN OLD.state='completed' AND (
 NEW.upload_id<>OLD.upload_id OR NEW.part_number<>OLD.part_number OR NEW.state<>OLD.state
 OR NEW.attempts<>OLD.attempts OR NEW.attempt_id IS NOT OLD.attempt_id
 OR NEW.expected_size<>OLD.expected_size OR NEW.lease_expires_at IS NOT OLD.lease_expires_at
 OR NEW.etag IS NOT OLD.etag OR NEW.sha256 IS NOT OLD.sha256)
BEGIN SELECT RAISE(ABORT,'immutable_completed_part'); END;
CREATE TRIGGER uploads_multipart_completed_terminal BEFORE UPDATE OF state ON uploads
WHEN OLD.mode='multipart' AND OLD.state='completed' AND NEW.state<>'completed'
BEGIN SELECT RAISE(ABORT,'terminal_multipart_upload'); END;
