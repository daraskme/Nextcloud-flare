CREATE TABLE outbox_dead_letters(
  outbox_id TEXT NOT NULL REFERENCES outbox(outbox_id),
  queue_message_id TEXT NOT NULL UNIQUE CHECK(length(queue_message_id) BETWEEN 1 AND 128),
  observed_attempts INTEGER NOT NULL CHECK(observed_attempts BETWEEN 1 AND 1000000),
  first_observed_at INTEGER NOT NULL CHECK(first_observed_at>=0),
  last_observed_at INTEGER NOT NULL CHECK(last_observed_at>=first_observed_at),
  status TEXT NOT NULL CHECK(status IN ('failed','requeued')),
  requeue_count INTEGER NOT NULL DEFAULT 0 CHECK(
    (status='failed' AND requeue_count=0) OR
    (status='requeued' AND requeue_count=1)
  ),
  epoch INTEGER NOT NULL CHECK(epoch>0),
  PRIMARY KEY(outbox_id,queue_message_id)
) STRICT;
CREATE INDEX outbox_dead_letters_outbox_status
  ON outbox_dead_letters(outbox_id,status,last_observed_at);

CREATE TRIGGER outbox_dead_letters_identity BEFORE UPDATE ON outbox_dead_letters
WHEN NEW.outbox_id<>OLD.outbox_id OR NEW.queue_message_id<>OLD.queue_message_id
 OR NEW.epoch<>OLD.epoch OR NEW.first_observed_at<>OLD.first_observed_at
 OR NEW.observed_attempts<OLD.observed_attempts OR NEW.last_observed_at<OLD.last_observed_at
 OR NOT (
   (NEW.status=OLD.status AND NEW.requeue_count=OLD.requeue_count) OR
   (OLD.status='failed' AND OLD.requeue_count=0
     AND NEW.status='requeued' AND NEW.requeue_count=1)
 )
BEGIN SELECT RAISE(ABORT,'immutable_outbox_dead_letter'); END;

CREATE TRIGGER backup_freeze_outbox_dead_letters_insert BEFORE INSERT ON outbox_dead_letters
WHEN (SELECT backup_frozen FROM control WHERE singleton=1)=1
BEGIN SELECT RAISE(ABORT,'backup_frozen'); END;
CREATE TRIGGER backup_freeze_outbox_dead_letters_update BEFORE UPDATE ON outbox_dead_letters
WHEN (SELECT backup_frozen FROM control WHERE singleton=1)=1
BEGIN SELECT RAISE(ABORT,'backup_frozen'); END;
CREATE TRIGGER backup_freeze_outbox_dead_letters_delete BEFORE DELETE ON outbox_dead_letters
WHEN (SELECT backup_frozen FROM control WHERE singleton=1)=1
BEGIN SELECT RAISE(ABORT,'backup_frozen'); END;
