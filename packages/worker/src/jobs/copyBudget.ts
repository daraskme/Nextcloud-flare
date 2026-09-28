import { COPY_EXECUTION_LIMITS as LIMITS } from "./copyLimits";

/** A lower bound, not a promise of completion or evidence that native I/O ended.
 * Use the largest supported part for untouched blobs; existing multipart geometry
 * is immutable. Prepared/unknown sends may still report success without new I/O,
 * so charge no future native call for them. Stored blobs need no more R2 calls.
 */
export function copyRemainingBudgetSql(job: "j" | "NEW"): string {
  const parts = `((b.size+${LIMITS.streamRangeBytes - 1})/${LIMITS.streamRangeBytes})`;
  const unprepared = `(m.part_count-(SELECT COUNT(*) FROM copy_multipart_parts p
    WHERE p.destination_blob_id=m.destination_blob_id))`;
  return `SELECT COALESCE(SUM(CASE WHEN cb.transfer_state='pending' THEN
      CASE WHEN b.size<=${LIMITS.rangeBytes} THEN 2 ELSE 2+2*${parts} END
      WHEN m.state IN ('creating','uploading') THEN 1+2*${unprepared} ELSE 0 END),0) AS calls,
    COALESCE(SUM(CASE WHEN cb.transfer_state='pending' THEN
      CASE WHEN b.size<=${LIMITS.rangeBytes} THEN 1 ELSE 2+${parts} END
      WHEN m.state IN ('creating','uploading') THEN 1+${unprepared} ELSE 1 END),0) AS steps
    FROM copy_job_blobs cb CROSS JOIN blobs b ON b.id=cb.source_blob_id
    LEFT JOIN copy_multipart_uploads m ON m.destination_blob_id=cb.destination_blob_id
    WHERE cb.job_id=${job}.id AND cb.transfer_state<>'stored'`;
}

/** Rechecked by migration 0060's stop trigger; a live execution can still finish. */
export function copyBudgetExhaustedSql(job: "j" | "NEW"): string {
  return `(NOT EXISTS(SELECT 1 FROM job_leases l WHERE l.job_id=${job}.id
      AND l.expires_at>strftime('%s','now')*1000)
    AND (${job}.invocation_count>=${LIMITS.invocations}
      OR EXISTS(SELECT 1 FROM job_leases l WHERE l.job_id=${job}.id AND l.attempt>=${LIMITS.attempts})
      OR EXISTS(SELECT 1 FROM (${copyRemainingBudgetSql(job)}) remaining
        WHERE ${job}.r2_calls+remaining.calls>${LIMITS.r2Calls}
          OR remaining.calls>${LIMITS.invocationR2Calls}*(${LIMITS.invocations}-${job}.invocation_count)
          OR remaining.steps>${LIMITS.steps}*(${LIMITS.invocations}-${job}.invocation_count))))`;
}
