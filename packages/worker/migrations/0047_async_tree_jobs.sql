ALTER TABLE bulk_jobs ADD COLUMN dispatch_state TEXT NOT NULL DEFAULT 'pending'
  CHECK(dispatch_state IN ('pending','dispatching','sent','completed','failed'));
ALTER TABLE bulk_jobs ADD COLUMN dispatch_token TEXT;
ALTER TABLE bulk_jobs ADD COLUMN dispatch_expires_at INTEGER;

CREATE INDEX bulk_jobs_dispatch
ON bulk_jobs(epoch,dispatch_state,dispatch_expires_at,updated_at,id);

DROP TRIGGER mutation_admission_close;
CREATE TRIGGER mutation_admission_close AFTER UPDATE OF state ON mutation_admissions
WHEN NEW.state='closed' AND OLD.state<>'closed'
BEGIN
  UPDATE permits SET state='revoked' WHERE permit_id=NEW.permit_id AND state='open';
  UPDATE operations SET
    state='failed',
    error_code=COALESCE(
      (SELECT 'stale_epoch' WHERE NEW.epoch<>(SELECT epoch FROM control WHERE singleton=1)),
      (SELECT 'maintenance' WHERE (SELECT maintenance FROM control WHERE singleton=1)=1),
      'mutation_admission_closed'
    ),
    updated_at=MAX(updated_at,strftime('%s','now')*1000)
  WHERE permit_id=NEW.permit_id AND state='claimed'
    AND NOT EXISTS(
      SELECT 1 FROM bulk_jobs j
      WHERE j.op_id=operations.op_id AND j.state IN ('pending','running')
    );
END;

CREATE TRIGGER bulk_jobs_async_tree_shape_insert
BEFORE INSERT ON bulk_jobs
WHEN NEW.kind IN ('node.trash','node.restore','node.purge') AND (
  NEW.id<>'job_'||substr(NEW.op_id,4) OR
  NEW.credential_id IS NULL OR
  NEW.manifest_ref IS NOT NULL OR
  NEW.checkpoint IS NULL OR
  json_valid(NEW.checkpoint)<>1 OR
  json_extract(NEW.checkpoint,'$.phase')<>'manifest' OR
  json_type(NEW.checkpoint,'$.cursor') NOT IN ('null','text') OR
  NEW.dispatch_state<>'pending' OR
  NEW.dispatch_token IS NOT NULL OR
  NEW.dispatch_expires_at IS NOT NULL
)
BEGIN
  SELECT RAISE(ABORT,'invalid_async_tree_job');
END;

CREATE TRIGGER bulk_jobs_async_tree_shape_update
BEFORE UPDATE ON bulk_jobs
WHEN OLD.kind IN ('node.trash','node.restore','node.purge') AND (
  NEW.id<>OLD.id OR NEW.owner_id<>OLD.owner_id OR NEW.credential_id<>OLD.credential_id OR
  NEW.op_id<>OLD.op_id OR NEW.kind<>OLD.kind OR NEW.epoch<>OLD.epoch OR
  NEW.grant_snapshot<>OLD.grant_snapshot OR NEW.created_at<>OLD.created_at OR
  NEW.checkpoint IS NULL OR json_valid(NEW.checkpoint)<>1 OR
  json_extract(NEW.checkpoint,'$.phase') NOT IN ('manifest','finalize','completed','failed') OR
  json_type(NEW.checkpoint,'$.cursor') NOT IN ('null','text') OR
  (NEW.dispatch_state IN ('dispatching','sent') AND
    (NEW.dispatch_token IS NULL OR NEW.dispatch_expires_at IS NULL)) OR
  (NEW.dispatch_state IN ('pending','completed','failed') AND
    (NEW.dispatch_token IS NOT NULL OR NEW.dispatch_expires_at IS NOT NULL)) OR
  (NEW.state='completed' AND
    (NEW.dispatch_state<>'completed' OR json_extract(NEW.checkpoint,'$.phase')<>'completed')) OR
  (NEW.state='failed' AND
    (NEW.dispatch_state<>'failed' OR json_extract(NEW.checkpoint,'$.phase')<>'failed'))
)
BEGIN
  SELECT RAISE(ABORT,'invalid_async_tree_job');
END;
