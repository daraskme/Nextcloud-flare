-- Keep the exact share authority with a durable write and every replay of it.
-- Legacy operations/uploads retain their original unselected authority.
ALTER TABLE operations ADD COLUMN selected_share_id TEXT REFERENCES shares(id);
ALTER TABLE operations ADD COLUMN selected_share_version INTEGER
  CHECK(selected_share_version IS NULL OR selected_share_version BETWEEN 1 AND 9007199254740991);
ALTER TABLE uploads ADD COLUMN selected_share_id TEXT REFERENCES shares(id);
ALTER TABLE uploads ADD COLUMN selected_share_version INTEGER
  CHECK(selected_share_version IS NULL OR selected_share_version BETWEEN 1 AND 9007199254740991);

CREATE TRIGGER operations_selected_share_insert BEFORE INSERT ON operations
WHEN (NEW.selected_share_id IS NULL) <> (NEW.selected_share_version IS NULL)
  OR (NEW.selected_share_id IS NOT NULL AND (
    NEW.principal_kind<>'user' OR NOT EXISTS(
      SELECT 1 FROM shares sh JOIN spaces sp ON sp.id=NEW.space_id
      WHERE sh.id=NEW.selected_share_id AND sh.kind='internal' AND sh.owner_id=sp.owner_id
        AND sh.version>=NEW.selected_share_version)))
BEGIN SELECT RAISE(ABORT,'invalid_operation_share'); END;
CREATE TRIGGER operations_selected_share_identity BEFORE UPDATE ON operations
WHEN NEW.selected_share_id IS NOT OLD.selected_share_id
  OR NEW.selected_share_version IS NOT OLD.selected_share_version
BEGIN SELECT RAISE(ABORT,'immutable_operation_share'); END;

CREATE TRIGGER uploads_selected_share_insert BEFORE INSERT ON uploads
WHEN (NEW.selected_share_id IS NULL) <> (NEW.selected_share_version IS NULL)
  OR (NEW.selected_share_id IS NOT NULL AND (
    NEW.source<>'private' OR NOT EXISTS(
      SELECT 1 FROM shares sh WHERE sh.id=NEW.selected_share_id
        AND sh.kind='internal' AND sh.owner_id=NEW.owner_id AND sh.version>=NEW.selected_share_version)))
BEGIN SELECT RAISE(ABORT,'invalid_upload_share'); END;
CREATE TRIGGER uploads_selected_share_identity BEFORE UPDATE ON uploads
WHEN NEW.selected_share_id IS NOT OLD.selected_share_id
  OR NEW.selected_share_version IS NOT OLD.selected_share_version
BEGIN SELECT RAISE(ABORT,'immutable_upload_share'); END;

CREATE TRIGGER uploads_selected_completion_insert BEFORE INSERT ON uploads
WHEN NEW.completion_op_id IS NOT NULL AND NOT EXISTS(
  SELECT 1 FROM operations o WHERE o.op_id=NEW.completion_op_id
    AND o.selected_share_id IS NEW.selected_share_id
    AND o.selected_share_version IS NEW.selected_share_version)
BEGIN SELECT RAISE(ABORT,'upload_operation_share_mismatch'); END;

CREATE INDEX operations_selected_share ON operations(selected_share_id,selected_share_version);
CREATE INDEX uploads_selected_share ON uploads(selected_share_id,selected_share_version);
CREATE TRIGGER uploads_selected_completion_update BEFORE UPDATE OF completion_op_id ON uploads
WHEN NEW.completion_op_id IS NOT NULL AND NOT EXISTS(
  SELECT 1 FROM operations o WHERE o.op_id=NEW.completion_op_id
    AND o.selected_share_id IS NEW.selected_share_id
    AND o.selected_share_version IS NEW.selected_share_version)
BEGIN SELECT RAISE(ABORT,'upload_operation_share_mismatch'); END;
