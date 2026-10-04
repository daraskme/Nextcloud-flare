-- Source quota for public unlocks. Legacy rows remain nullable and count
-- toward the share-wide cap, but have no recoverable source identity.
ALTER TABLE share_sessions ADD COLUMN source_digest TEXT
  CHECK(source_digest IS NULL OR length(source_digest)=43);
CREATE INDEX share_sessions_active_source
  ON share_sessions(share_id,share_version,epoch,source_digest,expires_at)
  WHERE revoked_at IS NULL AND source_digest IS NOT NULL;
