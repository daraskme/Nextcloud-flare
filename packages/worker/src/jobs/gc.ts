import {
  assertExists,
  assertOneChange,
  atomicBatch,
  primary,
  type SqlStatement,
} from "../db/primary";
import { type RestorePause, restorePauseCondition } from "../db/restorePause";
import {
  acquireSystemMutation,
  commitSystemMutation,
  type SystemMutationSource,
  systemMutationStatements,
} from "../services/systemMutation";

const MAX_BLOBS = 1_000;
const MAX_R2_CALLS = 2_000;
const MAX_WALL_MS = 25_000;
const CLAIM_MS = 60_000;
const CLOCK = "strftime('%s','now')*1000";
const SETTLED_UPLOADS = `NOT EXISTS(SELECT 1 FROM uploads u WHERE u.blob_id=b.id AND (
  u.state NOT IN ('completed','expired','aborted','failed') OR u.cleanup_token IS NOT NULL
  OR EXISTS(SELECT 1 FROM reservations r WHERE r.id=u.reservation_id AND r.state='reserved')
  OR (u.mode='multipart' AND u.state<>'completed' AND u.multipart_cleanup_closed IS NULL)))`;

type GcMode = boolean | RestorePause;
function modeFence(mode: GcMode, alias: string) {
  const proof =
    typeof mode === "object" ? restorePauseCondition(mode, alias) : { sql: "1=1", values: [] };
  return {
    sql: proof.sql,
    values: [mode === true ? 1 : 0, mode === false ? 0 : 1, ...proof.values],
  };
}

interface Candidate {
  blobId: string;
  ownerId: string;
  key: string;
  state: "candidate" | "deleting";
}

export interface GcResult {
  claimed: number;
  deleted: number;
  retried: number;
  r2Calls: number;
}

async function nextCandidate(
  db: D1Database,
  epoch: number,
  now: number,
  stopped: GcMode,
): Promise<Candidate | null> {
  const mode = modeFence(stopped, "control");
  return primary(db)
    .prepare(`SELECT g.blob_id AS blobId,b.owner_id AS ownerId,b.r2_key AS key,g.state
      FROM gc_candidates g JOIN blobs b ON b.id=g.blob_id
      WHERE ((?=0 AND g.state='candidate' AND g.not_before<=? AND b.state NOT IN ('deleting','deleted')) OR
        (g.state='deleting' AND b.state='deleting' AND (g.claim_token IS NULL OR g.claim_expires_at<=?)))
        AND b.ref_count=0 AND g.pinned_by IS NULL
        AND ${SETTLED_UPLOADS}
        AND NOT EXISTS(SELECT 1 FROM blob_pins p WHERE p.blob_id=g.blob_id)
        AND EXISTS(SELECT 1 FROM control WHERE singleton=1 AND epoch=? AND maintenance=? AND gc_paused=? AND ${mode.sql})
      ORDER BY CASE g.state WHEN 'deleting' THEN 0 ELSE 1 END,g.not_before,g.blob_id LIMIT 1`)
    .bind(stopped === false ? 0 : 1, now, now, epoch, ...mode.values)
    .first<Candidate>();
}

async function claimCandidate(
  env: SystemMutationSource,
  candidate: Candidate,
  epoch: number,
  token: string,
  stopped: GcMode,
  deadline: number,
): Promise<boolean> {
  const { DB: db } = env;
  if (stopped !== false && candidate.state === "candidate") return false;
  const mode = modeFence(stopped, "control");
  const common = `blob_id=? AND pinned_by IS NULL
    AND NOT EXISTS(SELECT 1 FROM blob_pins p WHERE p.blob_id=gc_candidates.blob_id)
    AND EXISTS(SELECT 1 FROM blobs b WHERE b.id=gc_candidates.blob_id AND b.owner_id=? AND b.r2_key=? AND b.ref_count=0 AND ${SETTLED_UPLOADS})
    AND EXISTS(SELECT 1 FROM control WHERE singleton=1 AND epoch=? AND maintenance=? AND gc_paused=? AND ${mode.sql})`;
  const statements =
    candidate.state === "candidate"
      ? [
          {
            sql: `UPDATE blobs SET state='deleting' WHERE id=? AND ref_count=0
              AND state NOT IN ('deleting','deleted') AND NOT EXISTS(SELECT 1 FROM blob_pins WHERE blob_id=?)`,
            values: [candidate.blobId, candidate.blobId],
          },
          assertOneChange,
          {
            sql: `UPDATE gc_candidates SET state='deleting',claim_token=?,claim_expires_at=${CLOCK}+?,claim_epoch=?,
              attempt=MIN(attempt+1,100),last_error=NULL WHERE state='candidate' AND not_before<=${CLOCK} AND ${common}`,
            values: [
              token,
              CLAIM_MS,
              epoch,
              candidate.blobId,
              candidate.ownerId,
              candidate.key,
              epoch,
              ...mode.values,
            ],
          },
          assertOneChange,
        ]
      : [
          {
            sql: `UPDATE gc_candidates SET claim_token=?,claim_expires_at=${CLOCK}+?,claim_epoch=?,attempt=MIN(attempt+1,100),last_error=NULL
              WHERE state='deleting' AND (claim_token IS NULL OR claim_expires_at<=${CLOCK}) AND ${common}
              AND EXISTS(SELECT 1 FROM blobs WHERE id=gc_candidates.blob_id AND state='deleting')`,
            values: [
              token,
              CLAIM_MS,
              epoch,
              candidate.blobId,
              candidate.ownerId,
              candidate.key,
              epoch,
              ...mode.values,
            ],
          },
          assertOneChange,
        ];
  try {
    const admission = await acquireSystemMutation(env, candidate.ownerId, "gc.claim", deadline);
    await commitSystemMutation(db, admission, candidate.ownerId, statements);
  } catch {
    // A lost response is successful only when this exact token owns the durable claim.
  }
  return (
    (await primary(db)
      .prepare(
        "SELECT 1 AS ok FROM gc_candidates WHERE blob_id=? AND state='deleting' AND claim_token=?",
      )
      .bind(candidate.blobId, token)
      .first<number>("ok")) === 1
  );
}

function dispatchFence(
  candidate: Candidate,
  token: string,
  epoch: number,
  stopped: GcMode,
): SqlStatement {
  const mode = modeFence(stopped, "c");
  return assertExists(
    `SELECT 1 FROM gc_candidates g JOIN blobs b ON b.id=g.blob_id
    JOIN control c ON c.singleton=1 WHERE g.blob_id=? AND b.r2_key=? AND b.owner_id=?
    AND g.state='deleting' AND b.state='deleting' AND b.ref_count=0 AND g.pinned_by IS NULL
    AND g.claim_token=? AND g.claim_epoch=? AND g.claim_expires_at>${CLOCK}
    AND c.epoch=g.claim_epoch AND c.maintenance=? AND c.gc_paused=? AND ${mode.sql}
    AND ${SETTLED_UPLOADS}
    AND NOT EXISTS(SELECT 1 FROM blob_pins WHERE blob_id=b.id)`,
    [candidate.blobId, candidate.key, candidate.ownerId, token, epoch, ...mode.values],
  );
}

async function recordFailure(
  env: SystemMutationSource,
  candidate: Candidate,
  token: string,
  epoch: number,
  stopped: GcMode,
): Promise<void> {
  const mode = modeFence(stopped, "c");
  try {
    const admission = await acquireSystemMutation(env, candidate.ownerId, "gc.error");
    await commitSystemMutation(env.DB, admission, candidate.ownerId, [
      assertExists(
        `SELECT 1 FROM control c WHERE c.singleton=1 AND c.epoch=?
        AND c.maintenance=? AND c.gc_paused=? AND ${mode.sql}`,
        [epoch, ...mode.values],
      ),
      {
        sql: `UPDATE gc_candidates SET last_error='r2_unconfirmed'
          WHERE blob_id=? AND state='deleting' AND claim_token=? AND claim_epoch=?`,
        values: [candidate.blobId, token, epoch],
      },
      assertOneChange,
    ]);
  } catch {
    // Failure to save an annotation never releases a deleting object or its physical bytes.
  }
}

async function finalizeCandidate(
  env: SystemMutationSource,
  candidate: Candidate,
  token: string,
  epoch: number,
  stopped: GcMode,
): Promise<boolean> {
  const { DB: db } = env;
  const blobId = candidate.blobId;
  try {
    const admission = await acquireSystemMutation(env, candidate.ownerId, "gc.finalize");
    await commitSystemMutation(db, admission, candidate.ownerId, [
      dispatchFence(candidate, token, epoch, stopped),
      {
        sql: `UPDATE blobs SET state='deleted' WHERE id=? AND state='deleting' AND ref_count=0
          AND NOT EXISTS(SELECT 1 FROM blob_pins WHERE blob_id=?)`,
        values: [blobId, blobId],
      },
      assertOneChange,
      {
        sql: `UPDATE gc_candidates SET state='deleted',claim_token=NULL,claim_expires_at=NULL,claim_epoch=NULL,last_error=NULL
          WHERE blob_id=? AND state='deleting' AND claim_token=?`,
        values: [blobId, token],
      },
      assertOneChange,
      {
        sql: `UPDATE blob_storage SET removed_at=MAX(observed_at,${CLOCK}) WHERE blob_id=? AND removed_at IS NULL`,
        values: [blobId],
      },
      assertExists(
        "SELECT 1 WHERE NOT EXISTS(SELECT 1 FROM blob_storage WHERE blob_id=? AND removed_at IS NULL)",
        [blobId],
      ),
      {
        sql: `UPDATE uploads SET cleanup_pending=0,cleanup_token=NULL,cleanup_lease_expires_at=NULL,cleanup_error=NULL
          WHERE blob_id=? AND state IN ('expired','aborted','failed')
            AND (mode='single' OR (mode='multipart' AND multipart_cleanup_started_at IS NOT NULL
              AND multipart_cleanup_closed IS NOT NULL))`,
        values: [blobId],
      },
    ]);
  } catch {
    // Another collector's terminal pair can settle the result, never this grant's unknown slot.
  }
  const row = await primary(db)
    .prepare(`SELECT b.state AS blobState,g.state AS candidateState
      FROM blobs b JOIN gc_candidates g ON g.blob_id=b.id WHERE b.id=? AND b.r2_key=?
      AND g.claim_token IS NULL AND g.claim_epoch IS NULL
      AND NOT EXISTS(SELECT 1 FROM blob_storage WHERE blob_id=b.id AND removed_at IS NULL)
      AND NOT EXISTS(SELECT 1 FROM uploads WHERE blob_id=b.id AND cleanup_pending<>0)`)
    .bind(blobId, candidate.key)
    .first<{ blobState: string; candidateState: string }>();
  return row?.blobState === "deleted" && row.candidateState === "deleted";
}

/** Runs only under an admitted epoch. Each claimed object uses at most delete + head. */
export async function runGarbageCollection(
  env: SystemMutationSource,
  bucket: R2Bucket,
  epoch: number,
  options: { maxBlobs?: number; maxWallMs?: number } = {},
): Promise<GcResult> {
  return collect(env, bucket, epoch, options, false);
}

/** Finish only already-irreversible deletions. A pause never admits fresh GC candidates. */
export async function drainStoppedBlobGarbageCollection(
  env: SystemMutationSource,
  bucket: R2Bucket,
  epoch: number,
  options: { maxBlobs?: number; maxWallMs?: number } = {},
): Promise<GcResult> {
  return collect(env, bucket, epoch, { ...options, maxBlobs: options.maxBlobs ?? 20 }, true);
}

/** Drain irreversible deletions under this exact live restore window; no new candidates. */
export async function drainRestoreBlobGarbageCollection(
  env: SystemMutationSource,
  bucket: R2Bucket,
  pause: RestorePause,
  options: { maxBlobs?: number; maxWallMs?: number } = {},
): Promise<GcResult> {
  restorePauseCondition(pause);
  return collect(env, bucket, pause.epoch, { ...options, maxBlobs: options.maxBlobs ?? 20 }, pause);
}

async function collect(
  env: SystemMutationSource,
  bucket: R2Bucket,
  epoch: number,
  options: { maxBlobs?: number; maxWallMs?: number },
  stopped: GcMode,
): Promise<GcResult> {
  const { DB: db } = env;
  const limit = options.maxBlobs ?? 50;
  const wall = options.maxWallMs ?? MAX_WALL_MS;
  if (
    !Number.isSafeInteger(epoch) ||
    epoch < 1 ||
    !Number.isSafeInteger(limit) ||
    limit < 1 ||
    limit > (stopped ? 20 : MAX_BLOBS) ||
    !Number.isSafeInteger(wall) ||
    wall < 1 ||
    wall > MAX_WALL_MS
  )
    throw new Error("invalid_gc_limit");
  const started = Date.now();
  const result: GcResult = { claimed: 0, deleted: 0, retried: 0, r2Calls: 0 };
  // Failed claims also consume the pass budget; overload/rollback must not spin on one object.
  let inspected = 0;
  while (inspected < limit && result.r2Calls + 2 <= MAX_R2_CALLS && Date.now() - started < wall) {
    const now = Date.now();
    const candidate = await nextCandidate(db, epoch, now, stopped);
    if (!candidate) break;
    inspected++;
    const token = crypto.randomUUID();
    if (!(await claimCandidate(env, candidate, epoch, token, stopped, started + wall))) continue;
    result.claimed++;
    const charge = async () => {
      const admission = await acquireSystemMutation(
        env,
        candidate.ownerId,
        "gc.call",
        started + wall,
      );
      if (Date.now() - started >= wall) throw new Error("gc_budget");
      await atomicBatch(
        db,
        systemMutationStatements(admission, candidate.ownerId, [
          dispatchFence(candidate, token, epoch, stopped),
          {
            sql: "UPDATE gc_candidates SET r2_calls=r2_calls+1 WHERE blob_id=? AND claim_token=?",
            values: [candidate.blobId, token],
          },
          assertOneChange,
        ]),
      );
      // An unknown counter acknowledgement never grants permission to dispatch.
      if (Date.now() - started >= wall) throw new Error("gc_budget");
      result.r2Calls++;
    };
    try {
      await charge();
      try {
        await bucket.delete(candidate.key);
      } catch {
        // A lost delete response is resolved by the authoritative absence check below.
      }
      await charge();
      const remaining = await bucket.head(candidate.key);
      if (remaining || !(await finalizeCandidate(env, candidate, token, epoch, stopped))) {
        await recordFailure(env, candidate, token, epoch, stopped);
        result.retried++;
      } else result.deleted++;
    } catch {
      await recordFailure(env, candidate, token, epoch, stopped);
      result.retried++;
    }
  }
  return result;
}
