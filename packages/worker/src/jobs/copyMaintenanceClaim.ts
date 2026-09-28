import { assertExists, assertOneChange, primary, type SqlStatement } from "../db/primary";
import {
  acquireSystemMutation,
  commitSystemMutation,
  type SystemMutationSource,
} from "../services/systemMutation";
import { loadCopyJobManifest, type StoredCopyManifest } from "./copyManifest";

const CLOCK = "strftime('%s','now')*1000";
export const COPY_MAINTENANCE_CRON = "*/2 * * * *";
export const COPY_MAINTENANCE_LIMIT = 8;
export const COPY_MAINTENANCE_ELIGIBLE = `j.kind='node.copy'
  AND j.state IN ('pending','running','cancelled','failed')
  AND j.cleanup_next_at<=${CLOCK} AND j.cleanup_expires_at<=${CLOCK}
  AND ((j.state IN ('cancelled','failed') AND EXISTS(SELECT 1 FROM copy_job_blobs WHERE job_id=j.id))
    OR (j.state IN ('pending','running') AND (j.epoch<c.epoch
      OR m.expires_at<=${CLOCK}
      OR ((j.invocation_count>=200 OR j.r2_calls>=20000 OR COALESCE(l.attempt,0)>=10)
        AND COALESCE(l.expires_at,0)<=${CLOCK}))))`;
export const COPY_MAINTENANCE_FROM = `FROM bulk_jobs j JOIN copy_job_manifests m ON m.job_id=j.id
  JOIN control c ON c.singleton=1 LEFT JOIN job_leases l ON l.job_id=j.id`;
export interface CopyMaintenanceClaim {
  readonly id: string;
  readonly ownerId: string;
  readonly token: string;
  readonly epoch: number;
  readonly deadline: number;
  readonly after: string;
  readonly plan: StoredCopyManifest["plan"];
}
const proofs = new WeakSet<CopyMaintenanceClaim>();
export function checkCopyMaintenance(claim: CopyMaintenanceClaim, jobId = claim.id) {
  if (!proofs.has(claim) || claim.id !== jobId || Date.now() >= claim.deadline)
    throw new Error("copy_maintenance_unavailable");
}
export function copyMaintenanceFence(claim: CopyMaintenanceClaim, stopped = true): SqlStatement {
  checkCopyMaintenance(claim);
  return assertExists(
    `SELECT 1 FROM bulk_jobs j JOIN control c ON c.singleton=1
    WHERE j.id=? AND j.owner_id=? AND j.cleanup_token=? AND j.cleanup_epoch=?
      AND j.cleanup_expires_at=? AND j.cleanup_expires_at>${CLOCK}
      AND j.kind='node.copy' AND j.state IN (${stopped ? "'cancelled','failed'" : "'pending','running','cancelled','failed'"})
      AND j.cleanup_epoch=c.epoch AND c.maintenance=0`,
    [claim.id, claim.ownerId, claim.token, claim.epoch, claim.deadline],
  );
}
/** Included in the caller's direct-ACK dispatch transaction; lost ACKs never refund calls. */
export function chargeCopyMaintenance(claim: CopyMaintenanceClaim): SqlStatement[] {
  return [
    copyMaintenanceFence(claim),
    {
      sql: "UPDATE bulk_jobs SET cleanup_calls=cleanup_calls+1,cleanup_total_calls=cleanup_total_calls+1 WHERE id=? AND cleanup_token=? AND cleanup_calls<?",
      values: [claim.id, claim.token, COPY_MAINTENANCE_LIMIT],
    },
    assertOneChange,
  ];
}
export async function claimCopyMaintenance(
  env: SystemMutationSource,
  id: string,
  epoch: number,
  deadline: number,
): Promise<CopyMaintenanceClaim> {
  if (
    !/^copy_[a-f0-9]{64}$/.test(id) ||
    !Number.isSafeInteger(epoch) ||
    epoch < 1 ||
    !Number.isSafeInteger(deadline) ||
    deadline <= Date.now() ||
    deadline > Date.now() + 25_000
  )
    throw new Error("invalid_copy_maintenance");
  const row = await primary(env.DB)
    .prepare("SELECT owner_id,cleanup_after FROM bulk_jobs WHERE id=? AND kind='node.copy'")
    .bind(id)
    .first<{ owner_id: string; cleanup_after: string }>();
  if (!row) throw new Error("copy_job_unavailable");
  const token = crypto.randomUUID();
  const admission = await acquireSystemMutation(
    env,
    row.owner_id,
    "copy.maintenance-claim",
    deadline,
  );
  await commitSystemMutation(env.DB, admission, row.owner_id, [
    assertExists(
      `SELECT 1 ${COPY_MAINTENANCE_FROM} WHERE j.id=? AND c.epoch=? AND c.maintenance=0 AND ${COPY_MAINTENANCE_ELIGIBLE}`,
      [id, epoch],
    ),
    {
      sql: `UPDATE bulk_jobs SET cleanup_token=?,cleanup_epoch=?,cleanup_expires_at=?,cleanup_next_at=${CLOCK}+60000,cleanup_calls=0 WHERE id=? AND cleanup_after=?`,
      values: [token, epoch, deadline, id, row.cleanup_after],
    },
    assertOneChange,
  ]);
  // A corrupt manifest also backs off: scheduling was persisted before this potentially failing read.
  const { plan } = await loadCopyJobManifest(env.DB, id);
  const claim = Object.freeze({
    id,
    ownerId: row.owner_id,
    token,
    epoch,
    deadline,
    after: row.cleanup_after,
    plan,
  });
  proofs.add(claim);
  return claim;
}
/** Advance before external work so a repeatedly slow/unknown blob cannot starve its successors. */
export async function advanceCopyMaintenance(
  env: SystemMutationSource,
  claim: CopyMaintenanceClaim,
  sourceId: string,
) {
  if (!claim.plan.source.blobs.some((b) => b.id === sourceId))
    throw new Error("invalid_copy_maintenance_cursor");
  const admission = await acquireSystemMutation(
    env,
    claim.ownerId,
    "copy.maintenance-progress",
    claim.deadline,
  );
  await commitSystemMutation(env.DB, admission, claim.ownerId, [
    copyMaintenanceFence(claim),
    {
      sql: "UPDATE bulk_jobs SET cleanup_after=? WHERE id=? AND cleanup_token=? AND cleanup_after<?",
      values: [sourceId, claim.id, claim.token, sourceId],
    },
    assertOneChange,
  ]);
}
export async function releaseCopyMaintenance(
  env: SystemMutationSource,
  claim: CopyMaintenanceClaim,
  wrap: boolean,
) {
  const admission = await acquireSystemMutation(
    env,
    claim.ownerId,
    "copy.maintenance-release",
    claim.deadline,
  );
  await commitSystemMutation(env.DB, admission, claim.ownerId, [
    copyMaintenanceFence(claim, false),
    {
      sql: "UPDATE bulk_jobs SET cleanup_expires_at=0,cleanup_after=CASE WHEN ?=1 THEN '' ELSE cleanup_after END WHERE id=? AND cleanup_token=?",
      values: [Number(wrap), claim.id, claim.token],
    },
    assertOneChange,
  ]);
}
