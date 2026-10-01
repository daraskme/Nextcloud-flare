# Operations health

`pnpm ops:health` composes the private `OperationsOperator.inspect(epoch)` snapshot with the existing backup health inspector and prints one redacted JSON envelope. The command is read-only: it uses service-binding RPCs, aggregate D1 reads, and backup inventory/verification only.

Exit codes:

- `0`: the snapshot is complete and healthy.
- `2`: the snapshot is complete/unhealthy or incomplete because durable state needs existing repair/drain work.
- `1`: transport, binding, D1 query, backup composition, or argument inspection failed.

The envelope omits user IDs, node IDs, job IDs, row IDs, names, email, object keys, operation operands/results, webhook/provider URLs, SQL, credentials, and secret material. Backup generation identities and object keys are redacted from the composed backup section.

`pnpm ops:operator-drill` is an isolated local service-binding proof. It composes `OperationsOperator` and `BackupOperator`, verifies that inspection creates no operations, permits, admissions, or backup runs, and proves both HTTP `fetch()` surfaces remain closed. It does not validate real Cloudflare Cron, Queue, D1 Time Travel, R2, Logpush, or remote service-binding behavior.

Alert predicates and safe responses:

| Code | Predicate | Existing response |
| --- | --- | --- |
| `backup_daily_missing` | Existing backup health reports no fresh daily backup. | Run the existing backup maintain command, then re-run `ops:health`. |
| `backup_generation_invalid` | Existing backup health cannot verify a generation. | Run the existing backup verify command for the generation; investigate manually if it still fails. |
| `backup_generations_insufficient` | Existing backup health reports fewer retained generations than policy requires. | Run the existing backup maintain command to replenish completed generations. |
| `backup_health_incomplete` | Existing backup inventory/verification budget is exhausted or backup authority changed. | Re-run `ops:health`; if it remains incomplete, investigate backup operator reachability manually. |
| `control_epoch_mismatch` | Start/final ControlDO or D1 mirror epochs differ, or do not match the expected epoch. | Wait for the epoch transition to settle, then re-run `ops:health`. |
| `control_maintenance_mismatch` | Start/final ControlDO or D1 mirror maintenance flags differ. | Wait for the maintenance transition to settle, then re-run `ops:health`. |
| `control_gc_pause_mismatch` | Start/final ControlDO or D1 mirror GC-pause flags differ. | Wait for the GC-pause transition to settle, then re-run `ops:health`. |
| `control_mirror_mismatch` | ControlDO and D1 mirror disagree at the start or final read. | Run existing control recovery checks; investigate manually before admitting new work. |
| `gc_candidate_due` | A GC candidate is due. | Run the existing GC worker path or cron repair, then re-run `ops:health`. |
| `gc_claim_expired` | A GC deleting claim has expired. | Run the existing GC worker path or cron repair; stale claims are safe to reclaim. |
| `health_scan_bounded` | A bounded health predicate exceeded the fixed row budget. | Re-run after existing repair workers drain the domain, or investigate manually. |
| `multipart_bucket_abort_unconfirmed` | A multipart bucket abort attempt is unconfirmed. | Run the existing multipart cleanup/closure flow; investigate manually if unconfirmed attempts persist. |
| `multipart_closure_due` | A multipart closure run is due. | Run the existing multipart closure worker path, then re-run `ops:health`. |
| `multipart_handle_quarantined` | A multipart bucket handle remains quarantined. | Run the existing multipart bucket cleanup flow; investigate manually if quarantine persists. |
| `multipart_settlement_expired` | A multipart upload settlement claim has expired. | Run the existing multipart closure settlement worker path; stale claims are safe to reclaim. |
| `mutation_admission_expired` | A waiting or active mutation admission has passed its safe deadline. | Run the existing mutation admission cleanup/repair path; no manual row edits. |
| `operation_claim_expired` | A claimed operation lease has expired. | Run existing recovery/repair workers; investigate manually before retrying user-facing mutations. |
| `orphan_object_due` | An orphan object is due for cleanup. | Run the existing orphan inventory cleanup worker path, then re-run `ops:health`. |
| `orphan_object_expired_claim` | An orphan deletion claim has expired. | Run the existing orphan inventory cleanup worker path; stale claims are safe to reclaim. |
| `outbox_dead_letter_failed` | A DLQ dead-letter row remains failed. | Run the existing DLQ recovery path; investigate manually if requeue is not safe. |
| `outbox_delivery_failed` | An outbox row is failed. | Run the existing outbox/DLQ recovery path, then re-run `ops:health`. |
| `outbox_lease_expired` | An outbox dispatch/consumer lease has expired. | Run the existing outbox dispatcher/consumer repair path; stale leases are safe to reclaim. |
| `permit_expired` | An open permit has expired. | Run existing mutation admission cleanup/repair; expired open permits cannot authorize new work. |
| `reservation_expired` | A reserved upload/share reservation has expired. | Run existing upload cleanup/settlement repair; investigate manually if reservations remain held. |
| `tree_job_failed` | An async tree job is failed. | Run existing job recovery/cancel flow, or investigate the failed async job manually. |
| `tree_job_lease_expired` | An async tree job execution or dispatch lease has expired. | Run existing async job worker/repair path; stale job leases are safe to reclaim. |
| `upload_cleanup_due` | An upload cleanup row is due. | Run the existing upload cleanup worker path, then re-run `ops:health`. |
| `upload_lease_expired` | A single or multipart upload lease has expired. | Run the existing upload cleanup/settlement worker path; stale upload leases are safe to reclaim. |
