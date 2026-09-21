-- Minimal Phase 0 probe schema, not a production migration.
CREATE TABLE _assert(v INTEGER NOT NULL CHECK(v=0)) STRICT;
CREATE TABLE control(singleton INTEGER NOT NULL PRIMARY KEY CHECK(singleton=1), epoch INTEGER NOT NULL CHECK(epoch>0)) STRICT;
CREATE TABLE users(id TEXT NOT NULL PRIMARY KEY, used_bytes INTEGER NOT NULL CHECK(used_bytes>=0), reserved_bytes INTEGER NOT NULL CHECK(reserved_bytes>=0), disabled_at INTEGER) STRICT;
CREATE TABLE sessions(id TEXT NOT NULL PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id), expires_at INTEGER NOT NULL, revoked_at INTEGER) STRICT;
CREATE TABLE spaces(id TEXT NOT NULL PRIMARY KEY, owner_id TEXT NOT NULL REFERENCES users(id), tree_generation INTEGER NOT NULL CHECK(tree_generation>=1)) STRICT;
CREATE TABLE blobs(id TEXT NOT NULL PRIMARY KEY, ref_count INTEGER NOT NULL CHECK(ref_count>=0), state TEXT NOT NULL CHECK(state IN ('committed','deleting'))) STRICT;
CREATE TABLE nodes(id TEXT NOT NULL PRIMARY KEY, space_id TEXT NOT NULL REFERENCES spaces(id), revision INTEGER NOT NULL CHECK(revision>=1), deleted_at INTEGER, last_op_id TEXT) STRICT;
CREATE TABLE permits(permit_id TEXT NOT NULL PRIMARY KEY, space_id TEXT NOT NULL REFERENCES spaces(id), epoch INTEGER NOT NULL, expires_at INTEGER NOT NULL, state TEXT NOT NULL CHECK(state IN ('open','released','revoked'))) STRICT;
CREATE TABLE operations(op_id TEXT NOT NULL PRIMARY KEY, permit_id TEXT NOT NULL REFERENCES permits(permit_id), credential_id TEXT NOT NULL REFERENCES sessions(id), state TEXT NOT NULL CHECK(state IN ('claimed','committed','failed')), expected_steps INTEGER NOT NULL, result_json TEXT, error_code TEXT) STRICT;
CREATE TABLE operation_steps(op_id TEXT NOT NULL REFERENCES operations(op_id), step_no INTEGER NOT NULL, PRIMARY KEY(op_id,step_no)) STRICT;
CREATE TABLE audit(id TEXT NOT NULL PRIMARY KEY, op_id TEXT NOT NULL REFERENCES operations(op_id)) STRICT;
CREATE TABLE outbox(id TEXT NOT NULL PRIMARY KEY, op_id TEXT NOT NULL REFERENCES operations(op_id), state TEXT NOT NULL CHECK(state='pending')) STRICT;
CREATE TABLE trash_ops(op_id TEXT NOT NULL PRIMARY KEY, state TEXT NOT NULL CHECK(state IN ('pending','trashed'))) STRICT;
