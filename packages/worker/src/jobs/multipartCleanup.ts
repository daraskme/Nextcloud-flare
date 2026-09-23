import { assertExists, assertOneChange, atomicBatch, primary } from "../db/primary";
import {
  COMPLETION,
  controlFence,
  matches,
  observedObject,
  settleUploadCleanup,
  UNPUBLISHED,
  type UploadCleanupCandidate,
  type UploadCleanupResult,
} from "./uploadCleanup";

const CLOCK = "strftime('%s','now')*1000";
const TERMINAL = "'expired','aborted','failed'";
const LEASE_MS = 60_000;
export interface MultipartCleanupCandidate extends UploadCleanupCandidate {
  r2_upload_id: string | null;
  multipart_complete_attempt: string | null;
  multipart_cleanup_closed: "aborted" | "completed" | null;
}
type Candidate = MultipartCleanupCandidate;

// Expired leases stop dispatch; elapsed time alone never proves that R2 data is absent.
const DRAINED = `(u.r2_upload_id IS NOT NULL OR COALESCE(u.write_lease_expires_at,0)<=${CLOCK})
  AND COALESCE(u.multipart_complete_lease,0)<=${CLOCK}
  AND NOT EXISTS(SELECT 1 FROM upload_parts p WHERE p.upload_id=u.id
    AND p.state IN ('in_flight','unknown') AND p.lease_expires_at>${CLOCK})`;
export const MULTIPART_CLEANUP_ELIGIBLE = `u.mode='multipart' AND u.state<>'completed' AND u.upload_name IS NOT NULL
  AND u.cleanup_next_at<=${CLOCK}
  AND (u.cleanup_token IS NULL OR u.cleanup_lease_expires_at<=${CLOCK})
  AND (u.epoch<? OR u.expires_at<=${CLOCK} OR u.last_progress_at<=${CLOCK}-86400000
    OR (u.state IN ('aborting',${TERMINAL}) AND u.cleanup_pending=1)
    OR (u.state IN ('created','uploading') AND EXISTS(SELECT 1 FROM upload_parts p
      WHERE p.upload_id=u.id AND p.state IN ('in_flight','unknown') AND p.lease_expires_at<=${CLOCK})))
  AND ${DRAINED}
  AND b.state IN ('staging','orphan') AND b.ref_count=0
  AND ${UNPUBLISHED}
  AND NOT EXISTS(SELECT 1 FROM blob_pins WHERE blob_id=b.id)
  AND NOT EXISTS(SELECT 1 FROM gc_candidates WHERE blob_id=b.id)`;
const ELIGIBLE = `${MULTIPART_CLEANUP_ELIGIBLE}
  AND NOT EXISTS(SELECT 1 FROM multipart_inventory_scans WHERE upload_id=u.id)`;
export const MULTIPART_INVENTORY_ELIGIBLE = `${MULTIPART_CLEANUP_ELIGIBLE}
  AND u.multipart_cleanup_closed IS NULL
  AND (u.r2_upload_id IS NULL OR EXISTS(SELECT 1 FROM multipart_inventory_scans WHERE upload_id=u.id))`;

export function multipartCleanupFence(row: Candidate, token: string, closed = false) {
  return assertExists(
    `SELECT 1 FROM uploads u JOIN blobs b ON b.id=u.blob_id
    WHERE u.id=? AND u.blob_id=? AND u.r2_upload_id IS ?
      AND u.cleanup_token=? AND u.cleanup_lease_expires_at>${CLOCK}
      AND u.mode='multipart' AND u.state IN (${TERMINAL}) AND u.cleanup_pending=1
      AND u.multipart_cleanup_started_at IS NOT NULL
      ${closed ? "AND u.multipart_cleanup_closed IS NOT NULL" : ""}
      AND b.state='orphan' AND b.ref_count=0 AND ${UNPUBLISHED}
      AND NOT EXISTS(SELECT 1 FROM blob_pins WHERE blob_id=b.id)
      AND NOT EXISTS(SELECT 1 FROM gc_candidates WHERE blob_id=b.id)`,
    [row.id, row.blob_id, row.r2_upload_id, token],
  );
}
const cleanupFence = multipartCleanupFence;

export async function claimMultipartCleanup(
  db: D1Database,
  id: string,
  epoch: number,
  maintenance: boolean,
  token: string,
  inventorySource?: string,
): Promise<Candidate | null> {
  try {
    await atomicBatch(db, [
      controlFence(epoch, maintenance),
      assertExists(
        `SELECT 1 FROM uploads u JOIN blobs b ON b.id=u.blob_id WHERE u.id=? AND u.epoch<=? AND ${inventorySource === undefined ? ELIGIBLE : MULTIPART_INVENTORY_ELIGIBLE}`,
        [id, epoch, epoch],
      ),
      {
        sql: `UPDATE operations SET state='failed',error_code='upload_expired',updated_at=MAX(updated_at,${CLOCK})
          WHERE state='claimed' AND op_id IN (SELECT o.op_id FROM operations o JOIN uploads u ON ${COMPLETION} WHERE u.id=?)`,
        values: [id],
      },
      {
        sql: `UPDATE uploads SET state=CASE WHEN epoch<? THEN 'failed'
            WHEN state='aborting' THEN CASE WHEN error_code='upload_aborted' THEN 'aborted' ELSE 'failed' END
            WHEN state IN (${TERMINAL}) THEN state WHEN state='completing' THEN 'failed' ELSE 'expired' END,
          error_code=CASE WHEN epoch<? THEN 'stale_epoch' ELSE COALESCE(error_code,'upload_expired') END,
          accept_parts=0,in_flight=0,cleanup_pending=1,
          multipart_cleanup_started_at=COALESCE(multipart_cleanup_started_at,${CLOCK}),
          cleanup_token=?,cleanup_lease_expires_at=${CLOCK}+?,cleanup_next_at=${CLOCK}+?,cleanup_error=NULL WHERE id=?`,
        values: [epoch, epoch, token, LEASE_MS, LEASE_MS, id],
      },
      assertOneChange,
      {
        sql: "UPDATE upload_parts SET state='unknown' WHERE upload_id=? AND state='in_flight'",
        values: [id],
      },
      {
        sql: "UPDATE blobs SET state='orphan' WHERE id=(SELECT blob_id FROM uploads WHERE id=?) AND state IN ('staging','orphan') AND ref_count=0",
        values: [id],
      },
      assertOneChange,
      ...(inventorySource === undefined
        ? []
        : [
            {
              sql: `INSERT INTO multipart_inventory_scans(upload_id,r2_key,source,epoch,round_id)
          SELECT u.id,b.r2_key,?,?,? FROM uploads u JOIN blobs b ON b.id=u.blob_id WHERE u.id=?
          ON CONFLICT(upload_id) DO NOTHING`,
              values: [inventorySource, epoch, crypto.randomUUID(), id],
            },
          ]),
    ]);
  } catch {
    // The durable stop, not a replay of the original dispatch, recovers a lost claim reply.
  }
  return primary(db)
    .prepare(`SELECT u.id,u.owner_id,u.blob_id,u.reservation_id,u.epoch,u.write_attempt_id,b.r2_key,
      u.r2_upload_id,u.multipart_complete_attempt,u.multipart_cleanup_closed
      FROM uploads u JOIN blobs b ON b.id=u.blob_id
      WHERE u.id=? AND u.cleanup_token=? AND u.cleanup_lease_expires_at>${CLOCK}
        AND u.multipart_cleanup_started_at IS NOT NULL AND u.state IN (${TERMINAL})`)
    .bind(id, token)
    .first<Candidate>();
}

/** Internal, bounded repair. A reservation survives until the multipart handle is proven closed. */
export async function repairMultipartUploads(
  db: D1Database,
  bucket: R2Bucket,
  epoch: number,
  options: { maxUploads?: number; maxWallMs?: number; maintenance?: boolean } = {},
): Promise<UploadCleanupResult> {
  const limit = options.maxUploads ?? 20;
  const wall = options.maxWallMs ?? 20_000;
  const maintenance = options.maintenance ?? false;
  if (
    !Number.isSafeInteger(epoch) ||
    epoch < 1 ||
    !Number.isSafeInteger(limit) ||
    limit < 1 ||
    limit > 100 ||
    !Number.isSafeInteger(wall) ||
    wall < 1 ||
    wall > 25_000
  )
    throw new Error("invalid_upload_cleanup_limit");
  const started = Date.now();
  const result: UploadCleanupResult = { claimed: 0, absent: 0, queued: 0, retried: 0, r2Calls: 0 };
  const rows = await primary(db)
    .prepare(`SELECT u.id FROM uploads u JOIN blobs b ON b.id=u.blob_id
      WHERE u.epoch<=? AND ${ELIGIBLE}
      AND EXISTS(SELECT 1 FROM control WHERE singleton=1 AND epoch=? AND maintenance=? AND (?=0 OR gc_paused=1))
      ORDER BY u.cleanup_next_at,u.expires_at,u.id LIMIT ?`)
    .bind(epoch, epoch, epoch, maintenance ? 1 : 0, maintenance ? 1 : 0, limit)
    .all<{ id: string }>();
  for (const { id } of rows.results) {
    if (Date.now() - started >= wall) break;
    const token = crypto.randomUUID();
    const row = await claimMultipartCleanup(db, id, epoch, maintenance, token);
    if (!row) continue;
    result.claimed++;
    const charge = async () => {
      await atomicBatch(db, [
        controlFence(epoch, maintenance),
        cleanupFence(row, token),
        {
          sql: "UPDATE uploads SET cleanup_calls=cleanup_calls+1 WHERE id=? AND cleanup_token=?",
          values: [id, token],
        },
        assertOneChange,
      ]);
      result.r2Calls++;
    };
    try {
      if (row.r2_upload_id && !row.multipart_cleanup_closed) {
        await charge();
        let aborted = false;
        try {
          await bucket.resumeMultipartUpload(row.r2_key, row.r2_upload_id).abort();
          aborted = true;
        } catch {
          // NoSuchUpload/transport errors alone do not prove that a completed object is absent.
        }
        if (aborted) {
          await atomicBatch(db, [
            controlFence(epoch, maintenance),
            cleanupFence(row, token),
            {
              sql: "UPDATE uploads SET multipart_cleanup_closed='aborted' WHERE id=? AND multipart_cleanup_closed IS NULL",
              values: [id],
            },
            assertOneChange,
          ]);
          row.multipart_cleanup_closed = "aborted";
        }
      }
      await charge();
      const object = await bucket.head(row.r2_key);
      if (object) {
        // Physical facts remain chargeable even when metadata or the multipart ID is unknown.
        await atomicBatch(db, [
          controlFence(epoch, maintenance),
          cleanupFence(row, token),
          ...observedObject(row, object),
        ]);
        if (!matches(row, object)) throw new Error("upload_object_mismatch");
        if (!row.multipart_cleanup_closed && row.r2_upload_id && row.multipart_complete_attempt) {
          await atomicBatch(db, [
            controlFence(epoch, maintenance),
            cleanupFence(row, token),
            ...observedObject(row, object),
            {
              sql: "UPDATE uploads SET multipart_cleanup_closed='completed' WHERE id=? AND multipart_cleanup_closed IS NULL",
              values: [id],
            },
            assertOneChange,
          ]);
          row.multipart_cleanup_closed = "completed";
        }
      }
      if (!row.multipart_cleanup_closed) throw new Error("multipart_cleanup_unconfirmed");
      result[
        await settleUploadCleanup(
          db,
          row,
          epoch,
          maintenance,
          token,
          object,
          cleanupFence(row, token, true),
          "u.mode='multipart' AND u.multipart_cleanup_started_at IS NOT NULL AND u.multipart_cleanup_closed IS NOT NULL",
        )
      ]++;
    } catch (error) {
      result.retried++;
      const code =
        error instanceof Error &&
        ["upload_object_mismatch", "multipart_cleanup_unconfirmed"].includes(error.message)
          ? error.message
          : "cleanup_unconfirmed";
      await primary(db)
        .prepare("UPDATE uploads SET cleanup_error=? WHERE id=? AND cleanup_token=?")
        .bind(code, id, token)
        .run();
    }
  }
  return result;
}
