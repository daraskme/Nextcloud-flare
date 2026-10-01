-- Index only read-only health predicates that had no bounded covering path.
CREATE INDEX permits_health_expiry
 ON permits(expires_at,permit_id)
 WHERE state='open';

CREATE INDEX operations_health_claimed
 ON operations(claimed_expires_at,updated_at,op_id)
 WHERE state='claimed';

CREATE INDEX bulk_jobs_health_state
 ON bulk_jobs(updated_at,id)
 WHERE state='failed';

CREATE INDEX bulk_jobs_health_dispatch
 ON bulk_jobs(dispatch_expires_at,updated_at,id)
 WHERE dispatch_state IN ('dispatching','sent');

CREATE INDEX job_leases_health_expiry
 ON job_leases(expires_at,job_id);

CREATE INDEX reservations_health_expiry
 ON reservations(expires_at,id)
 WHERE state='reserved';

CREATE INDEX outbox_dead_letters_health
 ON outbox_dead_letters(last_observed_at,outbox_id)
 WHERE status='failed';

CREATE INDEX mutation_admissions_health_waiting
 ON mutation_admissions(MAX(wait_until,COALESCE(committed_at+60000,0)),seq)
 WHERE state='waiting';

CREATE INDEX mutation_admissions_health_active
 ON mutation_admissions(expires_at,seq)
 WHERE state='active';

CREATE INDEX uploads_health_write_lease
 ON uploads(write_lease_expires_at,id)
 WHERE write_attempt_id IS NOT NULL AND state<>'completed';

CREATE INDEX uploads_health_multipart_complete
 ON uploads(multipart_complete_lease,id)
 WHERE multipart_complete_attempt IS NOT NULL
  AND state NOT IN ('completed','expired','aborted','failed');

CREATE INDEX multipart_closure_health
 ON multipart_closure_runs(not_before,created_at,id)
 WHERE phase IN ('waiting','scanning');

CREATE INDEX multipart_upload_settlement_health
 ON multipart_upload_settlements(lease_expires_at,upload_id)
 WHERE state='claimed';

CREATE INDEX multipart_bucket_handles_health
 ON multipart_bucket_handles(last_seen_at,id)
 WHERE state='quarantined';

CREATE INDEX multipart_bucket_abort_health
 ON multipart_bucket_abort_attempts(finished_at,id)
 WHERE outcome='unconfirmed';

CREATE INDEX orphan_objects_claim_health
 ON orphan_objects(claim_expires_at,next_check_at,r2_key)
 WHERE state='deleting';
