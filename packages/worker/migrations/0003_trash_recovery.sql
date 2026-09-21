ALTER TABLE gc_candidates ADD COLUMN claim_token TEXT;
ALTER TABLE gc_candidates ADD COLUMN claim_expires_at INTEGER;
CREATE INDEX gc_candidates_claim ON gc_candidates(state,claim_expires_at);
CREATE TABLE recovery_runs(
  id TEXT NOT NULL PRIMARY KEY,
  kind TEXT NOT NULL CHECK(kind IN ('time_travel','logical_export')),
  state TEXT NOT NULL CHECK(state IN ('started','restored','verified','failed')),
  source_generation TEXT NOT NULL,
  epoch_before INTEGER NOT NULL CHECK(epoch_before>0),
  epoch_after INTEGER,
  checkpoint TEXT,
  details_json TEXT,
  created_at INTEGER NOT NULL,
  completed_at INTEGER
) STRICT;
CREATE INDEX recovery_runs_state ON recovery_runs(state,created_at);
