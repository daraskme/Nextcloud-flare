-- Queue messages carry only outbox_id. The durable row is the job identity and
-- must not be repointed while a duplicate delivery or a lost ack is in flight.
ALTER TABLE outbox ADD COLUMN claim_token TEXT;
ALTER TABLE outbox ADD COLUMN claim_expires_at INTEGER
  CHECK(claim_expires_at IS NULL OR claim_expires_at>=0);
CREATE INDEX outbox_claim_repair ON outbox(state,claim_expires_at,updated_at);

CREATE TRIGGER outbox_identity BEFORE UPDATE ON outbox
WHEN NEW.outbox_id<>OLD.outbox_id OR NEW.op_id<>OLD.op_id
 OR NEW.kind<>OLD.kind OR NEW.payload_ref<>OLD.payload_ref
 OR NEW.epoch<>OLD.epoch OR NEW.created_at<>OLD.created_at
 OR NEW.updated_at<OLD.updated_at
BEGIN SELECT RAISE(ABORT,'immutable_outbox_identity'); END;
