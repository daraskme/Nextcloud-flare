-- A lazy server-generated preview is a durable request, never an upload of client bytes.
INSERT INTO _assert(v) SELECT 1 WHERE NOT EXISTS(
 SELECT 1 FROM control WHERE singleton=1 AND maintenance=1 AND backup_token IS NULL
 AND backup_frozen=0 AND restore_freeze_token IS NULL)
 OR EXISTS(SELECT 1 FROM permits WHERE state='open')
 OR EXISTS(SELECT 1 FROM operations WHERE state='claimed')
 OR EXISTS(SELECT 1 FROM mutation_admissions WHERE state<>'closed')
 OR EXISTS(SELECT 1 FROM r2_write_attempts WHERE state='pending')
 OR EXISTS(SELECT 1 FROM kdf_attempts WHERE state='claimed')
 OR EXISTS(SELECT 1 FROM image_transform_attempts WHERE state='pending');
INSERT INTO operation_kinds(name) VALUES('thumbnail.request');
-- The payload is the hash of original blob, variant and generator, shared by all COW aliases.
-- Failed delivery does not authorize a fresh paid attempt or discard the saved authority.
CREATE UNIQUE INDEX outbox_large_thumbnail ON outbox(payload_ref) WHERE kind='image.requested';
