PRAGMA foreign_keys = ON;
CREATE TABLE _assert(v INTEGER NOT NULL CHECK(v=0)) STRICT;
CREATE TABLE users(
  id TEXT NOT NULL PRIMARY KEY,
  access_iss TEXT NOT NULL,
  access_sub TEXT NOT NULL,
  email TEXT NOT NULL,
  role TEXT NOT NULL CHECK(role IN ('member','app_admin')),
  quota_bytes INTEGER NOT NULL CHECK(quota_bytes>=0),
  used_bytes INTEGER NOT NULL DEFAULT 0 CHECK(used_bytes>=0),
  physical_bytes INTEGER NOT NULL DEFAULT 0 CHECK(physical_bytes>=0),
  reserved_bytes INTEGER NOT NULL DEFAULT 0 CHECK(reserved_bytes>=0),
  disabled_at INTEGER,
  created_at INTEGER NOT NULL,
  UNIQUE(access_iss,access_sub)
) STRICT;
CREATE TABLE control(
  singleton INTEGER NOT NULL PRIMARY KEY CHECK(singleton=1),
  epoch INTEGER NOT NULL CHECK(epoch>0),
  bootstrap_done_at INTEGER,
  bootstrap_iss TEXT,
  bootstrap_sub TEXT,
  backup_barrier_op TEXT,
  updated_at INTEGER NOT NULL
) STRICT;
INSERT INTO control(singleton,epoch,updated_at) VALUES(1,1,unixepoch()*1000);
CREATE TABLE settings(
  singleton INTEGER NOT NULL PRIMARY KEY CHECK(singleton=1),
  signup_enabled INTEGER NOT NULL DEFAULT 0 CHECK(signup_enabled IN (0,1))
) STRICT;
INSERT INTO settings(singleton,signup_enabled) VALUES(1,0);
CREATE TABLE sessions(
  id TEXT NOT NULL PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  kind TEXT NOT NULL CHECK(kind IN ('access','app_password','share')),
  fingerprint TEXT NOT NULL UNIQUE,
  issued_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL CHECK(expires_at>issued_at),
  revoked_at INTEGER,
  last_seen_at INTEGER NOT NULL
) STRICT;
CREATE INDEX sessions_user_live ON sessions(user_id,revoked_at,expires_at);
CREATE TABLE app_passwords(
  id TEXT NOT NULL PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  session_id TEXT NOT NULL REFERENCES sessions(id),
  secret_digest TEXT NOT NULL,
  kdf TEXT NOT NULL,
  kdf_params TEXT NOT NULL,
  kid TEXT NOT NULL,
  scopes_json TEXT NOT NULL,
  root_node_id TEXT,
  expires_at INTEGER NOT NULL,
  revoked_at INTEGER,
  created_at INTEGER NOT NULL
) STRICT;
CREATE INDEX app_passwords_user ON app_passwords(user_id,revoked_at,expires_at);
CREATE TABLE blobs(
  id TEXT NOT NULL PRIMARY KEY,
  owner_id TEXT NOT NULL REFERENCES users(id),
  r2_key TEXT NOT NULL UNIQUE,
  size INTEGER NOT NULL CHECK(size>=0),
  sha256_verified TEXT,
  client_sha256 TEXT,
  content_etag TEXT NOT NULL,
  r2_etag TEXT,
  mime_sniffed TEXT,
  ref_count INTEGER NOT NULL CHECK(ref_count>=0),
  state TEXT NOT NULL CHECK(state IN ('staging','committed','orphan','gc_candidate','deleting','deleted')),
  created_at INTEGER NOT NULL,
  last_op_id TEXT
) STRICT;
CREATE INDEX blobs_owner_state ON blobs(owner_id,state);
CREATE TABLE spaces(
  id TEXT NOT NULL PRIMARY KEY,
  owner_id TEXT NOT NULL REFERENCES users(id),
  root_node_id TEXT NOT NULL UNIQUE,
  tree_generation INTEGER NOT NULL DEFAULT 1 CHECK(tree_generation>=1),
  UNIQUE(owner_id)
) STRICT;
CREATE INDEX spaces_owner ON spaces(owner_id);
CREATE TABLE trash_ops(
  op_id TEXT NOT NULL PRIMARY KEY,
  actor_id TEXT NOT NULL REFERENCES users(id),
  space_id TEXT NOT NULL REFERENCES spaces(id),
  root_node_id TEXT NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('pending','trashed','restoring','restored','purging','purged')),
  reason TEXT,
  created_at INTEGER NOT NULL,
  purge_after INTEGER,
  checkpoint TEXT,
  epoch INTEGER NOT NULL CHECK(epoch>0)
) STRICT;
CREATE INDEX trash_ops_space_state ON trash_ops(space_id,state);
CREATE TABLE nodes(
  id TEXT NOT NULL PRIMARY KEY,
  space_id TEXT NOT NULL REFERENCES spaces(id),
  owner_id TEXT NOT NULL REFERENCES users(id),
  parent_id TEXT REFERENCES nodes(id),
  name TEXT NOT NULL,
  name_ci TEXT NOT NULL,
  kind TEXT NOT NULL CHECK(kind IN ('root','folder','file')),
  current_blob_id TEXT REFERENCES blobs(id),
  revision INTEGER NOT NULL DEFAULT 1 CHECK(revision>=1),
  client_mtime INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  deleted_at INTEGER,
  deleted_op_id TEXT REFERENCES trash_ops(op_id),
  orig_parent_id TEXT,
  hidden INTEGER NOT NULL DEFAULT 0 CHECK(hidden IN (0,1)),
  last_op_id TEXT,
  CHECK((kind='root' AND parent_id IS NULL) OR (kind<>'root' AND (parent_id IS NOT NULL OR deleted_at IS NOT NULL))),
  CHECK((kind='file') OR current_blob_id IS NULL)
) STRICT;
CREATE UNIQUE INDEX nodes_parent_name_live ON nodes(parent_id,name_ci) WHERE deleted_at IS NULL;
CREATE UNIQUE INDEX nodes_one_root_live ON nodes(space_id) WHERE kind='root' AND deleted_at IS NULL;
CREATE INDEX nodes_children_keyset ON nodes(parent_id,name_ci,id,name,kind,revision,current_blob_id,updated_at) WHERE deleted_at IS NULL;
CREATE INDEX nodes_children_updated_live ON nodes(parent_id,updated_at DESC,id) WHERE deleted_at IS NULL;
CREATE INDEX nodes_children_deleted ON nodes(parent_id,deleted_at,id);
CREATE INDEX nodes_space_parent_live ON nodes(space_id,parent_id,id) WHERE deleted_at IS NULL;
CREATE INDEX nodes_blob ON nodes(current_blob_id) WHERE current_blob_id IS NOT NULL;
CREATE TRIGGER nodes_parent_insert BEFORE INSERT ON nodes
WHEN NEW.parent_id IS NOT NULL AND NOT EXISTS(
  SELECT 1 FROM nodes p WHERE p.id=NEW.parent_id AND p.space_id=NEW.space_id
    AND p.owner_id=NEW.owner_id AND p.kind IN ('root','folder') AND p.deleted_at IS NULL
)
BEGIN SELECT RAISE(ABORT,'invalid parent'); END;
CREATE TRIGGER nodes_parent_update BEFORE UPDATE OF parent_id,space_id,owner_id ON nodes
WHEN NEW.parent_id IS NOT NULL AND NOT EXISTS(
  SELECT 1 FROM nodes p WHERE p.id=NEW.parent_id AND p.space_id=NEW.space_id
    AND p.owner_id=NEW.owner_id AND p.kind IN ('root','folder') AND p.deleted_at IS NULL
)
BEGIN SELECT RAISE(ABORT,'invalid parent'); END;
CREATE TABLE permits(
  permit_id TEXT NOT NULL PRIMARY KEY,
  space_id TEXT NOT NULL REFERENCES spaces(id),
  epoch INTEGER NOT NULL CHECK(epoch>0),
  expires_at INTEGER NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('open','released','revoked'))
) STRICT;
CREATE INDEX permits_space_state ON permits(space_id,state,expires_at);
CREATE TABLE operations(
  op_id TEXT NOT NULL PRIMARY KEY,
  principal_kind TEXT NOT NULL CHECK(principal_kind IN ('user','app_password','share','service','job','system')),
  principal_id TEXT NOT NULL,
  credential_id TEXT NOT NULL,
  credential_version INTEGER,
  space_id TEXT NOT NULL REFERENCES spaces(id),
  kind TEXT NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('claimed','committed','failed')),
  request_digest TEXT NOT NULL,
  epoch INTEGER NOT NULL CHECK(epoch>0),
  permit_id TEXT NOT NULL REFERENCES permits(permit_id),
  permit_expires_at INTEGER NOT NULL,
  claimed_expires_at INTEGER NOT NULL,
  expected_steps INTEGER NOT NULL CHECK(expected_steps>=0),
  result_json TEXT,
  error_code TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE(principal_id,credential_id,space_id,kind,request_digest)
) STRICT;
CREATE INDEX operations_permit_state ON operations(permit_id,state,claimed_expires_at);
CREATE TABLE operation_steps(
  op_id TEXT NOT NULL REFERENCES operations(op_id),
  step_no INTEGER NOT NULL CHECK(step_no>=1),
  kind TEXT NOT NULL,
  affected_id TEXT,
  PRIMARY KEY(op_id,step_no)
) STRICT;
CREATE INDEX operation_steps_op ON operation_steps(op_id);
CREATE TABLE audit(
  audit_id TEXT NOT NULL PRIMARY KEY,
  op_id TEXT NOT NULL REFERENCES operations(op_id),
  actor_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  target_id TEXT,
  created_at INTEGER NOT NULL
) STRICT;
CREATE INDEX audit_op ON audit(op_id);
CREATE TABLE outbox(
  outbox_id TEXT NOT NULL PRIMARY KEY,
  op_id TEXT NOT NULL REFERENCES operations(op_id),
  kind TEXT NOT NULL,
  payload_ref TEXT NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('pending','dispatching','sent','completed','failed')),
  dispatch_token TEXT,
  dispatch_expires_at INTEGER,
  epoch INTEGER NOT NULL CHECK(epoch>0),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
) STRICT;
CREATE INDEX outbox_state_lease ON outbox(state,dispatch_expires_at);
CREATE TABLE trash_members(
  trash_op_id TEXT NOT NULL REFERENCES trash_ops(op_id),
  node_id TEXT NOT NULL REFERENCES nodes(id),
  PRIMARY KEY(trash_op_id,node_id)
) STRICT;
CREATE INDEX trash_members_node ON trash_members(node_id);
CREATE TABLE node_props(
  node_id TEXT NOT NULL REFERENCES nodes(id),
  namespace_uri TEXT NOT NULL,
  local_name TEXT NOT NULL,
  value_xml TEXT NOT NULL CHECK(length(value_xml)<=8192),
  PRIMARY KEY(node_id,namespace_uri,local_name)
) STRICT;
CREATE TABLE tags(
  id TEXT NOT NULL PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  name TEXT NOT NULL,
  name_ci TEXT NOT NULL,
  UNIQUE(user_id,name_ci)
) STRICT;
CREATE TABLE node_tags(
  node_id TEXT NOT NULL REFERENCES nodes(id),
  tag_id TEXT NOT NULL REFERENCES tags(id),
  PRIMARY KEY(node_id,tag_id)
) STRICT;
CREATE INDEX node_tags_tag ON node_tags(tag_id);
CREATE TABLE node_media(
  node_id TEXT NOT NULL PRIMARY KEY REFERENCES nodes(id),
  blob_id TEXT NOT NULL REFERENCES blobs(id),
  generator_version TEXT NOT NULL,
  width INTEGER CHECK(width>0),
  height INTEGER CHECK(height>0),
  taken_at INTEGER,
  duration_ms INTEGER CHECK(duration_ms>=0),
  orientation INTEGER,
  dominant_color TEXT,
  camera_make TEXT,
  camera_model TEXT
) STRICT;
CREATE INDEX node_media_blob ON node_media(blob_id);
CREATE TABLE node_audio(
  node_id TEXT NOT NULL PRIMARY KEY REFERENCES nodes(id),
  blob_id TEXT NOT NULL REFERENCES blobs(id),
  generator_version TEXT NOT NULL,
  title TEXT,
  artist TEXT,
  album TEXT,
  duration_ms INTEGER CHECK(duration_ms>=0),
  codec TEXT,
  override_json TEXT
) STRICT;
CREATE INDEX node_audio_blob ON node_audio(blob_id);
CREATE TABLE library_items(
  id TEXT NOT NULL PRIMARY KEY,
  node_id TEXT NOT NULL UNIQUE REFERENCES nodes(id),
  blob_id TEXT NOT NULL REFERENCES blobs(id),
  kind TEXT NOT NULL CHECK(kind IN ('epub','cbz','pdf','folder')),
  title TEXT,
  author TEXT,
  cover_blob_id TEXT REFERENCES blobs(id),
  generator_version TEXT NOT NULL
) STRICT;
CREATE INDEX library_items_blob ON library_items(blob_id);
CREATE INDEX library_items_cover_blob ON library_items(cover_blob_id);
CREATE TABLE archive_index(
  node_id TEXT NOT NULL REFERENCES nodes(id),
  blob_id TEXT NOT NULL REFERENCES blobs(id),
  entry_id TEXT NOT NULL,
  path TEXT NOT NULL,
  method INTEGER NOT NULL,
  flags INTEGER NOT NULL,
  compressed_size INTEGER NOT NULL CHECK(compressed_size>=0),
  uncompressed_size INTEGER NOT NULL CHECK(uncompressed_size>=0),
  offset INTEGER NOT NULL CHECK(offset>=0),
  crc32 INTEGER NOT NULL,
  PRIMARY KEY(node_id,blob_id,entry_id)
) STRICT;
CREATE INDEX archive_index_blob ON archive_index(blob_id);
CREATE TABLE user_reading_state(
  user_id TEXT NOT NULL REFERENCES users(id),
  node_id TEXT NOT NULL REFERENCES nodes(id),
  blob_id TEXT NOT NULL REFERENCES blobs(id),
  position TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY(user_id,node_id,blob_id)
) STRICT;
CREATE INDEX user_reading_state_node ON user_reading_state(node_id);
CREATE INDEX user_reading_state_blob ON user_reading_state(blob_id);
CREATE TABLE user_playback_state(
  user_id TEXT NOT NULL REFERENCES users(id),
  node_id TEXT NOT NULL REFERENCES nodes(id),
  blob_id TEXT NOT NULL REFERENCES blobs(id),
  position_ms INTEGER NOT NULL CHECK(position_ms>=0),
  updated_at INTEGER NOT NULL,
  PRIMARY KEY(user_id,node_id,blob_id)
) STRICT;
CREATE INDEX user_playback_state_node ON user_playback_state(node_id);
CREATE INDEX user_playback_state_blob ON user_playback_state(blob_id);
CREATE TABLE shares(
  id TEXT NOT NULL PRIMARY KEY,
  owner_id TEXT NOT NULL REFERENCES users(id),
  root_node_id TEXT NOT NULL REFERENCES nodes(id),
  version INTEGER NOT NULL CHECK(version>=1),
  actions_json TEXT NOT NULL,
  secret_digest TEXT,
  kdf TEXT,
  kdf_params TEXT,
  kid TEXT,
  expires_at INTEGER,
  disabled_at INTEGER,
  created_at INTEGER NOT NULL
) STRICT;
CREATE INDEX shares_root ON shares(root_node_id);
CREATE INDEX shares_owner_live ON shares(owner_id,disabled_at,expires_at);
CREATE TABLE share_grants(
  id TEXT NOT NULL PRIMARY KEY,
  share_id TEXT NOT NULL REFERENCES shares(id),
  grantee_user_id TEXT NOT NULL REFERENCES users(id),
  actions_json TEXT NOT NULL,
  revoked_at INTEGER,
  UNIQUE(share_id,grantee_user_id)
) STRICT;
CREATE INDEX share_grants_user ON share_grants(grantee_user_id,revoked_at);
CREATE TABLE share_sessions(
  id TEXT NOT NULL PRIMARY KEY,
  share_id TEXT NOT NULL REFERENCES shares(id),
  share_version INTEGER NOT NULL,
  fingerprint TEXT NOT NULL UNIQUE,
  issued_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  revoked_at INTEGER
) STRICT;
CREATE INDEX share_sessions_share ON share_sessions(share_id,revoked_at,expires_at);
CREATE TABLE content_target_sets(
  id TEXT NOT NULL PRIMARY KEY,
  owner_id TEXT NOT NULL REFERENCES users(id),
  target_hash TEXT NOT NULL,
  targets_json TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
) STRICT;
CREATE TABLE content_sessions(
  id TEXT NOT NULL PRIMARY KEY,
  user_id TEXT REFERENCES users(id),
  share_id TEXT REFERENCES shares(id),
  share_version INTEGER,
  issued_by_credential_id TEXT NOT NULL REFERENCES sessions(id),
  target_set_id TEXT NOT NULL REFERENCES content_target_sets(id),
  budget_id TEXT NOT NULL,
  epoch INTEGER NOT NULL CHECK(epoch>0),
  issued_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  revoked_at INTEGER,
  CHECK(user_id IS NOT NULL OR share_id IS NOT NULL)
) STRICT;
CREATE INDEX content_sessions_issuer ON content_sessions(issued_by_credential_id,revoked_at,expires_at);
CREATE INDEX content_sessions_budget ON content_sessions(budget_id,revoked_at,expires_at);
CREATE TABLE node_versions(
  id TEXT NOT NULL PRIMARY KEY,
  node_id TEXT NOT NULL REFERENCES nodes(id),
  blob_id TEXT NOT NULL REFERENCES blobs(id),
  created_at INTEGER NOT NULL,
  op_id TEXT NOT NULL REFERENCES operations(op_id)
) STRICT;
CREATE INDEX node_versions_node ON node_versions(node_id,created_at);
CREATE INDEX node_versions_blob ON node_versions(blob_id);
CREATE TABLE blob_pins(
  pin_id TEXT NOT NULL PRIMARY KEY,
  blob_id TEXT NOT NULL REFERENCES blobs(id),
  purpose TEXT NOT NULL,
  expires_at INTEGER,
  created_at INTEGER NOT NULL
) STRICT;
CREATE INDEX blob_pins_blob ON blob_pins(blob_id);
CREATE TABLE gc_candidates(
  blob_id TEXT NOT NULL PRIMARY KEY REFERENCES blobs(id),
  trash_op_id TEXT REFERENCES trash_ops(op_id),
  state TEXT NOT NULL CHECK(state IN ('candidate','deleting','deleted')),
  pinned_by TEXT,
  not_before INTEGER NOT NULL,
  last_error TEXT
) STRICT;
CREATE INDEX gc_candidates_state ON gc_candidates(state,not_before);
CREATE TABLE locks(
  id TEXT NOT NULL PRIMARY KEY,
  node_id TEXT NOT NULL REFERENCES nodes(id),
  creator_user_id TEXT NOT NULL REFERENCES users(id),
  creator_credential_id TEXT NOT NULL,
  token_digest TEXT NOT NULL UNIQUE,
  depth TEXT NOT NULL CHECK(depth IN ('0','infinity')),
  expires_at INTEGER NOT NULL,
  epoch INTEGER NOT NULL CHECK(epoch>0)
) STRICT;
CREATE INDEX locks_node_expiry ON locks(node_id,expires_at);
CREATE TABLE uploads(
  id TEXT NOT NULL PRIMARY KEY,
  owner_id TEXT NOT NULL REFERENCES users(id),
  credential_id TEXT NOT NULL,
  parent_id TEXT NOT NULL REFERENCES nodes(id),
  target_node_id TEXT REFERENCES nodes(id),
  blob_id TEXT NOT NULL,
  mode TEXT NOT NULL CHECK(mode IN ('single','multipart')),
  state TEXT NOT NULL CHECK(state IN ('created','receiving','completing','completed','failed','aborted','expired')),
  declared_size INTEGER NOT NULL CHECK(declared_size>=0),
  reserved_bytes INTEGER NOT NULL CHECK(reserved_bytes>=0),
  expires_at INTEGER NOT NULL,
  epoch INTEGER NOT NULL CHECK(epoch>0),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  CHECK(mode='single' OR declared_size>0)
) STRICT;
CREATE INDEX uploads_parent_state ON uploads(parent_id,state,expires_at);
CREATE INDEX uploads_owner_state ON uploads(owner_id,state,expires_at);
CREATE TABLE upload_parts(
  upload_id TEXT NOT NULL REFERENCES uploads(id),
  part_number INTEGER NOT NULL CHECK(part_number BETWEEN 1 AND 10000),
  attempt INTEGER NOT NULL CHECK(attempt BETWEEN 1 AND 3),
  size INTEGER NOT NULL CHECK(size>0),
  etag TEXT,
  state TEXT NOT NULL CHECK(state IN ('uploading','stored','unknown')),
  PRIMARY KEY(upload_id,part_number,attempt)
) STRICT;
CREATE TABLE job_leases(
  job_id TEXT NOT NULL PRIMARY KEY,
  operation_id TEXT NOT NULL REFERENCES operations(op_id),
  credential_id TEXT NOT NULL REFERENCES sessions(id),
  claim_token TEXT NOT NULL,
  claim_expires_at INTEGER NOT NULL,
  epoch INTEGER NOT NULL CHECK(epoch>0),
  state TEXT NOT NULL CHECK(state IN ('pending','claimed','completed','failed')),
  checkpoint TEXT,
  updated_at INTEGER NOT NULL
) STRICT;
CREATE INDEX job_leases_state ON job_leases(state,claim_expires_at);
CREATE TABLE derivative_results(
  kind TEXT NOT NULL,
  blob_id TEXT NOT NULL REFERENCES blobs(id),
  variant TEXT NOT NULL,
  generator_version TEXT NOT NULL,
  claim_token TEXT NOT NULL,
  r2_key TEXT,
  state TEXT NOT NULL CHECK(state IN ('claimed','published','failed')),
  PRIMARY KEY(kind,blob_id,variant,generator_version)
) STRICT;
CREATE INDEX derivative_results_blob ON derivative_results(blob_id);
CREATE TABLE backup_runs(
  id TEXT NOT NULL PRIMARY KEY,
  barrier_op_id TEXT REFERENCES operations(op_id),
  generation TEXT NOT NULL UNIQUE,
  state TEXT NOT NULL CHECK(state IN ('started','exported','verified','failed')),
  created_at INTEGER NOT NULL,
  completed_at INTEGER
) STRICT;
CREATE TABLE search_index(
  rowid INTEGER PRIMARY KEY,
  node_id TEXT NOT NULL UNIQUE REFERENCES nodes(id),
  space_id TEXT NOT NULL REFERENCES spaces(id),
  text_norm TEXT NOT NULL,
  tokens TEXT NOT NULL,
  revision INTEGER NOT NULL CHECK(revision>=1)
) STRICT;
CREATE INDEX search_index_scope ON search_index(space_id,node_id);
CREATE VIRTUAL TABLE search_fts USING fts5(text_norm,tokens,content='search_index',content_rowid='rowid',tokenize='unicode61');
