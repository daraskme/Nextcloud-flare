import type { Principal } from "../auth/authorize";
import { GC_NOT_BEFORE_SQL } from "../db/gcGrace";
import {
  assertExists,
  assertOneChange,
  atomicBatch,
  primary,
  type SqlStatement,
} from "../db/primary";
import {
  acquireSystemMutation,
  commitSystemMutation,
  type SystemMutationSource,
} from "../services/systemMutation";
import { COPY_EXECUTION_LIMITS, copyAuthorityStatements } from "./copyClaim";
import { loadCopyJobManifest } from "./copyManifest";

const CLOCK = "strftime('%s','now')*1000";
type StopReason = "copy_cancelled" | "copy_expired" | "stale_epoch" | "copy_budget_exhausted";
export interface CopyJobStatus {
  id: string;
  state: "pending" | "running" | "completed" | "cancelled" | "failed";
  nodeCount: number;
  blobCount: number;
  cleanupPending: number;
  heldBytes: number;
  errorCode: string | null;
  publishedRootId: string | null;
}
const statusQuery = (id: string): SqlStatement => ({
  sql: `SELECT j.id,j.state,j.node_count AS nodeCount,j.blob_count AS blobCount,
    CASE WHEN j.state IN ('cancelled','failed') THEN (SELECT COUNT(*) FROM copy_job_blobs WHERE job_id=j.id) ELSE 0 END AS cleanupPending,
    COALESCE((SELECT SUM(r.bytes) FROM copy_job_blobs cb JOIN reservations r ON r.id=cb.reservation_id WHERE cb.job_id=j.id),0) AS heldBytes,
    j.error_code AS errorCode,j.published_root_id AS publishedRootId FROM bulk_jobs j WHERE j.id=? AND j.kind='node.copy'`,
  values: [id],
});
async function authority(db: D1Database, principal: Principal, id: string) {
  const { plan } = await loadCopyJobManifest(db, id);
  if (
    principal.kind !== "user" ||
    plan.principal.kind !== "user" ||
    principal.user_id !== plan.principal.user_id ||
    principal.credential_id !== plan.principal.credential_id
  )
    throw new Error("authorization_denied");
  const statements = await copyAuthorityStatements(db, {
    ...plan,
    principal: { ...plan.principal, epoch: principal.epoch },
  });
  return { plan, statements };
}

/** Reauthorize both original operands and selections, including terminal receipt reads. */
export async function readCopyJob(
  db: D1Database,
  principal: Principal,
  id: string,
): Promise<CopyJobStatus> {
  const { statements } = await authority(db, principal, id);
  const result = await atomicBatch(db, [...statements, statusQuery(id)]);
  const status = result.at(-1)?.results[0] as unknown as CopyJobStatus | undefined;
  if (!status) throw new Error("copy_job_unavailable");
  return status;
}

function stopStatements(id: string, reason: StopReason, epoch: number): SqlStatement[] {
  return [
    {
      sql: `UPDATE bulk_jobs SET state=?,error_code=?,stopped_at=MAX(created_at,${CLOCK}),stop_epoch=?,updated_at=MAX(updated_at,${CLOCK})
        WHERE id=? AND kind='node.copy' AND state IN ('pending','running') AND publish_op_id IS NULL`,
      values: [reason === "copy_cancelled" ? "cancelled" : "failed", reason, epoch, id],
    },
    assertOneChange,
    {
      sql: `UPDATE operations SET state='failed',error_code=?,updated_at=MAX(updated_at,${CLOCK})
        WHERE kind='copy.publish' AND state='claimed' AND json_extract(operands_json,'$.jobId')=?
        AND NOT EXISTS(SELECT 1 FROM operation_steps WHERE op_id=operations.op_id)`,
      values: [reason, id],
    },
    {
      sql: `UPDATE outbox SET state='failed',updated_at=MAX(updated_at,${CLOCK})
        WHERE kind='copy.requested' AND payload_ref=? AND op_id=(SELECT op_id FROM bulk_jobs WHERE id=?)
          AND state IN ('pending','dispatching','sent','failed')`,
      values: [id, id],
    },
    assertOneChange,
    { sql: "DELETE FROM job_leases WHERE job_id=?", values: [id] },
  ];
}

/** Stop dispatch/publication atomically. Existing native calls and all holds remain recorded. */
export async function cancelCopyJob(
  env: SystemMutationSource,
  principal: Principal,
  id: string,
): Promise<CopyJobStatus> {
  const { plan, statements } = await authority(env.DB, principal, id);
  const status = await primary(env.DB).prepare(statusQuery(id).sql).bind(id).first<CopyJobStatus>();
  if (!status) throw new Error("copy_job_unavailable");
  if (status.state === "cancelled" || status.state === "failed")
    return readCopyJob(env.DB, principal, id);
  if (status.state === "completed") throw new Error("copy_already_completed");
  const admission = await acquireSystemMutation(env, plan.destinationOwnerId, "copy.stop");
  try {
    await commitSystemMutation(env.DB, admission, plan.destinationOwnerId, [
      ...statements,
      assertExists("SELECT 1 FROM control WHERE singleton=1 AND epoch=? AND maintenance=0", [
        principal.epoch,
      ]),
      ...stopStatements(id, "copy_cancelled", admission.epoch),
    ]);
  } catch (error) {
    const latest = await readCopyJob(env.DB, principal, id);
    if (latest.state !== "cancelled" && latest.state !== "failed") throw error;
  }
  return readCopyJob(env.DB, principal, id);
}

/** Internal bounded executor/recovery entry; eligibility is rechecked by SQL in the stop batch. */
export async function stopExpiredCopyJob(env: SystemMutationSource, id: string): Promise<boolean> {
  const { plan } = await loadCopyJobManifest(env.DB, id);
  const row = await primary(env.DB)
    .prepare(`SELECT j.state,
    CASE WHEN j.epoch<c.epoch THEN 'stale_epoch' WHEN m.expires_at<=${CLOCK} THEN 'copy_expired'
      WHEN (j.invocation_count>=? OR j.r2_calls>=? OR l.attempt>=?) AND COALESCE(l.expires_at,0)<=${CLOCK} THEN 'copy_budget_exhausted' END AS reason
    FROM bulk_jobs j JOIN copy_job_manifests m ON m.job_id=j.id JOIN control c ON c.singleton=1
    LEFT JOIN job_leases l ON l.job_id=j.id WHERE j.id=?`)
    .bind(
      COPY_EXECUTION_LIMITS.invocations,
      COPY_EXECUTION_LIMITS.r2Calls,
      COPY_EXECUTION_LIMITS.attempts,
      id,
    )
    .first<{ state: string; reason: StopReason | null }>();
  if (!row?.reason || !["pending", "running"].includes(row.state)) return false;
  const admission = await acquireSystemMutation(env, plan.destinationOwnerId, "copy.stop");
  await commitSystemMutation(
    env.DB,
    admission,
    plan.destinationOwnerId,
    stopStatements(id, row.reason, admission.epoch),
  );
  return true;
}

interface CleanupBlob {
  source_blob_id: string;
  destination_blob_id: string;
  pin_id: string;
  reservation_id: string;
  size: number;
  disposition: "unwritten" | "stored" | "aborted" | null;
}
export interface CopyCleanupResult {
  examined: number;
  settled: number;
  held: number;
  remaining: number;
  nextAfter: string | null;
}

/** No external I/O or inferred absence. A page may retain unknown native calls or open multipart. */
export async function cleanupStoppedCopyJob(
  env: SystemMutationSource,
  id: string,
  options: { after?: string; limit?: number } = {},
): Promise<CopyCleanupResult> {
  const deadline = Date.now() + 25_000;
  const { after = "", limit = 32 } = options;
  if (
    !Number.isInteger(limit) ||
    limit < 1 ||
    limit > 32 ||
    (after && !/^[A-Za-z0-9_-]{1,128}$/.test(after))
  )
    throw new Error("invalid_copy_cleanup");
  const { plan } = await loadCopyJobManifest(env.DB, id);
  const terminal = await primary(env.DB)
    .prepare(
      "SELECT 1 FROM bulk_jobs WHERE id=? AND state IN ('cancelled','failed') AND stopped_at IS NOT NULL",
    )
    .bind(id)
    .first();
  if (!terminal) throw new Error("copy_not_stopped");
  const rows = await primary(env.DB)
    .prepare(`SELECT cb.source_blob_id,cb.destination_blob_id,cb.pin_id,cb.reservation_id,source.size,
    CASE WHEN EXISTS(SELECT 1 FROM r2_write_attempts w WHERE w.r2_key='u/'||j.owner_id||'/b/'||cb.destination_blob_id AND w.state='pending') THEN NULL
      WHEN m.abort_attempt IS NOT NULL AND EXISTS(SELECT 1 FROM r2_write_attempts w INDEXED BY r2_write_source
        WHERE w.kind='multipart.abort' AND w.source_ref=json_array('copy',cb.job_id,cb.source_blob_id,m.abort_attempt)
          AND w.state='succeeded' AND w.state<>'not_started' AND w.epoch=m.abort_epoch
          AND w.owner_id=j.owner_id AND w.r2_key='u/'||j.owner_id||'/b/'||cb.destination_blob_id) THEN 'aborted'
      WHEN cb.transfer_state='stored' AND EXISTS(SELECT 1 FROM r2_write_attempts w INDEXED BY r2_write_source
        WHERE w.kind=CASE cb.transfer_mode WHEN 'single' THEN 'copy.put' ELSE 'copy.multipart.complete' END
          AND w.source_ref=json_array(cb.job_id,cb.source_blob_id,CASE cb.transfer_mode WHEN 'single' THEN cb.transfer_attempt ELSE m.complete_attempt END)
          AND w.state='succeeded' AND w.state<>'not_started') THEN 'stored'
      WHEN cb.transfer_state='pending' THEN 'unwritten'
      WHEN cb.transfer_state='claimed' AND NOT EXISTS(SELECT 1 FROM r2_write_attempts w WHERE w.r2_key='u/'||j.owner_id||'/b/'||cb.destination_blob_id AND w.state<>'not_started')
        AND EXISTS(SELECT 1 FROM r2_write_attempts w WHERE w.kind=CASE cb.transfer_mode WHEN 'single' THEN 'copy.put' ELSE 'copy.multipart.create' END
          AND w.source_ref=json_array(cb.job_id,cb.source_blob_id,cb.transfer_attempt) AND w.state='not_started') THEN 'unwritten'
    END AS disposition
    FROM copy_job_blobs cb JOIN bulk_jobs j ON j.id=cb.job_id JOIN blobs source ON source.id=cb.source_blob_id
    LEFT JOIN copy_multipart_uploads m ON m.destination_blob_id=cb.destination_blob_id
    WHERE cb.job_id=? AND cb.source_blob_id>? ORDER BY cb.source_blob_id LIMIT ?`)
    .bind(id, after, limit + 1)
    .all<CleanupBlob>();
  const result: CopyCleanupResult = {
    examined: 0,
    settled: 0,
    held: 0,
    remaining: 0,
    nextAfter: null,
  };
  for (const row of rows.results.slice(0, limit)) {
    if (Date.now() >= deadline) {
      if (result.examined === 0) throw new Error("copy_cleanup_budget");
      break;
    }
    if (row.disposition) {
      const admission = await acquireSystemMutation(
        env,
        plan.destinationOwnerId,
        "copy.cleanup",
        deadline,
      );
      const stored = row.disposition === "stored";
      await commitSystemMutation(env.DB, admission, plan.destinationOwnerId, [
        {
          sql: `INSERT INTO copy_cleanup_receipts(job_id,source_blob_id,destination_blob_id,pin_id,reservation_id,bytes,disposition,epoch,settled_at)
            VALUES(?,?,?,?,?,?,?,?,MAX(${CLOCK},(SELECT stopped_at FROM bulk_jobs WHERE id=?)))`,
          values: [
            id,
            row.source_blob_id,
            row.destination_blob_id,
            row.pin_id,
            row.reservation_id,
            row.size,
            row.disposition,
            admission.epoch,
            id,
          ],
        },
        {
          sql: "UPDATE reservations SET state='released' WHERE id=? AND state='reserved'",
          values: [row.reservation_id],
        },
        assertOneChange,
        {
          sql: "UPDATE blobs SET state=? WHERE id=? AND state='staging' AND ref_count=0",
          values: [stored ? "orphan" : "deleted", row.destination_blob_id],
        },
        ...(stored
          ? [
              assertOneChange,
              {
                sql: `INSERT INTO gc_candidates(blob_id,state,not_before) VALUES(?,'candidate',${GC_NOT_BEFORE_SQL})`,
                values: [row.destination_blob_id],
              },
            ]
          : []),
        {
          sql: "DELETE FROM copy_multipart_parts WHERE destination_blob_id=?",
          values: [row.destination_blob_id],
        },
        {
          sql: "DELETE FROM copy_multipart_uploads WHERE destination_blob_id=?",
          values: [row.destination_blob_id],
        },
        {
          sql: "DELETE FROM copy_job_blobs WHERE job_id=? AND source_blob_id=?",
          values: [id, row.source_blob_id],
        },
        assertOneChange,
        { sql: "DELETE FROM blob_pins WHERE pin_id=?", values: [row.pin_id] },
        assertOneChange,
      ]);
      result.settled++;
    } else result.held++;
    result.examined++;
    result.nextAfter = row.source_blob_id;
  }
  if (result.examined === rows.results.length) result.nextAfter = null;
  result.remaining =
    (await primary(env.DB)
      .prepare("SELECT COUNT(*) AS n FROM copy_job_blobs WHERE job_id=?")
      .bind(id)
      .first<number>("n")) ?? 0;
  return result;
}
