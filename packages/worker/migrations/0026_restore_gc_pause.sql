-- ControlDO policy and a fenced, expiring global restore window. Apply while quiesced.
ALTER TABLE control ADD COLUMN gc_operator_paused INTEGER NOT NULL DEFAULT 1
  CHECK(gc_operator_paused IN (0,1));
UPDATE control SET gc_operator_paused=gc_paused;
ALTER TABLE control ADD COLUMN gc_hold_token TEXT
  CHECK(gc_hold_token IS NULL OR length(gc_hold_token)=36);
ALTER TABLE control ADD COLUMN gc_hold_operation TEXT
  CHECK(gc_hold_operation IS NULL OR (length(gc_hold_operation)=67 AND gc_hold_operation GLOB 'op_*'));
ALTER TABLE control ADD COLUMN gc_hold_expires_at INTEGER
  CHECK((gc_hold_token IS NULL AND gc_hold_operation IS NULL AND gc_hold_expires_at IS NULL)
    OR (gc_hold_token IS NOT NULL AND gc_hold_operation IS NOT NULL
      AND typeof(gc_hold_expires_at)='integer' AND gc_hold_expires_at BETWEEN 1 AND 9007199254740991));
