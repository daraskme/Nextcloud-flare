-- Preserve source and destination grants independently; legacy NULL tuples keep their original scope.
ALTER TABLE operations ADD COLUMN destination_space_id TEXT REFERENCES spaces(id);
ALTER TABLE operations ADD COLUMN destination_share_id TEXT REFERENCES shares(id);
ALTER TABLE operations ADD COLUMN destination_share_version INTEGER
  CHECK(destination_share_version IS NULL OR destination_share_version BETWEEN 1 AND 9007199254740991);
CREATE INDEX operations_destination_space ON operations(destination_space_id);
CREATE INDEX operations_destination_share ON operations(destination_share_id,destination_share_version);
CREATE TRIGGER operations_destination_insert BEFORE INSERT ON operations
WHEN (NEW.destination_share_id IS NULL)<>(NEW.destination_share_version IS NULL)
  OR (NEW.destination_space_id IS NULL AND NEW.destination_share_id IS NOT NULL)
  OR (NEW.destination_space_id IS NOT NULL AND (
    NEW.kind NOT IN ('node.copy','node.move','dav.copy','dav.move')
    OR NEW.principal_kind NOT IN ('user','app_password')
    OR NEW.destination_space_id<>NEW.space_id
    OR NOT EXISTS(SELECT 1 FROM spaces sp WHERE sp.id=NEW.destination_space_id AND (
      (NEW.destination_share_id IS NULL AND sp.owner_id=NEW.principal_id)
      OR EXISTS(SELECT 1 FROM shares sh WHERE sh.id=NEW.destination_share_id AND sh.kind='internal'
        AND sh.owner_id=sp.owner_id AND sh.version>=NEW.destination_share_version)))))
BEGIN SELECT RAISE(ABORT,'invalid_transfer_destination'); END;
CREATE TRIGGER operations_destination_identity BEFORE UPDATE ON operations
WHEN NEW.destination_space_id IS NOT OLD.destination_space_id
  OR NEW.destination_share_id IS NOT OLD.destination_share_id
  OR NEW.destination_share_version IS NOT OLD.destination_share_version
BEGIN SELECT RAISE(ABORT,'immutable_transfer_destination'); END;
