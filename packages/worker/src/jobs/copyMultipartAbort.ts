import { assertOneChange, atomicBatch, primary } from "../db/primary";
import { COPY_MULTIPART_ABORT_FROM, COPY_MULTIPART_ABORT_READY } from "../db/r2CopyAbort";
import type { Env } from "../env";
import { type R2WriteSource, trackedR2Write } from "../services/r2Write";
import {
  acquireSystemMutation,
  type SystemMutationSource,
  systemMutationStatements,
} from "../services/systemMutation";
import { loadCopyJobManifest } from "./copyManifest";

interface AbortRow {
  destination_blob_id: string;
  r2_key: string;
  r2_upload_id: string;
  abort_attempt: string | null;
  confirmed: number;
}

/** One known handle. An existing preparation is read-only, including a lost ACK.
 * Unknown create/part/complete calls stay held; no absence or timeout is closure.
 * The separate cleanup transaction consumes the durable native success receipt.
 */
export async function abortStoppedCopyMultipart(
  env: SystemMutationSource & R2WriteSource & Pick<Env, "BLOBS">,
  jobId: string,
  sourceBlobId: string,
): Promise<"confirmed" | "held"> {
  const deadline = Date.now() + 25_000;
  if (!/^copy_[a-f0-9]{64}$/.test(jobId) || !/^[A-Za-z0-9_-]{1,128}$/.test(sourceBlobId))
    throw new Error("invalid_copy_abort");
  const { plan } = await loadCopyJobManifest(env.DB, jobId);
  const stopped = await primary(env.DB)
    .prepare(
      "SELECT 1 FROM bulk_jobs WHERE id=? AND state IN ('cancelled','failed') AND stopped_at IS NOT NULL",
    )
    .bind(jobId)
    .first();
  if (!stopped) throw new Error("copy_not_stopped");
  const read = async (): Promise<AbortRow | null> =>
    primary(env.DB)
      .prepare(`SELECT
    cb.destination_blob_id,b.r2_key,m.r2_upload_id,m.abort_attempt,
    EXISTS(SELECT 1 FROM r2_write_attempts w INDEXED BY r2_write_source
      WHERE w.kind='multipart.abort' AND w.source_ref=json_array('copy',cb.job_id,cb.source_blob_id,m.abort_attempt)
        AND w.state='succeeded' AND w.state<>'not_started' AND w.epoch=m.abort_epoch
        AND w.owner_id=j.owner_id AND w.r2_key=b.r2_key) AS confirmed
    ${COPY_MULTIPART_ABORT_FROM} WHERE cb.job_id=? AND cb.source_blob_id=? AND ${COPY_MULTIPART_ABORT_READY}`)
      .bind(jobId, sourceBlobId)
      .first<AbortRow>();
  const alreadySettled = async () =>
    !!(await primary(env.DB)
      .prepare(
        "SELECT 1 FROM copy_cleanup_receipts WHERE job_id=? AND source_blob_id=? AND disposition='aborted'",
      )
      .bind(jobId, sourceBlobId)
      .first());
  const row = await read();
  if (!row) return (await alreadySettled()) ? "confirmed" : "held";
  if (row.abort_attempt) return row.confirmed ? "confirmed" : "held";
  const admission = await acquireSystemMutation(
    env,
    plan.destinationOwnerId,
    "copy.multipart-abort",
    deadline,
  );
  const attempt = crypto.randomUUID(),
    startedAt = Date.now();
  if (startedAt >= deadline) throw new Error("copy_abort_budget");
  // Only this direct ACK authorizes dispatch. A committed but unacknowledged
  // preparation must never be replayed from a later invocation.
  await atomicBatch(
    env.DB,
    systemMutationStatements(admission, plan.destinationOwnerId, [
      {
        sql: `UPDATE copy_multipart_uploads SET abort_attempt=?,abort_epoch=?,abort_started_at=?,abort_deadline=?
        WHERE destination_blob_id=? AND r2_upload_id=? AND abort_attempt IS NULL`,
        values: [
          attempt,
          admission.epoch,
          startedAt,
          deadline,
          row.destination_blob_id,
          row.r2_upload_id,
        ],
      },
      assertOneChange,
    ]),
  );
  try {
    await trackedR2Write(
      env,
      {
        epoch: admission.epoch,
        ownerId: plan.destinationOwnerId,
        kind: "multipart.abort",
        key: row.r2_key,
        abort: {
          source: "copy",
          jobId,
          sourceBlobId,
          attemptId: attempt,
          r2UploadId: row.r2_upload_id,
          maintenance: admission.maintenance === 1,
        },
      },
      () => env.BLOBS.resumeMultipartUpload(row.r2_key, row.r2_upload_id).abort(),
      deadline,
    );
  } catch {
    // A lost finish reply can be reconciled by its exact receipt, but cannot
    // cause another native abort. Pending/failed calls remain held.
  }
  return (await read())?.confirmed || (await alreadySettled()) ? "confirmed" : "held";
}
