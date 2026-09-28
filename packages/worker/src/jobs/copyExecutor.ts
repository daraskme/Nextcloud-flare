import { d1CallBudget } from "../db/callBudget";
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
  total_calls: number;
  invocation_calls: number | null;
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
    .prepare(`SELECT cb.transfer_state,m.state,m.part_bytes,m.part_count,p.part_number,p.state AS part_state,
      j.r2_calls AS total_calls,l.r2_calls AS invocation_calls
      FROM copy_job_blobs cb JOIN bulk_jobs j ON j.id=cb.job_id
      LEFT JOIN job_leases l ON l.job_id=j.id AND l.claim_token=?
      LEFT JOIN copy_multipart_uploads m ON m.destination_blob_id=cb.destination_blob_id
      LEFT JOIN copy_multipart_parts p ON p.destination_blob_id=m.destination_blob_id
        AND p.part_number=(SELECT MAX(part_number) FROM copy_multipart_parts WHERE destination_blob_id=m.destination_blob_id)
      WHERE cb.job_id=? AND cb.source_blob_id=?`)
    .bind(claim.token, claim.id, blob.id)
    .first<StepRow>();
  if (!row) throw new Error("copy_transfer_unavailable");
  const step = (action: "transfer" | "reconcile", calls: number) => ({
    action:
      calls &&
      (row.invocation_calls === null ||
        row.invocation_calls + calls > COPY_EXECUTION_LIMITS.invocationR2Calls ||
        row.total_calls + calls > COPY_EXECUTION_LIMITS.r2Calls)
        ? ("yield" as const)
        : action,
    calls,
  });
  if (row.transfer_state === "stored") return { action: "transfer", calls: 0 } as const;
  if (row.transfer_state === "pending")
    return step("transfer", blob.size <= COPY_EXECUTION_LIMITS.rangeBytes ? 2 : 1);
  if (blob.size <= COPY_EXECUTION_LIMITS.rangeBytes || row.state === "completing")
    return step("reconcile", 1);
  if (row.state !== "uploading" || row.part_state === "claimed")
    return { action: "held", calls: 0 } as const;
  if (
    row.part_number &&
    copyClaimOffset(claim) < Math.min(blob.size, row.part_number * row.part_bytes!)
  )
    return { action: "transfer", calls: 0 } as const;
  return step("transfer", (row.part_number ?? 0) < row.part_count! ? 2 : 1);
}

/** One internal invocation. Durable checkpoints drive replay; terminal holds have separate cleanup. */
export async function executeCopyJob(
  env: ExecutorEnv,
  outboxId: string,
  options: { deadline?: number; partBytes?: number; maxSteps?: number } = {},
): Promise<CopyExecutionResult> {
  const started = Date.now(),
    deadline = options.deadline ?? started + COPY_EXECUTION_LIMITS.wallMs,
    maxSteps = options.maxSteps ?? COPY_EXECUTION_LIMITS.steps;
  if (
    !/^[A-Za-z0-9_-]{1,128}$/.test(outboxId) ||
    !Number.isSafeInteger(deadline) ||
    deadline <= started ||
    deadline > started + COPY_EXECUTION_LIMITS.wallMs ||
    !Number.isInteger(maxSteps) ||
    maxSteps < 1 ||
    maxSteps > COPY_EXECUTION_LIMITS.steps ||
    (options.partBytes !== undefined &&
      (!Number.isSafeInteger(options.partBytes) ||
        options.partBytes < UPLOAD_LIMITS.minPartBytes ||
        options.partBytes > UPLOAD_LIMITS.maxPartBytes))
  )
    throw new Error("invalid_copy_execution");
  const budget = d1CallBudget(env.DB, COPY_EXECUTION_LIMITS.d1Calls),
    reservedCalls = COPY_EXECUTION_LIMITS.d1Calls - COPY_EXECUTION_LIMITS.d1YieldCalls;
  env = { ...env, DB: budget.db };
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
  // A caller may have already spent part of this invocation's D1 allowance.
  // Do not consume an execution claim when there is no room to begin work.
  if (budget.calls >= budget.limit - reservedCalls) return result;
  if (await stopExpiredCopyJob(env, row.id, deadline)) return { ...result, state: "stopped" };
  const claim = await claimCopyJob(env, outboxId, deadline);
  try {
    for (;;) {
      checkCopyClaim(claim);
      // Reserve calls for one step, publication and release. Once all blobs are
      // checkpointed, publish in this claim even at the final native/step limit.
      if (
        copyClaimPosition(claim) < claim.plan.source.blobs.length &&
        (result.steps >= maxSteps || budget.calls >= budget.limit - reservedCalls)
      )
        return result;
      const step = await nextStep(env.DB, claim);
      if (step.action === "held") return { ...result, state: "held" };
      if (step.action === "yield") return result;
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
      if (
        copyClaimPosition(claim) < claim.plan.source.blobs.length &&
        Date.now() >= claim.expiresAt - 1000
      )
        return result;
    }
  } finally {
    await releaseCopyJobClaim(env, claim);
  }
}
