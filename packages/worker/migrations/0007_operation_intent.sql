ALTER TABLE operations ADD COLUMN operands_json TEXT NOT NULL DEFAULT '{}'
  CHECK(json_valid(operands_json) AND length(CAST(operands_json AS BLOB))<=8192);
CREATE TRIGGER operations_identity BEFORE UPDATE ON operations
WHEN NEW.op_id<>OLD.op_id OR NEW.principal_kind<>OLD.principal_kind OR NEW.principal_id<>OLD.principal_id
 OR NEW.credential_id IS NOT OLD.credential_id OR NEW.credential_version IS NOT OLD.credential_version
 OR NEW.space_id<>OLD.space_id OR NEW.kind<>OLD.kind OR NEW.request_digest<>OLD.request_digest
 OR NEW.epoch<>OLD.epoch OR NEW.permit_id<>OLD.permit_id OR NEW.permit_expires_at<>OLD.permit_expires_at
 OR NEW.claimed_expires_at<>OLD.claimed_expires_at OR NEW.expected_steps<>OLD.expected_steps
 OR NEW.operands_json<>OLD.operands_json OR NEW.created_at<>OLD.created_at OR NEW.updated_at<OLD.updated_at
BEGIN SELECT RAISE(ABORT,'immutable_operation_intent'); END;
CREATE TRIGGER app_passwords_identity BEFORE UPDATE OF id,user_id,created_at ON app_passwords
WHEN NEW.id<>OLD.id OR NEW.user_id<>OLD.user_id OR NEW.created_at<>OLD.created_at
BEGIN SELECT RAISE(ABORT,'immutable_app_password_identity'); END;
