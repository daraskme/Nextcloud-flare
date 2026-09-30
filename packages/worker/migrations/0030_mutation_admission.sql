-- Apply only after stopping admission and draining namespace work.
INSERT INTO _assert(v) SELECT 1 WHERE NOT EXISTS(SELECT 1 FROM control WHERE singleton=1 AND maintenance=1)
 OR EXISTS(SELECT 1 FROM permits WHERE state='open') OR EXISTS(SELECT 1 FROM operations WHERE state='claimed');

CREATE TABLE mutation_admissions(
 seq INTEGER PRIMARY KEY AUTOINCREMENT,
 id TEXT NOT NULL UNIQUE CHECK(length(id)=36),
 permit_id TEXT NOT NULL CHECK(length(permit_id) BETWEEN 1 AND 128),
 space_id TEXT NOT NULL REFERENCES spaces(id),
 epoch INTEGER NOT NULL CHECK(epoch>0),
 requested_at INTEGER NOT NULL CHECK(requested_at>=0),
 wait_until INTEGER NOT NULL CHECK(wait_until>requested_at AND wait_until<=requested_at+5000),
 state TEXT NOT NULL DEFAULT 'waiting' CHECK(state IN ('waiting','active','closed')),
 granted_at INTEGER,
 expires_at INTEGER,
 CHECK((granted_at IS NULL)=(expires_at IS NULL)),
 CHECK(granted_at IS NULL OR (granted_at>=requested_at AND granted_at<wait_until AND expires_at=granted_at+30000)),
 CHECK(state<>'waiting' OR granted_at IS NULL),
 CHECK(state<>'active' OR granted_at IS NOT NULL)
) STRICT;
CREATE INDEX mutation_admissions_space ON mutation_admissions(space_id);
CREATE INDEX mutation_admissions_state ON mutation_admissions(state,seq);
CREATE INDEX mutation_admissions_cleanup ON mutation_admissions(state,wait_until,seq);
CREATE INDEX mutation_admissions_permit ON mutation_admissions(permit_id);
CREATE UNIQUE INDEX mutation_admissions_live_permit ON mutation_admissions(permit_id) WHERE state<>'closed';
CREATE TRIGGER mutation_admission_insert BEFORE INSERT ON mutation_admissions
WHEN NEW.state<>'waiting' OR NEW.granted_at IS NOT NULL
 OR NEW.requested_at<>strftime('%s','now')*1000 OR NEW.wait_until<=strftime('%s','now')*1000
 OR NOT EXISTS(SELECT 1 FROM control WHERE singleton=1 AND maintenance=0 AND epoch=NEW.epoch)
 OR EXISTS(SELECT 1 FROM permits WHERE permit_id=NEW.permit_id)
 OR (SELECT COUNT(*) FROM mutation_admissions WHERE state='waiting')>=256
BEGIN SELECT RAISE(ABORT,'mutation_unavailable'); END;
CREATE TRIGGER mutation_admission_identity BEFORE UPDATE ON mutation_admissions
WHEN NEW.seq<>OLD.seq OR NEW.id<>OLD.id OR NEW.permit_id<>OLD.permit_id OR NEW.space_id<>OLD.space_id
 OR NEW.epoch<>OLD.epoch OR NEW.requested_at<>OLD.requested_at OR NEW.wait_until<>OLD.wait_until
 OR OLD.state='closed' OR NEW.state='waiting'
 OR (OLD.state='active' AND (NEW.state<>'closed' OR NEW.granted_at IS NOT OLD.granted_at OR NEW.expires_at IS NOT OLD.expires_at))
 OR (NEW.state='closed' AND (NEW.granted_at IS NOT OLD.granted_at OR NEW.expires_at IS NOT OLD.expires_at))
BEGIN SELECT RAISE(ABORT,'immutable_mutation_admission'); END;
CREATE TRIGGER mutation_admission_grant BEFORE UPDATE ON mutation_admissions
WHEN NEW.state='active' AND (
 NEW.granted_at<>strftime('%s','now')*1000 OR NEW.wait_until<=strftime('%s','now')*1000
 OR NOT EXISTS(SELECT 1 FROM control WHERE singleton=1 AND maintenance=0 AND epoch=NEW.epoch)
 OR (SELECT COUNT(*) FROM mutation_admissions WHERE state='active')>=32)
BEGIN SELECT RAISE(ABORT,'mutation_unavailable'); END;
CREATE TRIGGER mutation_admission_delete BEFORE DELETE ON mutation_admissions
WHEN OLD.state<>'closed' OR OLD.wait_until>strftime('%s','now')*1000
BEGIN SELECT RAISE(ABORT,'mutation_receipt_required'); END;

-- Expired/old/stopped rows may be imported for recovery, but cannot authorize a commit.
CREATE TRIGGER permit_mutation_admission BEFORE INSERT ON permits
WHEN NEW.state='open' AND NEW.expires_at>strftime('%s','now')*1000
 AND EXISTS(SELECT 1 FROM control WHERE singleton=1 AND maintenance=0 AND epoch=NEW.epoch)
 AND NOT EXISTS(SELECT 1 FROM mutation_admissions WHERE permit_id=NEW.permit_id AND space_id=NEW.space_id
  AND epoch=NEW.epoch AND state='active' AND expires_at>=NEW.expires_at)
BEGIN SELECT RAISE(ABORT,'mutation_admission_required'); END;
CREATE TRIGGER mutation_admission_close AFTER UPDATE OF state ON mutation_admissions
WHEN NEW.state='closed' AND OLD.state<>'closed'
BEGIN
 UPDATE permits SET state='revoked' WHERE permit_id=NEW.permit_id AND state='open';
 UPDATE operations SET state='failed',error_code=COALESCE((SELECT 'stale_epoch' WHERE NEW.epoch<>(SELECT epoch FROM control WHERE singleton=1)),(SELECT 'maintenance' WHERE (SELECT maintenance FROM control WHERE singleton=1)=1),'mutation_admission_closed'),updated_at=MAX(updated_at,strftime('%s','now')*1000)
  WHERE permit_id=NEW.permit_id AND state='claimed';
END;
CREATE TRIGGER permit_close_mutation_admission AFTER UPDATE OF state ON permits
WHEN OLD.state='open' AND NEW.state<>'open'
BEGIN UPDATE mutation_admissions SET state='closed' WHERE permit_id=NEW.permit_id AND state<>'closed'; END;
CREATE TRIGGER control_close_mutation_admission AFTER UPDATE OF maintenance,epoch ON control
WHEN NEW.maintenance=1 OR NEW.epoch<>OLD.epoch
BEGIN UPDATE mutation_admissions SET state='closed' WHERE state<>'closed'; END;
