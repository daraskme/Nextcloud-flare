ALTER TABLE node_audio ADD COLUMN track_no INTEGER CHECK(track_no IS NULL OR track_no>=0);
ALTER TABLE node_audio ADD COLUMN disc_no INTEGER CHECK(disc_no IS NULL OR disc_no>=0);
ALTER TABLE node_audio ADD COLUMN bitrate INTEGER CHECK(bitrate IS NULL OR bitrate>=0);
ALTER TABLE node_audio ADD COLUMN cover_key TEXT;
ALTER TABLE node_audio ADD COLUMN updated_at INTEGER NOT NULL DEFAULT 0;
CREATE INDEX node_audio_album_order ON node_audio(album,disc_no,track_no,node_id);

CREATE TABLE audio_jobs(
  id TEXT NOT NULL PRIMARY KEY,
  node_id TEXT NOT NULL REFERENCES nodes(id),
  blob_id TEXT NOT NULL REFERENCES blobs(id),
  owner_id TEXT NOT NULL REFERENCES users(id),
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
CREATE INDEX audio_jobs_dispatch ON audio_jobs(state,claim_expires_at,created_at,id);
CREATE INDEX audio_jobs_node ON audio_jobs(node_id,blob_id);
