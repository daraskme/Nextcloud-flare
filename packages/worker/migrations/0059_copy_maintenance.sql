INSERT INTO _assert(v) SELECT 1 WHERE NOT EXISTS(SELECT 1 FROM control WHERE singleton=1
  AND maintenance=1 AND backup_token IS NULL AND backup_frozen=0 AND restore_freeze_token IS NULL)
  OR EXISTS(SELECT 1 FROM permits WHERE state='open') OR EXISTS(SELECT 1 FROM operations WHERE state='claimed')
  OR EXISTS(SELECT 1 FROM mutation_admissions WHERE state<>'closed');

-- Independent repair scheduling never changes the transfer checkpoint or proves native closure.
ALTER TABLE bulk_jobs ADD COLUMN cleanup_token TEXT CHECK(cleanup_token IS NULL OR length(cleanup_token)=36);
ALTER TABLE bulk_jobs ADD COLUMN cleanup_epoch INTEGER NOT NULL DEFAULT 0 CHECK(cleanup_epoch>=0);
ALTER TABLE bulk_jobs ADD COLUMN cleanup_expires_at INTEGER NOT NULL DEFAULT 0 CHECK(cleanup_expires_at>=0);
ALTER TABLE bulk_jobs ADD COLUMN cleanup_next_at INTEGER NOT NULL DEFAULT 0 CHECK(cleanup_next_at>=0);
ALTER TABLE bulk_jobs ADD COLUMN cleanup_after TEXT NOT NULL DEFAULT '' CHECK(length(cleanup_after)<=128);
ALTER TABLE bulk_jobs ADD COLUMN cleanup_calls INTEGER NOT NULL DEFAULT 0 CHECK(cleanup_calls BETWEEN 0 AND 8);
ALTER TABLE bulk_jobs ADD COLUMN cleanup_total_calls INTEGER NOT NULL DEFAULT 0 CHECK(cleanup_total_calls BETWEEN 0 AND 9007199254740991);
CREATE INDEX bulk_copy_maintenance ON bulk_jobs(kind,cleanup_next_at,id)
  WHERE kind='node.copy' AND state IN ('pending','running','cancelled','failed');
CREATE TRIGGER copy_maintenance_initial BEFORE INSERT ON bulk_jobs
WHEN NEW.cleanup_token IS NOT NULL OR NEW.cleanup_epoch<>0 OR NEW.cleanup_expires_at<>0
  OR NEW.cleanup_next_at<>0 OR NEW.cleanup_after<>'' OR NEW.cleanup_calls<>0 OR NEW.cleanup_total_calls<>0
BEGIN SELECT RAISE(ABORT,'invalid_copy_maintenance'); END;
CREATE TRIGGER copy_maintenance_update BEFORE UPDATE ON bulk_jobs
WHEN (NEW.cleanup_token IS NOT OLD.cleanup_token OR NEW.cleanup_epoch<>OLD.cleanup_epoch
  OR NEW.cleanup_expires_at<>OLD.cleanup_expires_at OR NEW.cleanup_next_at<>OLD.cleanup_next_at
  OR NEW.cleanup_after<>OLD.cleanup_after OR NEW.cleanup_calls<>OLD.cleanup_calls
  OR NEW.cleanup_total_calls<>OLD.cleanup_total_calls)
  AND (NEW.kind<>'node.copy' OR NEW.state='completed' OR NEW.cleanup_epoch<OLD.cleanup_epoch
    OR NEW.cleanup_token IS NULL
    OR NEW.cleanup_total_calls<OLD.cleanup_total_calls
    OR (NEW.cleanup_token IS OLD.cleanup_token AND NEW.cleanup_calls<OLD.cleanup_calls)
    OR (NEW.cleanup_token IS OLD.cleanup_token AND NEW.cleanup_total_calls-OLD.cleanup_total_calls<>NEW.cleanup_calls-OLD.cleanup_calls)
    OR (NEW.cleanup_token IS NOT OLD.cleanup_token AND (NEW.cleanup_calls<>0 OR NEW.cleanup_total_calls<>OLD.cleanup_total_calls))
    OR NOT EXISTS(SELECT 1 FROM control c JOIN spaces s ON s.owner_id=NEW.owner_id
      JOIN mutation_admissions a ON a.space_id=s.id
      WHERE c.singleton=1 AND c.epoch=NEW.cleanup_epoch AND c.maintenance=0
        AND a.system=1 AND a.state='active' AND a.epoch=c.epoch AND a.maintenance=c.maintenance
        AND a.expires_at>strftime('%s','now')*1000
        AND (a.permit_id GLOB 'system:copy.maintenance-claim:*'
          OR a.permit_id GLOB 'system:copy.maintenance-progress:*'
          OR a.permit_id GLOB 'system:copy.maintenance-release:*'
          OR a.permit_id GLOB 'system:copy.reconcile-object:*'
          OR a.permit_id GLOB 'system:copy.multipart-abort:*')))
BEGIN SELECT RAISE(ABORT,'copy_maintenance_unproven'); END;
