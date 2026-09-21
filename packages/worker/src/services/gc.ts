import type { Env } from "../env.js";
import { getRuntimeControl } from "./control.js";

interface GcCandidate {
  blobId: string;
  key: string;
  ownerId: string;
  size: number;
}

export interface GcIo {
  delete: (key: string) => Promise<void>;
  head: (key: string) => Promise<R2Object | null>;
}

export async function discoverGcCandidates(
  env: Env,
  now = Date.now(),
  limit = 1000,
): Promise<number> {
  const rows = await env.DB.prepare(
    "SELECT id FROM blobs WHERE ref_count=0 AND state IN ('committed','orphan') ORDER BY created_at,id LIMIT ?1",
  )
    .bind(limit)
    .all<{ id: string }>();
  for (const row of rows.results) {
    await env.DB.batch([
      env.DB.prepare(
        "UPDATE blobs SET state='gc_candidate' WHERE id=?1 AND ref_count=0 AND state IN ('committed','orphan') AND NOT EXISTS(SELECT 1 FROM blob_pins WHERE blob_id=?1)",
      ).bind(row.id),
      env.DB.prepare(
        "INSERT INTO gc_candidates(blob_id,trash_op_id,state,pinned_by,not_before,last_error,claim_token,claim_expires_at) SELECT id,NULL,'candidate',NULL,?1,NULL,NULL,NULL FROM blobs WHERE id=?2 AND state='gc_candidate' ON CONFLICT(blob_id) DO NOTHING",
      ).bind(now, row.id),
    ]);
  }
  return rows.results.length;
}

async function claimCandidates(
  env: Env,
  token: string,
  now: number,
  limit: number,
  deletingOnly: boolean,
): Promise<GcCandidate[]> {
  const rows = await env.DB.prepare(
    "SELECT g.blob_id blobId,b.r2_key key,b.owner_id ownerId,b.size FROM gc_candidates g JOIN blobs b ON b.id=g.blob_id WHERE ((g.state='candidate' AND g.not_before<=?1) OR (g.state='deleting' AND g.claim_expires_at<=?1)) AND (?3=0 OR g.state='deleting') AND b.ref_count=0 AND b.state IN ('gc_candidate','deleting') AND NOT EXISTS(SELECT 1 FROM blob_pins p WHERE p.blob_id=b.id) ORDER BY g.not_before,g.blob_id LIMIT ?2",
  )
    .bind(now, limit, deletingOnly ? 1 : 0)
    .all<GcCandidate>();
  if (rows.results.length === 0) return [];
  const statements: D1PreparedStatement[] = [];
  for (const candidate of rows.results) {
    statements.push(
      env.DB.prepare(
        "UPDATE blobs SET state='deleting' WHERE id=?1 AND ref_count=0 AND state IN ('gc_candidate','deleting') AND NOT EXISTS(SELECT 1 FROM blob_pins WHERE blob_id=?1)",
      ).bind(candidate.blobId),
      env.DB.prepare("INSERT INTO _assert(v) SELECT 1 WHERE changes()<>1"),
      env.DB.prepare(
        "UPDATE gc_candidates SET state='deleting',claim_token=?1,claim_expires_at=?2,last_error=NULL WHERE blob_id=?3 AND state IN ('candidate','deleting')",
      ).bind(token, now + 30_000, candidate.blobId),
      env.DB.prepare("INSERT INTO _assert(v) SELECT 1 WHERE changes()<>1"),
    );
  }
  await env.DB.batch(statements);
  return rows.results;
}

async function finalizeDeleted(
  env: Env,
  candidate: GcCandidate,
  token: string,
  now: number,
): Promise<void> {
  await env.DB.batch([
    env.DB.prepare(
      "UPDATE blobs SET state='deleted' WHERE id=?1 AND state='deleting' AND ref_count=0",
    ).bind(candidate.blobId),
    env.DB.prepare("INSERT INTO _assert(v) SELECT 1 WHERE changes()<>1"),
    env.DB.prepare(
      "UPDATE gc_candidates SET state='deleted',claim_token=NULL,claim_expires_at=NULL,last_error=NULL WHERE blob_id=?1 AND state='deleting' AND claim_token=?2",
    ).bind(candidate.blobId, token),
    env.DB.prepare("INSERT INTO _assert(v) SELECT 1 WHERE changes()<>1"),
    env.DB.prepare(
      "UPDATE users SET physical_bytes=physical_bytes-?1 WHERE id=?2 AND physical_bytes>=?1",
    ).bind(candidate.size, candidate.ownerId),
    env.DB.prepare("INSERT INTO _assert(v) SELECT 1 WHERE changes()<>1"),
  ]);
  void now;
}

export async function runGarbageCollection(
  env: Env,
  options: {
    now?: number;
    limit?: number;
    token?: string;
    io?: GcIo;
    allowPaused?: boolean;
    deletingOnly?: boolean;
  } = {},
): Promise<number> {
  const control = await getRuntimeControl(env);
  if ((control.maintenance || control.gcPaused) && options.allowPaused !== true) return 0;
  const now = options.now ?? Date.now();
  const limit = Math.min(options.limit ?? 100, 1000);
  const token = options.token ?? crypto.randomUUID();
  const io = options.io ?? {
    delete: (key: string) => env.BLOBS.delete(key),
    head: (key: string) => env.BLOBS.head(key),
  };
  const candidates = await claimCandidates(env, token, now, limit, options.deletingOnly === true);
  for (const candidate of candidates) {
    let absent = false;
    try {
      await io.delete(candidate.key);
      absent = (await io.head(candidate.key)) === null;
    } catch {
      absent = (await io.head(candidate.key)) === null;
    }
    if (absent) {
      await finalizeDeleted(env, candidate, token, now);
    } else {
      await env.DB.prepare(
        "UPDATE gc_candidates SET last_error='delete_unconfirmed' WHERE blob_id=?1 AND state='deleting' AND claim_token=?2",
      )
        .bind(candidate.blobId, token)
        .run();
    }
  }
  return candidates.length;
}
