-- Preserve existing users and all inbound trash references while making the actor nullable.
INSERT INTO _assert(v) SELECT 1 WHERE NOT EXISTS(SELECT 1 FROM control WHERE singleton=1
  AND maintenance=1 AND backup_token IS NULL AND backup_frozen=0 AND restore_freeze_token IS NULL)
  OR EXISTS(SELECT 1 FROM permits WHERE state='open') OR EXISTS(SELECT 1 FROM operations WHERE state='claimed')
  OR EXISTS(SELECT 1 FROM mutation_admissions WHERE state<>'closed');
CREATE TABLE _trash_actor_migration(op_id TEXT PRIMARY KEY,actor_id TEXT NOT NULL) STRICT;
INSERT INTO _trash_actor_migration SELECT op_id,actor_id FROM trash_ops;
DROP INDEX trash_ops_actor_id_fk;
ALTER TABLE trash_ops DROP COLUMN actor_id;
ALTER TABLE trash_ops ADD COLUMN actor_id TEXT REFERENCES users(id);
UPDATE trash_ops SET actor_id=(SELECT actor_id FROM _trash_actor_migration WHERE op_id=trash_ops.op_id);
INSERT INTO _assert(v) SELECT 1 WHERE EXISTS(
  SELECT op_id,actor_id FROM trash_ops EXCEPT SELECT op_id,actor_id FROM _trash_actor_migration);
DROP TABLE _trash_actor_migration;
CREATE INDEX trash_ops_actor_id_fk ON trash_ops(actor_id);

-- An anonymous actor is attributed through its immutable initiating operation/credential.
CREATE TRIGGER trash_anonymous_actor BEFORE INSERT ON trash_ops
WHEN (SELECT restore_freeze_token FROM control WHERE singleton=1) IS NULL
 AND COALESCE((SELECT backup_frozen FROM control WHERE singleton=1),0)=0
 AND (NEW.actor_id IS NULL OR EXISTS(SELECT 1 FROM operations WHERE op_id=NEW.op_id AND principal_kind='link_share'))
 AND NOT EXISTS(
  SELECT 1 FROM operations o JOIN credentials c ON c.id=o.credential_id
    JOIN share_sessions ss ON ss.id=c.share_session_id JOIN shares sh ON sh.id=ss.share_id
    JOIN spaces sp ON sp.id=o.space_id
  WHERE NEW.actor_id IS NULL AND o.op_id=NEW.op_id AND o.kind='node.trash' AND o.principal_kind='link_share'
    AND o.state IN ('claimed','committed')
    AND o.space_id=NEW.space_id AND o.epoch=NEW.epoch AND o.expected_steps=13
    AND o.principal_id=sh.id AND o.credential_version=ss.share_version AND ss.epoch=o.epoch
    AND c.kind='share' AND sh.kind='link' AND sh.owner_id=sp.owner_id
    AND sh.version>=o.credential_version AND o.credential_version>0
    AND json_extract(o.operands_json,'$.nodeId')=NEW.root_node_id AND NEW.reason='node.trash')
BEGIN SELECT RAISE(ABORT,'invalid_anonymous_trash_actor'); END;
CREATE TRIGGER trash_actor_identity BEFORE UPDATE ON trash_ops
WHEN (SELECT restore_freeze_token FROM control WHERE singleton=1) IS NULL
 AND COALESCE((SELECT backup_frozen FROM control WHERE singleton=1),0)=0
 AND (NEW.op_id IS NOT OLD.op_id OR NEW.actor_id IS NOT OLD.actor_id
  OR NEW.space_id IS NOT OLD.space_id OR NEW.root_node_id IS NOT OLD.root_node_id
  OR NEW.reason IS NOT OLD.reason OR NEW.epoch IS NOT OLD.epoch)
BEGIN SELECT RAISE(ABORT,'immutable_trash_actor'); END;
