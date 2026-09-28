import { primary } from "../db/primary";
import { UPLOAD_LIMITS } from "../do/uploadPlan";
import type { Env } from "../env";
import {
  COPY_EXECUTION_LIMITS,
  type CopyJobClaim,
  checkCopyClaim,
  claimCopyJob,
  copyClaimOffset,
  copyClaimPosition,
  releaseCopyJobClaim,
} from "./copyClaim";
import { stopExpiredCopyJob } from "./copyLifecycle";
import { loadCopyJobManifest } from "./copyManifest";
import { copyNextBlob } from "./copyMultipart";
import { publishCopyJob } from "./copyPublication";
import { reconcileCopyObject } from "./copyReconcile";

type ExecutorEnv = Pick<Env, "DB" | "CONTROL" | "BLOBS" | "LOCKS">;
export interface CopyExecutionResult {
  jobId: string;
  state: "completed" | "stopped" | "yielded" | "held";
  steps: number;
}
interface StepRow {
  transfer_state: string;
  state: string | null;
  part_bytes: number | null;
  part_count: number | null;
  part_number: number | null;
  part_state: string | null;
}

/** Exact next native cost; a GET must leave room for its subsequent PUT/part. */
async function nextStep(db: D1Database, claim: CopyJobClaim) {
  const blob = claim.plan.source.blobs[copyClaimPosition(claim)];
  if (!blob) return { action: "publish", calls: 0 } as const;
  const row = await primary(db)
    .prepare(`SELECT cb.transfer_state,m.state,m.part_bytes,m.part_count,p.part_number,p.state AS part_state
      FROM copy_job_blobs cb LEFT JOIN copy_multipart_uploads m ON m.destination_blob_id=cb.destination_blob_id
      LEFT JOIN copy_multipart_parts p ON p.destination_blob_id=m.destination_blob_id
        AND p.part_number=(SELECT MAX(part_number) FROM copy_multipart_parts WHERE destination_blob_id=m.destination_blob_id)
      WHERE cb.job_id=? AND cb.source_blob_id=?`)
    .bind(claim.id, blob.id)
    .first<StepRow>();
  if (!row) throw new Error("copy_transfer_unavailable");
  if (row.transfer_state === "stored") return { action: "transfer", calls: 0 } as const;
  if (row.transfer_state === "pending")
    return {
      action: "transfer",
      calls: blob.size <= COPY_EXECUTION_LIMITS.rangeBytes ? 2 : 1,
    } as const;
  if (blob.size <= COPY_EXECUTION_LIMITS.rangeBytes || row.state === "completing")
    return { action: "reconcile", calls: 1 } as const;
  if (row.state !== "uploading" || row.part_state === "claimed")
    return { action: "held", calls: 0 } as const;
  if (
    row.part_number &&
    copyClaimOffset(claim) < Math.min(blob.size, row.part_number * row.part_bytes!)
  )
    return { action: "transfer", calls: 0 } as const;
  return { action: "transfer", calls: (row.part_number ?? 0) < row.part_count! ? 2 : 1 } as const;
}

/** One internal invocation. Durable checkpoints drive replay; terminal holds have separate cleanup. */
export async function executeCopyJob(
  env: ExecutorEnv,
  outboxId: string,
  options: { deadline?: number; partBytes?: number; maxSteps?: number } = {},
): Promise<CopyExecutionResult> {
  const started = Date.now(),
    deadline = options.deadline ?? started + COPY_EXECUTION_LIMITS.wallMs,
    maxSteps = options.maxSteps ?? 32;
  if (
    !/^[A-Za-z0-9_-]{1,128}$/.test(outboxId) ||
    !Number.isSafeInteger(deadline) ||
    deadline <= started ||
    deadline > started + COPY_EXECUTION_LIMITS.wallMs ||
    !Number.isInteger(maxSteps) ||
    maxSteps < 1 ||
    maxSteps > 32 ||
    (options.partBytes !== undefined &&
      (!Number.isSafeInteger(options.partBytes) ||
        options.partBytes < UPLOAD_LIMITS.minPartBytes ||
        options.partBytes > UPLOAD_LIMITS.maxPartBytes))
  )
    throw new Error("invalid_copy_execution");
  const row = await primary(env.DB)
    .prepare(`SELECT j.id,j.state FROM outbox o JOIN bulk_jobs j ON j.id=o.payload_ref AND j.op_id=o.op_id
    WHERE o.outbox_id=? AND o.kind='copy.requested' AND j.kind='node.copy'`)
    .bind(outboxId)
    .first<{ id: string; state: string }>();
  if (!row) throw new Error("copy_job_unavailable");
  const result: CopyExecutionResult = { jobId: row.id, state: "yielded", steps: 0 };
  if (row.state === "completed" || row.state === "cancelled" || row.state === "failed") {
    // Terminal replay still validates the immutable manifest and publication/cleanup receipts.
    await loadCopyJobManifest(env.DB, row.id);
    return { ...result, state: row.state === "completed" ? "completed" : "stopped" };
  }
  if (await stopExpiredCopyJob(env, row.id)) return { ...result, state: "stopped" };
  const claim = await claimCopyJob(env, outboxId, deadline);
  try {
    for (; result.steps < maxSteps; ) {
      checkCopyClaim(claim);
      const step = await nextStep(env.DB, claim);
      if (step.action === "held") return { ...result, state: "held" };
      if (step.calls) {
        const budget = await primary(env.DB)
          .prepare(`SELECT j.r2_calls AS total,l.r2_calls AS invocation FROM job_leases l
          JOIN bulk_jobs j ON j.id=l.job_id WHERE l.job_id=? AND l.claim_token=?`)
          .bind(claim.id, claim.token)
          .first<{ total: number; invocation: number }>();
        if (
          !budget ||
          budget.invocation + step.calls > COPY_EXECUTION_LIMITS.rangeReads ||
          budget.total + step.calls > COPY_EXECUTION_LIMITS.r2Calls
        )
          return result;
      }
      if (step.action === "publish") {
        const published = await publishCopyJob(env, claim);
        if (published.kind === "terminal" && published.operation.state === "committed")
          return { ...result, state: "completed" };
        return { ...result, state: "held" };
      }
      if (step.action === "reconcile") {
        const blob = claim.plan.source.blobs[copyClaimPosition(claim)]!;
        if ((await reconcileCopyObject(env, claim.id, blob.id, claim)) !== "stored")
          return { ...result, state: "held" };
      } else await copyNextBlob(env, claim, options.partBytes);
      result.steps++;
      // Leave time to relinquish the claim. A running native operation still has its original deadline.
      if (Date.now() >= claim.expiresAt - 1000) return result;
    }
    return result;
  } finally {
    await releaseCopyJobClaim(env, claim);
  }
}
