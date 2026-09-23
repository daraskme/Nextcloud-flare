import { assertExists, assertOneChange, atomicBatch, primary } from "../db/primary";

const MAX_BLOBS = 1_000;
const MAX_R2_CALLS = 2_000;
const MAX_WALL_MS = 25_000;
const CLAIM_MS = 60_000;

interface Candidate {
  blobId: string;
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
): Promise<Candidate | null> {
  return primary(db)
    .prepare(`SELECT g.blob_id AS blobId,b.r2_key AS key,g.state
      FROM gc_candidates g JOIN blobs b ON b.id=g.blob_id
      WHERE ((g.state='candidate' AND g.not_before<=? AND b.state NOT IN ('deleting','deleted')) OR
        (g.state='deleting' AND b.state='deleting' AND (g.claim_token IS NULL OR g.claim_expires_at<=?)))
        AND b.ref_count=0 AND g.pinned_by IS NULL
        AND NOT EXISTS(SELECT 1 FROM blob_pins p WHERE p.blob_id=g.blob_id)
        AND EXISTS(SELECT 1 FROM control WHERE singleton=1 AND epoch=? AND maintenance=0 AND gc_paused=0)
      ORDER BY CASE g.state WHEN 'deleting' THEN 0 ELSE 1 END,g.not_before,g.blob_id LIMIT 1`)
    .bind(now, now, epoch)
    .first<Candidate>();
}

async function claimCandidate(
  db: D1Database,
  candidate: Candidate,
  epoch: number,
  token: string,
  now: number,
): Promise<boolean> {
  const expires = now + CLAIM_MS;
  const common = `blob_id=? AND pinned_by IS NULL
    AND NOT EXISTS(SELECT 1 FROM blob_pins p WHERE p.blob_id=gc_candidates.blob_id)
    AND EXISTS(SELECT 1 FROM blobs b WHERE b.id=gc_candidates.blob_id AND b.ref_count=0)
    AND EXISTS(SELECT 1 FROM control WHERE singleton=1 AND epoch=? AND maintenance=0 AND gc_paused=0)`;
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
            sql: `UPDATE gc_candidates SET state='deleting',claim_token=?,claim_expires_at=?,
              attempt=MIN(attempt+1,100),last_error=NULL WHERE state='candidate' AND not_before<=? AND ${common}`,
            values: [token, expires, now, candidate.blobId, epoch],
          },
          assertOneChange,
        ]
      : [
          {
            sql: `UPDATE gc_candidates SET claim_token=?,claim_expires_at=?,attempt=MIN(attempt+1,100),last_error=NULL
              WHERE state='deleting' AND (claim_token IS NULL OR claim_expires_at<=?) AND ${common}
              AND EXISTS(SELECT 1 FROM blobs WHERE id=gc_candidates.blob_id AND state='deleting')`,
            values: [token, expires, now, candidate.blobId, epoch],
          },
          assertOneChange,
        ];
  try {
    await atomicBatch(db, statements);
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

async function recordFailure(db: D1Database, blobId: string, token: string): Promise<void> {
  await primary(db)
    .prepare(`UPDATE gc_candidates SET last_error='r2_unconfirmed'
      WHERE blob_id=? AND state='deleting' AND claim_token=?`)
    .bind(blobId, token)
    .run();
}

async function finalizeCandidate(
  db: D1Database,
  blobId: string,
  token: string,
  now: number,
): Promise<boolean> {
  try {
    await atomicBatch(db, [
      {
        sql: `UPDATE blobs SET state='deleted' WHERE id=? AND state='deleting' AND ref_count=0
          AND NOT EXISTS(SELECT 1 FROM blob_pins WHERE blob_id=?)`,
        values: [blobId, blobId],
      },
      assertOneChange,
      {
        sql: `UPDATE gc_candidates SET state='deleted',claim_token=NULL,claim_expires_at=NULL,last_error=NULL
          WHERE blob_id=? AND state='deleting' AND claim_token=?`,
        values: [blobId, token],
      },
      assertOneChange,
      {
        sql: "UPDATE blob_storage SET removed_at=? WHERE blob_id=? AND removed_at IS NULL",
        values: [now, blobId],
      },
      assertExists(
        "SELECT 1 WHERE NOT EXISTS(SELECT 1 FROM blob_storage WHERE blob_id=? AND removed_at IS NULL)",
        [blobId],
      ),
    ]);
  } catch {
    // Re-read the terminal pair to resolve a lost D1 acknowledgement.
  }
  const row = await primary(db)
    .prepare(`SELECT b.state AS blobState,g.state AS candidateState
      FROM blobs b JOIN gc_candidates g ON g.blob_id=b.id WHERE b.id=?`)
    .bind(blobId)
    .first<{ blobState: string; candidateState: string }>();
  return row?.blobState === "deleted" && row.candidateState === "deleted";
}

/** Runs only under an admitted epoch. Each claimed object uses at most delete + head. */
export async function runGarbageCollection(
  db: D1Database,
  bucket: R2Bucket,
  epoch: number,
  options: { maxBlobs?: number; maxWallMs?: number } = {},
): Promise<GcResult> {
  const limit = Math.min(MAX_BLOBS, Math.max(1, options.maxBlobs ?? 50));
  const wall = Math.min(MAX_WALL_MS, Math.max(1, options.maxWallMs ?? MAX_WALL_MS));
  const started = Date.now();
  const result: GcResult = { claimed: 0, deleted: 0, retried: 0, r2Calls: 0 };
  while (
    result.claimed < limit &&
    result.r2Calls + 2 <= MAX_R2_CALLS &&
    Date.now() - started < wall
  ) {
    const now = Date.now();
    const candidate = await nextCandidate(db, epoch, now);
    if (!candidate) break;
    const token = crypto.randomUUID();
    if (!(await claimCandidate(db, candidate, epoch, token, now))) continue;
    result.claimed++;
    try {
      result.r2Calls++;
      try {
        await bucket.delete(candidate.key);
      } catch {
        // A lost delete response is resolved by the authoritative absence check below.
      }
      const remaining = await bucket.head(candidate.key);
      result.r2Calls++;
      if (remaining || !(await finalizeCandidate(db, candidate.blobId, token, Date.now()))) {
        await recordFailure(db, candidate.blobId, token);
        result.retried++;
      } else result.deleted++;
    } catch {
      await recordFailure(db, candidate.blobId, token);
      result.retried++;
    }
  }
  return result;
}
