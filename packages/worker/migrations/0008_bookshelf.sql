CREATE TABLE library_roots(
  user_id TEXT NOT NULL REFERENCES users(id),
  node_id TEXT NOT NULL REFERENCES nodes(id),
  created_at INTEGER NOT NULL,
  PRIMARY KEY(user_id,node_id)
) STRICT;
CREATE INDEX library_roots_node ON library_roots(node_id,user_id);

ALTER TABLE library_items ADD COLUMN series TEXT;
ALTER TABLE library_items ADD COLUMN tags_json TEXT NOT NULL DEFAULT '[]';
ALTER TABLE library_items ADD COLUMN page_count INTEGER CHECK(page_count IS NULL OR page_count>=0);
ALTER TABLE library_items ADD COLUMN cover_key TEXT;
ALTER TABLE library_items ADD COLUMN status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','indexed','failed'));
ALTER TABLE library_items ADD COLUMN error_code TEXT;
ALTER TABLE library_items ADD COLUMN metadata_json TEXT NOT NULL DEFAULT '{}';
ALTER TABLE library_items ADD COLUMN override_json TEXT NOT NULL DEFAULT '{}';
ALTER TABLE library_items ADD COLUMN updated_at INTEGER NOT NULL DEFAULT 0;
CREATE INDEX library_items_status ON library_items(status,updated_at,id);

ALTER TABLE archive_index ADD COLUMN data_offset INTEGER NOT NULL DEFAULT 0 CHECK(data_offset>=0);
ALTER TABLE archive_index ADD COLUMN content_type TEXT NOT NULL DEFAULT 'application/octet-stream';
ALTER TABLE archive_index ADD COLUMN page_no INTEGER CHECK(page_no IS NULL OR page_no>=0);
CREATE INDEX archive_index_pages ON archive_index(node_id,blob_id,page_no,entry_id);

CREATE TABLE library_jobs(
  id TEXT NOT NULL PRIMARY KEY,
  node_id TEXT NOT NULL REFERENCES nodes(id),
  blob_id TEXT NOT NULL REFERENCES blobs(id),
  owner_id TEXT NOT NULL REFERENCES users(id),
  kind TEXT NOT NULL CHECK(kind IN ('archive','epub','pdf')),
  generator_version TEXT NOT NULL,
  saved_principal_json TEXT NOT NULL,
  epoch INTEGER NOT NULL CHECK(epoch>0),
  state TEXT NOT NULL CHECK(state IN ('pending','claimed','completed','failed')),
  attempt INTEGER NOT NULL DEFAULT 0 CHECK(attempt BETWEEN 0 AND 3),
  claim_token TEXT,
  claim_expires_at INTEGER,
  last_error TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE(node_id,blob_id,generator_version)
) STRICT;
CREATE INDEX library_jobs_dispatch ON library_jobs(state,claim_expires_at,created_at,id);
CREATE INDEX library_jobs_node ON library_jobs(node_id,blob_id);
