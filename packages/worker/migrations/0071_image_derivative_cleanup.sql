-- Stop new work before settling image storage. Native uncertainty retains every hold.
INSERT INTO _assert(v) SELECT 1 WHERE NOT EXISTS(SELECT 1 FROM control WHERE singleton=1 AND maintenance=1 AND backup_token IS NULL AND backup_frozen=0 AND restore_freeze_token IS NULL)
 OR EXISTS(SELECT 1 FROM permits WHERE state='open') OR EXISTS(SELECT 1 FROM operations WHERE state='claimed')
 OR EXISTS(SELECT 1 FROM mutation_admissions WHERE state<>'closed') OR EXISTS(SELECT 1 FROM r2_write_attempts WHERE state='pending')
 OR EXISTS(SELECT 1 FROM kdf_attempts WHERE state='claimed') OR EXISTS(SELECT 1 FROM image_transform_attempts WHERE state='pending');
CREATE TABLE image_derivative_cleanup(
 image_id TEXT PRIMARY KEY REFERENCES image_derivative_objects(id),
 next_at INTEGER NOT NULL CHECK(next_at>=0),
 claim_token TEXT CHECK(length(claim_token)=36), claim_epoch INTEGER CHECK(claim_epoch>0),
 claim_deadline INTEGER NOT NULL DEFAULT 0 CHECK(claim_deadline>=0),
 retired_at INTEGER CHECK(retired_at>=0), retired_epoch INTEGER CHECK(retired_epoch>0),
 reason TEXT CHECK(reason IN ('expired','source_deleted')),
 seal_token TEXT UNIQUE CHECK(length(seal_token)=36),
 head_calls INTEGER NOT NULL DEFAULT 0 CHECK(head_calls BETWEEN 0 AND 64),
 head_token TEXT CHECK(length(head_token)=36),
 disposition TEXT CHECK(disposition IN ('stored','absent')), settled_at INTEGER CHECK(settled_at>=retired_at),
 CHECK((claim_token IS NULL)=(claim_epoch IS NULL)),
 CHECK((retired_at IS NULL)=(retired_epoch IS NULL) AND (retired_at IS NULL)=(reason IS NULL)),
 CHECK(seal_token IS NULL OR retired_at IS NOT NULL),
 CHECK((disposition IS NULL)=(settled_at IS NULL)),
 CHECK(settled_at IS NULL OR seal_token IS NOT NULL)
) STRICT;
CREATE INDEX image_cleanup_due ON image_derivative_cleanup(next_at,image_id) WHERE settled_at IS NULL;
INSERT INTO image_derivative_cleanup(image_id,next_at) SELECT id,strftime('%s','now')*1000+30000 FROM image_derivative_objects;
UPDATE image_derivative_cleanup SET next_at=9007199254740991 WHERE image_id IN (
 SELECT x.id FROM image_derivative_objects x JOIN blobs source ON source.id=x.source_blob_id
 WHERE x.state='published' AND source.state NOT IN ('deleting','deleted'));
CREATE TRIGGER image_cleanup_start BEFORE INSERT ON image_derivative_cleanup
WHEN NEW.claim_token IS NOT NULL OR NEW.claim_epoch IS NOT NULL OR NEW.claim_deadline<>0
 OR NEW.retired_at IS NOT NULL OR NEW.seal_token IS NOT NULL OR NEW.head_calls<>0
 OR NEW.head_token IS NOT NULL OR NEW.settled_at IS NOT NULL
BEGIN SELECT RAISE(ABORT,'invalid_image_cleanup'); END;
CREATE TRIGGER image_cleanup_create AFTER INSERT ON image_derivative_objects
BEGIN INSERT INTO image_derivative_cleanup(image_id,next_at) VALUES(NEW.id,strftime('%s','now')*1000+30000); END;
CREATE TRIGGER image_cleanup_sleep AFTER UPDATE OF state ON image_derivative_objects
WHEN NEW.state='published'
BEGIN UPDATE image_derivative_cleanup SET next_at=9007199254740991 WHERE image_id=NEW.id AND retired_at IS NULL; END;
CREATE TRIGGER image_cleanup_wake AFTER UPDATE OF state ON blobs
WHEN OLD.state NOT IN ('deleting','deleted') AND NEW.state IN ('deleting','deleted')
BEGIN UPDATE image_derivative_cleanup SET next_at=strftime('%s','now')*1000
 WHERE settled_at IS NULL AND image_id IN (SELECT id FROM image_derivative_objects WHERE source_blob_id=NEW.id AND state='published'); END;
CREATE TRIGGER image_cleanup_identity BEFORE UPDATE ON image_derivative_cleanup
WHEN NEW.image_id IS NOT OLD.image_id OR OLD.settled_at IS NOT NULL
 OR (OLD.retired_at IS NOT NULL AND (NEW.retired_at IS NOT OLD.retired_at OR NEW.retired_epoch IS NOT OLD.retired_epoch OR NEW.reason IS NOT OLD.reason))
 OR (OLD.seal_token IS NOT NULL AND NEW.seal_token IS NOT OLD.seal_token)
 OR NEW.head_calls<OLD.head_calls OR NEW.head_calls>OLD.head_calls+1
BEGIN SELECT RAISE(ABORT,'immutable_image_cleanup'); END;
CREATE TRIGGER image_cleanup_keep BEFORE DELETE ON image_derivative_cleanup
BEGIN SELECT RAISE(ABORT,'image_cleanup_history_required'); END;
CREATE TRIGGER image_cleanup_retire BEFORE UPDATE OF retired_at ON image_derivative_cleanup
WHEN OLD.retired_at IS NULL AND NEW.retired_at IS NOT NULL AND NOT EXISTS(
 SELECT 1 FROM image_derivative_objects x JOIN image_transform_attempts t ON t.id=x.id
 JOIN blobs source ON source.id=x.source_blob_id JOIN control c ON c.singleton=1
 JOIN spaces sp ON sp.owner_id=x.owner_id JOIN mutation_admissions a ON a.space_id=sp.id
 WHERE x.id=NEW.image_id AND NEW.retired_epoch=c.epoch AND NEW.retired_at>=x.created_at
 AND a.system=1 AND a.state='active' AND a.epoch=c.epoch AND a.maintenance=c.maintenance
 AND a.permit_id GLOB 'system:image.cleanup:*' AND a.expires_at>strftime('%s','now')*1000
 AND ((NEW.reason='expired' AND x.state<>'published' AND (t.epoch<c.epoch OR t.expires_at<=strftime('%s','now')*1000))
   OR (NEW.reason='source_deleted' AND x.state='published' AND source.state IN ('deleting','deleted'))))
BEGIN SELECT RAISE(ABORT,'image_retirement_unproven'); END;
CREATE TRIGGER image_cleanup_block_write BEFORE INSERT ON r2_write_attempts
WHEN NEW.kind='image.put' AND NEW.state='pending' AND EXISTS(
 SELECT 1 FROM image_derivative_cleanup WHERE image_id=json_extract(NEW.source_ref,'$[0]') AND retired_at IS NOT NULL)
BEGIN SELECT RAISE(ABORT,'image_derivative_retired'); END;
CREATE TRIGGER image_cleanup_seal BEFORE UPDATE OF seal_token ON image_derivative_cleanup
WHEN NEW.seal_token IS NOT OLD.seal_token AND NOT EXISTS(SELECT 1 FROM mutation_admissions a JOIN control c ON c.singleton=1
 WHERE a.space_id IS NULL AND a.system=1 AND a.state='active' AND a.epoch=c.epoch AND a.maintenance=c.maintenance
 AND a.permit_id GLOB 'global:images.cleanup-seal:*' AND a.expires_at>strftime('%s','now')*1000)
BEGIN SELECT RAISE(ABORT,'image_seal_unproven'); END;
CREATE TRIGGER image_cleanup_block_ready BEFORE UPDATE OF state ON derivative_results
WHEN NEW.state='ready' AND EXISTS(SELECT 1 FROM image_derivative_objects x JOIN image_derivative_cleanup c ON c.image_id=x.id
 WHERE x.result_id=NEW.id AND c.retired_at IS NOT NULL)
BEGIN SELECT RAISE(ABORT,'image_derivative_retired'); END;
CREATE TRIGGER image_cleanup_settle BEFORE UPDATE OF settled_at ON image_derivative_cleanup
WHEN NEW.settled_at IS NOT NULL AND NOT EXISTS(
 SELECT 1 FROM image_derivative_objects x JOIN blobs b ON b.id=x.output_blob_id
 JOIN reservations r ON r.id=x.reservation_id JOIN blob_pins p ON p.pin_id=x.pin_id
 JOIN derivative_results d ON d.id=x.result_id JOIN control c ON c.singleton=1
 JOIN spaces sp ON sp.owner_id=x.owner_id JOIN mutation_admissions a ON a.space_id=sp.id
 WHERE x.id=NEW.image_id AND NEW.retired_at IS NOT NULL AND NEW.seal_token IS NOT NULL
 AND NEW.claim_epoch=c.epoch AND NEW.claim_deadline>strftime('%s','now')*1000
 AND a.system=1 AND a.state='active' AND a.epoch=c.epoch AND a.maintenance=c.maintenance
 AND a.permit_id GLOB 'system:image.cleanup:*' AND a.expires_at>strftime('%s','now')*1000
 AND d.state='failed' AND d.error_code='image_retired' AND b.state IN ('staging','committed') AND b.ref_count=1
 AND p.blob_id=b.id AND p.purpose='job' AND p.expires_at IS NULL AND r.physical_only=1 AND r.state IN ('reserved','released')
 AND NOT EXISTS(SELECT 1 FROM r2_write_attempts WHERE r2_key=b.r2_key AND state='pending')
 AND ((NEW.disposition='stored' AND EXISTS(SELECT 1 FROM blob_storage s WHERE s.blob_id=b.id AND s.removed_at IS NULL))
 OR (NEW.disposition='absent' AND NEW.head_token=NEW.claim_token AND NEW.head_calls>0
   AND NOT EXISTS(SELECT 1 FROM blob_storage WHERE blob_id=b.id))))
BEGIN SELECT RAISE(ABORT,'image_cleanup_unproven'); END;
DROP TRIGGER image_derivative_pin_hold;
CREATE TRIGGER image_derivative_pin_hold BEFORE DELETE ON blob_pins
WHEN EXISTS(SELECT 1 FROM image_derivative_objects x WHERE x.pin_id=OLD.pin_id
 AND NOT EXISTS(SELECT 1 FROM image_derivative_cleanup c WHERE c.image_id=x.id AND c.settled_at IS NOT NULL))
BEGIN SELECT RAISE(ABORT,'image_derivative_retained'); END;
DROP TRIGGER image_derivative_reservation_hold;
CREATE TRIGGER image_derivative_reservation_hold BEFORE UPDATE OF state ON reservations
WHEN NEW.state<>OLD.state AND EXISTS(SELECT 1 FROM image_derivative_objects WHERE reservation_id=OLD.id)
 AND (NEW.state<>'released' OR NOT EXISTS(SELECT 1 FROM image_derivative_objects x JOIN derivative_results d ON d.id=x.result_id
 LEFT JOIN image_derivative_cleanup c ON c.image_id=x.id WHERE x.reservation_id=OLD.id
 AND ((x.state='published' AND d.state='ready') OR (c.settled_at IS NOT NULL AND d.state='failed' AND d.error_code='image_retired'))))
BEGIN SELECT RAISE(ABORT,'image_derivative_unsettled'); END;

-- Keep backup/restore freeze guards effective on new and modified tables.
CREATE TRIGGER backup_freeze_image_derivative_cleanup_insert BEFORE INSERT ON image_derivative_cleanup
WHEN (SELECT backup_frozen FROM control WHERE singleton=1) =1
BEGIN SELECT RAISE(ABORT,'backup_frozen'); END;
CREATE TRIGGER backup_freeze_image_derivative_cleanup_update BEFORE UPDATE ON image_derivative_cleanup
WHEN (SELECT backup_frozen FROM control WHERE singleton=1) =1
BEGIN SELECT RAISE(ABORT,'backup_frozen'); END;
CREATE TRIGGER backup_freeze_image_derivative_cleanup_delete BEFORE DELETE ON image_derivative_cleanup
WHEN (SELECT backup_frozen FROM control WHERE singleton=1) =1
BEGIN SELECT RAISE(ABORT,'backup_frozen'); END;
CREATE TRIGGER restore_freeze_image_derivative_cleanup_insert BEFORE INSERT ON image_derivative_cleanup
WHEN (SELECT restore_freeze_token FROM control WHERE singleton=1) IS NOT NULL
BEGIN SELECT RAISE(ABORT,'database_restore_frozen'); END;
CREATE TRIGGER restore_freeze_image_derivative_cleanup_update BEFORE UPDATE ON image_derivative_cleanup
WHEN (SELECT restore_freeze_token FROM control WHERE singleton=1) IS NOT NULL
BEGIN SELECT RAISE(ABORT,'database_restore_frozen'); END;
CREATE TRIGGER restore_freeze_image_derivative_cleanup_delete BEFORE DELETE ON image_derivative_cleanup
WHEN (SELECT restore_freeze_token FROM control WHERE singleton=1) IS NOT NULL
BEGIN SELECT RAISE(ABORT,'database_restore_frozen'); END;
DROP TRIGGER backup_freeze_image_derivative_objects_insert;
CREATE TRIGGER backup_freeze_image_derivative_objects_insert BEFORE INSERT ON image_derivative_objects
WHEN (SELECT backup_frozen FROM control WHERE singleton=1)=1
BEGIN SELECT RAISE(ABORT,'backup_frozen'); END;
DROP TRIGGER backup_freeze_image_derivative_objects_update;
CREATE TRIGGER backup_freeze_image_derivative_objects_update BEFORE UPDATE ON image_derivative_objects
WHEN (SELECT backup_frozen FROM control WHERE singleton=1)=1
BEGIN SELECT RAISE(ABORT,'backup_frozen'); END;
DROP TRIGGER backup_freeze_image_derivative_objects_delete;
CREATE TRIGGER backup_freeze_image_derivative_objects_delete BEFORE DELETE ON image_derivative_objects
WHEN (SELECT backup_frozen FROM control WHERE singleton=1)=1
BEGIN SELECT RAISE(ABORT,'backup_frozen'); END;
DROP TRIGGER restore_freeze_image_derivative_objects_insert;
CREATE TRIGGER restore_freeze_image_derivative_objects_insert BEFORE INSERT ON image_derivative_objects
WHEN (SELECT restore_freeze_token FROM control WHERE singleton=1) IS NOT NULL
BEGIN SELECT RAISE(ABORT,'database_restore_frozen'); END;
DROP TRIGGER restore_freeze_image_derivative_objects_update;
CREATE TRIGGER restore_freeze_image_derivative_objects_update BEFORE UPDATE ON image_derivative_objects
WHEN (SELECT restore_freeze_token FROM control WHERE singleton=1) IS NOT NULL
BEGIN SELECT RAISE(ABORT,'database_restore_frozen'); END;
DROP TRIGGER restore_freeze_image_derivative_objects_delete;
CREATE TRIGGER restore_freeze_image_derivative_objects_delete BEFORE DELETE ON image_derivative_objects
WHEN (SELECT restore_freeze_token FROM control WHERE singleton=1) IS NOT NULL
BEGIN SELECT RAISE(ABORT,'database_restore_frozen'); END;
DROP TRIGGER backup_freeze_r2_write_attempts_insert;
CREATE TRIGGER backup_freeze_r2_write_attempts_insert BEFORE INSERT ON r2_write_attempts
WHEN (SELECT backup_frozen FROM control WHERE singleton=1)=1
BEGIN SELECT RAISE(ABORT,'backup_frozen'); END;
DROP TRIGGER backup_freeze_r2_write_attempts_update;
CREATE TRIGGER backup_freeze_r2_write_attempts_update BEFORE UPDATE ON r2_write_attempts
WHEN (SELECT backup_frozen FROM control WHERE singleton=1)=1
BEGIN SELECT RAISE(ABORT,'backup_frozen'); END;
DROP TRIGGER backup_freeze_r2_write_attempts_delete;
CREATE TRIGGER backup_freeze_r2_write_attempts_delete BEFORE DELETE ON r2_write_attempts
WHEN (SELECT backup_frozen FROM control WHERE singleton=1)=1
BEGIN SELECT RAISE(ABORT,'backup_frozen'); END;
DROP TRIGGER restore_freeze_r2_write_attempts_insert;
CREATE TRIGGER restore_freeze_r2_write_attempts_insert BEFORE INSERT ON r2_write_attempts
WHEN (SELECT restore_freeze_token FROM control WHERE singleton=1) IS NOT NULL
BEGIN SELECT RAISE(ABORT,'database_restore_frozen'); END;
DROP TRIGGER restore_freeze_r2_write_attempts_update;
CREATE TRIGGER restore_freeze_r2_write_attempts_update BEFORE UPDATE ON r2_write_attempts
WHEN (SELECT restore_freeze_token FROM control WHERE singleton=1) IS NOT NULL
BEGIN SELECT RAISE(ABORT,'database_restore_frozen'); END;
DROP TRIGGER restore_freeze_r2_write_attempts_delete;
CREATE TRIGGER restore_freeze_r2_write_attempts_delete BEFORE DELETE ON r2_write_attempts
WHEN (SELECT restore_freeze_token FROM control WHERE singleton=1) IS NOT NULL
BEGIN SELECT RAISE(ABORT,'database_restore_frozen'); END;
DROP TRIGGER backup_freeze_derivative_results_insert;
CREATE TRIGGER backup_freeze_derivative_results_insert BEFORE INSERT ON derivative_results
WHEN (SELECT backup_frozen FROM control WHERE singleton=1)=1
BEGIN SELECT RAISE(ABORT,'backup_frozen'); END;
DROP TRIGGER backup_freeze_derivative_results_update;
CREATE TRIGGER backup_freeze_derivative_results_update BEFORE UPDATE ON derivative_results
WHEN (SELECT backup_frozen FROM control WHERE singleton=1)=1
BEGIN SELECT RAISE(ABORT,'backup_frozen'); END;
DROP TRIGGER backup_freeze_derivative_results_delete;
CREATE TRIGGER backup_freeze_derivative_results_delete BEFORE DELETE ON derivative_results
WHEN (SELECT backup_frozen FROM control WHERE singleton=1)=1
BEGIN SELECT RAISE(ABORT,'backup_frozen'); END;
DROP TRIGGER restore_freeze_derivative_results_insert;
CREATE TRIGGER restore_freeze_derivative_results_insert BEFORE INSERT ON derivative_results
WHEN (SELECT restore_freeze_token FROM control WHERE singleton=1) IS NOT NULL
BEGIN SELECT RAISE(ABORT,'database_restore_frozen'); END;
DROP TRIGGER restore_freeze_derivative_results_update;
CREATE TRIGGER restore_freeze_derivative_results_update BEFORE UPDATE ON derivative_results
WHEN (SELECT restore_freeze_token FROM control WHERE singleton=1) IS NOT NULL
BEGIN SELECT RAISE(ABORT,'database_restore_frozen'); END;
DROP TRIGGER restore_freeze_derivative_results_delete;
CREATE TRIGGER restore_freeze_derivative_results_delete BEFORE DELETE ON derivative_results
WHEN (SELECT restore_freeze_token FROM control WHERE singleton=1) IS NOT NULL
BEGIN SELECT RAISE(ABORT,'database_restore_frozen'); END;
DROP TRIGGER backup_freeze_blob_pins_insert;
CREATE TRIGGER backup_freeze_blob_pins_insert BEFORE INSERT ON blob_pins
WHEN (SELECT backup_frozen FROM control WHERE singleton=1)=1
BEGIN SELECT RAISE(ABORT,'backup_frozen'); END;
DROP TRIGGER backup_freeze_blob_pins_update;
CREATE TRIGGER backup_freeze_blob_pins_update BEFORE UPDATE ON blob_pins
WHEN (SELECT backup_frozen FROM control WHERE singleton=1)=1
BEGIN SELECT RAISE(ABORT,'backup_frozen'); END;
DROP TRIGGER backup_freeze_blob_pins_delete;
CREATE TRIGGER backup_freeze_blob_pins_delete BEFORE DELETE ON blob_pins
WHEN (SELECT backup_frozen FROM control WHERE singleton=1)=1
BEGIN SELECT RAISE(ABORT,'backup_frozen'); END;
DROP TRIGGER restore_freeze_blob_pins_insert;
CREATE TRIGGER restore_freeze_blob_pins_insert BEFORE INSERT ON blob_pins
WHEN (SELECT restore_freeze_token FROM control WHERE singleton=1) IS NOT NULL
BEGIN SELECT RAISE(ABORT,'database_restore_frozen'); END;
DROP TRIGGER restore_freeze_blob_pins_update;
CREATE TRIGGER restore_freeze_blob_pins_update BEFORE UPDATE ON blob_pins
WHEN (SELECT restore_freeze_token FROM control WHERE singleton=1) IS NOT NULL
BEGIN SELECT RAISE(ABORT,'database_restore_frozen'); END;
DROP TRIGGER restore_freeze_blob_pins_delete;
CREATE TRIGGER restore_freeze_blob_pins_delete BEFORE DELETE ON blob_pins
WHEN (SELECT restore_freeze_token FROM control WHERE singleton=1) IS NOT NULL
BEGIN SELECT RAISE(ABORT,'database_restore_frozen'); END;
DROP TRIGGER backup_freeze_reservations_insert;
CREATE TRIGGER backup_freeze_reservations_insert BEFORE INSERT ON reservations
WHEN (SELECT backup_frozen FROM control WHERE singleton=1)=1
BEGIN SELECT RAISE(ABORT,'backup_frozen'); END;
DROP TRIGGER backup_freeze_reservations_update;
CREATE TRIGGER backup_freeze_reservations_update BEFORE UPDATE ON reservations
WHEN (SELECT backup_frozen FROM control WHERE singleton=1)=1
BEGIN SELECT RAISE(ABORT,'backup_frozen'); END;
DROP TRIGGER backup_freeze_reservations_delete;
CREATE TRIGGER backup_freeze_reservations_delete BEFORE DELETE ON reservations
WHEN (SELECT backup_frozen FROM control WHERE singleton=1)=1
BEGIN SELECT RAISE(ABORT,'backup_frozen'); END;
DROP TRIGGER restore_freeze_reservations_insert;
CREATE TRIGGER restore_freeze_reservations_insert BEFORE INSERT ON reservations
WHEN (SELECT restore_freeze_token FROM control WHERE singleton=1) IS NOT NULL
BEGIN SELECT RAISE(ABORT,'database_restore_frozen'); END;
DROP TRIGGER restore_freeze_reservations_update;
CREATE TRIGGER restore_freeze_reservations_update BEFORE UPDATE ON reservations
WHEN (SELECT restore_freeze_token FROM control WHERE singleton=1) IS NOT NULL
BEGIN SELECT RAISE(ABORT,'database_restore_frozen'); END;
DROP TRIGGER restore_freeze_reservations_delete;
CREATE TRIGGER restore_freeze_reservations_delete BEFORE DELETE ON reservations
WHEN (SELECT restore_freeze_token FROM control WHERE singleton=1) IS NOT NULL
BEGIN SELECT RAISE(ABORT,'database_restore_frozen'); END;
