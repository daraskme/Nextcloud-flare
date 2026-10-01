import type { ControlStatus } from "../do/ControlDO";
import { CONTROL_NAME } from "../do/controlName";
import type { Env } from "../env";

const VERSION = "ops-health.v1";
const MAX_ROWS = 256;
const CLOCK = "strftime('%s','now')*1000";

export const OPERATIONS_HEALTH_VERSION = VERSION;
export const OPERATIONS_HEALTH_MAX_ROWS = MAX_ROWS;

export const OPERATIONS_HEALTH_RESPONSES = Object.freeze({
  backup_daily_missing: "Run the existing backup maintain command, then re-run ops:health.",
  backup_generation_invalid:
    "Run the existing backup verify command for the generation; investigate manually if it still fails.",
  backup_generations_insufficient:
    "Run the existing backup maintain command to replenish completed generations.",
  backup_health_incomplete:
    "Re-run ops:health; if it remains incomplete, investigate backup operator reachability manually.",
  control_epoch_mismatch: "Wait for in-flight epoch transition to settle, then re-run ops:health.",
  control_gc_pause_mismatch: "Wait for the GC-pause transition to settle, then re-run ops:health.",
  control_maintenance_mismatch:
    "Wait for the maintenance transition to settle, then re-run ops:health.",
  control_mirror_mismatch:
    "Run existing control recovery checks; investigate manually before admitting new work.",
  gc_candidate_due: "Run the existing GC worker path or cron repair, then re-run ops:health.",
  gc_claim_expired:
    "Run the existing GC worker path or cron repair; stale claims are safe to reclaim.",
  health_scan_bounded:
    "Re-run ops:health after existing repair workers drain this domain, or investigate manually.",
  multipart_bucket_abort_unconfirmed:
    "Run the existing multipart cleanup/closure flow; investigate manually if unconfirmed attempts persist.",
  multipart_closure_due: "Run the existing multipart closure worker path, then re-run ops:health.",
  multipart_handle_quarantined:
    "Run the existing multipart bucket cleanup flow; investigate manually if quarantine persists.",
  multipart_settlement_expired:
    "Run the existing multipart closure settlement worker path; stale claims are safe to reclaim.",
  mutation_admission_expired:
    "Run the existing mutation admission cleanup/repair path; no manual row edits.",
  operation_claim_expired:
    "Run existing recovery/repair workers; investigate manually before retrying user-facing mutations.",
  orphan_object_due:
    "Run the existing orphan inventory cleanup worker path, then re-run ops:health.",
  orphan_object_expired_claim:
    "Run the existing orphan inventory cleanup worker path; stale claims are safe to reclaim.",
  outbox_dead_letter_failed:
    "Run the existing DLQ recovery path; investigate manually if requeue is not safe.",
  outbox_delivery_failed: "Run the existing outbox/DLQ recovery path, then re-run ops:health.",
  outbox_lease_expired:
    "Run the existing outbox dispatcher/consumer repair path; stale leases are safe to reclaim.",
  permit_expired:
    "Run existing mutation admission cleanup/repair; expired open permits cannot authorize new work.",
  reservation_expired:
    "Run existing upload cleanup/settlement repair; investigate manually if reservations remain held.",
  tree_job_failed:
    "Run existing job recovery/cancel flow, or investigate the failed async job manually.",
  tree_job_lease_expired:
    "Run existing async job worker/repair path; stale job leases are safe to reclaim.",
  upload_cleanup_due: "Run the existing upload cleanup worker path, then re-run ops:health.",
  upload_lease_expired:
    "Run the existing upload cleanup/settlement worker path; stale upload leases are safe to reclaim.",
} as const);

export type OperationsHealthAlertCode = keyof typeof OPERATIONS_HEALTH_RESPONSES;

export interface OperationsHealthAlert {
  readonly code: OperationsHealthAlertCode;
  readonly response: string;
}

export interface HealthAuthority {
  readonly control: ControlStatus;
  readonly mirror: ControlStatus;
}

interface Bucket {
  readonly count: number;
  readonly oldestAt: number | null;
  readonly truncated: boolean;
}

type DomainBuckets = Record<string, Bucket>;

export interface OperationsHealthSnapshot {
  readonly version: typeof VERSION;
  readonly observedAt: number;
  readonly expectedEpoch: number;
  readonly complete: boolean;
  readonly healthy: boolean;
  readonly authority: {
    readonly start: HealthAuthority;
    readonly final: HealthAuthority;
    readonly stable: boolean;
  };
  readonly domains: {
    readonly mutation: DomainBuckets;
    readonly operations: DomainBuckets;
    readonly queues: DomainBuckets;
    readonly uploads: DomainBuckets;
    readonly multipart: DomainBuckets;
    readonly reservations: DomainBuckets;
    readonly orphans: DomainBuckets;
    readonly gc: DomainBuckets;
  };
  readonly alerts: readonly OperationsHealthAlert[];
}

interface InspectOptions {
  readonly expectedEpoch: number;
}

function assertEpoch(epoch: number): void {
  if (!Number.isSafeInteger(epoch) || epoch < 1) throw new Error("ops_health_invalid_epoch");
}

function mirrorStatus(
  row: { epoch: number; maintenance: number; gc_paused: number } | null,
): ControlStatus {
  if (
    row === null ||
    !Number.isSafeInteger(row.epoch) ||
    ![0, 1].includes(row.maintenance) ||
    ![0, 1].includes(row.gc_paused)
  )
    throw new Error("ops_health_invalid_control_mirror");
  return { epoch: row.epoch, maintenance: row.maintenance === 1, gcPaused: row.gc_paused === 1 };
}

async function authority(env: Env): Promise<HealthAuthority> {
  const control = await env.CONTROL.get(env.CONTROL.idFromName(CONTROL_NAME)).status();
  const mirror = mirrorStatus(
    await env.DB.prepare(
      "SELECT epoch,maintenance,gc_paused FROM control WHERE singleton=1 LIMIT 1",
    ).first<{ epoch: number; maintenance: number; gc_paused: number }>(),
  );
  return { control, mirror };
}

function sameStatus(a: ControlStatus, b: ControlStatus): boolean {
  return a.epoch === b.epoch && a.maintenance === b.maintenance && a.gcPaused === b.gcPaused;
}

function stable(start: HealthAuthority, final: HealthAuthority, expectedEpoch: number): boolean {
  return (
    sameStatus(start.control, start.mirror) &&
    sameStatus(final.control, final.mirror) &&
    sameStatus(start.control, final.control) &&
    sameStatus(start.mirror, final.mirror) &&
    start.control.epoch === expectedEpoch &&
    start.mirror.epoch === expectedEpoch
  );
}

function authorityAlerts(
  start: HealthAuthority,
  final: HealthAuthority,
  expectedEpoch: number,
): OperationsHealthAlertCode[] {
  const alerts: OperationsHealthAlertCode[] = [];
  if (
    start.control.epoch !== expectedEpoch ||
    start.mirror.epoch !== expectedEpoch ||
    final.control.epoch !== expectedEpoch ||
    final.mirror.epoch !== expectedEpoch ||
    start.control.epoch !== final.control.epoch ||
    start.mirror.epoch !== final.mirror.epoch
  )
    alerts.push("control_epoch_mismatch");
  if (
    start.control.maintenance !== start.mirror.maintenance ||
    final.control.maintenance !== final.mirror.maintenance ||
    start.control.maintenance !== final.control.maintenance ||
    start.mirror.maintenance !== final.mirror.maintenance
  )
    alerts.push("control_maintenance_mismatch");
  if (
    start.control.gcPaused !== start.mirror.gcPaused ||
    final.control.gcPaused !== final.mirror.gcPaused ||
    start.control.gcPaused !== final.control.gcPaused ||
    start.mirror.gcPaused !== final.mirror.gcPaused
  )
    alerts.push("control_gc_pause_mismatch");
  if (!sameStatus(start.control, start.mirror) || !sameStatus(final.control, final.mirror))
    alerts.push("control_mirror_mismatch");
  return alerts;
}

async function bucket(
  env: Env,
  source: string,
  order: string,
  values: readonly (string | number | null)[] = [],
): Promise<Bucket> {
  const result = await env.DB.prepare(
    `WITH page AS (SELECT ${order} AS oldest_at FROM ${source} ORDER BY ${order} LIMIT ?)
     SELECT COUNT(*) AS count, MIN(oldest_at) AS oldestAt FROM page`,
  )
    .bind(...values, MAX_ROWS + 1)
    .first<{ count: number; oldestAt: number | null }>();
  const count = Number(result?.count ?? 0);
  return {
    count: Math.min(count, MAX_ROWS),
    oldestAt: result?.oldestAt ?? null,
    truncated: count > MAX_ROWS,
  };
}

function addAlerts(
  codes: OperationsHealthAlertCode[],
  buckets: DomainBuckets,
  mapping: Record<string, OperationsHealthAlertCode>,
): void {
  for (const [name, code] of Object.entries(mapping)) {
    const found = buckets[name];
    if (found && found.count > 0) codes.push(code);
    if (found?.truncated) codes.push("health_scan_bounded");
  }
}

function finalized(codes: readonly OperationsHealthAlertCode[]): OperationsHealthAlert[] {
  return [...new Set(codes)]
    .sort()
    .map((code) => ({ code, response: OPERATIONS_HEALTH_RESPONSES[code] }));
}

export async function inspectOperationsHealth(
  env: Env,
  options: InspectOptions,
): Promise<OperationsHealthSnapshot> {
  assertEpoch(options.expectedEpoch);
  const start = await authority(env);
  const [mutation, operations, queues, uploads, multipart, reservations, orphans, gc] =
    await Promise.all([
      inspectMutation(env),
      inspectOperations(env),
      inspectQueues(env),
      inspectUploads(env),
      inspectMultipart(env),
      inspectReservations(env),
      inspectOrphans(env),
      inspectGc(env),
    ]);
  const final = await authority(env);
  const codes = authorityAlerts(start, final, options.expectedEpoch);
  addAlerts(codes, mutation, {
    activeAdmissionsExpired: "mutation_admission_expired",
    waitingAdmissionsExpired: "mutation_admission_expired",
    openPermitsExpired: "permit_expired",
  });
  addAlerts(codes, operations, {
    claimedExpired: "operation_claim_expired",
    failedTreeJobs: "tree_job_failed",
    expiredTreeJobLeases: "tree_job_lease_expired",
    expiredTreeDispatchLeases: "tree_job_lease_expired",
  });
  addAlerts(codes, queues, {
    deliveryFailed: "outbox_delivery_failed",
    deliveryLeaseExpired: "outbox_lease_expired",
    deadLettersFailed: "outbox_dead_letter_failed",
  });
  addAlerts(codes, uploads, {
    cleanupDue: "upload_cleanup_due",
    writeLeaseExpired: "upload_lease_expired",
    multipartCompleteLeaseExpired: "upload_lease_expired",
  });
  addAlerts(codes, multipart, {
    closureDue: "multipart_closure_due",
    settlementExpired: "multipart_settlement_expired",
    bucketHandlesQuarantined: "multipart_handle_quarantined",
    abortsUnconfirmed: "multipart_bucket_abort_unconfirmed",
  });
  addAlerts(codes, reservations, { expired: "reservation_expired" });
  addAlerts(codes, orphans, {
    due: "orphan_object_due",
    expiredClaims: "orphan_object_expired_claim",
  });
  addAlerts(codes, gc, {
    candidatesDue: "gc_candidate_due",
    expiredClaims: "gc_claim_expired",
  });
  const alerts = finalized(codes);
  const complete =
    stable(start, final, options.expectedEpoch) &&
    !alerts.some((a) => a.code === "health_scan_bounded");
  return {
    version: VERSION,
    observedAt: Date.now(),
    expectedEpoch: options.expectedEpoch,
    complete,
    healthy: complete && alerts.length === 0,
    authority: { start, final, stable: stable(start, final, options.expectedEpoch) },
    domains: { mutation, operations, queues, uploads, multipart, reservations, orphans, gc },
    alerts,
  };
}

async function inspectMutation(env: Env): Promise<DomainBuckets> {
  return {
    waitingAdmissionsExpired: await bucket(
      env,
      `mutation_admissions INDEXED BY mutation_admissions_health_waiting
       WHERE state='waiting' AND MAX(wait_until,COALESCE(committed_at+60000,0))<=${CLOCK}`,
      "MAX(wait_until,COALESCE(committed_at+60000,0))",
    ),
    activeAdmissionsExpired: await bucket(
      env,
      `mutation_admissions INDEXED BY mutation_admissions_health_active
       WHERE state='active' AND expires_at<=${CLOCK}`,
      "expires_at",
    ),
    openPermitsExpired: await bucket(
      env,
      `permits INDEXED BY permits_health_expiry WHERE state='open' AND expires_at<=${CLOCK}`,
      "expires_at",
    ),
  };
}

async function inspectOperations(env: Env): Promise<DomainBuckets> {
  return {
    claimedExpired: await bucket(
      env,
      `operations INDEXED BY operations_health_claimed
       WHERE state='claimed' AND claimed_expires_at<=${CLOCK}`,
      "claimed_expires_at",
    ),
    failedTreeJobs: await bucket(
      env,
      "bulk_jobs INDEXED BY bulk_jobs_health_state WHERE state='failed'",
      "updated_at",
    ),
    expiredTreeJobLeases: await bucket(
      env,
      `job_leases INDEXED BY job_leases_health_expiry WHERE expires_at<=${CLOCK}`,
      "expires_at",
    ),
    expiredTreeDispatchLeases: await bucket(
      env,
      `bulk_jobs INDEXED BY bulk_jobs_health_dispatch WHERE dispatch_state IN ('dispatching','sent')
       AND dispatch_expires_at IS NOT NULL AND dispatch_expires_at<=${CLOCK}`,
      "dispatch_expires_at",
    ),
  };
}

async function inspectQueues(env: Env): Promise<DomainBuckets> {
  return {
    deliveryFailed: await bucket(
      env,
      "outbox INDEXED BY outbox_claim_repair WHERE state='failed'",
      "updated_at",
    ),
    deliveryLeaseExpired: await bucket(
      env,
      `outbox INDEXED BY outbox_claim_repair
       WHERE state IN ('dispatching','sent') AND claim_expires_at IS NOT NULL AND claim_expires_at<=${CLOCK}`,
      "claim_expires_at",
    ),
    deadLettersFailed: await bucket(
      env,
      "outbox_dead_letters INDEXED BY outbox_dead_letters_health WHERE status='failed'",
      "last_observed_at",
    ),
  };
}

async function inspectUploads(env: Env): Promise<DomainBuckets> {
  return {
    cleanupDue: await bucket(
      env,
      `uploads INDEXED BY uploads_cleanup
       WHERE cleanup_pending=1 AND expires_at<=${CLOCK} AND state<>'completed'`,
      "expires_at",
    ),
    writeLeaseExpired: await bucket(
      env,
      `uploads INDEXED BY uploads_health_write_lease
       WHERE write_attempt_id IS NOT NULL AND write_lease_expires_at<=${CLOCK} AND state<>'completed'`,
      "write_lease_expires_at",
    ),
    multipartCompleteLeaseExpired: await bucket(
      env,
      `uploads INDEXED BY uploads_health_multipart_complete
       WHERE multipart_complete_attempt IS NOT NULL AND multipart_complete_lease<=${CLOCK}
       AND state NOT IN ('completed','expired','aborted','failed')`,
      "multipart_complete_lease",
    ),
  };
}

async function inspectMultipart(env: Env): Promise<DomainBuckets> {
  return {
    closureDue: await bucket(
      env,
      `multipart_closure_runs INDEXED BY multipart_closure_health
       WHERE phase IN ('waiting','scanning') AND not_before<=${CLOCK}`,
      "not_before",
    ),
    settlementExpired: await bucket(
      env,
      `multipart_upload_settlements INDEXED BY multipart_upload_settlement_health
       WHERE state='claimed' AND lease_expires_at<=${CLOCK}`,
      "lease_expires_at",
    ),
    bucketHandlesQuarantined: await bucket(
      env,
      "multipart_bucket_handles INDEXED BY multipart_bucket_handles_health WHERE state='quarantined'",
      "last_seen_at",
    ),
    abortsUnconfirmed: await bucket(
      env,
      "multipart_bucket_abort_attempts INDEXED BY multipart_bucket_abort_health WHERE outcome='unconfirmed'",
      "finished_at",
    ),
  };
}

async function inspectReservations(env: Env): Promise<DomainBuckets> {
  return {
    expired: await bucket(
      env,
      `reservations INDEXED BY reservations_health_expiry
       WHERE state='reserved' AND expires_at<=${CLOCK}`,
      "expires_at",
    ),
  };
}

async function inspectOrphans(env: Env): Promise<DomainBuckets> {
  return {
    due: await bucket(
      env,
      `orphan_objects INDEXED BY orphan_objects_due
       WHERE state<>'deleted' AND next_check_at<=${CLOCK}`,
      "next_check_at",
    ),
    expiredClaims: await bucket(
      env,
      `orphan_objects INDEXED BY orphan_objects_claim_health
       WHERE state='deleting' AND claim_expires_at IS NOT NULL AND claim_expires_at<=${CLOCK}`,
      "claim_expires_at",
    ),
  };
}

async function inspectGc(env: Env): Promise<DomainBuckets> {
  return {
    candidatesDue: await bucket(
      env,
      `gc_candidates INDEXED BY gc_candidates_ready
       WHERE state='candidate' AND not_before<=${CLOCK}`,
      "not_before",
    ),
    expiredClaims: await bucket(
      env,
      `gc_candidates INDEXED BY gc_candidates_ready
       WHERE state='deleting' AND claim_expires_at IS NOT NULL AND claim_expires_at<=${CLOCK}`,
      "claim_expires_at",
    ),
  };
}
