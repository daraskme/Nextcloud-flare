-- Persist the ControlDO transition identity so delayed requests cannot reopen a newer stop.
ALTER TABLE control ADD COLUMN admission_revision INTEGER NOT NULL DEFAULT 0
  CHECK(admission_revision BETWEEN 0 AND 9007199254740991);
ALTER TABLE control ADD COLUMN admission_token TEXT
  CHECK(admission_token IS NULL OR length(admission_token) BETWEEN 1 AND 128);
