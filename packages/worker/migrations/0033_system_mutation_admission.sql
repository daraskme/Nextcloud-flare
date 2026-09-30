-- Extend the same capacity ledger for typed internal facts while normal work is stopped.
-- Old receipts and AUTOINCREMENT sequence remain in place; apply only after draining work.
INSERT INTO _assert(v) SELECT 1 WHERE NOT EXISTS(SELECT 1 FROM control WHERE singleton=1 AND maintenance=1)
 OR EXISTS(SELECT 1 FROM mutation_admissions WHERE state<>'closed')
 OR EXISTS(SELECT 1 FROM permits WHERE state='open') OR EXISTS(SELECT 1 FROM operations WHERE state='claimed');

ALTER TABLE mutation_admissions ADD COLUMN system INTEGER NOT NULL DEFAULT 0
 CHECK(system IN (0,1) AND (system=0 OR (space_id IS NOT NULL AND substr(permit_id,1,7)='system:')));
ALTER TABLE mutation_admissions ADD COLUMN maintenance INTEGER NOT NULL DEFAULT 0
 CHECK(maintenance IN (0,1) AND maintenance<=system);

DROP TRIGGER mutation_admission_insert;
DROP TRIGGER mutation_admission_identity;
DROP TRIGGER mutation_admission_grant;
DROP TRIGGER permit_mutation_admission;
DROP TRIGGER control_close_mutation_admission;
DROP TRIGGER mutation_commit_update;

CREATE TRIGGER mutation_admission_insert BEFORE INSERT ON mutation_admissions
WHEN NEW.state<>'waiting' OR NEW.granted_at IS NOT NULL
 OR (NEW.system=0 AND substr(NEW.permit_id,1,7)='system:')
 OR NEW.requested_at<>strftime('%s','now')*1000 OR NEW.wait_until<=strftime('%s','now')*1000
 OR NOT EXISTS(SELECT 1 FROM control WHERE singleton=1 AND maintenance=NEW.maintenance AND epoch=NEW.epoch)
 OR EXISTS(SELECT 1 FROM permits WHERE permit_id=NEW.permit_id)
 OR (SELECT COUNT(*) FROM mutation_admissions WHERE state='waiting')>=256
BEGIN SELECT RAISE(ABORT,'mutation_unavailable'); END;
CREATE TRIGGER mutation_admission_identity BEFORE UPDATE ON mutation_admissions
WHEN NEW.seq<>OLD.seq OR NEW.id<>OLD.id OR NEW.permit_id<>OLD.permit_id OR NEW.space_id IS NOT OLD.space_id
 OR NEW.epoch<>OLD.epoch OR NEW.system<>OLD.system OR NEW.maintenance<>OLD.maintenance
 OR NEW.requested_at<>OLD.requested_at OR NEW.wait_until<>OLD.wait_until
 OR OLD.state='closed' OR NEW.state='waiting'
 OR (OLD.state='active' AND (NEW.state<>'closed' OR NEW.granted_at IS NOT OLD.granted_at OR NEW.expires_at IS NOT OLD.expires_at))
 OR (NEW.state='closed' AND (NEW.granted_at IS NOT OLD.granted_at OR NEW.expires_at IS NOT OLD.expires_at))
BEGIN SELECT RAISE(ABORT,'immutable_mutation_admission'); END;
CREATE TRIGGER mutation_admission_grant BEFORE UPDATE ON mutation_admissions
WHEN NEW.state='active' AND (
 NEW.granted_at<>strftime('%s','now')*1000 OR NEW.wait_until<=strftime('%s','now')*1000
 OR NOT EXISTS(SELECT 1 FROM control WHERE singleton=1 AND maintenance=NEW.maintenance AND epoch=NEW.epoch)
 OR (SELECT COUNT(*) FROM mutation_admissions WHERE state='active')>=32)
BEGIN SELECT RAISE(ABORT,'mutation_unavailable'); END;

-- Internal tickets never authorize namespace permits, including in normal mode.
CREATE TRIGGER permit_mutation_admission BEFORE INSERT ON permits
WHEN (NEW.state='open' AND substr(NEW.permit_id,1,7)='system:') OR (
 NEW.state='open' AND NEW.expires_at>strftime('%s','now')*1000
 AND EXISTS(SELECT 1 FROM control WHERE singleton=1 AND maintenance=0 AND epoch=NEW.epoch)
 AND NOT EXISTS(SELECT 1 FROM mutation_admissions WHERE permit_id=NEW.permit_id AND space_id=NEW.space_id
  AND epoch=NEW.epoch AND system=0 AND maintenance=0 AND state='active' AND expires_at>=NEW.expires_at))
BEGIN SELECT RAISE(ABORT,'mutation_admission_required'); END;
CREATE TRIGGER control_close_mutation_admission AFTER UPDATE OF maintenance,epoch ON control
WHEN NEW.maintenance=1 OR NEW.maintenance<>OLD.maintenance OR NEW.epoch<>OLD.epoch
BEGIN UPDATE mutation_admissions SET state='closed' WHERE state<>'closed'; END;
CREATE TRIGGER mutation_commit_update BEFORE UPDATE OF committed_at ON mutation_admissions
WHEN NEW.committed_at IS NOT OLD.committed_at AND (
 OLD.committed_at IS NOT NULL OR NEW.committed_at IS NULL OR OLD.state<>'active' OR NEW.state<>'closed'
 OR NEW.committed_at<>strftime('%s','now')*1000 OR OLD.expires_at<=strftime('%s','now')*1000
 OR NOT EXISTS(SELECT 1 FROM control WHERE singleton=1 AND epoch=OLD.epoch AND maintenance=OLD.maintenance)
 OR EXISTS(SELECT 1 FROM permits WHERE permit_id=OLD.permit_id))
BEGIN SELECT RAISE(ABORT,'invalid_mutation_commit'); END;
