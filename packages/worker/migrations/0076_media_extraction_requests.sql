-- Explicit extraction uses the current reader, independently of a historical upload credential.
INSERT INTO _assert(v) SELECT 1 WHERE NOT EXISTS(
 SELECT 1 FROM control WHERE singleton=1 AND maintenance=1 AND backup_token IS NULL
 AND backup_frozen=0 AND restore_freeze_token IS NULL)
 OR EXISTS(SELECT 1 FROM permits WHERE state='open')
 OR EXISTS(SELECT 1 FROM operations WHERE state='claimed')
 OR EXISTS(SELECT 1 FROM mutation_admissions WHERE state<>'closed')
 OR EXISTS(SELECT 1 FROM r2_write_attempts WHERE state='pending')
 OR EXISTS(SELECT 1 FROM kdf_attempts WHERE state='claimed')
 OR EXISTS(SELECT 1 FROM image_transform_attempts WHERE state='pending');
INSERT INTO operation_kinds(name) VALUES('media.extract');
ALTER TABLE outbox ADD COLUMN result_json TEXT CHECK(result_json IS NULL OR
 (kind='media.requested' AND state='completed' AND json_valid(result_json)
  AND length(CAST(result_json AS BLOB))<=1024));
CREATE UNIQUE INDEX outbox_media_extraction ON outbox(payload_ref) WHERE kind='media.requested';
