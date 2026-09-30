-- DAV bodies use the same durable storage/cleanup ledger without a private upload capability.
ALTER TABLE uploads ADD COLUMN source TEXT NOT NULL DEFAULT 'private' CHECK(source IN ('private','dav'));
CREATE TRIGGER uploads_source_identity BEFORE UPDATE OF source ON uploads
WHEN NEW.source<>OLD.source
BEGIN SELECT RAISE(ABORT,'immutable_upload_source'); END;
CREATE TRIGGER uploads_dav_source BEFORE INSERT ON uploads
WHEN NEW.source='dav' AND (
  NEW.mode='single' AND NEW.capability_hash='internal:dav' AND NEW.capability_kid IS NULL
  AND NEW.id='dav_'||NEW.completion_op_id AND NEW.upload_name IS NOT NULL
  AND NEW.write_attempt_id IS NOT NULL AND NEW.write_lease_expires_at IS NOT NULL
  AND EXISTS(SELECT 1 FROM operations o JOIN reservations r ON r.op_id=o.op_id
    JOIN spaces s ON s.id=o.space_id
    JOIN credentials credential ON credential.id=o.credential_id AND credential.kind='app_password'
    WHERE o.op_id=NEW.completion_op_id AND o.kind='dav.put' AND o.principal_kind='app_password'
      AND o.credential_id=NEW.credential_id AND o.space_id=NEW.space_id AND o.epoch=NEW.epoch
      AND o.request_digest=NEW.request_digest AND s.owner_id=NEW.owner_id
      AND json_extract(o.operands_json,'$.parentId')=NEW.parent_id
      AND json_extract(o.operands_json,'$.nodeId') IS NEW.target_id
      AND r.id=NEW.reservation_id AND r.owner_id=NEW.owner_id AND r.bytes=NEW.declared_size
      AND r.epoch=NEW.epoch AND r.expires_at=NEW.expires_at AND r.share_id IS NULL)
) IS NOT 1
BEGIN SELECT RAISE(ABORT,'invalid_dav_upload_source'); END;
