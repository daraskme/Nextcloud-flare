-- Normalize in the Worker, never with SQLite's ASCII-only lower(). Existing rows require reindexing.
INSERT INTO _assert(v) SELECT 1 WHERE NOT EXISTS(
 SELECT 1 FROM control WHERE singleton=1 AND maintenance=1 AND backup_token IS NULL
 AND backup_frozen=0 AND restore_freeze_token IS NULL)
 OR EXISTS(SELECT 1 FROM permits WHERE state='open')
 OR EXISTS(SELECT 1 FROM operations WHERE state='claimed')
 OR EXISTS(SELECT 1 FROM mutation_admissions WHERE state<>'closed')
 OR EXISTS(SELECT 1 FROM r2_write_attempts WHERE state='pending')
 OR EXISTS(SELECT 1 FROM kdf_attempts WHERE state='claimed')
 OR EXISTS(SELECT 1 FROM image_transform_attempts WHERE state='pending');
ALTER TABLE node_audio ADD COLUMN search_text_norm TEXT NOT NULL DEFAULT ''
 CHECK(length(CAST(search_text_norm AS BLOB))<=65536);
ALTER TABLE node_audio ADD COLUMN search_tokens TEXT NOT NULL DEFAULT ''
 CHECK(length(CAST(search_tokens AS BLOB))<=196608);
ALTER TABLE node_audio ADD COLUMN search_source TEXT NOT NULL DEFAULT ''
 CHECK(length(CAST(search_source AS BLOB))<=32768);
ALTER TABLE node_audio ADD COLUMN search_version TEXT NOT NULL DEFAULT ''
 CHECK(length(CAST(search_version AS BLOB))<=128);
