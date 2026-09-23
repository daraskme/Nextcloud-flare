ALTER TABLE gc_candidates ADD COLUMN claim_token TEXT;
ALTER TABLE gc_candidates ADD COLUMN claim_expires_at INTEGER CHECK(claim_expires_at IS NULL OR claim_expires_at>=0);
ALTER TABLE gc_candidates ADD COLUMN attempt INTEGER NOT NULL DEFAULT 0 CHECK(attempt BETWEEN 0 AND 100);

CREATE UNIQUE INDEX gc_candidates_claim_token ON gc_candidates(claim_token) WHERE claim_token IS NOT NULL;
CREATE INDEX gc_candidates_ready ON gc_candidates(state,not_before,claim_expires_at,blob_id);

CREATE TRIGGER gc_candidates_state_irreversible BEFORE UPDATE OF state ON gc_candidates
WHEN (OLD.state='deleting' AND NEW.state NOT IN ('deleting','deleted'))
  OR (OLD.state='deleted' AND NEW.state<>'deleted')
BEGIN SELECT RAISE(ABORT,'gc_state_irreversible'); END;

CREATE TRIGGER gc_candidates_claim_insert BEFORE INSERT ON gc_candidates
WHEN (NEW.claim_token IS NULL)<>(NEW.claim_expires_at IS NULL)
  OR (NEW.state='deleting')<>(NEW.claim_token IS NOT NULL)
BEGIN SELECT RAISE(ABORT,'invalid_gc_claim'); END;

CREATE TRIGGER gc_candidates_claim_update BEFORE UPDATE OF state,claim_token,claim_expires_at ON gc_candidates
WHEN (NEW.claim_token IS NULL)<>(NEW.claim_expires_at IS NULL)
  OR (NEW.state='deleting')<>(NEW.claim_token IS NOT NULL)
BEGIN SELECT RAISE(ABORT,'invalid_gc_claim'); END;
