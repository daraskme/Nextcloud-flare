-- Dispatch receipts contain no password, pepper, salt, input or derived output.
ALTER TABLE control ADD COLUMN kdf_not_before INTEGER NOT NULL DEFAULT 0 CHECK(kdf_not_before>=0);
CREATE TRIGGER kdf_epoch_cooldown AFTER UPDATE OF epoch ON control
WHEN NEW.epoch<>OLD.epoch
BEGIN UPDATE control SET kdf_not_before=MAX(kdf_not_before,strftime('%s','now')*1000+65000) WHERE singleton=1; END;
CREATE TABLE kdf_attempts(
 id TEXT NOT NULL PRIMARY KEY CHECK(length(id)=36),
 dispatch_token TEXT NOT NULL UNIQUE CHECK(length(dispatch_token)=36),
 epoch INTEGER NOT NULL CHECK(epoch>0),
 issued_at INTEGER NOT NULL CHECK(issued_at>=0),
 expires_at INTEGER NOT NULL CHECK(expires_at>issued_at AND expires_at<=issued_at+5000),
 state TEXT NOT NULL DEFAULT 'claimed' CHECK(state IN ('claimed','finished','not_started')),
 finished_at INTEGER CHECK(finished_at>=issued_at),
 CHECK((state='claimed')=(finished_at IS NULL))
) STRICT;
CREATE INDEX kdf_attempts_state ON kdf_attempts(state,issued_at);
CREATE INDEX kdf_attempts_issued ON kdf_attempts(issued_at);
CREATE TRIGGER kdf_attempt_insert BEFORE INSERT ON kdf_attempts
WHEN NEW.state<>'claimed' OR NEW.issued_at<>strftime('%s','now')*1000
 OR NEW.expires_at<=strftime('%s','now')*1000
 OR NOT EXISTS(SELECT 1 FROM control WHERE singleton=1 AND epoch=NEW.epoch AND maintenance=0
  AND kdf_not_before<=strftime('%s','now')*1000)
 OR (SELECT COUNT(*) FROM kdf_attempts WHERE issued_at>strftime('%s','now')*1000-65000)>=600
 OR (SELECT COUNT(*) FROM kdf_attempts WHERE state='claimed')>=20
BEGIN SELECT RAISE(ABORT,'kdf_unavailable'); END;
CREATE TRIGGER kdf_attempt_update BEFORE UPDATE ON kdf_attempts
WHEN OLD.state<>'claimed' OR NEW.state='claimed' OR NEW.id<>OLD.id OR NEW.dispatch_token<>OLD.dispatch_token
 OR NEW.epoch<>OLD.epoch OR NEW.issued_at<>OLD.issued_at OR NEW.expires_at<>OLD.expires_at
BEGIN SELECT RAISE(ABORT,'immutable_kdf_attempt'); END;
CREATE TRIGGER kdf_attempt_delete BEFORE DELETE ON kdf_attempts
WHEN OLD.state='claimed' OR OLD.issued_at>strftime('%s','now')*1000-65000
BEGIN SELECT RAISE(ABORT,'kdf_receipt_required'); END;
