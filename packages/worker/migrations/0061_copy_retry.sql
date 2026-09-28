-- One accepted successor per stopped job, including concurrent requests with different keys.
INSERT INTO _assert(v) SELECT 1 WHERE NOT EXISTS(SELECT 1 FROM control WHERE singleton=1
  AND maintenance=1 AND backup_token IS NULL AND backup_frozen=0 AND restore_freeze_token IS NULL)
  OR EXISTS(SELECT 1 FROM permits WHERE state='open') OR EXISTS(SELECT 1 FROM operations WHERE state='claimed')
  OR EXISTS(SELECT 1 FROM mutation_admissions WHERE state<>'closed');
CREATE UNIQUE INDEX copy_retry_successor ON operations(json_extract(operands_json,'$.retryOf'))
  WHERE kind='copy.enqueue' AND state='committed';
CREATE TRIGGER copy_retry_input BEFORE INSERT ON operations
WHEN json_type(NEW.operands_json,'$.retryOf') IS NOT NULL AND
  (NEW.kind<>'copy.enqueue' OR json_type(NEW.operands_json,'$.retryOf')<>'text'
    OR length(json_extract(NEW.operands_json,'$.retryOf'))<>69
    OR substr(json_extract(NEW.operands_json,'$.retryOf'),1,5)<>'copy_'
    OR substr(json_extract(NEW.operands_json,'$.retryOf'),6) GLOB '*[^a-f0-9]*')
BEGIN SELECT RAISE(ABORT,'invalid_copy_retry'); END;
CREATE TRIGGER copy_retry_commit BEFORE UPDATE ON operations
WHEN NEW.kind='copy.enqueue' AND NEW.state='committed' AND json_type(NEW.operands_json,'$.retryOf') IS NOT NULL
  AND NOT EXISTS(SELECT 1 FROM bulk_jobs previous JOIN operations original ON original.op_id=previous.op_id
    WHERE previous.id=json_extract(NEW.operands_json,'$.retryOf') AND previous.kind='node.copy' AND previous.state IN ('failed','cancelled')
  AND previous.stopped_at IS NOT NULL AND previous.stop_epoch>=previous.epoch
  AND previous.publish_op_id IS NULL AND previous.published_root_id IS NULL
  AND original.kind='copy.enqueue' AND original.state='committed'
  AND NEW.principal_kind='user' AND original.principal_kind=NEW.principal_kind
  AND original.principal_id=NEW.principal_id AND original.credential_id=NEW.credential_id
  AND previous.credential_id=NEW.credential_id AND original.space_id=NEW.space_id
  AND original.selected_share_id IS NEW.selected_share_id
  AND original.selected_share_version IS NEW.selected_share_version
  AND original.destination_space_id=NEW.destination_space_id
  AND original.destination_share_id IS NEW.destination_share_id
  AND original.destination_share_version IS NEW.destination_share_version
  AND json_extract(original.operands_json,'$.sourceNodeId')=json_extract(NEW.operands_json,'$.sourceNodeId')
  AND json_extract(original.operands_json,'$.parentId')=json_extract(NEW.operands_json,'$.parentId')
  AND json_extract(original.operands_json,'$.name')=json_extract(NEW.operands_json,'$.name')
  AND json_extract(original.operands_json,'$.depth')=json_extract(NEW.operands_json,'$.depth')
  AND json_extract(original.operands_json,'$.overwriteTargetId') IS json_extract(NEW.operands_json,'$.overwriteTargetId')
  AND NOT EXISTS(SELECT 1 FROM copy_job_blobs WHERE job_id=previous.id)
  AND NOT EXISTS(SELECT 1 FROM job_leases WHERE job_id=previous.id)
  AND previous.blob_count=(SELECT COUNT(*) FROM copy_cleanup_receipts WHERE job_id=previous.id)
  AND EXISTS(SELECT 1 FROM outbox WHERE op_id=previous.op_id AND payload_ref=previous.id
    AND kind='copy.requested' AND state='failed'))
BEGIN SELECT RAISE(ABORT,'copy_retry_unproven'); END;
