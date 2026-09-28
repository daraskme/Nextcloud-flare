-- source='private' is the existing capability-based HTTP transfer protocol (as opposed to DAV).
-- Keep anonymous link authority separate from an authenticated recipient's selected internal share.
INSERT INTO _assert(v) SELECT 1 WHERE NOT EXISTS(SELECT 1 FROM control WHERE singleton=1
  AND maintenance=1 AND backup_token IS NULL AND backup_frozen=0 AND restore_freeze_token IS NULL)
  OR EXISTS(SELECT 1 FROM permits WHERE state='open') OR EXISTS(SELECT 1 FROM operations WHERE state='claimed')
  OR EXISTS(SELECT 1 FROM mutation_admissions WHERE state<>'closed');
ALTER TABLE uploads ADD COLUMN link_share_id TEXT REFERENCES shares(id);
ALTER TABLE uploads ADD COLUMN link_share_version INTEGER
  CHECK(link_share_version IS NULL OR link_share_version BETWEEN 1 AND 9007199254740991);

CREATE TRIGGER uploads_link_insert BEFORE INSERT ON uploads
WHEN (NEW.link_share_id IS NULL)<>(NEW.link_share_version IS NULL)
  OR (NEW.link_share_id IS NOT NULL AND (
    NEW.source<>'private' OR NEW.selected_share_id IS NOT NULL OR NEW.selected_share_version IS NOT NULL
    OR length(NEW.link_share_id) NOT BETWEEN 1 AND 128 OR NEW.link_share_id GLOB '*[^A-Za-z0-9_-]*'
    OR NOT EXISTS(SELECT 1 FROM credentials c JOIN share_sessions ss ON ss.id=c.share_session_id
      JOIN shares sh ON sh.id=ss.share_id JOIN reservations r ON r.id=NEW.reservation_id
      WHERE c.id=NEW.credential_id AND c.kind='share' AND ss.share_id=NEW.link_share_id
        AND ss.share_version=NEW.link_share_version AND ss.epoch=NEW.epoch
        AND sh.kind='link' AND sh.owner_id=NEW.owner_id AND sh.version>=NEW.link_share_version
        AND r.owner_id=NEW.owner_id AND r.share_id IS NULL AND r.op_id IS NULL
        AND r.bytes=NEW.declared_size AND r.epoch=NEW.epoch AND r.expires_at=NEW.expires_at)))
  OR (NEW.source='private' AND NEW.link_share_id IS NULL
    AND EXISTS(SELECT 1 FROM credentials WHERE id=NEW.credential_id AND kind='share'))
BEGIN SELECT RAISE(ABORT,'invalid_upload_link'); END;

CREATE TRIGGER uploads_link_identity BEFORE UPDATE ON uploads
WHEN NEW.link_share_id IS NOT OLD.link_share_id OR NEW.link_share_version IS NOT OLD.link_share_version
BEGIN SELECT RAISE(ABORT,'immutable_upload_link'); END;

CREATE TRIGGER uploads_link_completion_insert BEFORE INSERT ON uploads
WHEN NEW.completion_op_id IS NOT NULL AND NOT EXISTS(
  SELECT 1 FROM operations o WHERE o.op_id=NEW.completion_op_id
    AND ((NEW.link_share_id IS NULL AND o.principal_kind<>'link_share')
      OR (NEW.link_share_id IS NOT NULL AND o.kind='upload.complete' AND o.principal_kind='link_share'
        AND o.principal_id=NEW.link_share_id AND o.credential_version=NEW.link_share_version
        AND o.credential_id=NEW.credential_id AND o.epoch=NEW.epoch AND o.space_id=NEW.space_id
        AND json_extract(o.operands_json,'$.uploadId')=NEW.id
        AND json_extract(o.operands_json,'$.parentId')=NEW.parent_id
        AND json_extract(o.operands_json,'$.nodeId') IS NEW.target_id)))
BEGIN SELECT RAISE(ABORT,'upload_operation_link_mismatch'); END;

CREATE TRIGGER uploads_link_completion_update BEFORE UPDATE OF completion_op_id ON uploads
WHEN NEW.completion_op_id IS NOT NULL AND NOT EXISTS(
  SELECT 1 FROM operations o WHERE o.op_id=NEW.completion_op_id
    AND ((NEW.link_share_id IS NULL AND o.principal_kind<>'link_share')
      OR (NEW.link_share_id IS NOT NULL AND o.kind='upload.complete' AND o.principal_kind='link_share'
        AND o.principal_id=NEW.link_share_id AND o.credential_version=NEW.link_share_version
        AND o.credential_id=NEW.credential_id AND o.epoch=NEW.epoch AND o.space_id=NEW.space_id
        AND json_extract(o.operands_json,'$.uploadId')=NEW.id
        AND json_extract(o.operands_json,'$.parentId')=NEW.parent_id
        AND json_extract(o.operands_json,'$.nodeId') IS NEW.target_id)))
BEGIN SELECT RAISE(ABORT,'upload_operation_link_mismatch'); END;

CREATE INDEX uploads_link_share ON uploads(link_share_id,link_share_version);
