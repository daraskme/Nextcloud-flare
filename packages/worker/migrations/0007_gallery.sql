CREATE INDEX node_media_gallery_keyset ON node_media(taken_at DESC,node_id DESC,blob_id,width,height);

CREATE TABLE media_jobs(
  id TEXT NOT NULL PRIMARY KEY,
  node_id TEXT NOT NULL REFERENCES nodes(id),
  blob_id TEXT NOT NULL REFERENCES blobs(id),
  owner_id TEXT NOT NULL REFERENCES users(id),
  variant TEXT NOT NULL CHECK(variant IN ('metadata','lg1600')),
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
  UNIQUE(node_id,blob_id,variant,generator_version)
) STRICT;
CREATE INDEX media_jobs_dispatch ON media_jobs(state,claim_expires_at,created_at,id);
CREATE INDEX media_jobs_node ON media_jobs(node_id,blob_id);
