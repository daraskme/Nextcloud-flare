-- Invocation counters survive delivery retries. Existing job leases retain their identity.
ALTER TABLE job_leases ADD COLUMN r2_calls INTEGER NOT NULL DEFAULT 0
  CHECK(r2_calls BETWEEN 0 AND 2000);
CREATE INDEX bulk_jobs_owner_running ON bulk_jobs(owner_id,id)
  WHERE kind='node.copy' AND state='running';
