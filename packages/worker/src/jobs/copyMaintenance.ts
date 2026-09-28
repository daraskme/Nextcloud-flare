import { primary } from "../db/primary";
import type { Env } from "../env";
import { cleanupStoppedCopyJob, stopExpiredCopyJob } from "./copyLifecycle";
import {
  advanceCopyMaintenance,
  COPY_MAINTENANCE_ELIGIBLE,
  COPY_MAINTENANCE_FROM,
  COPY_MAINTENANCE_LIMIT,
  claimCopyMaintenance,
  releaseCopyMaintenance,
} from "./copyMaintenanceClaim";
import { abortStoppedCopyMultipart } from "./copyMultipartAbort";
import { reconcileCopyObject } from "./copyReconcile";

export interface CopyMaintenanceResult {
  jobId: string | null;
  inspected: number;
  settled: number;
  remaining: number;
}
/** A separate Cron invocation: one fair leased job, at most eight repair candidates and eight settlements. */
export async function repairStoppedCopyJobs(
  env: Pick<Env, "DB" | "CONTROL" | "BLOBS">,
  epoch: number,
  options: { deadline?: number; maxBlobs?: number; jobId?: string } = {},
): Promise<CopyMaintenanceResult> {
  const started = Date.now(),
    deadline = options.deadline ?? started + 25_000,
    limit = options.maxBlobs ?? COPY_MAINTENANCE_LIMIT;
  if (
    !Number.isSafeInteger(epoch) ||
    epoch < 1 ||
    !Number.isSafeInteger(deadline) ||
    deadline <= started ||
    deadline > started + 25_000 ||
    !Number.isInteger(limit) ||
    limit < 1 ||
    limit > COPY_MAINTENANCE_LIMIT ||
    (options.jobId !== undefined && !/^copy_[a-f0-9]{64}$/.test(options.jobId))
  )
    throw new Error("invalid_copy_maintenance");
  const result: CopyMaintenanceResult = { jobId: null, inspected: 0, settled: 0, remaining: 0 };
  const row = await primary(env.DB)
    .prepare(`SELECT j.id ${COPY_MAINTENANCE_FROM}
    WHERE c.epoch=? AND c.maintenance=0 AND ${COPY_MAINTENANCE_ELIGIBLE}
      AND (? IS NULL OR j.id=?) ORDER BY j.cleanup_next_at,j.id LIMIT 1`)
    .bind(epoch, options.jobId ?? null, options.jobId ?? null)
    .first<{ id: string }>();
  if (!row) return result;
  const claim = await claimCopyMaintenance(env, row.id, epoch, deadline);
  result.jobId = row.id;
  let wrap = false;
  try {
    await stopExpiredCopyJob(env, row.id, deadline, claim);
    const rows = await primary(env.DB)
      .prepare(
        "SELECT source_blob_id FROM copy_job_blobs WHERE job_id=? AND source_blob_id>? ORDER BY source_blob_id LIMIT ?",
      )
      .bind(row.id, claim.after, limit + 1)
      .all<{ source_blob_id: string }>();
    for (const blob of rows.results.slice(0, limit)) {
      if (Date.now() >= deadline - 1000) break;
      await advanceCopyMaintenance(env, claim, blob.source_blob_id);
      result.inspected++;
      try {
        if (
          (await reconcileCopyObject(env, row.id, blob.source_blob_id, undefined, {
            deadline,
            maintenance: claim,
          })) !== "stored"
        )
          await abortStoppedCopyMultipart(env, row.id, blob.source_blob_id, {
            deadline,
            maintenance: claim,
          });
      } catch {
        // Retain ambiguous writes and already-charged calls. The cursor grants no release permission.
      }
    }
    wrap = result.inspected === rows.results.length;
    if (Date.now() < deadline - 1000) {
      const cleanup = await cleanupStoppedCopyJob(env, row.id, {
        deadline,
        limit,
        readyOnly: true,
        maintenance: claim,
      });
      result.settled = cleanup.settled;
      result.remaining = cleanup.remaining;
    } else
      result.remaining = (await primary(env.DB)
        .prepare("SELECT COUNT(*) AS n FROM copy_job_blobs WHERE job_id=?")
        .bind(row.id)
        .first<number>("n"))!;
    return result;
  } finally {
    // Expiry stops new dispatch; it never proves the completion of an external call.
    if (Date.now() < deadline) await releaseCopyMaintenance(env, claim, wrap);
  }
}
