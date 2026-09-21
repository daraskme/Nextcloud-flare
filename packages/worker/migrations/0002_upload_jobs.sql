ALTER TABLE uploads ADD COLUMN target_name TEXT NOT NULL DEFAULT '';
ALTER TABLE uploads ADD COLUMN target_name_ci TEXT NOT NULL DEFAULT '';
ALTER TABLE uploads ADD COLUMN capability_digest TEXT NOT NULL DEFAULT '';
ALTER TABLE uploads ADD COLUMN part_size INTEGER NOT NULL DEFAULT 8388608 CHECK(part_size>=5242880);
ALTER TABLE uploads ADD COLUMN uploaded_size INTEGER NOT NULL DEFAULT 0 CHECK(uploaded_size>=0);
ALTER TABLE uploads ADD COLUMN r2_etag TEXT;
ALTER TABLE uploads ADD COLUMN client_sha256 TEXT;
ALTER TABLE uploads ADD COLUMN failure_reason TEXT;
CREATE TABLE bulk_jobs(
  id TEXT NOT NULL PRIMARY KEY,
  kind TEXT NOT NULL CHECK(kind IN ('cross_owner_copy')),
  source_blob_id TEXT NOT NULL REFERENCES blobs(id),
  destination_owner_id TEXT NOT NULL REFERENCES users(id),
  destination_parent_id TEXT NOT NULL REFERENCES nodes(id),
  destination_blob_id TEXT NOT NULL UNIQUE,
  destination_name TEXT NOT NULL,
  destination_name_ci TEXT NOT NULL,
  credential_id TEXT NOT NULL REFERENCES sessions(id),
  pin_id TEXT NOT NULL UNIQUE,
  declared_size INTEGER NOT NULL CHECK(declared_size>=0),
  reserved_bytes INTEGER NOT NULL CHECK(reserved_bytes>=0),
  state TEXT NOT NULL CHECK(state IN ('pending','claimed','completed','failed')),
  attempt INTEGER NOT NULL DEFAULT 0 CHECK(attempt BETWEEN 0 AND 3),
  r2_calls INTEGER NOT NULL DEFAULT 0 CHECK(r2_calls BETWEEN 0 AND 20000),
  bytes_processed INTEGER NOT NULL DEFAULT 0 CHECK(bytes_processed>=0),
  claim_token TEXT,
  claim_expires_at INTEGER,
  epoch INTEGER NOT NULL CHECK(epoch>0),
  operation_id TEXT,
  last_error TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
) STRICT;
CREATE INDEX bulk_jobs_state_claim ON bulk_jobs(state,claim_expires_at);
CREATE INDEX bulk_jobs_destination_owner ON bulk_jobs(destination_owner_id,state);
