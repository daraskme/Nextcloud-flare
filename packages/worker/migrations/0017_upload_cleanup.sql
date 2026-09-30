ALTER TABLE uploads ADD COLUMN cleanup_token TEXT;
ALTER TABLE uploads ADD COLUMN cleanup_lease_expires_at INTEGER CHECK(cleanup_lease_expires_at IS NULL OR cleanup_lease_expires_at>=0);
ALTER TABLE uploads ADD COLUMN cleanup_next_at INTEGER NOT NULL DEFAULT 0 CHECK(cleanup_next_at>=0);
ALTER TABLE uploads ADD COLUMN cleanup_error TEXT;
CREATE INDEX uploads_single_cleanup_due ON uploads(cleanup_next_at,expires_at,id)
WHERE mode='single' AND state<>'completed';
CREATE UNIQUE INDEX uploads_cleanup_token ON uploads(cleanup_token) WHERE cleanup_token IS NOT NULL;
CREATE INDEX operations_upload_transfer ON operations(json_extract(operands_json,'$.uploadId'),credential_id,epoch)
WHERE kind='upload.complete';
CREATE TRIGGER uploads_cleanup_claim_insert BEFORE INSERT ON uploads
WHEN (NEW.cleanup_token IS NULL)<>(NEW.cleanup_lease_expires_at IS NULL)
BEGIN SELECT RAISE(ABORT,'invalid_upload_cleanup_claim'); END;
CREATE TRIGGER uploads_cleanup_claim_update BEFORE UPDATE OF cleanup_token,cleanup_lease_expires_at ON uploads
WHEN (NEW.cleanup_token IS NULL)<>(NEW.cleanup_lease_expires_at IS NULL)
BEGIN SELECT RAISE(ABORT,'invalid_upload_cleanup_claim'); END;
