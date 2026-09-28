-- Native image costs survive caller loss; physical R2 publication is a separate operation.
INSERT INTO _assert(v) SELECT 1 WHERE NOT EXISTS(
 SELECT 1 FROM control WHERE singleton=1 AND maintenance=1 AND backup_token IS NULL
 AND backup_frozen=0 AND restore_freeze_token IS NULL)
 OR EXISTS(SELECT 1 FROM permits WHERE state='open')
 OR EXISTS(SELECT 1 FROM operations WHERE state='claimed')
 OR EXISTS(SELECT 1 FROM mutation_admissions WHERE state<>'closed')
 OR EXISTS(SELECT 1 FROM r2_write_attempts WHERE state='pending')
 OR EXISTS(SELECT 1 FROM kdf_attempts WHERE state='claimed');
CREATE TABLE image_transform_attempts(
 id TEXT PRIMARY KEY CHECK(length(id)=36), token TEXT NOT NULL UNIQUE CHECK(length(token)=36),
 epoch INTEGER NOT NULL CHECK(epoch>0), owner_id TEXT NOT NULL CHECK(length(owner_id) BETWEEN 1 AND 128),
 blob_id TEXT NOT NULL CHECK(length(blob_id) BETWEEN 1 AND 128), outbox_id TEXT NOT NULL CHECK(length(outbox_id) BETWEEN 1 AND 128),
 variant TEXT NOT NULL CHECK(variant IN ('sm','md','lg')),
 generator_version TEXT NOT NULL CHECK(length(generator_version) BETWEEN 1 AND 128),
 claim_token TEXT NOT NULL CHECK(length(claim_token)=36),
 source_json TEXT NOT NULL CHECK(json_valid(source_json) AND length(CAST(source_json AS BLOB))<=2048),
 started_at INTEGER NOT NULL CHECK(started_at>=0), dispatch_before INTEGER NOT NULL,
 expires_at INTEGER NOT NULL CHECK(expires_at>=dispatch_before AND expires_at<=started_at+25000),
 state TEXT NOT NULL CHECK(state IN ('pending','succeeded','not_started')),
 finished_at INTEGER CHECK(finished_at>=started_at),
 output_json TEXT CHECK(json_valid(output_json) AND length(CAST(output_json AS BLOB))<=512),
 CHECK(dispatch_before>started_at AND dispatch_before<=started_at+5000),
 CHECK((state='pending')=(finished_at IS NULL)),
 CHECK((state='succeeded')=(output_json IS NOT NULL))
) STRICT;
CREATE INDEX image_attempt_owner ON image_transform_attempts(owner_id);
CREATE INDEX image_attempt_blob ON image_transform_attempts(blob_id);
CREATE INDEX image_attempt_outbox ON image_transform_attempts(outbox_id);
CREATE INDEX image_attempt_pending ON image_transform_attempts(state,id);
CREATE UNIQUE INDEX image_attempt_cost ON image_transform_attempts(blob_id,variant,generator_version)
 WHERE state<>'not_started';
CREATE TRIGGER image_attempt_dispatch BEFORE INSERT ON image_transform_attempts
WHEN NEW.state='pending' AND (
 NEW.dispatch_before<=strftime('%s','now')*1000+1000
 OR NOT EXISTS(SELECT 1 FROM control WHERE singleton=1 AND epoch=NEW.epoch AND maintenance=0
   AND backup_token IS NULL AND backup_frozen=0 AND restore_freeze_token IS NULL)
 OR (SELECT COUNT(*) FROM image_transform_attempts WHERE state='pending')>=8
 OR NOT EXISTS(SELECT 1 FROM outbox WHERE outbox_id=NEW.outbox_id AND epoch=NEW.epoch
   AND state IN ('dispatching','sent') AND claim_token=NEW.claim_token AND claim_expires_at>=NEW.expires_at))
BEGIN SELECT RAISE(ABORT,'image_transform_unavailable'); END;
CREATE TRIGGER image_attempt_immutable BEFORE UPDATE ON image_transform_attempts
WHEN OLD.state<>'pending' OR NEW.state='pending' OR NEW.id IS NOT OLD.id OR NEW.token IS NOT OLD.token
 OR NEW.epoch IS NOT OLD.epoch OR NEW.owner_id IS NOT OLD.owner_id OR NEW.blob_id IS NOT OLD.blob_id
 OR NEW.outbox_id IS NOT OLD.outbox_id OR NEW.variant IS NOT OLD.variant
 OR NEW.generator_version IS NOT OLD.generator_version OR NEW.claim_token IS NOT OLD.claim_token
 OR NEW.source_json IS NOT OLD.source_json OR NEW.started_at IS NOT OLD.started_at
 OR NEW.dispatch_before IS NOT OLD.dispatch_before OR NEW.expires_at IS NOT OLD.expires_at
BEGIN SELECT RAISE(ABORT,'immutable_image_transform'); END;
-- Retain cost and terminal facts; cleanup must eventually prove blob deletion and backup expiry.
CREATE TRIGGER image_attempt_keep BEFORE DELETE ON image_transform_attempts
BEGIN SELECT RAISE(ABORT,'image_transform_receipt_required'); END;
CREATE TRIGGER image_attempt_restore_hold BEFORE UPDATE OF restore_freeze_token ON control
WHEN NEW.restore_freeze_token IS NOT NULL AND EXISTS(SELECT 1 FROM image_transform_attempts WHERE state='pending')
BEGIN SELECT RAISE(ABORT,'image_transform_unsettled'); END;
CREATE TRIGGER image_attempt_backup_hold BEFORE UPDATE OF backup_frozen ON control
WHEN NEW.backup_frozen=1 AND EXISTS(SELECT 1 FROM image_transform_attempts WHERE state='pending')
BEGIN SELECT RAISE(ABORT,'image_transform_unsettled'); END;
CREATE TRIGGER image_attempt_resume_hold BEFORE UPDATE OF maintenance ON control
WHEN NEW.maintenance=0 AND OLD.maintenance=1 AND EXISTS(SELECT 1 FROM image_transform_attempts WHERE state='pending')
BEGIN SELECT RAISE(ABORT,'image_transform_unsettled'); END;
CREATE TRIGGER image_attempt_blob_hold BEFORE UPDATE OF state ON blobs
WHEN NEW.state='deleting' AND EXISTS(SELECT 1 FROM image_transform_attempts WHERE blob_id=NEW.id AND state='pending')
BEGIN SELECT RAISE(ABORT,'image_transform_unsettled'); END;
CREATE TRIGGER backup_freeze_image_transform_attempts_insert BEFORE INSERT ON image_transform_attempts
WHEN (SELECT backup_frozen FROM control WHERE singleton=1)=1
BEGIN SELECT RAISE(ABORT,'backup_frozen'); END;
CREATE TRIGGER backup_freeze_image_transform_attempts_update BEFORE UPDATE ON image_transform_attempts
WHEN (SELECT backup_frozen FROM control WHERE singleton=1)=1
BEGIN SELECT RAISE(ABORT,'backup_frozen'); END;
CREATE TRIGGER backup_freeze_image_transform_attempts_delete BEFORE DELETE ON image_transform_attempts
WHEN (SELECT backup_frozen FROM control WHERE singleton=1)=1
BEGIN SELECT RAISE(ABORT,'backup_frozen'); END;
CREATE TRIGGER restore_freeze_image_transform_attempts_insert BEFORE INSERT ON image_transform_attempts
WHEN (SELECT restore_freeze_token FROM control WHERE singleton=1) IS NOT NULL
BEGIN SELECT RAISE(ABORT,'database_restore_frozen'); END;
CREATE TRIGGER restore_freeze_image_transform_attempts_update BEFORE UPDATE ON image_transform_attempts
WHEN (SELECT restore_freeze_token FROM control WHERE singleton=1) IS NOT NULL
BEGIN SELECT RAISE(ABORT,'database_restore_frozen'); END;
CREATE TRIGGER restore_freeze_image_transform_attempts_delete BEFORE DELETE ON image_transform_attempts
WHEN (SELECT restore_freeze_token FROM control WHERE singleton=1) IS NOT NULL
BEGIN SELECT RAISE(ABORT,'database_restore_frozen'); END;
