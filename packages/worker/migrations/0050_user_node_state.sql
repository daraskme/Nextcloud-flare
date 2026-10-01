CREATE TABLE user_node_state(
  user_id TEXT NOT NULL REFERENCES users(id),
  node_id TEXT NOT NULL REFERENCES nodes(id),
  starred INTEGER NOT NULL DEFAULT 0 CHECK(starred IN (0,1)),
  last_opened_at INTEGER
    CHECK(last_opened_at IS NULL OR last_opened_at BETWEEN 0 AND 9007199254740991),
  PRIMARY KEY(user_id,node_id),
  CHECK(starred=1 OR last_opened_at IS NOT NULL)
) STRICT;

INSERT INTO user_node_state(user_id,node_id,starred)
SELECT user_id,node_id,1 FROM stars;

DROP TABLE stars;

CREATE INDEX user_node_state_node_id_fk ON user_node_state(node_id);
CREATE INDEX user_node_state_recent
  ON user_node_state(user_id,last_opened_at DESC,node_id DESC)
  WHERE last_opened_at IS NOT NULL;
CREATE INDEX user_node_state_starred
  ON user_node_state(user_id,node_id)
  WHERE starred=1;

CREATE TRIGGER user_node_state_identity
BEFORE UPDATE OF user_id,node_id ON user_node_state
WHEN NEW.user_id<>OLD.user_id OR NEW.node_id<>OLD.node_id
BEGIN SELECT RAISE(ABORT,'immutable_user_node_state_identity'); END;

CREATE TRIGGER backup_freeze_user_node_state_insert
BEFORE INSERT ON user_node_state
WHEN (SELECT backup_frozen FROM control WHERE singleton=1)=1
BEGIN SELECT RAISE(ABORT,'backup_frozen'); END;
CREATE TRIGGER backup_freeze_user_node_state_update
BEFORE UPDATE ON user_node_state
WHEN (SELECT backup_frozen FROM control WHERE singleton=1)=1
BEGIN SELECT RAISE(ABORT,'backup_frozen'); END;
CREATE TRIGGER backup_freeze_user_node_state_delete
BEFORE DELETE ON user_node_state
WHEN (SELECT backup_frozen FROM control WHERE singleton=1)=1
BEGIN SELECT RAISE(ABORT,'backup_frozen'); END;

INSERT INTO operation_kinds(name) VALUES('recent.record');
