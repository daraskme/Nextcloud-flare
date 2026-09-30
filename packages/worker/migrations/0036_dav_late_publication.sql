-- Stage a DAV body before its short namespace permit exists. Existing bound rows are preserved.
DROP TRIGGER uploads_dav_source;
CREATE TRIGGER uploads_dav_source BEFORE INSERT ON uploads
WHEN NEW.source='dav' AND (
  NEW.mode='single' AND NEW.capability_hash='internal:dav' AND NEW.capability_kid IS NULL
  AND NEW.upload_name IS NOT NULL AND NEW.write_attempt_id IS NOT NULL AND NEW.write_lease_expires_at IS NOT NULL
  AND (
    (NEW.completion_op_id IS NULL AND length(NEW.id)=71 AND substr(NEW.id,1,7)='dav_op_'
      AND substr(NEW.id,8) NOT GLOB '*[^a-f0-9]*'
      AND NEW.blob_id=substr(NEW.id,5)||'_blob' AND NEW.reservation_id=substr(NEW.id,5)||'_reservation'
      AND length(NEW.request_digest)=64 AND NEW.request_digest NOT GLOB '*[^a-f0-9]*'
      AND EXISTS(SELECT 1 FROM reservations r JOIN spaces s ON s.id=NEW.space_id
        JOIN credentials c ON c.id=NEW.credential_id AND c.kind='app_password'
        JOIN app_passwords ap ON ap.id=c.app_password_id AND ap.user_id=NEW.owner_id
        JOIN nodes parent ON parent.id=NEW.parent_id AND parent.space_id=s.id AND parent.owner_id=NEW.owner_id
        JOIN blobs b ON b.id=NEW.blob_id AND b.owner_id=NEW.owner_id AND b.size=NEW.declared_size
        WHERE r.id=NEW.reservation_id AND r.op_id IS NULL AND r.owner_id=NEW.owner_id AND s.owner_id=NEW.owner_id
          AND r.bytes=NEW.declared_size AND r.epoch=NEW.epoch AND r.expires_at=NEW.expires_at AND r.share_id IS NULL
          AND b.r2_key='u/'||NEW.owner_id||'/b/'||NEW.blob_id))
    OR (NEW.id='dav_'||NEW.completion_op_id
      AND EXISTS(SELECT 1 FROM operations o JOIN reservations r ON r.op_id=o.op_id
        JOIN spaces s ON s.id=o.space_id
        JOIN credentials credential ON credential.id=o.credential_id AND credential.kind='app_password'
        WHERE o.op_id=NEW.completion_op_id AND o.kind='dav.put' AND o.principal_kind='app_password'
          AND o.credential_id=NEW.credential_id AND o.space_id=NEW.space_id AND o.epoch=NEW.epoch
          AND o.request_digest=NEW.request_digest AND s.owner_id=NEW.owner_id
          AND json_extract(o.operands_json,'$.parentId')=NEW.parent_id
          AND json_extract(o.operands_json,'$.nodeId') IS NEW.target_id
          AND r.id=NEW.reservation_id AND r.owner_id=NEW.owner_id AND r.bytes=NEW.declared_size
          AND r.epoch=NEW.epoch AND r.expires_at=NEW.expires_at AND r.share_id IS NULL))
  )
) IS NOT 1
BEGIN SELECT RAISE(ABORT,'invalid_dav_upload_source'); END;

CREATE TRIGGER uploads_dav_completion BEFORE UPDATE OF completion_op_id ON uploads
WHEN NEW.source='dav' AND OLD.completion_op_id IS NULL AND NEW.completion_op_id IS NOT NULL
  AND (NEW.id='dav_'||NEW.completion_op_id AND EXISTS(
    SELECT 1 FROM operations o JOIN reservations r ON r.op_id=o.op_id
    WHERE o.op_id=NEW.completion_op_id AND o.kind='dav.put' AND o.principal_kind='app_password'
      AND o.credential_id=NEW.credential_id AND o.space_id=NEW.space_id AND o.epoch=NEW.epoch
      AND o.request_digest=NEW.request_digest AND r.id=NEW.reservation_id AND r.owner_id=NEW.owner_id
      AND json_extract(o.operands_json,'$.parentId')=NEW.parent_id
      AND json_extract(o.operands_json,'$.nodeId') IS NEW.target_id
  )) IS NOT 1
BEGIN SELECT RAISE(ABORT,'invalid_dav_upload_completion'); END;
