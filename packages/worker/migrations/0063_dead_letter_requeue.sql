-- One administrative wake-up per observation. Preserve the original delivery and job identities.
INSERT INTO _assert(v) SELECT 1 WHERE NOT EXISTS(SELECT 1 FROM control WHERE singleton=1
  AND maintenance=1 AND backup_token IS NULL AND backup_frozen=0 AND restore_freeze_token IS NULL)
  OR EXISTS(SELECT 1 FROM permits WHERE state='open') OR EXISTS(SELECT 1 FROM operations WHERE state='claimed')
  OR EXISTS(SELECT 1 FROM mutation_admissions WHERE state<>'closed');
ALTER TABLE queue_dead_letters ADD COLUMN requeue_id TEXT REFERENCES activity(id)
  CHECK(requeue_id IS NULL OR (length(requeue_id)=68 AND substr(requeue_id,1,4)='dlq_' AND substr(requeue_id,5) NOT GLOB '*[^a-f0-9]*'));
ALTER TABLE queue_dead_letters ADD COLUMN requeue_actor_id TEXT REFERENCES users(id);
ALTER TABLE queue_dead_letters ADD COLUMN requeue_credential_id TEXT REFERENCES credentials(id);
ALTER TABLE queue_dead_letters ADD COLUMN requeue_epoch INTEGER CHECK(requeue_epoch IS NULL OR requeue_epoch>0);
ALTER TABLE queue_dead_letters ADD COLUMN requeued_at INTEGER CHECK(requeued_at IS NULL OR requeued_at>=received_at);
CREATE UNIQUE INDEX queue_dead_letters_requeue ON queue_dead_letters(requeue_id);
CREATE INDEX queue_dead_letters_actor_fk ON queue_dead_letters(requeue_actor_id);
CREATE INDEX queue_dead_letters_credential_fk ON queue_dead_letters(requeue_credential_id);
DROP TRIGGER queue_dead_letters_identity;
CREATE TRIGGER queue_dead_letters_identity BEFORE UPDATE ON queue_dead_letters
WHEN NEW.message_id<>OLD.message_id OR NEW.outbox_id IS NOT OLD.outbox_id
  OR NEW.sent_at<>OLD.sent_at OR NEW.received_at<>OLD.received_at OR NEW.epoch<>OLD.epoch
  OR OLD.requeue_id IS NOT NULL
BEGIN SELECT RAISE(ABORT,'immutable_dead_letter'); END;
CREATE TRIGGER queue_dead_letters_requeue_insert BEFORE INSERT ON queue_dead_letters
WHEN NEW.requeue_id IS NOT NULL OR NEW.requeue_actor_id IS NOT NULL OR NEW.requeue_credential_id IS NOT NULL
  OR NEW.requeue_epoch IS NOT NULL OR NEW.requeued_at IS NOT NULL
BEGIN SELECT RAISE(ABORT,'invalid_dead_letter_requeue'); END;
CREATE TRIGGER queue_dead_letters_requeue_update BEFORE UPDATE ON queue_dead_letters
WHEN NEW.requeue_id IS NULL OR NEW.requeue_actor_id IS NULL OR NEW.requeue_credential_id IS NULL
  OR NEW.requeue_epoch IS NULL OR NEW.requeued_at IS NULL OR NEW.outbox_id IS NULL
  OR NOT EXISTS(SELECT 1 FROM activity a JOIN outbox b ON b.op_id=a.op_id
    JOIN operations o ON o.op_id=b.op_id JOIN control ctl ON ctl.singleton=1
    JOIN credentials c ON c.id=NEW.requeue_credential_id JOIN sessions s ON s.id=c.session_id
    JOIN users u ON u.id=s.user_id
    WHERE a.id=NEW.requeue_id AND a.kind='admin.dlq' AND a.actor_id=NEW.requeue_actor_id
      AND a.affected_id=NEW.message_id AND a.created_at=NEW.requeued_at
      AND b.outbox_id=NEW.outbox_id AND b.state='pending' AND b.epoch=NEW.requeue_epoch
      AND b.dispatch_token IS NULL AND b.dispatch_expires_at IS NULL
      AND o.state='committed' AND o.epoch=b.epoch AND ctl.epoch=b.epoch AND ctl.maintenance=0
      AND c.kind='access' AND s.kind='access' AND s.epoch=ctl.epoch AND s.revoked_at IS NULL
      AND s.expires_at>strftime('%s','now')*1000 AND u.id=NEW.requeue_actor_id AND u.role='app_admin' AND u.disabled_at IS NULL)
BEGIN SELECT RAISE(ABORT,'invalid_dead_letter_requeue'); END;
CREATE TRIGGER dead_letter_activity_identity BEFORE UPDATE ON activity
WHEN EXISTS(SELECT 1 FROM queue_dead_letters WHERE requeue_id=OLD.id)
BEGIN SELECT RAISE(ABORT,'immutable_dead_letter_activity'); END;
