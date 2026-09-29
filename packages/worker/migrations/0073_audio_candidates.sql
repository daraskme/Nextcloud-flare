-- A bounded keyset window must not scan hidden siblings before finding visible candidates.
INSERT INTO _assert(v) SELECT 1 WHERE NOT EXISTS(
 SELECT 1 FROM control WHERE singleton=1 AND maintenance=1 AND backup_token IS NULL
 AND backup_frozen=0 AND restore_freeze_token IS NULL)
 OR EXISTS(SELECT 1 FROM permits WHERE state='open')
 OR EXISTS(SELECT 1 FROM operations WHERE state='claimed')
 OR EXISTS(SELECT 1 FROM mutation_admissions WHERE state<>'closed')
 OR EXISTS(SELECT 1 FROM r2_write_attempts WHERE state='pending')
 OR EXISTS(SELECT 1 FROM kdf_attempts WHERE state='claimed')
 OR EXISTS(SELECT 1 FROM image_transform_attempts WHERE state='pending');
CREATE INDEX nodes_audio_candidates ON nodes(parent_id,space_id,owner_id,name_ci,id)
 WHERE deleted_at IS NULL AND hidden=0;
