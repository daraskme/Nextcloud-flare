-- Stop admission and drain outstanding work before changing receipt cleanup rules.
INSERT INTO _assert(v) SELECT 1 WHERE NOT EXISTS(SELECT 1 FROM control WHERE singleton=1 AND maintenance=1)
 OR EXISTS(SELECT 1 FROM mutation_admissions WHERE state IN ('waiting','active'))
 OR EXISTS(SELECT 1 FROM permits WHERE state='open') OR EXISTS(SELECT 1 FROM operations WHERE state='claimed');

ALTER TABLE mutation_admissions ADD COLUMN committed_at INTEGER CHECK(committed_at IS NULL OR (
 committed_at BETWEEN 0 AND 9007199254740991 AND state='closed' AND granted_at IS NOT NULL
 AND committed_at>=granted_at AND committed_at<expires_at));
CREATE TRIGGER mutation_commit_insert BEFORE INSERT ON mutation_admissions
WHEN NEW.committed_at IS NOT NULL
BEGIN SELECT RAISE(ABORT,'invalid_mutation_commit'); END;
CREATE TRIGGER mutation_commit_update BEFORE UPDATE OF committed_at ON mutation_admissions
WHEN NEW.committed_at IS NOT OLD.committed_at AND (
 OLD.committed_at IS NOT NULL OR NEW.committed_at IS NULL OR OLD.state<>'active' OR NEW.state<>'closed'
 OR NEW.committed_at<>strftime('%s','now')*1000 OR OLD.expires_at<=strftime('%s','now')*1000
 OR NOT EXISTS(SELECT 1 FROM control WHERE singleton=1 AND epoch=OLD.epoch AND maintenance=0)
 OR EXISTS(SELECT 1 FROM permits WHERE permit_id=OLD.permit_id))
BEGIN SELECT RAISE(ABORT,'invalid_mutation_commit'); END;

DROP TRIGGER mutation_admission_delete;
CREATE TRIGGER mutation_admission_delete BEFORE DELETE ON mutation_admissions
WHEN OLD.state<>'closed' OR MAX(OLD.wait_until,COALESCE(OLD.committed_at+60000,0))>strftime('%s','now')*1000
BEGIN SELECT RAISE(ABORT,'mutation_receipt_required'); END;
DROP INDEX mutation_admissions_cleanup;
CREATE INDEX mutation_admissions_cleanup
 ON mutation_admissions(state,MAX(wait_until,COALESCE(committed_at+60000,0)),seq);
