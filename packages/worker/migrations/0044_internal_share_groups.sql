CREATE TABLE share_groups(
  id TEXT NOT NULL PRIMARY KEY
    CHECK(length(id) BETWEEN 1 AND 128 AND instr(id,'/')=0),
  owner_id TEXT NOT NULL REFERENCES users(id),
  name TEXT NOT NULL CHECK(length(CAST(name AS BLOB)) BETWEEN 1 AND 255),
  name_ci TEXT NOT NULL CHECK(length(CAST(name_ci AS BLOB)) BETWEEN 1 AND 1024),
  version INTEGER NOT NULL DEFAULT 1 CHECK(version BETWEEN 1 AND 9007199254740991),
  disabled_at INTEGER,
  created_at INTEGER NOT NULL CHECK(created_at>=0),
  updated_at INTEGER NOT NULL CHECK(updated_at>=created_at)
) STRICT;

CREATE UNIQUE INDEX share_groups_owner_name_active
ON share_groups(owner_id,name_ci)
WHERE disabled_at IS NULL;

CREATE INDEX share_groups_owner_active
ON share_groups(owner_id,disabled_at,name_ci,id);

CREATE TRIGGER share_groups_limit BEFORE INSERT ON share_groups
WHEN NEW.disabled_at IS NULL AND (
  SELECT COUNT(*) FROM share_groups
  WHERE owner_id=NEW.owner_id AND disabled_at IS NULL
)>=100
BEGIN SELECT RAISE(ABORT,'share_group_limit'); END;

CREATE TABLE share_group_members(
  group_id TEXT NOT NULL REFERENCES share_groups(id),
  user_id TEXT NOT NULL REFERENCES users(id),
  version INTEGER NOT NULL DEFAULT 1 CHECK(version BETWEEN 1 AND 9007199254740991),
  added_at INTEGER NOT NULL CHECK(added_at>=0),
  disabled_at INTEGER,
  PRIMARY KEY(group_id,user_id)
) STRICT;

CREATE INDEX share_group_members_user_active
ON share_group_members(user_id,disabled_at,group_id,version);

CREATE TRIGGER share_group_members_limit_insert BEFORE INSERT ON share_group_members
WHEN NEW.disabled_at IS NULL AND (
  SELECT COUNT(*) FROM share_group_members
  WHERE group_id=NEW.group_id AND disabled_at IS NULL
)>=100
BEGIN SELECT RAISE(ABORT,'share_group_member_limit'); END;

CREATE TABLE share_group_grants(
  share_id TEXT NOT NULL PRIMARY KEY REFERENCES shares(id),
  group_id TEXT NOT NULL REFERENCES share_groups(id),
  created_at INTEGER NOT NULL CHECK(created_at>=0)
) STRICT;

CREATE INDEX share_group_grants_group
ON share_group_grants(group_id,share_id);

CREATE TRIGGER share_groups_identity BEFORE UPDATE OF id,owner_id,created_at ON share_groups
WHEN NEW.id<>OLD.id OR NEW.owner_id<>OLD.owner_id OR NEW.created_at<>OLD.created_at
BEGIN SELECT RAISE(ABORT,'immutable_share_group_identity'); END;

CREATE TRIGGER share_groups_no_reenable BEFORE UPDATE OF disabled_at ON share_groups
WHEN OLD.disabled_at IS NOT NULL AND NEW.disabled_at IS NULL
BEGIN SELECT RAISE(ABORT,'disabled_share_group'); END;

CREATE TRIGGER share_groups_disable_active BEFORE UPDATE OF disabled_at ON share_groups
WHEN OLD.disabled_at IS NULL AND NEW.disabled_at IS NOT NULL AND (
  EXISTS(SELECT 1 FROM share_group_members
    WHERE group_id=OLD.id AND disabled_at IS NULL)
  OR EXISTS(
    SELECT 1 FROM share_group_grants gg JOIN shares sh ON sh.id=gg.share_id
    WHERE gg.group_id=OLD.id AND sh.disabled_at IS NULL
  )
)
BEGIN SELECT RAISE(ABORT,'active_share_group'); END;

CREATE TRIGGER share_group_members_insert BEFORE INSERT ON share_group_members
WHEN NOT EXISTS(
  SELECT 1 FROM share_groups g JOIN users u ON u.id=NEW.user_id
  WHERE g.id=NEW.group_id AND g.disabled_at IS NULL AND u.disabled_at IS NULL
    AND u.id<>g.owner_id
)
BEGIN SELECT RAISE(ABORT,'invalid_share_group_member'); END;

CREATE TRIGGER share_group_members_identity BEFORE UPDATE OF group_id,user_id ON share_group_members
WHEN NEW.group_id<>OLD.group_id OR NEW.user_id<>OLD.user_id
BEGIN SELECT RAISE(ABORT,'immutable_share_group_member_identity'); END;

CREATE TRIGGER share_group_members_reenable BEFORE UPDATE OF disabled_at,version,added_at ON share_group_members
WHEN OLD.disabled_at IS NOT NULL AND NEW.disabled_at IS NULL
  AND (
    NEW.version<>OLD.version+1 OR NEW.added_at<OLD.added_at
    OR NOT EXISTS(
      SELECT 1 FROM share_groups g JOIN users u ON u.id=NEW.user_id
      WHERE g.id=NEW.group_id AND g.disabled_at IS NULL
        AND u.disabled_at IS NULL AND u.id<>g.owner_id
    )
    OR (
      SELECT COUNT(*) FROM share_group_members
      WHERE group_id=NEW.group_id AND disabled_at IS NULL
    )>=100
  )
BEGIN SELECT RAISE(ABORT,'stale_share_group_member'); END;

CREATE TRIGGER share_group_members_deactivate BEFORE UPDATE OF disabled_at,version,added_at
ON share_group_members
WHEN OLD.disabled_at IS NULL AND NEW.disabled_at IS NOT NULL
  AND (NEW.version<>OLD.version OR NEW.added_at<>OLD.added_at)
BEGIN SELECT RAISE(ABORT,'invalid_share_group_member_state'); END;

CREATE TRIGGER share_group_members_stable BEFORE UPDATE OF disabled_at,version,added_at
ON share_group_members
WHEN (
  OLD.disabled_at IS NULL AND NEW.disabled_at IS NULL
  AND (NEW.version<>OLD.version OR NEW.added_at<>OLD.added_at)
) OR (
  OLD.disabled_at IS NOT NULL AND NEW.disabled_at IS NOT NULL
  AND (
    NEW.disabled_at<>OLD.disabled_at
    OR NEW.version<>OLD.version
    OR NEW.added_at<>OLD.added_at
  )
)
BEGIN SELECT RAISE(ABORT,'invalid_share_group_member_state'); END;

CREATE TRIGGER share_group_grants_insert BEFORE INSERT ON share_group_grants
WHEN NOT EXISTS(
  SELECT 1 FROM shares sh JOIN share_groups g ON g.id=NEW.group_id
  WHERE sh.id=NEW.share_id AND sh.kind='internal' AND sh.owner_id=g.owner_id
    AND sh.disabled_at IS NULL AND g.disabled_at IS NULL
) OR EXISTS(SELECT 1 FROM share_grants WHERE share_id=NEW.share_id)
BEGIN SELECT RAISE(ABORT,'invalid_share_group_grant'); END;

CREATE TRIGGER share_group_grants_immutable BEFORE UPDATE ON share_group_grants
BEGIN SELECT RAISE(ABORT,'immutable_share_group_grant'); END;

CREATE TRIGGER share_grants_no_group_recipient BEFORE INSERT ON share_grants
WHEN EXISTS(SELECT 1 FROM share_group_grants WHERE share_id=NEW.share_id)
BEGIN SELECT RAISE(ABORT,'invalid_share_grant'); END;

CREATE TRIGGER backup_freeze_share_groups_insert BEFORE INSERT ON share_groups
WHEN (SELECT backup_frozen FROM control WHERE singleton=1)=1
BEGIN SELECT RAISE(ABORT,'backup_frozen'); END;
CREATE TRIGGER backup_freeze_share_groups_update BEFORE UPDATE ON share_groups
WHEN (SELECT backup_frozen FROM control WHERE singleton=1)=1
BEGIN SELECT RAISE(ABORT,'backup_frozen'); END;
CREATE TRIGGER backup_freeze_share_groups_delete BEFORE DELETE ON share_groups
WHEN (SELECT backup_frozen FROM control WHERE singleton=1)=1
BEGIN SELECT RAISE(ABORT,'backup_frozen'); END;
CREATE TRIGGER backup_freeze_share_group_members_insert BEFORE INSERT ON share_group_members
WHEN (SELECT backup_frozen FROM control WHERE singleton=1)=1
BEGIN SELECT RAISE(ABORT,'backup_frozen'); END;
CREATE TRIGGER backup_freeze_share_group_members_update BEFORE UPDATE ON share_group_members
WHEN (SELECT backup_frozen FROM control WHERE singleton=1)=1
BEGIN SELECT RAISE(ABORT,'backup_frozen'); END;
CREATE TRIGGER backup_freeze_share_group_members_delete BEFORE DELETE ON share_group_members
WHEN (SELECT backup_frozen FROM control WHERE singleton=1)=1
BEGIN SELECT RAISE(ABORT,'backup_frozen'); END;
CREATE TRIGGER backup_freeze_share_group_grants_insert BEFORE INSERT ON share_group_grants
WHEN (SELECT backup_frozen FROM control WHERE singleton=1)=1
BEGIN SELECT RAISE(ABORT,'backup_frozen'); END;
CREATE TRIGGER backup_freeze_share_group_grants_update BEFORE UPDATE ON share_group_grants
WHEN (SELECT backup_frozen FROM control WHERE singleton=1)=1
BEGIN SELECT RAISE(ABORT,'backup_frozen'); END;
CREATE TRIGGER backup_freeze_share_group_grants_delete BEFORE DELETE ON share_group_grants
WHEN (SELECT backup_frozen FROM control WHERE singleton=1)=1
BEGIN SELECT RAISE(ABORT,'backup_frozen'); END;
