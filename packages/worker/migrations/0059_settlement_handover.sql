-- A claimed-but-never-settled upload settlement used to be owned by its first
-- closure run forever: the claim fence required closure_id=excluded.closure_id,
-- so after an epoch bump no later proven run could reclaim it and the held
-- reservation could never be released. Allow a stale (lease-expired) claimed
-- settlement to be handed over to a currently proven closure run of the live
-- epoch; every other field stays immutable.
DROP TRIGGER multipart_upload_settlement_update;
CREATE TRIGGER multipart_upload_settlement_update BEFORE UPDATE ON multipart_upload_settlements
WHEN NEW.upload_id<>OLD.upload_id
 OR (NEW.closure_id<>OLD.closure_id AND NOT (
   OLD.state='claimed' AND NEW.state='claimed'
   AND OLD.lease_expires_at<=strftime('%s','now')*1000
   AND EXISTS(SELECT 1 FROM multipart_closure_runs hc
     WHERE hc.id=NEW.closure_id AND hc.phase='proven'
       AND hc.epoch=(SELECT epoch FROM control WHERE singleton=1))))
 OR NEW.owner_id<>OLD.owner_id OR NEW.reservation_id<>OLD.reservation_id
 OR NEW.share_id IS NOT OLD.share_id OR NEW.claimed_at<>OLD.claimed_at
 OR NEW.head_calls<OLD.head_calls OR OLD.state='settled'
 OR (NEW.state='settled' AND (
   NEW.object_state IS NULL OR NEW.settled_at IS NULL OR
   NOT EXISTS(SELECT 1 FROM reservations r WHERE r.id=NEW.reservation_id
     AND r.owner_id=NEW.owner_id AND r.share_id IS NEW.share_id AND r.state='released')))
BEGIN SELECT RAISE(ABORT,'immutable_multipart_upload_settlement'); END;
