-- A delivery failure is an observation, not a job stop/completion or native-I/O receipt.
-- Keep unknown references as well: a restored database may not contain their outbox row.
INSERT INTO _assert(v) SELECT 1 WHERE NOT EXISTS(SELECT 1 FROM control WHERE singleton=1
  AND maintenance=1 AND backup_token IS NULL AND backup_frozen=0 AND restore_freeze_token IS NULL)
  OR EXISTS(SELECT 1 FROM permits WHERE state='open') OR EXISTS(SELECT 1 FROM operations WHERE state='claimed')
  OR EXISTS(SELECT 1 FROM mutation_admissions WHERE state<>'closed');
CREATE TABLE queue_dead_letters(
  message_id TEXT NOT NULL PRIMARY KEY
    CHECK(length(message_id) BETWEEN 1 AND 128 AND message_id NOT GLOB '*[^A-Za-z0-9_-]*'),
  outbox_id TEXT CHECK(outbox_id IS NULL OR
    (length(outbox_id) BETWEEN 1 AND 128 AND outbox_id NOT GLOB '*[^A-Za-z0-9_-]*')),
  sent_at INTEGER NOT NULL CHECK(sent_at>=0),
  received_at INTEGER NOT NULL CHECK(received_at>=0),
  epoch INTEGER NOT NULL CHECK(epoch>0)
) STRICT;
CREATE INDEX queue_dead_letters_page ON queue_dead_letters(received_at,message_id);
CREATE INDEX queue_dead_letters_outbox ON queue_dead_letters(outbox_id);
CREATE TRIGGER queue_dead_letters_identity BEFORE UPDATE ON queue_dead_letters
BEGIN SELECT RAISE(ABORT,'immutable_dead_letter'); END;
CREATE TRIGGER backup_freeze_queue_dead_letters_insert BEFORE INSERT ON queue_dead_letters
WHEN (SELECT backup_frozen FROM control WHERE singleton=1)=1
BEGIN SELECT RAISE(ABORT,'backup_frozen'); END;
CREATE TRIGGER restore_freeze_queue_dead_letters_insert BEFORE INSERT ON queue_dead_letters
WHEN (SELECT restore_freeze_token FROM control WHERE singleton=1) IS NOT NULL
BEGIN SELECT RAISE(ABORT,'database_restore_frozen'); END;
CREATE TRIGGER restore_freeze_queue_dead_letters_update BEFORE UPDATE ON queue_dead_letters
WHEN (SELECT restore_freeze_token FROM control WHERE singleton=1) IS NOT NULL
BEGIN SELECT RAISE(ABORT,'database_restore_frozen'); END;
CREATE TRIGGER restore_freeze_queue_dead_letters_delete BEFORE DELETE ON queue_dead_letters
WHEN (SELECT restore_freeze_token FROM control WHERE singleton=1) IS NOT NULL
BEGIN SELECT RAISE(ABORT,'database_restore_frozen'); END;
CREATE TRIGGER backup_freeze_queue_dead_letters_update BEFORE UPDATE ON queue_dead_letters
WHEN (SELECT backup_frozen FROM control WHERE singleton=1)=1
BEGIN SELECT RAISE(ABORT,'backup_frozen'); END;
CREATE TRIGGER backup_freeze_queue_dead_letters_delete BEFORE DELETE ON queue_dead_letters
WHEN (SELECT backup_frozen FROM control WHERE singleton=1)=1
BEGIN SELECT RAISE(ABORT,'backup_frozen'); END;
