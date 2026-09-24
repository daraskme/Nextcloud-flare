import {
  assertExists,
  assertOneChange,
  atomicBatch,
  primary,
  type SqlStatement,
} from "../db/primary";
import {
  acquireGlobalMutation,
  commitGlobalMutation,
  type GlobalMutationSource,
  globalMutationStatements,
} from "../services/globalMutation";
import { controlFence } from "./uploadCleanup";

export const ORPHAN_GRACE_MS = 35 * 86400000;
const CLOCK = "strftime('%s','now')*1000";
const LEASE_MS = 60000;
const UNKNOWN = `NOT EXISTS(SELECT 1 FROM blobs WHERE r2_key=?)
 AND NOT EXISTS(SELECT 1 FROM derivative_results WHERE r2_key=?)
 AND NOT EXISTS(SELECT 1 FROM archive_index WHERE r2_key=?)
 AND NOT EXISTS(SELECT 1 FROM target_sets WHERE manifest_ref=?)`;
const keys = (key: string) => [key, key, key, key];

interface Observation {
  key: string;
  size: number;
  etag: string;
  version: string;
  uploaded: Date;
}

interface Orphan {
  r2_key: string;
  bytes: number;
  r2_etag: string;
  r2_version: string;
  uploaded_at: number;
  first_seen_at: number;
}

interface ObservedOrphan extends Orphan {
  state: string;
  last_seen_at: number;
  claim_token: string | null;
}

function validObject(object: Observation): void {
  if (
    !object.key.startsWith("u/") ||
    new TextEncoder().encode(object.key).length > 1024 ||
    !Number.isSafeInteger(object.size) ||
    object.size < 0 ||
    !object.etag ||
    object.etag.length > 256 ||
    !object.version ||
    object.version.length > 1024 ||
    !Number.isSafeInteger(object.uploaded.getTime()) ||
    object.uploaded.getTime() < 0
  )
    throw new Error("invalid_orphan_observation");
}

function limits(epoch: number, limit: number, wall: number) {
  if (
    !Number.isSafeInteger(epoch) ||
    epoch < 1 ||
    !Number.isSafeInteger(limit) ||
    limit < 1 ||
    limit > 100 ||
    !Number.isSafeInteger(wall) ||
    wall < 1 ||
    wall > 25000
  )
    throw new Error("invalid_orphan_limit");
}

function scanFence(epoch: number, token: string): SqlStatement {
  return assertExists(
    `SELECT 1 FROM r2_inventory_scan WHERE singleton=1 AND epoch=?
    AND lease_token=? AND lease_expires_at>${CLOCK}`,
    [epoch, token],
  );
}

function objectFence(row: Orphan, token: string): SqlStatement {
  return assertExists(
    `SELECT 1 FROM orphan_objects WHERE r2_key=? AND state='deleting'
    AND claim_token=? AND claim_expires_at>${CLOCK} AND bytes=? AND r2_etag=? AND r2_version=?
    AND uploaded_at=? AND first_seen_at=? AND ${UNKNOWN}`,
    [
      row.r2_key,
      token,
      row.bytes,
      row.r2_etag,
      row.r2_version,
      row.uploaded_at,
      row.first_seen_at,
      ...keys(row.r2_key),
    ],
  );
}

function matches(row: Orphan, object: Observation): boolean {
  return (
    row.r2_key === object.key &&
    row.bytes === object.size &&
    row.r2_etag === object.etag &&
    row.r2_version === object.version &&
    row.uploaded_at === object.uploaded.getTime()
  );
}

/** Current HEAD metadata, not a caller's claim or the age of the R2 upload, starts the grace. */
function observation(
  object: Observation,
  epoch: number,
  expected?: ObservedOrphan | null,
): SqlStatement {
  validObject(object);
  const parsed = /^u\/([^/]{1,128})\/b\/([^/]{1,128})$/.exec(object.key);
  const owner = parsed?.[1] ?? null;
  const blob = parsed?.[2] ?? null;
  const changed = `(orphan_objects.state='deleted' OR orphan_objects.bytes<>excluded.bytes
    OR orphan_objects.r2_etag<>excluded.r2_etag OR orphan_objects.r2_version<>excluded.r2_version
    OR orphan_objects.uploaded_at<>excluded.uploaded_at)`;
  // A concurrent collector may have replaced or removed the object after our HEAD started.
  // The collector calls this inside its own claim-fenced transaction, without a scan snapshot.
  const snapshot =
    expected === undefined
      ? ""
      : expected === null
        ? "AND NOT EXISTS(SELECT 1 FROM orphan_objects WHERE r2_key=?)"
        : `AND EXISTS(SELECT 1 FROM orphan_objects WHERE r2_key=? AND state=? AND bytes=?
        AND r2_etag=? AND r2_version=? AND uploaded_at=? AND first_seen_at=? AND last_seen_at=?
        AND claim_token IS NULL)`;
  const snapshotValues =
    expected === undefined
      ? []
      : expected === null
        ? [object.key]
        : [
            expected.r2_key,
            expected.state,
            expected.bytes,
            expected.r2_etag,
            expected.r2_version,
            expected.uploaded_at,
            expected.first_seen_at,
            expected.last_seen_at,
          ];
  return {
    sql: `INSERT INTO orphan_objects(r2_key,owner_key,blob_key,owner_id,bytes,r2_etag,r2_version,
      uploaded_at,first_seen_at,last_seen_at,epoch,next_check_at)
      SELECT ?,?,?,(SELECT id FROM users WHERE id=?),?,?,?,?,${CLOCK},${CLOCK},?,${CLOCK}+${ORPHAN_GRACE_MS} WHERE ${UNKNOWN} ${snapshot}
      ON CONFLICT(r2_key) DO UPDATE SET bytes=excluded.bytes,r2_etag=excluded.r2_etag,
        r2_version=excluded.r2_version,uploaded_at=excluded.uploaded_at,
        owner_id=COALESCE(orphan_objects.owner_id,excluded.owner_id),
        first_seen_at=CASE WHEN ${changed} THEN MAX(orphan_objects.last_seen_at,${CLOCK}) ELSE orphan_objects.first_seen_at END,
        last_seen_at=MAX(orphan_objects.last_seen_at,${CLOCK}),epoch=excluded.epoch,
        state=CASE WHEN orphan_objects.state='deleted' THEN 'quarantined' ELSE orphan_objects.state END,
        removed_at=NULL,next_check_at=CASE WHEN ${changed} THEN MAX(orphan_objects.last_seen_at,${CLOCK})+${ORPHAN_GRACE_MS} ELSE orphan_objects.next_check_at END,
        last_error=CASE WHEN ${changed} THEN 'orphan_object_changed' ELSE orphan_objects.last_error END
      WHERE orphan_objects.claim_token IS NULL`,
    values: [
      object.key,
      owner,
      blob,
      owner,
      object.size,
      object.etag,
      object.version,
      object.uploaded.getTime(),
      epoch,
      ...keys(object.key),
      ...snapshotValues,
    ],
  };
}

export interface OrphanScanResult {
  claimed: boolean;
  examined: number;
  observed: number;
  advanced: boolean;
  completed: boolean;
  r2Calls: number;
}

/** One durable page per invocation. A partial/failed page retains its original cursor. */
export async function scanOrphanObjects(
  env: GlobalMutationSource,
  bucket: R2Bucket,
  epoch: number,
  options: { limit?: number; maxWallMs?: number; maintenance?: boolean } = {},
): Promise<OrphanScanResult> {
  const { DB: db } = env;
  const limit = options.limit ?? 20;
  const wall = options.maxWallMs ?? 20000;
  const maintenance = options.maintenance ?? false;
  limits(epoch, limit, wall);
  const deadline = Date.now() + wall;
  const withinBudget = () => {
    if (Date.now() >= deadline) throw new Error("orphan_scan_budget");
  };
  const token = crypto.randomUUID();
  const result: OrphanScanResult = {
    claimed: false,
    examined: 0,
    observed: 0,
    advanced: false,
    completed: false,
    r2Calls: 0,
  };
  try {
    const admission = await acquireGlobalMutation(env, "orphan.scan-claim", deadline);
    await commitGlobalMutation(db, admission, [
      controlFence(epoch, maintenance),
      {
        sql: `UPDATE r2_inventory_scan SET cursor=CASE WHEN epoch<>? THEN '' ELSE cursor END,
        epoch=?,lease_token=?,lease_expires_at=${CLOCK}+?
        WHERE singleton=1 AND (epoch<>? OR lease_token IS NULL OR lease_expires_at<=${CLOCK})
          AND (epoch<>? OR next_scan_at<=${CLOCK} OR ?=1)`,
        values: [epoch, epoch, token, LEASE_MS, epoch, epoch, maintenance ? 1 : 0],
      },
      assertOneChange,
    ]);
  } catch {
    /* Reconcile only our own durable lease after an unknown acknowledgement. */
  }
  const claim = await primary(db)
    .prepare(`SELECT cursor FROM r2_inventory_scan
    WHERE singleton=1 AND epoch=? AND lease_token=? AND lease_expires_at>${CLOCK}`)
    .bind(epoch, token)
    .first<{ cursor: string }>();
  if (!claim) return result;
  result.claimed = true;
  const charge = async () => {
    const admission = await acquireGlobalMutation(env, "orphan.scan-call", deadline);
    withinBudget();
    // Only a direct acknowledgement authorizes this external call.
    await atomicBatch(
      db,
      globalMutationStatements(admission, [
        controlFence(epoch, maintenance),
        scanFence(epoch, token),
      ]),
    );
    withinBudget();
    result.r2Calls++;
  };
  try {
    await charge();
    const page = await bucket.list({
      prefix: "u/",
      limit,
      ...(claim.cursor ? { cursor: claim.cursor } : {}),
    });
    if (
      page.objects.length > limit ||
      page.delimitedPrefixes.length ||
      (page.truncated &&
        (!page.cursor || page.cursor.length > 8192 || page.cursor === claim.cursor))
    )
      throw new Error("invalid_orphan_inventory_page");
    for (const listed of page.objects) {
      if (Date.now() >= deadline) return result;
      validObject(listed);
      result.examined++;
      const unknown = await primary(db)
        .prepare(`SELECT 1 WHERE ${UNKNOWN}`)
        .bind(...keys(listed.key))
        .first();
      if (!unknown) continue;
      const expected = await primary(db)
        .prepare(`SELECT r2_key,state,bytes,r2_etag,r2_version,uploaded_at,
        first_seen_at,last_seen_at,claim_token FROM orphan_objects WHERE r2_key=?`)
        .bind(listed.key)
        .first<ObservedOrphan>();
      if (expected?.claim_token) continue;
      await charge();
      const current = await bucket.head(listed.key);
      if (!current) continue; // Absence never releases an existing record's physical charge here.
      if (current.key !== listed.key) throw new Error("orphan_key_mismatch");
      const admission = await acquireGlobalMutation(env, "orphan.scan-observe");
      // Preserve the original batch result: a receipt cannot reconstruct its changes count.
      const saved = await atomicBatch(
        db,
        globalMutationStatements(admission, [
          controlFence(epoch, maintenance),
          scanFence(epoch, token),
          observation(current, epoch, expected),
        ]),
      );
      result.observed += saved[3]?.meta.changes ? 1 : 0;
    }
    const cursor = page.truncated ? page.cursor : "";
    try {
      const admission = await acquireGlobalMutation(env, "orphan.scan-page");
      await commitGlobalMutation(db, admission, [
        controlFence(epoch, maintenance),
        scanFence(epoch, token),
        {
          sql: `UPDATE r2_inventory_scan SET cursor=?,lease_token=NULL,lease_expires_at=NULL,
          next_scan_at=${CLOCK}+?,last_token=?,pages=pages+1 WHERE singleton=1 AND lease_token=?`,
          values: [cursor, page.truncated ? 0 : 3600000, token, token],
        },
        assertOneChange,
      ]);
    } catch (error) {
      const saved = await primary(db)
        .prepare("SELECT 1 FROM r2_inventory_scan WHERE epoch=? AND last_token=? AND cursor=?")
        .bind(epoch, token, cursor)
        .first();
      if (!saved) throw error;
    }
    result.advanced = true;
    result.completed = !page.truncated;
    return result;
  } finally {
    try {
      const admission = await acquireGlobalMutation(env, "orphan.scan-release");
      await commitGlobalMutation(db, admission, [
        controlFence(epoch, maintenance),
        {
          sql: `UPDATE r2_inventory_scan SET lease_token=NULL,lease_expires_at=NULL
          WHERE singleton=1 AND epoch=? AND lease_token=?`,
          values: [epoch, token],
        },
      ]);
    } catch {
      /* Keep an unresolved lease until expiry; never mask the original scan outcome. */
    }
  }
}

export interface OrphanGcResult {
  claimed: number;
  deleted: number;
  changed: number;
  retried: number;
  r2Calls: number;
}

/** Separate from normal blob GC: immutable quarantine keys, 35-day grace, HEAD before and after delete. */
export async function collectOrphanObjects(
  env: GlobalMutationSource,
  bucket: R2Bucket,
  epoch: number,
  options: { limit?: number; maxWallMs?: number } = {},
): Promise<OrphanGcResult> {
  return collect(env, bucket, epoch, options, false);
}

/** Maintenance may reconcile an existing irreversible deletion, but cannot start quarantine GC. */
export async function drainStoppedOrphanGarbageCollection(
  env: GlobalMutationSource,
  bucket: R2Bucket,
  epoch: number,
  options: { limit?: number; maxWallMs?: number } = {},
): Promise<OrphanGcResult> {
  if ((options.limit ?? 20) > 20) throw new Error("invalid_orphan_limit");
  return collect(env, bucket, epoch, options, true);
}

async function collect(
  env: GlobalMutationSource,
  bucket: R2Bucket,
  epoch: number,
  options: { limit?: number; maxWallMs?: number },
  stopped: boolean,
): Promise<OrphanGcResult> {
  const { DB: db } = env;
  const limit = options.limit ?? 20;
  const wall = options.maxWallMs ?? 20000;
  limits(epoch, limit, wall);
  const deadline = Date.now() + wall;
  const withinBudget = () => {
    if (Date.now() >= deadline) throw new Error("orphan_gc_budget");
  };
  const result: OrphanGcResult = { claimed: 0, deleted: 0, changed: 0, retried: 0, r2Calls: 0 };
  const gate = () =>
    assertExists(
      "SELECT 1 FROM control WHERE singleton=1 AND epoch=? AND maintenance=? AND gc_paused=?",
      [epoch, stopped ? 1 : 0, stopped ? 1 : 0],
    );
  const due = `${stopped ? "state='deleting'" : "state<>'deleted'"} AND owner_key IS NOT NULL AND first_seen_at<=${CLOCK}-${ORPHAN_GRACE_MS}
    AND next_check_at<=${CLOCK} AND (claim_token IS NULL OR claim_expires_at<=${CLOCK})`;
  const rows = await primary(db)
    .prepare(`SELECT r2_key FROM orphan_objects WHERE ${due} AND epoch<=?
    AND EXISTS(SELECT 1 FROM control WHERE singleton=1 AND epoch=? AND maintenance=? AND gc_paused=?)
    ORDER BY next_check_at,first_seen_at,r2_key LIMIT ?`)
    .bind(epoch, epoch, stopped ? 1 : 0, stopped ? 1 : 0, limit)
    .all<{ r2_key: string }>();
  for (const { r2_key: key } of rows.results) {
    if (Date.now() >= deadline) break;
    const token = crypto.randomUUID();
    try {
      const admission = await acquireGlobalMutation(env, "orphan.gc-claim", deadline);
      await commitGlobalMutation(db, admission, [
        gate(),
        assertExists(`SELECT 1 WHERE ${UNKNOWN}`, keys(key)),
        {
          sql: `UPDATE orphan_objects SET state='deleting',claim_token=?,claim_expires_at=${CLOCK}+?,
          next_check_at=${CLOCK}+?,last_error=NULL WHERE r2_key=? AND ${due} AND epoch<=?`,
          values: [token, LEASE_MS, LEASE_MS, key, epoch],
        },
        assertOneChange,
      ]);
    } catch {
      /* A matching token is the only proof of a durable claim. */
    }
    const row = await primary(db)
      .prepare(`SELECT r2_key,bytes,r2_etag,r2_version,uploaded_at,first_seen_at
      FROM orphan_objects WHERE r2_key=? AND claim_token=? AND claim_expires_at>${CLOCK}`)
      .bind(key, token)
      .first<Orphan>();
    if (!row) continue;
    result.claimed++;
    const charge = async () => {
      const admission = await acquireGlobalMutation(env, "orphan.gc-call", deadline);
      withinBudget();
      await atomicBatch(
        db,
        globalMutationStatements(admission, [
          gate(),
          objectFence(row, token),
          {
            sql: "UPDATE orphan_objects SET r2_calls=r2_calls+1 WHERE r2_key=? AND claim_token=?",
            values: [key, token],
          },
          assertOneChange,
        ]),
      );
      withinBudget();
      result.r2Calls++;
    };
    try {
      await charge();
      let object = await bucket.head(key);
      if (object && !matches(row, object)) {
        validObject(object);
        if (object.key !== key) throw new Error("orphan_key_mismatch");
        const admission = await acquireGlobalMutation(env, "orphan.gc-observe");
        await commitGlobalMutation(db, admission, [
          gate(),
          objectFence(row, token),
          {
            sql: "UPDATE orphan_objects SET claim_token=NULL,claim_expires_at=NULL WHERE r2_key=? AND claim_token=?",
            values: [key, token],
          },
          assertOneChange,
          observation(object, epoch),
        ]);
        result.changed++;
        continue;
      }
      if (object) {
        await charge();
        try {
          await bucket.delete(key);
        } catch {
          /* Only HEAD absence confirms removal. */
        }
        await charge();
        object = await bucket.head(key);
      }
      if (object) throw new Error("orphan_removal_unconfirmed");
      try {
        const admission = await acquireGlobalMutation(env, "orphan.gc-finalize");
        await commitGlobalMutation(db, admission, [
          gate(),
          objectFence(row, token),
          {
            sql: `UPDATE orphan_objects SET state='deleted',removed_at=MAX(last_seen_at,${CLOCK}),
            claim_token=NULL,claim_expires_at=NULL,last_error=NULL WHERE r2_key=? AND claim_token=?`,
            values: [key, token],
          },
          assertOneChange,
        ]);
      } catch (error) {
        const saved = await primary(db)
          .prepare(`SELECT 1 FROM orphan_objects WHERE r2_key=? AND state='deleted'
          AND bytes=? AND r2_etag=? AND r2_version=? AND uploaded_at=? AND first_seen_at=?`)
          .bind(key, row.bytes, row.r2_etag, row.r2_version, row.uploaded_at, row.first_seen_at)
          .first();
        if (!saved) throw error;
      }
      result.deleted++;
    } catch {
      // Keep the lease until it expires; another worker must not immediately race unknown I/O.
      try {
        const admission = await acquireGlobalMutation(env, "orphan.gc-error");
        await commitGlobalMutation(db, admission, [
          gate(),
          {
            sql: "UPDATE orphan_objects SET last_error='orphan_removal_unconfirmed' WHERE r2_key=? AND claim_token=?",
            values: [key, token],
          },
          assertOneChange,
        ]);
      } catch {
        /* Retain the claim and physical charge when annotation cannot be confirmed. */
      }
      result.retried++;
    }
  }
  return result;
}
