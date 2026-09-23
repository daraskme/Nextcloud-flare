import {
  assertExists,
  assertOneChange,
  atomicBatch,
  primary,
  type SqlStatement,
} from "../db/primary";

const CLOCK = "strftime('%s','now')*1000";
const LEASE_MS = 60_000;
const TERMINAL = "'expired','aborted','failed'";
export interface UploadCleanupCandidate {
  id: string;
  owner_id: string;
  blob_id: string;
  reservation_id: string;
  epoch: number;
  r2_key: string;
  write_attempt_id: string | null;
}
type Candidate = UploadCleanupCandidate;
export interface UploadCleanupResult {
  claimed: number;
  absent: number;
  queued: number;
  retried: number;
  r2Calls: number;
}
export function controlFence(epoch: number, maintenance: boolean): SqlStatement {
  return assertExists(
    `SELECT 1 FROM control WHERE singleton=1 AND epoch=? AND maintenance=?
    AND (?=0 OR gc_paused=1)`,
    [epoch, maintenance ? 1 : 0, maintenance ? 1 : 0],
  );
}

// Include the gap between operation claim and recording completion_op_id.
export const COMPLETION = `o.kind='upload.complete' AND o.credential_id=u.credential_id
  AND o.epoch=u.epoch AND o.space_id=u.space_id
  AND json_extract(o.operands_json,'$.uploadId')=u.id
  AND json_extract(o.operands_json,'$.parentId')=u.parent_id
  AND json_extract(o.operands_json,'$.nodeId') IS u.target_id`;

export const UNPUBLISHED = `b.owner_id=u.owner_id AND b.r2_key='u/'||u.owner_id||'/b/'||u.blob_id
  AND (u.completion_op_id IS NULL OR EXISTS(SELECT 1 FROM operations o
    WHERE o.op_id=u.completion_op_id AND ${COMPLETION}))
  AND NOT EXISTS(SELECT 1 FROM operations o WHERE ${COMPLETION}
    AND (o.state='committed' OR EXISTS(SELECT 1 FROM operation_steps WHERE op_id=o.op_id)))`;

async function claim(
  db: D1Database,
  row: Candidate,
  epoch: number,
  maintenance: boolean,
  token: string,
): Promise<boolean> {
  try {
    await atomicBatch(db, [
      controlFence(epoch, maintenance),
      assertExists(
        `SELECT 1 FROM uploads u JOIN blobs b ON b.id=u.blob_id
        WHERE u.id=? AND u.mode='single' AND u.epoch<=? AND u.expires_at<=${CLOCK}
          AND u.cleanup_next_at<=${CLOCK}
          AND (u.cleanup_token IS NULL OR u.cleanup_lease_expires_at<=${CLOCK})
          AND (u.state IN ('created','receiving','completing') OR (u.state IN (${TERMINAL}) AND u.cleanup_pending=1))
          AND b.state IN ('staging','orphan') AND b.ref_count=0
          AND ${UNPUBLISHED}
          AND NOT EXISTS(SELECT 1 FROM blob_pins WHERE blob_id=b.id)
          AND NOT EXISTS(SELECT 1 FROM gc_candidates WHERE blob_id=b.id)`,
        [row.id, epoch],
      ),
      {
        sql: `UPDATE operations SET state='failed',error_code='upload_expired',updated_at=MAX(updated_at,${CLOCK})
          WHERE state='claimed' AND op_id IN (SELECT o.op_id FROM operations o JOIN uploads u ON ${COMPLETION} WHERE u.id=?)`,
        values: [row.id],
      },
      {
        sql: `UPDATE uploads SET state=CASE WHEN state='completing' THEN 'failed'
            WHEN state IN ('created','receiving') THEN 'expired' ELSE state END,
          error_code=COALESCE(error_code,CASE WHEN epoch<? THEN 'stale_epoch' ELSE 'upload_expired' END),
          accept_parts=0,in_flight=0,cleanup_pending=1,cleanup_token=?,
          cleanup_lease_expires_at=${CLOCK}+?,cleanup_next_at=${CLOCK}+?,cleanup_error=NULL WHERE id=?`,
        values: [epoch, token, LEASE_MS, LEASE_MS, row.id],
      },
      assertOneChange,
      {
        sql: "UPDATE blobs SET state='orphan' WHERE id=? AND state IN ('staging','orphan') AND ref_count=0",
        values: [row.blob_id],
      },
      assertOneChange,
    ]);
  } catch {
    // A lost acknowledgement is recovered by its exact durable token.
  }
  return (
    (await primary(db)
      .prepare(`SELECT 1 FROM uploads WHERE id=? AND cleanup_token=?
    AND cleanup_lease_expires_at>${CLOCK} AND state IN (${TERMINAL})`)
      .bind(row.id, token)
      .first()) !== null
  );
}

function cleanupFence(row: Candidate, token: string): SqlStatement {
  return assertExists(
    `SELECT 1 FROM uploads u JOIN blobs b ON b.id=u.blob_id
    WHERE u.id=? AND u.blob_id=? AND u.cleanup_token=? AND u.cleanup_lease_expires_at>${CLOCK}
      AND u.state IN (${TERMINAL}) AND u.cleanup_pending=1 AND u.expires_at<=${CLOCK}
      AND b.state='orphan' AND b.ref_count=0
      AND NOT EXISTS(SELECT 1 FROM blob_pins WHERE blob_id=b.id)
      AND NOT EXISTS(SELECT 1 FROM gc_candidates WHERE blob_id=b.id)`,
    [row.id, row.blob_id, token],
  );
}
export function observedObject(row: Candidate, object: R2Object): SqlStatement[] {
  if (
    !Number.isSafeInteger(object.size) ||
    object.size < 0 ||
    !object.etag ||
    object.etag.length > 256
  )
    throw new Error("invalid_r2_observation");
  return [
    {
      sql: `INSERT INTO blob_storage(blob_id,bytes,r2_etag,observed_at) VALUES(?,?,?,${CLOCK})
        ON CONFLICT(blob_id) DO NOTHING`,
      values: [row.blob_id, object.size, object.etag],
    },
    assertExists(
      "SELECT 1 FROM blob_storage WHERE blob_id=? AND bytes=? AND r2_etag=? AND removed_at IS NULL",
      [row.blob_id, object.size, object.etag],
    ),
  ];
}
export function matches(row: Candidate, object: R2Object): boolean {
  return (
    row.write_attempt_id !== null &&
    object.customMetadata?.upload_id === row.id &&
    object.customMetadata.blob_id === row.blob_id &&
    object.customMetadata.attempt_id === row.write_attempt_id &&
    object.customMetadata.epoch === String(row.epoch)
  );
}

export async function settleUploadCleanup(
  db: D1Database,
  row: Candidate,
  epoch: number,
  maintenance: boolean,
  token: string,
  object: R2Object | null,
  fence = cleanupFence(row, token),
  terminalProof = "1",
): Promise<"absent" | "queued"> {
  if (object && !matches(row, object)) {
    // Unexpected objects consume storage too. Quarantine without deleting or refunding.
    await atomicBatch(db, [
      controlFence(epoch, maintenance),
      fence,
      ...observedObject(row, object),
    ]);
    throw new Error("upload_object_mismatch");
  }
  const statements: SqlStatement[] = [controlFence(epoch, maintenance), fence];
  if (object) statements.push(...observedObject(row, object));
  else
    statements.push(
      {
        sql: "UPDATE blobs SET state='deleted' WHERE id=? AND state='orphan' AND ref_count=0",
        values: [row.blob_id],
      },
      assertOneChange,
      {
        sql: `UPDATE blob_storage SET removed_at=MAX(observed_at,${CLOCK}) WHERE blob_id=? AND removed_at IS NULL`,
        values: [row.blob_id],
      },
    );
  statements.push(
    {
      sql: "UPDATE reservations SET state='released' WHERE id=? AND state IN ('reserved','released')",
      values: [row.reservation_id],
    },
    assertOneChange,
    {
      sql: `INSERT INTO gc_candidates(blob_id,state,not_before) VALUES(?,?,${CLOCK})`,
      values: [row.blob_id, object ? "candidate" : "deleted"],
    },
    assertOneChange,
    {
      sql: `UPDATE uploads SET cleanup_token=NULL,cleanup_lease_expires_at=NULL,cleanup_pending=?,cleanup_error=NULL
        WHERE id=? AND cleanup_token=?`,
      values: [object ? 1 : 0, row.id, token],
    },
    assertOneChange,
  );
  try {
    await atomicBatch(db, statements);
  } catch (error) {
    // Inspect the full terminal/handoff tuple before accepting a lost acknowledgement.
    const saved = await primary(db)
      .prepare(`SELECT 1 FROM uploads u JOIN reservations r ON r.id=u.reservation_id
      JOIN blobs b ON b.id=u.blob_id JOIN gc_candidates g ON g.blob_id=b.id
      WHERE u.id=? AND u.state IN (${TERMINAL}) AND u.cleanup_token IS NULL AND r.state='released'
        AND (${terminalProof})
        AND ((b.state='deleted' AND g.state='deleted' AND u.cleanup_pending=0
          AND NOT EXISTS(SELECT 1 FROM blob_storage s WHERE s.blob_id=b.id AND s.removed_at IS NULL))
        OR (b.state IN ('orphan','deleting') AND g.state IN ('candidate','deleting') AND u.cleanup_pending=1
          AND EXISTS(SELECT 1 FROM blob_storage s WHERE s.blob_id=b.id AND s.removed_at IS NULL)))`)
      .bind(row.id)
      .first();
    if (!saved) throw error;
  }
  return object ? "queued" : "absent";
}

/** The internal caller supplies the authoritative ControlDO epoch/mode. No public repair route. */
export async function repairSingleUploads(
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
    .prepare(`SELECT u.id,u.owner_id,u.blob_id,u.reservation_id,u.epoch,u.write_attempt_id,b.r2_key
    FROM uploads u JOIN blobs b ON b.id=u.blob_id
    WHERE u.mode='single' AND u.state<>'completed' AND u.upload_name IS NOT NULL
      AND u.epoch<=? AND u.expires_at<=${CLOCK} AND u.cleanup_next_at<=${CLOCK}
      AND (u.cleanup_token IS NULL OR u.cleanup_lease_expires_at<=${CLOCK})
      AND (u.state IN ('created','receiving','completing') OR (u.state IN (${TERMINAL}) AND u.cleanup_pending=1))
      AND b.state IN ('staging','orphan') AND b.ref_count=0
      AND ${UNPUBLISHED}
      AND NOT EXISTS(SELECT 1 FROM blob_pins WHERE blob_id=b.id)
      AND NOT EXISTS(SELECT 1 FROM gc_candidates WHERE blob_id=b.id)
      AND EXISTS(SELECT 1 FROM control WHERE singleton=1 AND epoch=? AND maintenance=? AND (?=0 OR gc_paused=1))
    ORDER BY u.cleanup_next_at,u.expires_at,u.id LIMIT ?`)
    .bind(epoch, epoch, maintenance ? 1 : 0, maintenance ? 1 : 0, limit)
    .all<Candidate>();
  for (const row of rows.results) {
    if (Date.now() - started >= wall) break;
    const token = crypto.randomUUID();
    if (!(await claim(db, row, epoch, maintenance, token))) continue;
    result.claimed++;
    try {
      await atomicBatch(db, [
        controlFence(epoch, maintenance),
        cleanupFence(row, token),
        {
          sql: "UPDATE uploads SET cleanup_calls=cleanup_calls+1 WHERE id=? AND cleanup_token=?",
          values: [row.id, token],
        },
        assertOneChange,
      ]);
      result.r2Calls++;
      const object = await bucket.head(row.r2_key);
      result[await settleUploadCleanup(db, row, epoch, maintenance, token, object)]++;
    } catch (error) {
      result.retried++;
      await primary(db)
        .prepare("UPDATE uploads SET cleanup_error=? WHERE id=? AND cleanup_token=?")
        .bind(
          error instanceof Error && error.message === "upload_object_mismatch"
            ? "upload_object_mismatch"
            : "cleanup_unconfirmed",
          row.id,
          token,
        )
        .run();
    }
  }
  return result;
}
