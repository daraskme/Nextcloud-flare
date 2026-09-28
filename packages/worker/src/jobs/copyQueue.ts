import { primary } from "../db/primary";
import type { Env } from "../env";
import { executeCopyJob } from "./copyExecutor";
import { cleanupStoppedCopyJob } from "./copyLifecycle";
import { loadCopyJobManifest } from "./copyManifest";

/** A stopped outbox row alone cannot authorize ack: all original holds need receipts. */
export async function consumeCopyOutbox(
  env: Pick<Env, "DB" | "CONTROL" | "BLOBS" | "LOCKS">,
  outboxId: string,
  deadline: number,
): Promise<"completed" | "failed" | "retry"> {
  const result = await executeCopyJob(env, outboxId, { deadline });
  if (result.state === "yielded" || result.state === "held") return "retry";
  if (result.state === "stopped") {
    if (Date.now() >= deadline) return "retry";
    // Skip unknown writes so one retained hold cannot starve later, proven cleanup.
    // No native repair is dispatched here; a timeout/absence never releases a hold.
    const cleanup = await cleanupStoppedCopyJob(env, result.jobId, { deadline, readyOnly: true });
    if (cleanup.remaining) return "retry";
  }
  // Re-read the exact publication/cleanup receipt after cleanup or a duplicate delivery.
  await loadCopyJobManifest(env.DB, result.jobId);
  const terminal = await primary(env.DB)
    .prepare(`SELECT o.state FROM outbox o JOIN bulk_jobs j ON j.id=o.payload_ref AND j.op_id=o.op_id
      WHERE o.outbox_id=? AND o.kind='copy.requested' AND j.id=? AND j.kind='node.copy'
        AND NOT EXISTS(SELECT 1 FROM copy_job_blobs WHERE job_id=j.id)
        AND ((o.state='completed' AND j.state='completed' AND j.publish_op_id IS NOT NULL)
          OR (o.state='failed' AND j.state IN ('failed','cancelled') AND j.stopped_at IS NOT NULL))`)
    .bind(outboxId, result.jobId)
    .first<"completed" | "failed">("state");
  return terminal ?? "retry";
}
