-- Install only with admission stopped and every outstanding namespace/admission claim closed.
INSERT INTO _assert(v) SELECT 1 WHERE NOT EXISTS(SELECT 1 FROM control WHERE singleton=1
  AND maintenance=1 AND backup_token IS NULL AND backup_frozen=0 AND restore_freeze_token IS NULL)
  OR EXISTS(SELECT 1 FROM permits WHERE state='open') OR EXISTS(SELECT 1 FROM operations WHERE state='claimed')
  OR EXISTS(SELECT 1 FROM mutation_admissions WHERE state<>'closed');
ALTER TABLE uploads ADD COLUMN upload_only INTEGER NOT NULL DEFAULT 0 CHECK(upload_only IN (0,1));

DROP TRIGGER uploads_link_insert;
CREATE TRIGGER uploads_link_insert BEFORE INSERT ON uploads
WHEN (NEW.link_share_id IS NULL)<>(NEW.link_share_version IS NULL)
  OR (NEW.upload_only=1 AND (NEW.link_share_id IS NULL OR NEW.target_id IS NOT NULL OR NEW.target_revision IS NOT NULL))
  OR (NEW.link_share_id IS NOT NULL AND (
    NEW.source<>'private' OR NEW.selected_share_id IS NOT NULL OR NEW.selected_share_version IS NOT NULL
    OR length(NEW.link_share_id) NOT BETWEEN 1 AND 128 OR NEW.link_share_id GLOB '*[^A-Za-z0-9_-]*'
    OR NOT EXISTS(SELECT 1 FROM credentials c JOIN share_sessions ss ON ss.id=c.share_session_id
      JOIN shares sh ON sh.id=ss.share_id JOIN reservations r ON r.id=NEW.reservation_id
      WHERE c.id=NEW.credential_id AND c.kind='share' AND ss.share_id=NEW.link_share_id
        AND ss.share_version=NEW.link_share_version AND ss.epoch=NEW.epoch
        AND sh.owner_id=NEW.owner_id AND sh.version>=NEW.link_share_version
        AND ((NEW.upload_only=0 AND sh.kind='link' AND r.share_id IS NULL)
          OR (NEW.upload_only=1 AND sh.kind='upload_only' AND r.share_id=sh.id AND NEW.parent_id=sh.root_node_id))
        AND r.owner_id=NEW.owner_id AND r.op_id IS NULL
        AND r.bytes=NEW.declared_size AND r.epoch=NEW.epoch AND r.expires_at=NEW.expires_at)))
  OR (NEW.source='private' AND NEW.link_share_id IS NULL
    AND EXISTS(SELECT 1 FROM credentials WHERE id=NEW.credential_id AND kind='share'))
BEGIN SELECT RAISE(ABORT,'invalid_upload_link'); END;

CREATE TRIGGER uploads_upload_only_identity BEFORE UPDATE OF upload_only ON uploads
WHEN NEW.upload_only<>OLD.upload_only
BEGIN SELECT RAISE(ABORT,'immutable_upload_policy'); END;
