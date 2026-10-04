-- Durable target-set membership: trash/purge revoke only the tickets and
-- content sessions that actually cover the removed subtree instead of every
-- set owned by the space owner.
CREATE TABLE target_set_nodes(
  target_set_id TEXT NOT NULL REFERENCES target_sets(id),
  node_id TEXT NOT NULL,
  PRIMARY KEY(target_set_id,node_id)
) STRICT;
CREATE INDEX target_set_nodes_node_id ON target_set_nodes(node_id);
CREATE TRIGGER backup_freeze_target_set_nodes_insert BEFORE INSERT ON target_set_nodes
WHEN (SELECT backup_frozen FROM control WHERE singleton=1)=1
BEGIN SELECT RAISE(ABORT,'backup_frozen'); END;
CREATE TRIGGER backup_freeze_target_set_nodes_update BEFORE UPDATE ON target_set_nodes
WHEN (SELECT backup_frozen FROM control WHERE singleton=1)=1
BEGIN SELECT RAISE(ABORT,'backup_frozen'); END;
CREATE TRIGGER backup_freeze_target_set_nodes_delete BEFORE DELETE ON target_set_nodes
WHEN (SELECT backup_frozen FROM control WHERE singleton=1)=1
BEGIN SELECT RAISE(ABORT,'backup_frozen'); END;
