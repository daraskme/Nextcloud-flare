DROP TRIGGER share_delegations_insert;

CREATE TABLE share_reshare_policy_actions_editable(
  share_id TEXT NOT NULL REFERENCES share_reshare_policies(share_id),
  action TEXT NOT NULL CHECK(action IN ('read','download','create','edit')),
  PRIMARY KEY(share_id,action)
) STRICT;

INSERT INTO share_reshare_policy_actions_editable(share_id,action)
SELECT share_id,action FROM share_reshare_policy_actions;

DROP TABLE share_reshare_policy_actions;
ALTER TABLE share_reshare_policy_actions_editable RENAME TO share_reshare_policy_actions;

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

ALTER TABLE operations ADD COLUMN authorization_context TEXT
  CHECK(authorization_context IS NULL OR (
    json_valid(authorization_context)
    AND length(CAST(authorization_context AS BLOB)) BETWEEN 2 AND 2048
  ));

DROP TRIGGER operations_identity;
CREATE TRIGGER operations_identity BEFORE UPDATE ON operations
WHEN NEW.op_id<>OLD.op_id OR NEW.principal_kind<>OLD.principal_kind OR NEW.principal_id<>OLD.principal_id
 OR NEW.credential_id IS NOT OLD.credential_id OR NEW.credential_version IS NOT OLD.credential_version
 OR NEW.authorization_context IS NOT OLD.authorization_context
 OR NEW.space_id<>OLD.space_id OR NEW.kind<>OLD.kind OR NEW.request_digest<>OLD.request_digest
 OR NEW.epoch<>OLD.epoch OR NEW.permit_id<>OLD.permit_id OR NEW.permit_expires_at<>OLD.permit_expires_at
 OR NEW.claimed_expires_at<>OLD.claimed_expires_at OR NEW.expected_steps<>OLD.expected_steps
 OR NEW.operands_json<>OLD.operands_json OR NEW.created_at<>OLD.created_at OR NEW.updated_at<OLD.updated_at
BEGIN SELECT RAISE(ABORT,'immutable_operation_intent'); END;

ALTER TABLE uploads ADD COLUMN authorization_context TEXT
  CHECK(authorization_context IS NULL OR (
    json_valid(authorization_context)
    AND length(CAST(authorization_context AS BLOB)) BETWEEN 2 AND 2048
  ));

CREATE TRIGGER uploads_authorization_context_identity
BEFORE UPDATE OF authorization_context ON uploads
WHEN NEW.authorization_context IS NOT OLD.authorization_context
BEGIN SELECT RAISE(ABORT,'immutable_upload_authorization_context'); END;

DROP TRIGGER uploads_dav_source;
CREATE TRIGGER uploads_dav_source BEFORE INSERT ON uploads
WHEN NEW.source='dav' AND (
  NEW.mode='single' AND NEW.capability_hash='internal:dav' AND NEW.capability_kid IS NULL
  AND NEW.upload_name IS NOT NULL AND NEW.write_attempt_id IS NOT NULL
  AND NEW.write_lease_expires_at IS NOT NULL
  AND (
    (NEW.completion_op_id IS NULL AND length(NEW.id)=71 AND substr(NEW.id,1,7)='dav_op_'
      AND substr(NEW.id,8) NOT GLOB '*[^a-f0-9]*'
      AND NEW.blob_id=substr(NEW.id,5)||'_blob'
      AND NEW.reservation_id=substr(NEW.id,5)||'_reservation'
      AND length(NEW.request_digest)=64 AND NEW.request_digest NOT GLOB '*[^a-f0-9]*'
      AND EXISTS(
        SELECT 1 FROM reservations r
        JOIN spaces s ON s.id=NEW.space_id
        JOIN credentials c ON c.id=NEW.credential_id AND c.kind='app_password'
        JOIN app_passwords ap ON ap.id=c.app_password_id
        JOIN nodes parent ON parent.id=NEW.parent_id AND parent.space_id=s.id
          AND parent.owner_id=NEW.owner_id
        JOIN blobs b ON b.id=NEW.blob_id AND b.owner_id=NEW.owner_id
          AND b.size=NEW.declared_size
        WHERE r.id=NEW.reservation_id AND r.op_id IS NULL AND r.owner_id=NEW.owner_id
          AND s.owner_id=NEW.owner_id AND r.bytes=NEW.declared_size
          AND r.epoch=NEW.epoch AND r.expires_at=NEW.expires_at AND r.share_id IS NULL
          AND b.r2_key='u/'||NEW.owner_id||'/b/'||NEW.blob_id
          AND (
            (NEW.authorization_context IS NULL AND ap.user_id=NEW.owner_id)
            OR (NEW.authorization_context IS NOT NULL AND EXISTS(
              SELECT 1 FROM current_internal_shares current
              JOIN shares sh ON sh.id=current.share_id AND sh.version=current.version
              JOIN users recipient ON recipient.id=ap.user_id AND recipient.disabled_at IS NULL
              WHERE sh.id=json_extract(NEW.authorization_context,'$.share_id')
                AND sh.version=json_extract(NEW.authorization_context,'$.share_version')
                AND sh.kind='internal' AND sh.owner_id=NEW.owner_id
                AND sh.disabled_at IS NULL
                AND (sh.expires_at IS NULL OR sh.expires_at>strftime('%s','now')*1000)
                AND EXISTS(
                  SELECT 1 FROM share_actions sa WHERE sa.share_id=sh.id
                    AND sa.action=CASE WHEN NEW.target_id IS NULL THEN 'create' ELSE 'edit' END
                )
                AND (
                  (json_extract(NEW.authorization_context,'$.recipient.kind')='direct'
                    AND EXISTS(
                      SELECT 1 FROM share_grants g
                      WHERE g.share_id=sh.id AND g.user_id=recipient.id
                        AND g.disabled_at IS NULL AND g.version=sh.version
                        AND g.version=json_extract(
                          NEW.authorization_context,'$.recipient.version'
                        )
                    ))
                  OR (json_extract(NEW.authorization_context,'$.recipient.kind')='group'
                    AND EXISTS(
                      SELECT 1 FROM share_group_grants gg
                      JOIN share_groups sg ON sg.id=gg.group_id AND sg.owner_id=sh.owner_id
                        AND sg.disabled_at IS NULL
                        AND sg.id=json_extract(
                          NEW.authorization_context,'$.recipient.group_id'
                        )
                        AND sg.version=json_extract(
                          NEW.authorization_context,'$.recipient.group_version'
                        )
                      JOIN share_group_members gm ON gm.group_id=sg.id
                        AND gm.user_id=recipient.id AND gm.disabled_at IS NULL
                        AND gm.version=json_extract(
                          NEW.authorization_context,'$.recipient.membership_version'
                        )
                      WHERE gg.share_id=sh.id
                    ))
                )
            ))
          )
      ))
    OR (NEW.id='dav_'||NEW.completion_op_id
      AND EXISTS(
        SELECT 1 FROM operations o
        JOIN reservations r ON r.op_id=o.op_id
        JOIN spaces s ON s.id=o.space_id
        JOIN credentials credential ON credential.id=o.credential_id
          AND credential.kind='app_password'
        WHERE o.op_id=NEW.completion_op_id AND o.kind='dav.put'
          AND o.principal_kind='app_password' AND o.credential_id=NEW.credential_id
          AND o.authorization_context IS NEW.authorization_context
          AND o.space_id=NEW.space_id AND o.epoch=NEW.epoch
          AND o.request_digest=NEW.request_digest AND s.owner_id=NEW.owner_id
          AND json_extract(o.operands_json,'$.parentId')=NEW.parent_id
          AND json_extract(o.operands_json,'$.nodeId') IS NEW.target_id
          AND r.id=NEW.reservation_id AND r.owner_id=NEW.owner_id
          AND r.bytes=NEW.declared_size AND r.epoch=NEW.epoch
          AND r.expires_at=NEW.expires_at AND r.share_id IS NULL
          AND (NEW.authorization_context IS NULL OR EXISTS(
            SELECT 1 FROM credentials c
            JOIN app_passwords ap ON ap.id=c.app_password_id
            JOIN users recipient ON recipient.id=ap.user_id AND recipient.disabled_at IS NULL
            JOIN current_internal_shares current
              ON current.share_id=json_extract(NEW.authorization_context,'$.share_id')
              AND current.version=json_extract(NEW.authorization_context,'$.share_version')
            JOIN shares sh ON sh.id=current.share_id AND sh.version=current.version
              AND sh.owner_id=NEW.owner_id
            WHERE c.id=NEW.credential_id AND c.kind='app_password'
              AND EXISTS(
                SELECT 1 FROM share_actions sa WHERE sa.share_id=sh.id
                  AND sa.action=CASE WHEN NEW.target_id IS NULL THEN 'create' ELSE 'edit' END
              )
              AND (
                (json_extract(NEW.authorization_context,'$.recipient.kind')='direct'
                  AND EXISTS(
                    SELECT 1 FROM share_grants g
                    WHERE g.share_id=sh.id AND g.user_id=recipient.id
                      AND g.disabled_at IS NULL AND g.version=sh.version
                      AND g.version=json_extract(
                        NEW.authorization_context,'$.recipient.version'
                      )
                  ))
                OR (json_extract(NEW.authorization_context,'$.recipient.kind')='group'
                  AND EXISTS(
                    SELECT 1 FROM share_group_grants gg
                    JOIN share_groups sg ON sg.id=gg.group_id AND sg.owner_id=sh.owner_id
                      AND sg.disabled_at IS NULL
                      AND sg.id=json_extract(
                        NEW.authorization_context,'$.recipient.group_id'
                      )
                      AND sg.version=json_extract(
                        NEW.authorization_context,'$.recipient.group_version'
                      )
                    JOIN share_group_members gm ON gm.group_id=sg.id
                      AND gm.user_id=recipient.id AND gm.disabled_at IS NULL
                      AND gm.version=json_extract(
                        NEW.authorization_context,'$.recipient.membership_version'
                      )
                    WHERE gg.share_id=sh.id
                  ))
              )
          ))
      ))
  )
) IS NOT 1
BEGIN SELECT RAISE(ABORT,'invalid_dav_upload_source'); END;

DROP TRIGGER uploads_dav_completion;
CREATE TRIGGER uploads_dav_completion BEFORE UPDATE OF completion_op_id ON uploads
WHEN NEW.source='dav' AND OLD.completion_op_id IS NULL AND NEW.completion_op_id IS NOT NULL
  AND (NEW.id='dav_'||NEW.completion_op_id AND EXISTS(
    SELECT 1 FROM operations o
    JOIN reservations r ON r.op_id=o.op_id
    WHERE o.op_id=NEW.completion_op_id AND o.kind='dav.put'
      AND o.principal_kind='app_password' AND o.credential_id=NEW.credential_id
      AND o.authorization_context IS NEW.authorization_context
      AND o.space_id=NEW.space_id AND o.epoch=NEW.epoch
      AND o.request_digest=NEW.request_digest AND r.id=NEW.reservation_id
      AND r.owner_id=NEW.owner_id
      AND json_extract(o.operands_json,'$.parentId')=NEW.parent_id
      AND json_extract(o.operands_json,'$.nodeId') IS NEW.target_id
      AND (NEW.authorization_context IS NULL OR EXISTS(
        SELECT 1 FROM credentials c
        JOIN app_passwords ap ON ap.id=c.app_password_id
        JOIN users recipient ON recipient.id=ap.user_id AND recipient.disabled_at IS NULL
        JOIN current_internal_shares current
          ON current.share_id=json_extract(NEW.authorization_context,'$.share_id')
          AND current.version=json_extract(NEW.authorization_context,'$.share_version')
        JOIN shares sh ON sh.id=current.share_id AND sh.version=current.version
          AND sh.owner_id=NEW.owner_id
        WHERE c.id=NEW.credential_id AND c.kind='app_password'
          AND EXISTS(
            SELECT 1 FROM share_actions sa WHERE sa.share_id=sh.id
              AND sa.action=CASE WHEN NEW.target_id IS NULL THEN 'create' ELSE 'edit' END
          )
          AND (
            (json_extract(NEW.authorization_context,'$.recipient.kind')='direct'
              AND EXISTS(
                SELECT 1 FROM share_grants g
                WHERE g.share_id=sh.id AND g.user_id=recipient.id
                  AND g.disabled_at IS NULL AND g.version=sh.version
                  AND g.version=json_extract(
                    NEW.authorization_context,'$.recipient.version'
                  )
              ))
            OR (json_extract(NEW.authorization_context,'$.recipient.kind')='group'
              AND EXISTS(
                SELECT 1 FROM share_group_grants gg
                JOIN share_groups sg ON sg.id=gg.group_id AND sg.owner_id=sh.owner_id
                  AND sg.disabled_at IS NULL
                  AND sg.id=json_extract(
                    NEW.authorization_context,'$.recipient.group_id'
                  )
                  AND sg.version=json_extract(
                    NEW.authorization_context,'$.recipient.group_version'
                  )
                JOIN share_group_members gm ON gm.group_id=sg.id
                  AND gm.user_id=recipient.id AND gm.disabled_at IS NULL
                  AND gm.version=json_extract(
                    NEW.authorization_context,'$.recipient.membership_version'
                  )
                WHERE gg.share_id=sh.id
              ))
          )
      ))
  )) IS NOT 1
BEGIN SELECT RAISE(ABORT,'invalid_dav_upload_completion'); END;
