-- Scratch set for purge: reshare delegations that reference purged member
-- nodes can only be reached through share_delegation_ancestry, which the purge
-- itself deletes. Capture the doomed share ids here first so the delegation
-- rows can still be identified after their ancestry rows are gone.
CREATE TABLE purge_share_ids(
  purge_op_id TEXT NOT NULL REFERENCES operations(op_id),
  share_id TEXT NOT NULL,
  PRIMARY KEY(purge_op_id,share_id)
) STRICT;
CREATE TRIGGER backup_freeze_purge_share_ids_insert BEFORE INSERT ON purge_share_ids
WHEN (SELECT backup_frozen FROM control WHERE singleton=1)=1
BEGIN SELECT RAISE(ABORT,'backup_frozen'); END;
CREATE TRIGGER backup_freeze_purge_share_ids_update BEFORE UPDATE ON purge_share_ids
WHEN (SELECT backup_frozen FROM control WHERE singleton=1)=1
BEGIN SELECT RAISE(ABORT,'backup_frozen'); END;
CREATE TRIGGER backup_freeze_purge_share_ids_delete BEFORE DELETE ON purge_share_ids
WHEN (SELECT backup_frozen FROM control WHERE singleton=1)=1
BEGIN SELECT RAISE(ABORT,'backup_frozen'); END;
