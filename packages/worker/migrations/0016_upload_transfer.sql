-- Existing upload fixtures/legacy rows remain unreadable by the transfer service until upgraded.
ALTER TABLE uploads ADD COLUMN upload_name TEXT;
ALTER TABLE uploads ADD COLUMN target_revision INTEGER CHECK(target_revision IS NULL OR target_revision>=1);
ALTER TABLE uploads ADD COLUMN request_digest TEXT;
ALTER TABLE uploads ADD COLUMN capability_kid TEXT;
ALTER TABLE uploads ADD COLUMN write_attempt_id TEXT;
ALTER TABLE uploads ADD COLUMN write_lease_expires_at INTEGER;
ALTER TABLE uploads ADD COLUMN completion_op_id TEXT REFERENCES operations(op_id);
CREATE INDEX uploads_completion_op_id_fk ON uploads(completion_op_id);
CREATE INDEX uploads_cleanup ON uploads(cleanup_pending,expires_at,id);

CREATE TRIGGER uploads_transfer_identity BEFORE UPDATE OF
  id,owner_id,space_id,parent_id,target_id,epoch,capability_hash,capability_kid,
  upload_name,target_revision,request_digest,created_at,expires_at ON uploads
WHEN NEW.id<>OLD.id OR NEW.owner_id<>OLD.owner_id OR NEW.space_id<>OLD.space_id
 OR NEW.parent_id<>OLD.parent_id OR NEW.target_id IS NOT OLD.target_id OR NEW.epoch<>OLD.epoch
 OR NEW.capability_hash<>OLD.capability_hash OR NEW.capability_kid IS NOT OLD.capability_kid
 OR NEW.upload_name IS NOT OLD.upload_name OR NEW.target_revision IS NOT OLD.target_revision
 OR NEW.request_digest IS NOT OLD.request_digest OR NEW.created_at<>OLD.created_at OR NEW.expires_at<>OLD.expires_at
BEGIN SELECT RAISE(ABORT,'immutable_upload_transfer'); END;

CREATE TRIGGER uploads_single_attempt BEFORE UPDATE OF write_attempt_id,write_lease_expires_at ON uploads
WHEN OLD.mode='single' AND OLD.write_attempt_id IS NOT NULL AND
 (NEW.write_attempt_id IS NOT OLD.write_attempt_id OR NEW.write_lease_expires_at IS NOT OLD.write_lease_expires_at)
BEGIN SELECT RAISE(ABORT,'single_upload_cannot_rewrite'); END;
CREATE TRIGGER uploads_completion_identity BEFORE UPDATE OF completion_op_id ON uploads
WHEN OLD.completion_op_id IS NOT NULL AND NEW.completion_op_id IS NOT OLD.completion_op_id
BEGIN SELECT RAISE(ABORT,'immutable_upload_completion'); END;
