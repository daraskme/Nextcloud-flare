-- Admit cover derivatives through the same native receipt, quota and immutable object proofs.
INSERT INTO _assert(v) SELECT 1 WHERE NOT EXISTS(
 SELECT 1 FROM control WHERE singleton=1 AND maintenance=1 AND backup_token IS NULL
 AND backup_frozen=0 AND restore_freeze_token IS NULL)
 OR EXISTS(SELECT 1 FROM permits WHERE state='open')
 OR EXISTS(SELECT 1 FROM operations WHERE state='claimed')
 OR EXISTS(SELECT 1 FROM mutation_admissions WHERE state<>'closed')
 OR EXISTS(SELECT 1 FROM r2_write_attempts WHERE state='pending')
 OR EXISTS(SELECT 1 FROM kdf_attempts WHERE state='claimed')
 OR EXISTS(SELECT 1 FROM image_transform_attempts WHERE state='pending');

DROP TRIGGER image_derivative_start;
CREATE TRIGGER image_derivative_start BEFORE INSERT ON image_derivative_objects
WHEN NEW.state<>'prepared' OR NOT EXISTS(
 SELECT 1 FROM image_transform_attempts t JOIN derivative_results d ON d.id=NEW.result_id
 JOIN blobs b ON b.id=NEW.output_blob_id JOIN reservations r ON r.id=NEW.reservation_id
 JOIN blob_pins p ON p.pin_id=NEW.pin_id JOIN control c ON c.singleton=1
 WHERE t.id=NEW.id AND t.state='succeeded' AND t.owner_id=NEW.owner_id AND t.blob_id=NEW.source_blob_id
 AND c.epoch=t.epoch AND c.maintenance=0 AND t.expires_at>strftime('%s','now')*1000+1000
 AND d.id='image_'||t.id AND d.kind=(CASE t.generator_version WHEN 'image-webp-v1' THEN 'thumbnail' WHEN 'audio-cover-webp-v1' THEN 'cover' END) AND d.blob_id=t.blob_id AND d.variant=t.variant
 AND d.generator_version=t.generator_version AND d.state='running' AND d.claim_token=t.claim_token
 AND d.claim_expires_at=t.expires_at AND d.epoch=t.epoch AND d.attempts=1
 AND b.id='image_'||t.id AND b.owner_id=t.owner_id AND b.state='staging'
 AND b.r2_key='u/'||t.owner_id||'/d/'||t.blob_id||'/'||t.generator_version||'/'||t.variant||'/'||t.id
 AND b.size=json_extract(t.output_json,'$.bytes') AND b.size=d.size AND b.r2_key=d.r2_key
 AND b.mime_sniffed='image/webp' AND b.ref_count=1
 AND r.owner_id=t.owner_id AND r.bytes=b.size AND r.state='reserved' AND r.physical_only=1 AND r.epoch=t.epoch AND r.expires_at=t.expires_at
 AND r.share_id IS NULL AND p.blob_id=b.id AND p.purpose='job' AND p.expires_at IS NULL
 AND NOT EXISTS(SELECT 1 FROM blob_storage WHERE blob_id=b.id))
BEGIN SELECT RAISE(ABORT,'image_derivative_unproven'); END;
