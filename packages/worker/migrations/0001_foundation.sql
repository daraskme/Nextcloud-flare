-- All timestamps are Unix milliseconds; epoch values are issued only by ControlDO.
-- Root/trash root and audit affected IDs are logical references so terminal records survive purge.
CREATE TABLE _assert(v INTEGER NOT NULL CHECK(v=0)) STRICT;
CREATE TABLE control(
  singleton INTEGER NOT NULL PRIMARY KEY CHECK(singleton=1),
  epoch INTEGER NOT NULL CHECK(epoch BETWEEN 1 AND 9007199254740991),
  maintenance INTEGER NOT NULL DEFAULT 1 CHECK(maintenance IN (0,1)),
  gc_paused INTEGER NOT NULL DEFAULT 1 CHECK(gc_paused IN (0,1)),
  bootstrap_done_at INTEGER, bootstrap_iss TEXT, bootstrap_sub TEXT,
  backup_barrier_op TEXT, updated_at INTEGER NOT NULL CHECK(updated_at>=0)
) STRICT;
INSERT INTO control(singleton,epoch,updated_at) VALUES(1,1,strftime('%s','now')*1000);
CREATE TABLE settings(
  singleton INTEGER NOT NULL PRIMARY KEY CHECK(singleton=1),
  signup_enabled INTEGER NOT NULL DEFAULT 0 CHECK(signup_enabled IN (0,1))
) STRICT;
INSERT INTO settings(singleton) VALUES(1);
CREATE TABLE users(
  id TEXT NOT NULL PRIMARY KEY CHECK(length(id) BETWEEN 1 AND 128 AND instr(id,'/')=0),
  access_iss TEXT NOT NULL, access_sub TEXT NOT NULL, email TEXT NOT NULL,
  role TEXT NOT NULL CHECK(role IN ('member','app_admin')),
  quota_bytes INTEGER NOT NULL CHECK(quota_bytes BETWEEN 0 AND 7505999378950825),
  used_bytes INTEGER NOT NULL DEFAULT 0 CHECK(used_bytes BETWEEN 0 AND 9007199254740991),
  physical_bytes INTEGER NOT NULL DEFAULT 0 CHECK(physical_bytes BETWEEN 0 AND 9007199254740991),
  reserved_bytes INTEGER NOT NULL DEFAULT 0 CHECK(reserved_bytes BETWEEN 0 AND 9007199254740991),
  disabled_at INTEGER, created_at INTEGER NOT NULL CHECK(created_at>=0),
  UNIQUE(access_iss,access_sub)
) STRICT;
CREATE TABLE spaces(
  id TEXT NOT NULL PRIMARY KEY,
  owner_id TEXT NOT NULL UNIQUE REFERENCES users(id),
  root_node_id TEXT NOT NULL UNIQUE,
  tree_generation INTEGER NOT NULL DEFAULT 1 CHECK(tree_generation BETWEEN 1 AND 9007199254740991)
) STRICT;
CREATE TABLE sessions(
  id TEXT NOT NULL PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  kind TEXT NOT NULL CHECK(kind IN ('access','app_password','share')),
  fingerprint TEXT NOT NULL UNIQUE,
  epoch INTEGER NOT NULL CHECK(epoch>0),
  issued_at INTEGER NOT NULL CHECK(issued_at>=0),
  expires_at INTEGER NOT NULL CHECK(expires_at>issued_at),
  revoked_at INTEGER, last_seen_at INTEGER NOT NULL CHECK(last_seen_at>=issued_at)
) STRICT;
CREATE TABLE blobs(
  id TEXT NOT NULL PRIMARY KEY, owner_id TEXT NOT NULL REFERENCES users(id),
  r2_key TEXT NOT NULL UNIQUE CHECK(length(CAST(r2_key AS BLOB))<=1024),
  size INTEGER NOT NULL CHECK(size BETWEEN 0 AND 536870912000),
  sha256_verified TEXT, client_sha256 TEXT, content_etag TEXT NOT NULL,
  r2_etag TEXT, mime_sniffed TEXT,
  ref_count INTEGER NOT NULL DEFAULT 0 CHECK(ref_count BETWEEN 0 AND 1000),
  state TEXT NOT NULL CHECK(state IN ('staging','committed','orphan','gc_candidate','deleting','deleted')),
  created_at INTEGER NOT NULL CHECK(created_at>=0), last_op_id TEXT
) STRICT;
CREATE TABLE trash_ops(
  op_id TEXT NOT NULL PRIMARY KEY, actor_id TEXT NOT NULL REFERENCES users(id),
  space_id TEXT NOT NULL REFERENCES spaces(id), root_node_id TEXT NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('pending','trashed','restoring','restored','purging','purged')),
  reason TEXT, created_at INTEGER NOT NULL CHECK(created_at>=0), purge_after INTEGER,
  checkpoint TEXT, epoch INTEGER NOT NULL CHECK(epoch>0)
) STRICT;
CREATE TABLE nodes(
  id TEXT NOT NULL PRIMARY KEY CHECK(length(id) BETWEEN 1 AND 128 AND instr(id,'/')=0),
  space_id TEXT NOT NULL REFERENCES spaces(id), owner_id TEXT NOT NULL REFERENCES users(id),
  parent_id TEXT REFERENCES nodes(id), name TEXT NOT NULL,
  name_ci TEXT NOT NULL CHECK(length(CAST(name_ci AS BLOB))<=1024),
  kind TEXT NOT NULL CHECK(kind IN ('root','folder','file')),
  current_blob_id TEXT REFERENCES blobs(id),
  revision INTEGER NOT NULL DEFAULT 1 CHECK(revision BETWEEN 1 AND 9007199254740991),
  client_mtime INTEGER, created_at INTEGER NOT NULL CHECK(created_at>=0), updated_at INTEGER NOT NULL CHECK(updated_at>=0),
  deleted_at INTEGER, deleted_op_id TEXT REFERENCES trash_ops(op_id), orig_parent_id TEXT,
  hidden INTEGER NOT NULL DEFAULT 0 CHECK(hidden IN (0,1)), last_op_id TEXT,
  CHECK((kind='root' AND parent_id IS NULL AND deleted_at IS NULL AND name='' AND name_ci='') OR
        (kind<>'root' AND (parent_id IS NOT NULL OR deleted_at IS NOT NULL) AND length(name) BETWEEN 1 AND 254 AND length(CAST(name AS BLOB))<=255)),
  CHECK(kind='file' OR current_blob_id IS NULL),
  CHECK((deleted_at IS NULL)=(deleted_op_id IS NULL))
) STRICT;
CREATE UNIQUE INDEX nodes_parent_name_live ON nodes(parent_id,name_ci) WHERE deleted_at IS NULL;
CREATE UNIQUE INDEX nodes_one_root_live ON nodes(space_id) WHERE kind='root' AND deleted_at IS NULL;
CREATE INDEX nodes_children_keyset ON nodes(parent_id,name_ci,id,name,kind,revision,current_blob_id,updated_at) WHERE deleted_at IS NULL;
CREATE INDEX nodes_children_updated_live ON nodes(parent_id,updated_at DESC,id) WHERE deleted_at IS NULL;
CREATE INDEX nodes_children_deleted ON nodes(parent_id,deleted_at,id);
CREATE INDEX nodes_space_parent_live ON nodes(space_id,parent_id,id) WHERE deleted_at IS NULL;
CREATE TABLE trash_members(
  trash_op_id TEXT NOT NULL REFERENCES trash_ops(op_id), node_id TEXT NOT NULL REFERENCES nodes(id),
  PRIMARY KEY(trash_op_id,node_id)
) STRICT;
CREATE TABLE node_versions(
  id TEXT NOT NULL PRIMARY KEY, node_id TEXT NOT NULL REFERENCES nodes(id), blob_id TEXT NOT NULL REFERENCES blobs(id),
  revision INTEGER NOT NULL CHECK(revision>=1), created_at INTEGER NOT NULL CHECK(created_at>=0),
  UNIQUE(node_id,revision)
) STRICT;
CREATE TABLE blob_pins(
  pin_id TEXT NOT NULL PRIMARY KEY, blob_id TEXT NOT NULL REFERENCES blobs(id),
  purpose TEXT NOT NULL CHECK(purpose IN ('copy','zip','backup','job','reader')),
  expires_at INTEGER, created_at INTEGER NOT NULL CHECK(created_at>=0)
) STRICT;
CREATE TABLE gc_candidates(
  blob_id TEXT NOT NULL PRIMARY KEY REFERENCES blobs(id), trash_op_id TEXT REFERENCES trash_ops(op_id),
  state TEXT NOT NULL CHECK(state IN ('candidate','deleting','deleted')),
  pinned_by TEXT, not_before INTEGER NOT NULL CHECK(not_before>=0), last_error TEXT
) STRICT;
CREATE TABLE app_passwords(
  id TEXT NOT NULL PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id), root_node_id TEXT REFERENCES nodes(id),
  name TEXT NOT NULL, secret_digest TEXT NOT NULL, salt TEXT NOT NULL,
  kdf TEXT NOT NULL CHECK(kdf='PBKDF2-SHA256'),
  kdf_params TEXT NOT NULL CHECK(json_valid(kdf_params) AND json_extract(kdf_params,'$.iterations') IS 100000),
  kid TEXT NOT NULL, created_at INTEGER NOT NULL CHECK(created_at>=0),
  expires_at INTEGER NOT NULL CHECK(expires_at>created_at AND expires_at<=created_at+31536000000), revoked_at INTEGER
) STRICT;
CREATE TABLE shares(
  id TEXT NOT NULL PRIMARY KEY, owner_id TEXT NOT NULL REFERENCES users(id), root_node_id TEXT REFERENCES nodes(id),
  kind TEXT NOT NULL CHECK(kind IN ('link','internal','upload_only')),
  version INTEGER NOT NULL DEFAULT 1 CHECK(version>=1), secret_digest TEXT,
  password_digest TEXT, salt TEXT, kdf TEXT, kdf_params TEXT, kid TEXT,
  disabled_at INTEGER, expires_at INTEGER, created_at INTEGER NOT NULL CHECK(created_at>=0),
  reserved_bytes INTEGER NOT NULL DEFAULT 0 CHECK(reserved_bytes>=0),
  reservation_limit INTEGER NOT NULL DEFAULT 0 CHECK(reservation_limit>=0),
  CHECK(root_node_id IS NOT NULL OR disabled_at IS NOT NULL),
  CHECK(password_digest IS NULL OR (salt IS NOT NULL AND kdf='PBKDF2-SHA256' AND kid IS NOT NULL AND
    kdf_params IS NOT NULL AND json_valid(kdf_params) AND json_extract(kdf_params,'$.iterations') IS 100000))
) STRICT;
CREATE TABLE share_grants(
  share_id TEXT NOT NULL REFERENCES shares(id), user_id TEXT NOT NULL REFERENCES users(id),
  version INTEGER NOT NULL CHECK(version>=1), disabled_at INTEGER, PRIMARY KEY(share_id,user_id)
) STRICT;
CREATE TABLE share_actions(
  share_id TEXT NOT NULL REFERENCES shares(id),
  action TEXT NOT NULL CHECK(action IN ('read','download','create','edit','upload')),
  PRIMARY KEY(share_id,action)
) STRICT;
CREATE TABLE share_sessions(
  id TEXT NOT NULL PRIMARY KEY, share_id TEXT NOT NULL REFERENCES shares(id),
  share_version INTEGER NOT NULL CHECK(share_version>=1), user_id TEXT REFERENCES users(id),
  secret_digest TEXT NOT NULL UNIQUE, epoch INTEGER NOT NULL CHECK(epoch>0),
  issued_at INTEGER NOT NULL CHECK(issued_at>=0), expires_at INTEGER NOT NULL CHECK(expires_at>issued_at), revoked_at INTEGER
) STRICT;
CREATE TABLE service_principals(
  id TEXT NOT NULL PRIMARY KEY, access_iss TEXT NOT NULL, common_name TEXT NOT NULL,
  mapped_user_id TEXT NOT NULL REFERENCES users(id), space_id TEXT NOT NULL REFERENCES spaces(id),
  root_node_id TEXT REFERENCES nodes(id), disabled_at INTEGER,
  CHECK(root_node_id IS NOT NULL OR disabled_at IS NOT NULL),
  UNIQUE(access_iss,common_name)
) STRICT;
-- Registry gives every derived content session/job/operation a real credential FK.
CREATE TABLE credentials(
  id TEXT NOT NULL PRIMARY KEY,
  kind TEXT NOT NULL CHECK(kind IN ('access','app_password','share','service')),
  session_id TEXT UNIQUE REFERENCES sessions(id), app_password_id TEXT UNIQUE REFERENCES app_passwords(id),
  share_session_id TEXT UNIQUE REFERENCES share_sessions(id), service_principal_id TEXT UNIQUE REFERENCES service_principals(id),
  CHECK((kind='access' AND session_id IS NOT NULL AND id='as:'||session_id AND app_password_id IS NULL AND share_session_id IS NULL AND service_principal_id IS NULL) OR
    (kind='app_password' AND app_password_id IS NOT NULL AND id='ap:'||app_password_id AND session_id IS NULL AND share_session_id IS NULL AND service_principal_id IS NULL) OR
    (kind='share' AND share_session_id IS NOT NULL AND id='ss:'||share_session_id AND session_id IS NULL AND app_password_id IS NULL AND service_principal_id IS NULL) OR
    (kind='service' AND service_principal_id IS NOT NULL AND id='sv:'||service_principal_id AND session_id IS NULL AND app_password_id IS NULL AND share_session_id IS NULL))
) STRICT;
CREATE TABLE scopes(name TEXT NOT NULL PRIMARY KEY) STRICT;
INSERT INTO scopes VALUES('account:read'),('node:read'),('node:create'),('node:write'),('node:delete'),('node:star'),
  ('state:write'),('tag:write'),('share:manage'),('upload:create'),('upload:write'),('library:read'),('library:write'),
  ('credential:manage'),('job:read'),('job:cancel'),('admin:user'),('admin:lock'),('admin:dlq'),('admin:repair');
CREATE TABLE credential_scopes(
  credential_id TEXT NOT NULL REFERENCES credentials(id), scope TEXT NOT NULL REFERENCES scopes(name), PRIMARY KEY(credential_id,scope)
) STRICT;
CREATE TABLE permits(
  permit_id TEXT NOT NULL PRIMARY KEY, space_id TEXT NOT NULL REFERENCES spaces(id),
  epoch INTEGER NOT NULL CHECK(epoch>0), expires_at INTEGER NOT NULL CHECK(expires_at>=0),
  state TEXT NOT NULL CHECK(state IN ('open','released','revoked'))
) STRICT;
CREATE INDEX permits_space_state ON permits(space_id,state,expires_at);
CREATE TABLE operation_kinds(name TEXT NOT NULL PRIMARY KEY) STRICT;
CREATE TABLE operations(
  op_id TEXT NOT NULL PRIMARY KEY, principal_kind TEXT NOT NULL CHECK(principal_kind IN ('user','app_password','link_share','service','job','system')),
  principal_id TEXT NOT NULL, credential_id TEXT REFERENCES credentials(id), credential_version INTEGER,
  space_id TEXT NOT NULL REFERENCES spaces(id), kind TEXT NOT NULL REFERENCES operation_kinds(name),
  state TEXT NOT NULL CHECK(state IN ('claimed','committed','failed')),
  request_digest TEXT NOT NULL, epoch INTEGER NOT NULL CHECK(epoch>0),
  permit_id TEXT NOT NULL REFERENCES permits(permit_id), permit_expires_at INTEGER NOT NULL CHECK(permit_expires_at>=0),
  claimed_expires_at INTEGER NOT NULL CHECK(claimed_expires_at=permit_expires_at),
  expected_steps INTEGER NOT NULL CHECK(expected_steps BETWEEN 0 AND 1000),
  result_json TEXT CHECK(result_json IS NULL OR (json_valid(result_json) AND length(CAST(result_json AS BLOB))<=8192)), error_code TEXT,
  created_at INTEGER NOT NULL CHECK(created_at>=0), updated_at INTEGER NOT NULL CHECK(updated_at>=created_at),
  CHECK((principal_kind='system' AND credential_id IS NULL AND kind IN ('system.gc','system.repair','system.backup')) OR
        (principal_kind<>'system' AND credential_id IS NOT NULL AND kind NOT IN ('system.gc','system.repair','system.backup')))
) STRICT;
CREATE TABLE operation_steps(
  op_id TEXT NOT NULL REFERENCES operations(op_id), step_no INTEGER NOT NULL CHECK(step_no BETWEEN 1 AND 1000),
  kind TEXT NOT NULL, affected_id TEXT, PRIMARY KEY(op_id,step_no)
) STRICT;
CREATE TABLE outbox(
  outbox_id TEXT NOT NULL PRIMARY KEY, op_id TEXT NOT NULL REFERENCES operations(op_id),
  kind TEXT NOT NULL, payload_ref TEXT NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('pending','dispatching','sent','completed','failed')),
  dispatch_token TEXT, dispatch_expires_at INTEGER, epoch INTEGER NOT NULL CHECK(epoch>0),
  created_at INTEGER NOT NULL CHECK(created_at>=0), updated_at INTEGER NOT NULL CHECK(updated_at>=created_at)
) STRICT;
CREATE TABLE activity(
  id TEXT NOT NULL PRIMARY KEY, op_id TEXT NOT NULL REFERENCES operations(op_id), actor_id TEXT REFERENCES users(id),
  kind TEXT NOT NULL REFERENCES operation_kinds(name), affected_id TEXT,
  created_at INTEGER NOT NULL CHECK(created_at>=0)
) STRICT;
CREATE TABLE locks(
  id TEXT NOT NULL PRIMARY KEY, node_id TEXT NOT NULL REFERENCES nodes(id), space_id TEXT NOT NULL REFERENCES spaces(id),
  creator_credential_id TEXT NOT NULL REFERENCES credentials(id), token_hash TEXT NOT NULL UNIQUE,
  depth TEXT NOT NULL CHECK(depth IN ('0','infinity')), owner_text TEXT NOT NULL CHECK(length(CAST(owner_text AS BLOB))<=8192),
  epoch INTEGER NOT NULL CHECK(epoch>0), expires_at INTEGER NOT NULL CHECK(expires_at>=0)
) STRICT;
CREATE TABLE reservations(
  id TEXT NOT NULL PRIMARY KEY, owner_id TEXT NOT NULL REFERENCES users(id), share_id TEXT REFERENCES shares(id),
  bytes INTEGER NOT NULL CHECK(bytes BETWEEN 0 AND 536870912000),
  state TEXT NOT NULL CHECK(state IN ('reserved','consumed','released')),
  expires_at INTEGER NOT NULL CHECK(expires_at>=0), epoch INTEGER NOT NULL CHECK(epoch>0),
  op_id TEXT REFERENCES operations(op_id)
) STRICT;
CREATE TABLE uploads(
  id TEXT NOT NULL PRIMARY KEY, owner_id TEXT NOT NULL REFERENCES users(id), space_id TEXT NOT NULL REFERENCES spaces(id),
  parent_id TEXT NOT NULL REFERENCES nodes(id), target_id TEXT REFERENCES nodes(id), blob_id TEXT NOT NULL UNIQUE REFERENCES blobs(id),
  credential_id TEXT NOT NULL REFERENCES credentials(id), reservation_id TEXT NOT NULL UNIQUE REFERENCES reservations(id),
  mode TEXT NOT NULL CHECK(mode IN ('single','multipart')),
  state TEXT NOT NULL CHECK(state IN ('created','receiving','uploading','completing','completed','aborting','failed','expired','aborted')),
  declared_size INTEGER NOT NULL CHECK(declared_size BETWEEN 0 AND 536870912000),
  r2_upload_id TEXT, capability_hash TEXT NOT NULL, epoch INTEGER NOT NULL CHECK(epoch>0),
  accept_parts INTEGER NOT NULL DEFAULT 1 CHECK(accept_parts IN (0,1)),
  in_flight INTEGER NOT NULL DEFAULT 0 CHECK(in_flight BETWEEN 0 AND 4),
  data_calls INTEGER NOT NULL DEFAULT 0 CHECK(data_calls BETWEEN 0 AND 30000),
  data_bytes INTEGER NOT NULL DEFAULT 0 CHECK(data_bytes>=0 AND data_bytes<=declared_size*3),
  control_calls INTEGER NOT NULL DEFAULT 0 CHECK(control_calls>=0), cleanup_calls INTEGER NOT NULL DEFAULT 0 CHECK(cleanup_calls>=0),
  cleanup_pending INTEGER NOT NULL DEFAULT 0 CHECK(cleanup_pending IN (0,1)),
  created_at INTEGER NOT NULL CHECK(created_at>=0), expires_at INTEGER NOT NULL CHECK(expires_at>created_at),
  last_progress_at INTEGER NOT NULL CHECK(last_progress_at>=created_at), error_code TEXT,
  CHECK((mode='single' AND state NOT IN ('uploading','aborting') AND declared_size<=95000000) OR
        (mode='multipart' AND state<>'receiving' AND declared_size>0))
) STRICT;
CREATE TABLE upload_parts(
  upload_id TEXT NOT NULL REFERENCES uploads(id), part_number INTEGER NOT NULL CHECK(part_number BETWEEN 1 AND 10000),
  attempts INTEGER NOT NULL DEFAULT 0 CHECK(attempts BETWEEN 0 AND 3), attempt_id TEXT,
  state TEXT NOT NULL CHECK(state IN ('pending','in_flight','completed','unknown')),
  expected_size INTEGER NOT NULL CHECK(expected_size BETWEEN 1 AND 94371840),
  lease_expires_at INTEGER, etag TEXT, sha256 TEXT, PRIMARY KEY(upload_id,part_number)
) STRICT;
CREATE TABLE bulk_jobs(
  id TEXT NOT NULL PRIMARY KEY, owner_id TEXT NOT NULL REFERENCES users(id), credential_id TEXT REFERENCES credentials(id),
  op_id TEXT NOT NULL REFERENCES operations(op_id), kind TEXT NOT NULL REFERENCES operation_kinds(name),
  state TEXT NOT NULL CHECK(state IN ('pending','running','completed','failed','cancelled')),
  epoch INTEGER NOT NULL CHECK(epoch>0), manifest_ref TEXT, grant_snapshot TEXT NOT NULL CHECK(json_valid(grant_snapshot)),
  checkpoint TEXT, node_count INTEGER NOT NULL DEFAULT 0 CHECK(node_count BETWEEN 0 AND 10000),
  blob_count INTEGER NOT NULL DEFAULT 0 CHECK(blob_count BETWEEN 0 AND 10000),
  r2_calls INTEGER NOT NULL DEFAULT 0 CHECK(r2_calls BETWEEN 0 AND 20000),
  invocation_count INTEGER NOT NULL DEFAULT 0 CHECK(invocation_count BETWEEN 0 AND 200),
  error_code TEXT, created_at INTEGER NOT NULL CHECK(created_at>=0), updated_at INTEGER NOT NULL CHECK(updated_at>=created_at)
) STRICT;
CREATE TABLE job_leases(
  job_id TEXT NOT NULL PRIMARY KEY REFERENCES bulk_jobs(id), claim_token TEXT NOT NULL UNIQUE,
  epoch INTEGER NOT NULL CHECK(epoch>0), expires_at INTEGER NOT NULL CHECK(expires_at>=0),
  attempt INTEGER NOT NULL CHECK(attempt BETWEEN 1 AND 10)
) STRICT;
CREATE TABLE backup_runs(
  id TEXT NOT NULL PRIMARY KEY, epoch INTEGER NOT NULL CHECK(epoch>0), watermark TEXT,
  state TEXT NOT NULL CHECK(state IN ('pending','exporting','completed','failed')),
  manifest_key TEXT, manifest_sha256 TEXT, created_at INTEGER NOT NULL CHECK(created_at>=0), completed_at INTEGER
) STRICT;
