CREATE TABLE budgets(
  id TEXT NOT NULL PRIMARY KEY, owner_id TEXT NOT NULL REFERENCES users(id), user_id TEXT REFERENCES users(id),
  share_id TEXT REFERENCES shares(id), unlock_session_id TEXT REFERENCES share_sessions(id),
  epoch INTEGER NOT NULL CHECK(epoch>0), expires_at INTEGER NOT NULL CHECK(expires_at>=0),
  state TEXT NOT NULL CHECK(state IN ('active','expired','revoked'))
) STRICT;
CREATE TABLE target_sets(
  id TEXT NOT NULL PRIMARY KEY, owner_id TEXT NOT NULL REFERENCES users(id),
  credential_id TEXT NOT NULL REFERENCES credentials(id), manifest_hash TEXT NOT NULL,
  manifest_ref TEXT NOT NULL, total_bytes INTEGER NOT NULL CHECK(total_bytes>=0),
  expires_at INTEGER NOT NULL CHECK(expires_at>=0), epoch INTEGER NOT NULL CHECK(epoch>0)
) STRICT;
CREATE TABLE content_sessions(
  id TEXT NOT NULL PRIMARY KEY, user_id TEXT REFERENCES users(id), share_id TEXT REFERENCES shares(id),
  share_version INTEGER CHECK(share_version>=1), issued_by_credential_id TEXT NOT NULL REFERENCES credentials(id),
  target_set_id TEXT NOT NULL REFERENCES target_sets(id), budget_id TEXT NOT NULL REFERENCES budgets(id),
  epoch INTEGER NOT NULL CHECK(epoch>0), issued_at INTEGER NOT NULL CHECK(issued_at>=0),
  expires_at INTEGER NOT NULL CHECK(expires_at>issued_at AND expires_at<=issued_at+600000), revoked_at INTEGER,
  CHECK(user_id IS NOT NULL OR share_id IS NOT NULL), CHECK((share_id IS NULL)=(share_version IS NULL))
) STRICT;
CREATE TABLE tickets(
  id TEXT NOT NULL PRIMARY KEY, credential_id TEXT NOT NULL REFERENCES credentials(id),
  target_set_id TEXT NOT NULL REFERENCES target_sets(id), budget_id TEXT NOT NULL REFERENCES budgets(id),
  purpose TEXT NOT NULL CHECK(purpose IN ('content','thumb','page','zip','track')),
  epoch INTEGER NOT NULL CHECK(epoch>0), issued_at INTEGER NOT NULL CHECK(issued_at>=0),
  expires_at INTEGER NOT NULL CHECK(expires_at>issued_at AND expires_at<=issued_at+600000), cancelled_at INTEGER
) STRICT;
CREATE TABLE node_props(
  node_id TEXT NOT NULL REFERENCES nodes(id), namespace TEXT NOT NULL, name TEXT NOT NULL,
  value_xml TEXT NOT NULL CHECK(length(CAST(value_xml AS BLOB))<=8192), PRIMARY KEY(node_id,namespace,name)
) STRICT;
CREATE TABLE stars(
  user_id TEXT NOT NULL REFERENCES users(id), node_id TEXT NOT NULL REFERENCES nodes(id), PRIMARY KEY(user_id,node_id)
) STRICT;
CREATE TABLE tags(
  id TEXT NOT NULL PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id),
  name TEXT NOT NULL CHECK(length(CAST(name AS BLOB)) BETWEEN 1 AND 1024), UNIQUE(user_id,name)
) STRICT;
CREATE TABLE node_tags(
  node_id TEXT NOT NULL REFERENCES nodes(id), tag_id TEXT NOT NULL REFERENCES tags(id), PRIMARY KEY(node_id,tag_id)
) STRICT;
CREATE TABLE node_media(
  node_id TEXT NOT NULL PRIMARY KEY REFERENCES nodes(id), blob_id TEXT NOT NULL REFERENCES blobs(id),
  generator_version TEXT NOT NULL, width INTEGER CHECK(width>0), height INTEGER CHECK(height>0),
  taken_at INTEGER, duration_ms INTEGER CHECK(duration_ms>=0), orientation INTEGER CHECK(orientation BETWEEN 1 AND 8),
  dominant_color TEXT CHECK(length(dominant_color)<=16), camera_make TEXT CHECK(length(CAST(camera_make AS BLOB))<=1024),
  camera_model TEXT CHECK(length(CAST(camera_model AS BLOB))<=1024)
) STRICT;
CREATE TABLE derivative_results(
  id TEXT NOT NULL PRIMARY KEY, blob_id TEXT NOT NULL REFERENCES blobs(id),
  kind TEXT NOT NULL CHECK(kind IN ('thumbnail','cover','epub_sanitized','archive_index')),
  variant TEXT NOT NULL, generator_version TEXT NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('pending','running','ready','failed')),
  claim_token TEXT, claim_expires_at INTEGER, epoch INTEGER NOT NULL CHECK(epoch>0),
  attempts INTEGER NOT NULL DEFAULT 0 CHECK(attempts BETWEEN 0 AND 3),
  r2_key TEXT, size INTEGER CHECK(size>=0), error_code TEXT,
  UNIQUE(kind,blob_id,variant,generator_version)
) STRICT;
CREATE TABLE library_items(
  node_id TEXT NOT NULL PRIMARY KEY REFERENCES nodes(id), blob_id TEXT REFERENCES blobs(id),
  kind TEXT NOT NULL CHECK(kind IN ('epub','zip','cbz','pdf','folder')),
  generator_version TEXT NOT NULL, title_extracted TEXT, author_extracted TEXT, series_extracted TEXT,
  title_override TEXT, author_override TEXT, series_override TEXT,
  page_count INTEGER CHECK(page_count BETWEEN 0 AND 10000)
) STRICT;
CREATE TABLE archive_index(
  id TEXT NOT NULL PRIMARY KEY, node_id TEXT NOT NULL REFERENCES nodes(id), blob_id TEXT NOT NULL REFERENCES blobs(id),
  generator_version TEXT NOT NULL, r2_key TEXT NOT NULL UNIQUE, sha256 TEXT NOT NULL,
  entry_count INTEGER NOT NULL CHECK(entry_count BETWEEN 0 AND 10000),
  json_bytes INTEGER NOT NULL CHECK(json_bytes BETWEEN 0 AND 8388608), UNIQUE(node_id,blob_id,generator_version)
) STRICT;
CREATE TABLE library_roots(
  user_id TEXT NOT NULL REFERENCES users(id), node_id TEXT NOT NULL REFERENCES nodes(id), PRIMARY KEY(user_id,node_id)
) STRICT;
CREATE TABLE node_audio(
  node_id TEXT NOT NULL PRIMARY KEY REFERENCES nodes(id), blob_id TEXT NOT NULL REFERENCES blobs(id), generator_version TEXT NOT NULL,
  duration_ms INTEGER CHECK(duration_ms>=0), codec TEXT,
  title_extracted TEXT, artist_extracted TEXT, album_extracted TEXT,
  title_override TEXT, artist_override TEXT, album_override TEXT,
  track_number INTEGER CHECK(track_number>=0), disc_number INTEGER CHECK(disc_number>=0)
) STRICT;
CREATE TABLE user_reading_state(
  user_id TEXT NOT NULL REFERENCES users(id), node_id TEXT NOT NULL REFERENCES nodes(id), blob_id TEXT NOT NULL REFERENCES blobs(id),
  position_json TEXT NOT NULL CHECK(json_valid(position_json) AND length(CAST(position_json AS BLOB))<=8192),
  updated_at INTEGER NOT NULL CHECK(updated_at>=0), PRIMARY KEY(user_id,node_id,blob_id)
) STRICT;
CREATE TABLE user_playback_state(
  user_id TEXT NOT NULL REFERENCES users(id), node_id TEXT NOT NULL REFERENCES nodes(id), blob_id TEXT NOT NULL REFERENCES blobs(id),
  position_ms INTEGER NOT NULL CHECK(position_ms>=0), updated_at INTEGER NOT NULL CHECK(updated_at>=0),
  PRIMARY KEY(user_id,node_id,blob_id)
) STRICT;
CREATE TABLE search_index(
  rowid INTEGER PRIMARY KEY, node_id TEXT NOT NULL UNIQUE REFERENCES nodes(id), space_id TEXT NOT NULL REFERENCES spaces(id),
  text_norm TEXT NOT NULL, tokens TEXT NOT NULL, normalization_version TEXT NOT NULL,
  revision INTEGER NOT NULL CHECK(revision>=1)
) STRICT;
CREATE INDEX search_index_scope ON search_index(space_id,node_id);
CREATE VIRTUAL TABLE search_fts USING fts5(text_norm,tokens,content='search_index',content_rowid='rowid',tokenize='unicode61');
