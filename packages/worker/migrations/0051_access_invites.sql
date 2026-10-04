-- An administrator authorizes an exact Access email before the first login.
-- Consumed and revoked rows remain as an audit trail; only one pending row per email.
CREATE TABLE access_invites(
  id TEXT NOT NULL PRIMARY KEY,
  access_iss TEXT NOT NULL,
  email TEXT NOT NULL CHECK(length(email) BETWEEN 3 AND 320),
  approved_by TEXT NOT NULL REFERENCES users(id),
  created_at INTEGER NOT NULL CHECK(created_at>=0),
  expires_at INTEGER NOT NULL CHECK(expires_at>created_at),
  revoked_at INTEGER,
  claimed_at INTEGER,
  claimed_user_id TEXT REFERENCES users(id),
  CHECK((claimed_at IS NULL)=(claimed_user_id IS NULL)),
  CHECK(revoked_at IS NULL OR claimed_at IS NULL)
) STRICT;
CREATE UNIQUE INDEX access_invites_pending_email ON access_invites(lower(email))
  WHERE revoked_at IS NULL AND claimed_at IS NULL;
CREATE INDEX access_invites_admin_created ON access_invites(approved_by,created_at DESC);
CREATE INDEX access_invites_claimed_user ON access_invites(claimed_user_id);
INSERT INTO operation_kinds(name) VALUES('admin.user.invite');
CREATE TRIGGER backup_freeze_access_invites_insert BEFORE INSERT ON access_invites
WHEN (SELECT backup_frozen FROM control WHERE singleton=1)=1
BEGIN SELECT RAISE(ABORT,'backup_frozen'); END;
CREATE TRIGGER backup_freeze_access_invites_update BEFORE UPDATE ON access_invites
WHEN (SELECT backup_frozen FROM control WHERE singleton=1)=1
BEGIN SELECT RAISE(ABORT,'backup_frozen'); END;
CREATE TRIGGER backup_freeze_access_invites_delete BEFORE DELETE ON access_invites
WHEN (SELECT backup_frozen FROM control WHERE singleton=1)=1
BEGIN SELECT RAISE(ABORT,'backup_frozen'); END;
