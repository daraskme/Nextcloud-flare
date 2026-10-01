CREATE TABLE share_reshare_policies(
  share_id TEXT NOT NULL PRIMARY KEY REFERENCES shares(id),
  version INTEGER NOT NULL DEFAULT 1 CHECK(version BETWEEN 1 AND 9007199254740991),
  enabled INTEGER NOT NULL CHECK(enabled IN (0,1)),
  max_depth INTEGER NOT NULL CHECK(max_depth BETWEEN 1 AND 4),
  max_fanout INTEGER NOT NULL CHECK(max_fanout BETWEEN 1 AND 20),
  expires_at INTEGER,
  created_at INTEGER NOT NULL CHECK(created_at>=0),
  updated_at INTEGER NOT NULL CHECK(updated_at>=created_at)
) STRICT;

CREATE TABLE share_reshare_policy_actions(
  share_id TEXT NOT NULL REFERENCES share_reshare_policies(share_id),
  action TEXT NOT NULL CHECK(action IN ('read','download')),
  PRIMARY KEY(share_id,action)
) STRICT;

CREATE TABLE share_delegations(
  share_id TEXT NOT NULL PRIMARY KEY REFERENCES shares(id),
  source_share_id TEXT NOT NULL REFERENCES shares(id),
  source_share_version INTEGER NOT NULL CHECK(source_share_version BETWEEN 1 AND 9007199254740991),
  policy_share_id TEXT NOT NULL REFERENCES share_reshare_policies(share_id),
  policy_version INTEGER NOT NULL CHECK(policy_version BETWEEN 1 AND 9007199254740991),
  delegated_by_user_id TEXT NOT NULL REFERENCES users(id),
  source_group_id TEXT REFERENCES share_groups(id),
  source_membership_version INTEGER
    CHECK(source_membership_version IS NULL OR source_membership_version BETWEEN 1 AND 9007199254740991),
  depth INTEGER NOT NULL CHECK(depth BETWEEN 1 AND 4),
  source_root_parent_id TEXT REFERENCES nodes(id),
  delegated_root_parent_id TEXT REFERENCES nodes(id),
  created_at INTEGER NOT NULL CHECK(created_at>=0),
  CHECK(
    (source_group_id IS NULL AND source_membership_version IS NULL)
    OR (source_group_id IS NOT NULL AND source_membership_version IS NOT NULL)
  )
) STRICT;

CREATE INDEX share_delegations_source ON share_delegations(source_share_id,share_id);
CREATE INDEX share_delegations_policy ON share_delegations(policy_share_id,policy_version,share_id);
CREATE INDEX share_delegations_actor
  ON share_delegations(delegated_by_user_id,source_share_id,share_id);
CREATE INDEX share_delegations_group
  ON share_delegations(source_group_id,source_membership_version,share_id);
CREATE INDEX share_delegations_source_root_parent ON share_delegations(source_root_parent_id,share_id);
CREATE INDEX share_delegations_root_parent ON share_delegations(delegated_root_parent_id,share_id);

CREATE TABLE share_delegation_ancestry(
  share_id TEXT NOT NULL REFERENCES share_delegations(share_id),
  node_id TEXT NOT NULL REFERENCES nodes(id),
  parent_id TEXT REFERENCES nodes(id),
  depth INTEGER NOT NULL CHECK(depth BETWEEN 0 AND 64),
  PRIMARY KEY(share_id,depth),
  UNIQUE(share_id,node_id)
) STRICT;

CREATE INDEX share_delegation_ancestry_node
  ON share_delegation_ancestry(node_id,share_id,depth);
CREATE INDEX share_delegation_ancestry_parent
  ON share_delegation_ancestry(parent_id,share_id,depth);

CREATE TABLE share_delegation_status(
  share_id TEXT NOT NULL PRIMARY KEY REFERENCES share_delegations(share_id),
  valid INTEGER NOT NULL DEFAULT 1 CHECK(valid IN (0,1))
) STRICT;

CREATE TABLE share_reshare_requests(
  id TEXT NOT NULL PRIMARY KEY CHECK(length(id) BETWEEN 1 AND 128),
  credential_id TEXT NOT NULL REFERENCES credentials(id),
  request_digest TEXT NOT NULL CHECK(length(request_digest)=64),
  source_share_id TEXT NOT NULL REFERENCES shares(id),
  share_id TEXT NOT NULL UNIQUE REFERENCES shares(id),
  epoch INTEGER NOT NULL CHECK(epoch>0),
  created_at INTEGER NOT NULL CHECK(created_at>=0)
) STRICT;

CREATE INDEX share_reshare_requests_credential ON share_reshare_requests(credential_id,id);
CREATE INDEX share_reshare_requests_source ON share_reshare_requests(source_share_id,id);

CREATE TRIGGER share_reshare_policies_insert BEFORE INSERT ON share_reshare_policies
WHEN NOT EXISTS(
  SELECT 1 FROM shares sh
  WHERE sh.id=NEW.share_id AND sh.kind='internal' AND sh.disabled_at IS NULL
    AND NOT EXISTS(SELECT 1 FROM share_delegations d WHERE d.share_id=sh.id)
)
BEGIN SELECT RAISE(ABORT,'invalid_share_reshare_policy'); END;

CREATE TRIGGER share_reshare_policies_identity
BEFORE UPDATE OF share_id,created_at ON share_reshare_policies
WHEN NEW.share_id<>OLD.share_id OR NEW.created_at<>OLD.created_at
BEGIN SELECT RAISE(ABORT,'immutable_share_reshare_policy'); END;

CREATE TRIGGER share_reshare_policies_version BEFORE UPDATE ON share_reshare_policies
WHEN NEW.version<>OLD.version+1 OR NEW.updated_at<OLD.updated_at
BEGIN SELECT RAISE(ABORT,'stale_share_reshare_policy'); END;

CREATE TRIGGER share_reshare_policy_actions_insert
BEFORE INSERT ON share_reshare_policy_actions
WHEN NOT EXISTS(
  SELECT 1 FROM share_actions sa
  WHERE sa.share_id=NEW.share_id AND sa.action=NEW.action
)
BEGIN SELECT RAISE(ABORT,'invalid_share_reshare_action'); END;

CREATE TRIGGER share_delegations_insert BEFORE INSERT ON share_delegations
WHEN NEW.share_id=NEW.source_share_id
  OR NOT EXISTS(
    SELECT 1
    FROM shares child
    JOIN shares source ON source.id=NEW.source_share_id
    JOIN share_reshare_policies policy ON policy.share_id=NEW.policy_share_id
    JOIN nodes source_root ON source_root.id=source.root_node_id
    JOIN nodes child_root ON child_root.id=child.root_node_id
    WHERE child.id=NEW.share_id AND child.kind='internal' AND child.disabled_at IS NULL
      AND source.kind='internal' AND source.disabled_at IS NULL
      AND child.owner_id=source.owner_id
      AND source.version=NEW.source_share_version
      AND source_root.parent_id IS NEW.source_root_parent_id
      AND child_root.parent_id IS NEW.delegated_root_parent_id
      AND policy.enabled=1 AND policy.version=NEW.policy_version
      AND (policy.expires_at IS NULL OR policy.expires_at>strftime('%s','now')*1000)
      AND NEW.depth<=policy.max_depth
      AND (
        (NEW.depth=1 AND NEW.policy_share_id=source.id)
        OR EXISTS(
          SELECT 1 FROM share_delegations parent
          WHERE parent.share_id=source.id AND parent.depth+1=NEW.depth
            AND parent.policy_share_id=NEW.policy_share_id
            AND parent.policy_version=NEW.policy_version
        )
      )
      AND (
        (NEW.source_group_id IS NULL AND EXISTS(
          SELECT 1 FROM share_grants grant_row
          WHERE grant_row.share_id=source.id
            AND grant_row.user_id=NEW.delegated_by_user_id
            AND grant_row.disabled_at IS NULL AND grant_row.version=source.version
        ))
        OR
        (NEW.source_group_id IS NOT NULL AND EXISTS(
          SELECT 1
          FROM share_group_grants group_grant
          JOIN share_groups share_group ON share_group.id=group_grant.group_id
            AND share_group.owner_id=source.owner_id AND share_group.disabled_at IS NULL
          JOIN share_group_members member ON member.group_id=share_group.id
            AND member.user_id=NEW.delegated_by_user_id AND member.disabled_at IS NULL
          JOIN users delegated_user ON delegated_user.id=member.user_id
            AND delegated_user.disabled_at IS NULL
          WHERE group_grant.share_id=source.id
            AND share_group.id=NEW.source_group_id
            AND member.version=NEW.source_membership_version
        ))
      )
      AND NOT EXISTS(
        SELECT 1 FROM share_actions child_action
        WHERE child_action.share_id=child.id AND (
          NOT EXISTS(
            SELECT 1 FROM share_actions source_action
            WHERE source_action.share_id=source.id AND source_action.action=child_action.action
          )
          OR NOT EXISTS(
            SELECT 1 FROM share_reshare_policy_actions policy_action
            WHERE policy_action.share_id=policy.share_id
              AND policy_action.action=child_action.action
          )
        )
      )
      AND (source.expires_at IS NULL OR child.expires_at<=source.expires_at)
      AND (policy.expires_at IS NULL OR child.expires_at<=policy.expires_at)
      AND (
        SELECT COUNT(*) FROM share_delegations sibling
        JOIN share_delegation_status sibling_status
          ON sibling_status.share_id=sibling.share_id AND sibling_status.valid=1
        JOIN shares sibling_share ON sibling_share.id=sibling.share_id
        WHERE sibling.source_share_id=source.id
          AND sibling_share.disabled_at IS NULL
          AND (sibling_share.expires_at IS NULL
            OR sibling_share.expires_at>strftime('%s','now')*1000)
      )<policy.max_fanout
      AND NOT EXISTS(
        WITH RECURSIVE ancestors(id,path) AS (
          SELECT NEW.source_share_id,'/'||NEW.source_share_id||'/'
          UNION ALL
          SELECT parent.source_share_id,ancestors.path||parent.source_share_id||'/'
          FROM ancestors
          JOIN share_delegations parent ON parent.share_id=ancestors.id
          WHERE instr(ancestors.path,'/'||parent.source_share_id||'/')=0
        )
        SELECT 1 FROM ancestors WHERE id=NEW.share_id
      )
  )
BEGIN SELECT RAISE(ABORT,'invalid_share_delegation'); END;

CREATE TRIGGER share_delegations_immutable BEFORE UPDATE ON share_delegations
BEGIN SELECT RAISE(ABORT,'immutable_share_delegation'); END;

CREATE TRIGGER share_delegation_ancestry_immutable BEFORE UPDATE ON share_delegation_ancestry
BEGIN SELECT RAISE(ABORT,'immutable_share_delegation_ancestry'); END;

CREATE TRIGGER share_delegation_status_insert BEFORE INSERT ON share_delegation_status
WHEN NEW.valid<>1 OR NOT EXISTS(
  SELECT 1
  FROM share_delegations delegation
  JOIN shares child ON child.id=delegation.share_id
  JOIN shares source ON source.id=delegation.source_share_id
  WHERE delegation.share_id=NEW.share_id
    AND EXISTS(
      SELECT 1 FROM share_delegation_ancestry ancestry
      WHERE ancestry.share_id=delegation.share_id AND ancestry.depth=0
        AND ancestry.node_id=child.root_node_id
    )
    AND EXISTS(
      SELECT 1 FROM share_delegation_ancestry ancestry
      WHERE ancestry.share_id=delegation.share_id AND ancestry.node_id=source.root_node_id
    )
    AND NOT EXISTS(
      SELECT 1 FROM share_delegation_ancestry ancestry
      JOIN nodes node ON node.id=ancestry.node_id
      WHERE ancestry.share_id=delegation.share_id
        AND node.parent_id IS NOT ancestry.parent_id
    )
    AND NOT EXISTS(
      SELECT 1 FROM share_delegation_ancestry ancestry
      WHERE ancestry.share_id=delegation.share_id AND ancestry.depth>0
        AND NOT EXISTS(
          SELECT 1 FROM share_delegation_ancestry previous
          WHERE previous.share_id=ancestry.share_id
            AND previous.depth=ancestry.depth-1
            AND previous.parent_id=ancestry.node_id
        )
    )
    AND (
      SELECT COUNT(*) FROM share_delegation_ancestry ancestry
      WHERE ancestry.share_id=delegation.share_id
    )=(
      SELECT MAX(ancestry.depth)+1 FROM share_delegation_ancestry ancestry
      WHERE ancestry.share_id=delegation.share_id
    )
)
BEGIN SELECT RAISE(ABORT,'invalid_share_delegation_status'); END;

CREATE TRIGGER share_delegation_status_no_reactivate
BEFORE UPDATE OF valid ON share_delegation_status
WHEN OLD.valid=0 AND NEW.valid<>0
BEGIN SELECT RAISE(ABORT,'invalid_share_delegation_reactivation'); END;

CREATE TRIGGER share_delegation_status_invalidate_descendants
AFTER UPDATE OF valid ON share_delegation_status
WHEN OLD.valid=1 AND NEW.valid=0
BEGIN
  UPDATE share_delegation_status SET valid=0
  WHERE valid=1 AND share_id IN (
    WITH RECURSIVE descendants(id,depth) AS (
      SELECT share_id,1 FROM share_delegations WHERE source_share_id=NEW.share_id
      UNION ALL
      SELECT child.share_id,parent.depth+1
      FROM share_delegations child
      JOIN descendants parent ON parent.id=child.source_share_id
      WHERE parent.depth<4
    )
    SELECT id FROM descendants
  );
END;

CREATE TRIGGER share_reshare_requests_immutable BEFORE UPDATE ON share_reshare_requests
BEGIN SELECT RAISE(ABORT,'immutable_share_reshare_request'); END;

CREATE TRIGGER share_delegation_source_changed
AFTER UPDATE OF version,disabled_at,root_node_id,expires_at ON shares
WHEN OLD.version<>NEW.version OR OLD.disabled_at IS NOT NEW.disabled_at
  OR OLD.root_node_id<>NEW.root_node_id OR OLD.expires_at IS NOT NEW.expires_at
BEGIN
  UPDATE share_delegation_status SET valid=0 WHERE share_id IN (
    WITH RECURSIVE descendants(share_id) AS (
      SELECT share_id FROM share_delegations WHERE source_share_id=NEW.id
      UNION ALL
      SELECT child.share_id FROM share_delegations child
      JOIN descendants parent ON parent.share_id=child.source_share_id
    )
    SELECT share_id FROM descendants
  );
END;

CREATE TRIGGER share_delegation_action_removed
AFTER DELETE ON share_actions
BEGIN
  UPDATE share_delegation_status SET valid=0 WHERE share_id IN (
    WITH RECURSIVE descendants(share_id) AS (
      SELECT share_id FROM share_delegations WHERE source_share_id=OLD.share_id
      UNION ALL
      SELECT child.share_id FROM share_delegations child
      JOIN descendants parent ON parent.share_id=child.source_share_id
    )
    SELECT share_id FROM descendants
  );
END;

CREATE TRIGGER share_delegation_policy_changed
AFTER UPDATE ON share_reshare_policies
BEGIN
  UPDATE share_delegation_status SET valid=0 WHERE share_id IN (
    WITH RECURSIVE descendants(share_id) AS (
      SELECT share_id FROM share_delegations WHERE policy_share_id=OLD.share_id
      UNION ALL
      SELECT child.share_id FROM share_delegations child
      JOIN descendants parent ON parent.share_id=child.source_share_id
    )
    SELECT share_id FROM descendants
  );
END;

CREATE TRIGGER share_delegation_policy_action_removed
AFTER DELETE ON share_reshare_policy_actions
BEGIN
  UPDATE share_delegation_status SET valid=0 WHERE share_id IN (
    WITH RECURSIVE descendants(share_id) AS (
      SELECT share_id FROM share_delegations WHERE policy_share_id=OLD.share_id
      UNION ALL
      SELECT child.share_id FROM share_delegations child
      JOIN descendants parent ON parent.share_id=child.source_share_id
    )
    SELECT share_id FROM descendants
  );
END;

CREATE TRIGGER share_delegation_direct_recipient_changed
AFTER UPDATE OF version,disabled_at ON share_grants
WHEN OLD.version<>NEW.version OR OLD.disabled_at IS NOT NEW.disabled_at
BEGIN
  UPDATE share_delegation_status SET valid=0 WHERE share_id IN (
    WITH RECURSIVE descendants(share_id) AS (
      SELECT share_id FROM share_delegations
      WHERE source_share_id=NEW.share_id AND delegated_by_user_id=NEW.user_id
        AND source_group_id IS NULL
      UNION ALL
      SELECT child.share_id FROM share_delegations child
      JOIN descendants parent ON parent.share_id=child.source_share_id
    )
    SELECT share_id FROM descendants
  );
END;

CREATE TRIGGER share_delegation_group_recipient_changed
AFTER UPDATE OF version,disabled_at ON share_group_members
WHEN OLD.version<>NEW.version OR OLD.disabled_at IS NOT NEW.disabled_at
BEGIN
  UPDATE share_delegation_status SET valid=0 WHERE share_id IN (
    WITH RECURSIVE descendants(share_id) AS (
      SELECT share_id FROM share_delegations
      WHERE source_group_id=NEW.group_id AND delegated_by_user_id=NEW.user_id
      UNION ALL
      SELECT child.share_id FROM share_delegations child
      JOIN descendants parent ON parent.share_id=child.source_share_id
    )
    SELECT share_id FROM descendants
  );
END;

CREATE TRIGGER share_delegation_user_changed
AFTER UPDATE OF disabled_at ON users
WHEN OLD.disabled_at IS NOT NEW.disabled_at
BEGIN
  UPDATE share_delegation_status SET valid=0 WHERE share_id IN (
    WITH RECURSIVE descendants(share_id) AS (
      SELECT share_id FROM share_delegations WHERE delegated_by_user_id=NEW.id
      UNION ALL
      SELECT child.share_id FROM share_delegations child
      JOIN descendants parent ON parent.share_id=child.source_share_id
    )
    SELECT share_id FROM descendants
  );
END;

CREATE TRIGGER share_delegation_ancestry_changed
AFTER UPDATE OF parent_id,deleted_at,owner_id ON nodes
WHEN OLD.parent_id IS NOT NEW.parent_id OR OLD.deleted_at IS NOT NEW.deleted_at
  OR OLD.owner_id<>NEW.owner_id
BEGIN
  UPDATE share_delegation_status SET valid=0 WHERE share_id IN (
    WITH RECURSIVE descendants(share_id) AS (
      SELECT share_id FROM share_delegation_ancestry WHERE node_id=NEW.id
      UNION ALL
      SELECT child.share_id FROM share_delegations child
      JOIN descendants parent ON parent.share_id=child.source_share_id
    )
    SELECT share_id FROM descendants
  );
END;

CREATE VIEW current_internal_shares AS
WITH
active_shares AS (
  SELECT sh.id,sh.owner_id,sh.root_node_id,sh.version,sh.expires_at
  FROM shares sh
    JOIN users owner ON owner.id=sh.owner_id AND owner.disabled_at IS NULL
    WHERE sh.kind='internal' AND sh.disabled_at IS NULL
      AND (sh.expires_at IS NULL OR sh.expires_at>strftime('%s','now')*1000)
  )
SELECT sh.id AS share_id,sh.owner_id,sh.root_node_id,sh.version,sh.expires_at,
  0 AS depth,NULL AS policy_share_id,NULL AS policy_version
FROM active_shares sh
WHERE NOT EXISTS(SELECT 1 FROM share_delegations d WHERE d.share_id=sh.id)
UNION ALL
SELECT child.id,child.owner_id,child.root_node_id,child.version,child.expires_at,
  delegation.depth,delegation.policy_share_id,delegation.policy_version
FROM share_delegations delegation
JOIN share_delegation_status status ON status.share_id=delegation.share_id AND status.valid=1
JOIN active_shares child ON child.id=delegation.share_id
JOIN users delegated_user ON delegated_user.id=delegation.delegated_by_user_id
  AND delegated_user.disabled_at IS NULL;

CREATE TRIGGER backup_freeze_share_reshare_policies_insert
BEFORE INSERT ON share_reshare_policies
WHEN (SELECT backup_frozen FROM control WHERE singleton=1)=1
BEGIN SELECT RAISE(ABORT,'backup_frozen'); END;
CREATE TRIGGER backup_freeze_share_reshare_policies_update
BEFORE UPDATE ON share_reshare_policies
WHEN (SELECT backup_frozen FROM control WHERE singleton=1)=1
BEGIN SELECT RAISE(ABORT,'backup_frozen'); END;
CREATE TRIGGER backup_freeze_share_reshare_policies_delete
BEFORE DELETE ON share_reshare_policies
WHEN (SELECT backup_frozen FROM control WHERE singleton=1)=1
BEGIN SELECT RAISE(ABORT,'backup_frozen'); END;
CREATE TRIGGER backup_freeze_share_reshare_policy_actions_insert
BEFORE INSERT ON share_reshare_policy_actions
WHEN (SELECT backup_frozen FROM control WHERE singleton=1)=1
BEGIN SELECT RAISE(ABORT,'backup_frozen'); END;
CREATE TRIGGER backup_freeze_share_reshare_policy_actions_update
BEFORE UPDATE ON share_reshare_policy_actions
WHEN (SELECT backup_frozen FROM control WHERE singleton=1)=1
BEGIN SELECT RAISE(ABORT,'backup_frozen'); END;
CREATE TRIGGER backup_freeze_share_reshare_policy_actions_delete
BEFORE DELETE ON share_reshare_policy_actions
WHEN (SELECT backup_frozen FROM control WHERE singleton=1)=1
BEGIN SELECT RAISE(ABORT,'backup_frozen'); END;
CREATE TRIGGER backup_freeze_share_delegations_insert
BEFORE INSERT ON share_delegations
WHEN (SELECT backup_frozen FROM control WHERE singleton=1)=1
BEGIN SELECT RAISE(ABORT,'backup_frozen'); END;
CREATE TRIGGER backup_freeze_share_delegations_update
BEFORE UPDATE ON share_delegations
WHEN (SELECT backup_frozen FROM control WHERE singleton=1)=1
BEGIN SELECT RAISE(ABORT,'backup_frozen'); END;
CREATE TRIGGER backup_freeze_share_delegations_delete
BEFORE DELETE ON share_delegations
WHEN (SELECT backup_frozen FROM control WHERE singleton=1)=1
BEGIN SELECT RAISE(ABORT,'backup_frozen'); END;
CREATE TRIGGER backup_freeze_share_delegation_ancestry_insert
BEFORE INSERT ON share_delegation_ancestry
WHEN (SELECT backup_frozen FROM control WHERE singleton=1)=1
BEGIN SELECT RAISE(ABORT,'backup_frozen'); END;
CREATE TRIGGER backup_freeze_share_delegation_ancestry_update
BEFORE UPDATE ON share_delegation_ancestry
WHEN (SELECT backup_frozen FROM control WHERE singleton=1)=1
BEGIN SELECT RAISE(ABORT,'backup_frozen'); END;
CREATE TRIGGER backup_freeze_share_delegation_ancestry_delete
BEFORE DELETE ON share_delegation_ancestry
WHEN (SELECT backup_frozen FROM control WHERE singleton=1)=1
BEGIN SELECT RAISE(ABORT,'backup_frozen'); END;
CREATE TRIGGER backup_freeze_share_delegation_status_insert
BEFORE INSERT ON share_delegation_status
WHEN (SELECT backup_frozen FROM control WHERE singleton=1)=1
BEGIN SELECT RAISE(ABORT,'backup_frozen'); END;
CREATE TRIGGER backup_freeze_share_delegation_status_update
BEFORE UPDATE ON share_delegation_status
WHEN (SELECT backup_frozen FROM control WHERE singleton=1)=1
BEGIN SELECT RAISE(ABORT,'backup_frozen'); END;
CREATE TRIGGER backup_freeze_share_delegation_status_delete
BEFORE DELETE ON share_delegation_status
WHEN (SELECT backup_frozen FROM control WHERE singleton=1)=1
BEGIN SELECT RAISE(ABORT,'backup_frozen'); END;
CREATE TRIGGER backup_freeze_share_reshare_requests_insert
BEFORE INSERT ON share_reshare_requests
WHEN (SELECT backup_frozen FROM control WHERE singleton=1)=1
BEGIN SELECT RAISE(ABORT,'backup_frozen'); END;
CREATE TRIGGER backup_freeze_share_reshare_requests_update
BEFORE UPDATE ON share_reshare_requests
WHEN (SELECT backup_frozen FROM control WHERE singleton=1)=1
BEGIN SELECT RAISE(ABORT,'backup_frozen'); END;
CREATE TRIGGER backup_freeze_share_reshare_requests_delete
BEFORE DELETE ON share_reshare_requests
WHEN (SELECT backup_frozen FROM control WHERE singleton=1)=1
BEGIN SELECT RAISE(ABORT,'backup_frozen'); END;
