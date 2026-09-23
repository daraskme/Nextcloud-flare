-- Legacy claims are reconciled only after their lease expires; their epoch is not guessed.
ALTER TABLE gc_candidates ADD COLUMN claim_epoch INTEGER CHECK(claim_epoch IS NULL OR claim_epoch BETWEEN 1 AND 9007199254740991);
ALTER TABLE gc_candidates ADD COLUMN r2_calls INTEGER NOT NULL DEFAULT 0 CHECK(r2_calls BETWEEN 0 AND 9007199254740991);
CREATE TRIGGER gc_dispatch_counter BEFORE UPDATE OF r2_calls ON gc_candidates
WHEN NEW.r2_calls<OLD.r2_calls
BEGIN SELECT RAISE(ABORT,'immutable_gc_dispatch_counter'); END;
