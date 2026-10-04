-- Explicit, read-only administrator access to another user's files.
-- Audit rows deliberately retain identifiers after a user or node is removed.
CREATE TABLE admin_browse_audit(
  id TEXT NOT NULL PRIMARY KEY,
  actor_id TEXT NOT NULL,
  owner_id TEXT NOT NULL,
  node_id TEXT,
  action TEXT NOT NULL CHECK(action IN ('metadata','preview','download')),
  occurred_at INTEGER NOT NULL CHECK(occurred_at>=0)
) STRICT;
CREATE INDEX admin_browse_audit_latest ON admin_browse_audit(occurred_at DESC,id DESC);
CREATE INDEX admin_browse_audit_owner ON admin_browse_audit(owner_id,occurred_at DESC);

-- Ticket-specific authority; an ordinary user ticket can never become an admin grant.
CREATE TABLE admin_content_grants(
  ticket_id TEXT NOT NULL PRIMARY KEY REFERENCES tickets(id) ON DELETE CASCADE,
  actor_id TEXT NOT NULL,
  owner_id TEXT NOT NULL,
  node_id TEXT NOT NULL,
  action TEXT NOT NULL CHECK(action IN ('preview','download'))
) STRICT;
CREATE INDEX admin_content_grants_actor ON admin_content_grants(actor_id);
CREATE INDEX admin_content_grants_owner ON admin_content_grants(owner_id);
CREATE INDEX admin_content_grants_node ON admin_content_grants(node_id);

INSERT INTO operation_kinds(name) VALUES
  ('admin.users.read'),('admin.files.read'),('admin.content.issue'),('admin.audit.read');
INSERT INTO scopes(name) VALUES('admin:content');

CREATE TRIGGER backup_freeze_admin_browse_audit_insert BEFORE INSERT ON admin_browse_audit
WHEN (SELECT backup_frozen FROM control WHERE singleton=1)=1
BEGIN SELECT RAISE(ABORT,'backup_frozen'); END;
CREATE TRIGGER backup_freeze_admin_browse_audit_update BEFORE UPDATE ON admin_browse_audit
WHEN (SELECT backup_frozen FROM control WHERE singleton=1)=1
BEGIN SELECT RAISE(ABORT,'backup_frozen'); END;
CREATE TRIGGER backup_freeze_admin_browse_audit_delete BEFORE DELETE ON admin_browse_audit
WHEN (SELECT backup_frozen FROM control WHERE singleton=1)=1
BEGIN SELECT RAISE(ABORT,'backup_frozen'); END;
CREATE TRIGGER backup_freeze_admin_content_grants_insert BEFORE INSERT ON admin_content_grants
WHEN (SELECT backup_frozen FROM control WHERE singleton=1)=1
BEGIN SELECT RAISE(ABORT,'backup_frozen'); END;
CREATE TRIGGER backup_freeze_admin_content_grants_update BEFORE UPDATE ON admin_content_grants
WHEN (SELECT backup_frozen FROM control WHERE singleton=1)=1
BEGIN SELECT RAISE(ABORT,'backup_frozen'); END;
CREATE TRIGGER backup_freeze_admin_content_grants_delete BEFORE DELETE ON admin_content_grants
WHEN (SELECT backup_frozen FROM control WHERE singleton=1)=1
BEGIN SELECT RAISE(ABORT,'backup_frozen'); END;
