import { GC_NOT_BEFORE_SQL } from "../db/gcGrace";
import {
  assertExists,
  assertOneChange,
  atomicBatch,
  primary,
  type SqlStatement,
} from "../db/primary";
import type { R2S3Inventory } from "../r2/s3Inventory";
import type { InventoryMutationSource } from "../services/globalMutation";
import {
  acquireGlobalMutation,
  commitGlobalMutation,
  globalMutationStatements,
} from "../services/globalMutation";
import {
  acquireSystemMutation,
  commitSystemMutation,
  systemMutationStatements,
} from "../services/systemMutation";
import { scanVerifiedMultipartBucket } from "./multipartBucketInventory";
import { type VerifiedR2Inventory, withVerifiedR2Inventory } from "./r2BindingVerification";
import { controlFence, matches, observedObject, UNPUBLISHED } from "./uploadCleanup";

const CLOCK = "strftime('%s','now')*1000";
const LEASE_MS = 60_000;
const TERMINAL = "'expired','aborted','failed'";
const ACTIVE_PHASE = "'waiting','scanning'";

interface ClosureRun {
  id: string;
  source: string;
  epoch: number;
  phase: "waiting" | "scanning" | "proven" | "stale";
  generation: number;
  not_before: number;
  scan_round_id: string | null;
  calls: number;
  created_at: number;
  updated_at: number;
  proven_at: number | null;
}

interface BucketScan {
  source: string;
  epoch: number;
  round_id: string;
  pages: number;
  completed_at: number | null;
}

interface UploadCandidate {
  id: string;
  owner_id: string;
  blob_id: string;
  reservation_id: string;
  share_id: string | null;
  epoch: number;
  write_attempt_id: string | null;
  r2_key: string;
}

export interface MultipartClosureStatus {
  id: string | null;
  phase: ClosureRun["phase"] | "blocked" | "idle";
  epoch: number;
  generation: number;
  notBefore: number | null;
  scanRoundId: string | null;
  scanPages: number;
  scanCompleted: boolean;
  blockers: {
    parts: number;
    aborts: number;
    present: number;
    tracked: number;
    uploads: number;
  };
  unsettled: {
    handles: number;
    heldBytes: number;
    uploads: number;
    reservedBytes: number;
  };
  nextHandles: { id: string; action: "parts" | "abort" | "known_cleanup" | "rescan" }[];
}

export interface MultipartClosureAdvanceResult {
  action: "blocked" | "waiting" | "scanned" | "rescanning" | "proven";
  inventory?: { examined: number; completed: boolean };
  status: MultipartClosureStatus;
}

export interface MultipartClosureSettlementResult {
  closureId: string;
  handles: number;
  uploads: number;
  absent: number;
  queued: number;
  retried: number;
  r2Calls: number;
  status: MultipartClosureStatus;
}

function validate(epoch: number, limit: number): void {
  if (
    !Number.isSafeInteger(epoch) ||
    epoch < 1 ||
    !Number.isSafeInteger(limit) ||
    limit < 1 ||
    limit > 100
  )
    throw new Error("invalid_multipart_closure_limit");
}

function activeRun(db: D1Database) {
  return primary(db)
    .prepare(`SELECT * FROM multipart_closure_runs WHERE phase IN (${ACTIVE_PHASE})
      ORDER BY created_at DESC,id DESC LIMIT 1`)
    .first<ClosureRun>();
}

function runFence(run: ClosureRun): SqlStatement {
  return assertExists(
    `SELECT 1 FROM multipart_closure_runs WHERE id=? AND source=? AND epoch=? AND phase=?
      AND generation=? AND not_before=? AND scan_round_id IS ? AND calls=? AND updated_at=?`,
    [
      run.id,
      run.source,
      run.epoch,
      run.phase,
      run.generation,
      run.not_before,
      run.scan_round_id,
      run.calls,
      run.updated_at,
    ],
  );
}

function scanFence(scan: BucketScan): SqlStatement {
  return assertExists(
    `SELECT 1 FROM multipart_bucket_scan WHERE singleton=1 AND source=? AND epoch=? AND round_id=?
      AND pages=? AND completed_at IS ?`,
    [scan.source, scan.epoch, scan.round_id, scan.pages, scan.completed_at],
  );
}

function closureProof(id: string, epoch: number, source: string): SqlStatement {
  return assertExists(
    `SELECT 1 FROM multipart_closure_runs
      WHERE id=? AND phase='proven' AND epoch=? AND source=?`,
    [id, epoch, source],
  );
}

async function scanRow(db: D1Database) {
  return primary(db)
    .prepare(
      "SELECT source,epoch,round_id,pages,completed_at FROM multipart_bucket_scan WHERE singleton=1",
    )
    .first<BucketScan>();
}

async function latestRun(db: D1Database, epoch: number) {
  return primary(db)
    .prepare(`SELECT * FROM multipart_closure_runs
      WHERE epoch=?
      ORDER BY CASE WHEN phase IN (${ACTIVE_PHASE}) THEN 0 WHEN phase='proven' THEN 1 ELSE 2 END,
        created_at DESC,id DESC LIMIT 1`)
    .bind(epoch)
    .first<ClosureRun>();
}

async function blockerCounts(db: D1Database, run: ClosureRun | null) {
  const round = run?.scan_round_id ?? "";
  return primary(db)
    .prepare(`SELECT
      (SELECT COUNT(*) FROM multipart_bucket_handles h
        WHERE h.state='quarantined'
          AND NOT EXISTS(SELECT 1 FROM multipart_bucket_handle_settlements x WHERE x.handle_id=h.id)
          AND h.parts_completed_at IS NULL) AS parts,
      (SELECT COUNT(*) FROM multipart_bucket_handles h
        WHERE h.state='quarantined'
          AND NOT EXISTS(SELECT 1 FROM multipart_bucket_handle_settlements x WHERE x.handle_id=h.id)
          AND h.parts_completed_at IS NOT NULL
          AND NOT EXISTS(SELECT 1 FROM multipart_bucket_abort_attempts a
            WHERE a.handle_id=h.id AND a.outcome='confirmed' AND a.finished_at>=h.last_seen_at)) AS aborts,
      (SELECT COUNT(*) FROM multipart_bucket_handles h
        WHERE h.last_round_id=? AND NOT EXISTS(
          SELECT 1 FROM multipart_bucket_handle_settlements x WHERE x.handle_id=h.id)) AS present,
      (SELECT COUNT(*) FROM multipart_bucket_handles h
        WHERE h.last_round_id=? AND h.state='tracked') AS tracked,
      (SELECT COUNT(*) FROM uploads u
        WHERE u.mode='multipart' AND (
          u.state IN ('created','uploading','completing','aborting')
          OR COALESCE(u.write_lease_expires_at,0)>${CLOCK}
          OR COALESCE(u.multipart_complete_lease,0)>${CLOCK}
          OR EXISTS(SELECT 1 FROM upload_parts p WHERE p.upload_id=u.id
            AND p.state IN ('in_flight','unknown') AND p.lease_expires_at>${CLOCK})
          OR EXISTS(SELECT 1 FROM multipart_inventory_scans s
            WHERE s.upload_id=u.id AND (s.completed_at IS NULL OR EXISTS(
              SELECT 1 FROM multipart_inventory_handles ih
              WHERE ih.upload_id=u.id AND ih.state<>'aborted'))))) AS uploads`)
    .bind(round, round)
    .first<{
      parts: number;
      aborts: number;
      present: number;
      tracked: number;
      uploads: number;
    }>();
}

export async function multipartClosureStatus(
  db: D1Database,
  epoch: number,
  limit = 20,
): Promise<MultipartClosureStatus> {
  validate(epoch, limit);
  const run = await latestRun(db, epoch);
  const scan = await scanRow(db);
  const blockers = (await blockerCounts(db, run)) ?? {
    parts: 0,
    aborts: 0,
    present: 0,
    tracked: 0,
    uploads: 0,
  };
  const unsettled = (await primary(db)
    .prepare(`SELECT
      (SELECT COUNT(*) FROM multipart_bucket_handles h
        WHERE h.state='quarantined' AND NOT EXISTS(
          SELECT 1 FROM multipart_bucket_handle_settlements x WHERE x.handle_id=h.id)) AS handles,
      COALESCE((SELECT SUM(h.held_bytes) FROM multipart_bucket_handles h
        WHERE h.state='quarantined' AND NOT EXISTS(
          SELECT 1 FROM multipart_bucket_handle_settlements x WHERE x.handle_id=h.id)),0) AS heldBytes,
      (SELECT COUNT(*) FROM uploads u JOIN reservations r ON r.id=u.reservation_id
        WHERE r.state='reserved' AND EXISTS(
          SELECT 1 FROM multipart_inventory_scans s WHERE s.upload_id=u.id)
          AND NOT EXISTS(SELECT 1 FROM multipart_upload_settlements x
            WHERE x.upload_id=u.id AND x.state='settled')) AS uploads,
      COALESCE((SELECT SUM(r.bytes) FROM uploads u JOIN reservations r ON r.id=u.reservation_id
        WHERE r.state='reserved' AND EXISTS(
          SELECT 1 FROM multipart_inventory_scans s WHERE s.upload_id=u.id)
          AND NOT EXISTS(SELECT 1 FROM multipart_upload_settlements x
            WHERE x.upload_id=u.id AND x.state='settled')),0) AS reservedBytes`)
    .first<MultipartClosureStatus["unsettled"]>()) ?? {
    handles: 0,
    heldBytes: 0,
    uploads: 0,
    reservedBytes: 0,
  };
  const handles = await primary(db)
    .prepare(`SELECT h.id,
      CASE WHEN h.state='tracked' THEN 'known_cleanup'
        WHEN h.parts_completed_at IS NULL THEN 'parts'
        WHEN NOT EXISTS(SELECT 1 FROM multipart_bucket_abort_attempts a
          WHERE a.handle_id=h.id AND a.outcome='confirmed' AND a.finished_at>=h.last_seen_at)
          THEN 'abort' ELSE 'rescan' END AS action
      FROM multipart_bucket_handles h
      WHERE NOT EXISTS(SELECT 1 FROM multipart_bucket_handle_settlements x WHERE x.handle_id=h.id)
        AND (h.state='quarantined' OR h.last_round_id=?)
      ORDER BY CASE action WHEN 'parts' THEN 0 WHEN 'abort' THEN 1
        WHEN 'known_cleanup' THEN 2 ELSE 3 END,h.last_seen_at,h.id LIMIT ?`)
    .bind(run?.scan_round_id ?? "", limit)
    .all<MultipartClosureStatus["nextHandles"][number]>();
  const blocked =
    blockers.parts > 0 || blockers.aborts > 0 || blockers.tracked > 0 || blockers.uploads > 0;
  return {
    id: run?.id ?? null,
    phase: run?.phase ?? (blocked ? "blocked" : "idle"),
    epoch,
    generation: run?.generation ?? 0,
    notBefore: run?.not_before ?? null,
    scanRoundId: run?.scan_round_id ?? null,
    scanPages: scan !== null && run?.scan_round_id === scan.round_id ? scan.pages : 0,
    scanCompleted:
      scan !== null && run?.scan_round_id === scan.round_id && scan.completed_at !== null,
    blockers,
    unsettled,
    nextHandles: handles.results,
  };
}

function initialBlockers(blockers: MultipartClosureStatus["blockers"]): boolean {
  return blockers.parts > 0 || blockers.aborts > 0 || blockers.uploads > 0;
}

/** Advance at most one verified bucket page or one D1 proof transition. */
export async function advanceMultipartClosure(
  env: InventoryMutationSource,
  bucket: R2Bucket,
  inventory: R2S3Inventory,
  epoch: number,
  options: { limit?: number; quietMs?: number } = {},
): Promise<MultipartClosureAdvanceResult> {
  const limit = options.limit ?? 20;
  const quietMs = options.quietMs ?? 60_000;
  validate(epoch, limit);
  if (!Number.isSafeInteger(quietMs) || quietMs < 1 || quietMs > 300_000)
    throw new Error("invalid_multipart_closure_quiet");
  const { DB: db } = env;
  return withVerifiedR2Inventory(env, bucket, inventory, epoch, async (verified) => {
    const source = JSON.stringify(verified.observation.source);
    let run = await activeRun(db);
    if (run && (run.epoch !== epoch || run.source !== source)) {
      const admission = await acquireGlobalMutation(env, "bucket.closure-phase");
      await commitGlobalMutation(db, admission, [
        verified.fence(),
        controlFence(epoch, true),
        runFence(run),
        {
          sql: `UPDATE multipart_closure_runs SET phase='stale',updated_at=${CLOCK}
            WHERE id=? AND phase IN (${ACTIVE_PHASE})`,
          values: [run.id],
        },
        assertOneChange,
      ]);
      run = null;
    }
    if (!run) {
      const status = await multipartClosureStatus(db, epoch, limit);
      if (initialBlockers(status.blockers))
        return { action: "blocked", status } satisfies MultipartClosureAdvanceResult;
      const existingScan = await scanRow(db);
      if (
        !existingScan ||
        existingScan.source !== source ||
        existingScan.epoch !== epoch ||
        existingScan.completed_at === null
      ) {
        const scanned = await scanVerifiedMultipartBucket(env, verified, epoch, limit);
        return {
          action: "scanned",
          inventory: { examined: scanned.examined, completed: scanned.completed },
          status: await multipartClosureStatus(db, epoch, limit),
        };
      }
      const id = crypto.randomUUID();
      const admission = await acquireGlobalMutation(env, "bucket.closure-phase");
      await commitGlobalMutation(db, admission, [
        verified.fence(),
        controlFence(epoch, true),
        scanFence(existingScan),
        {
          sql: `INSERT INTO multipart_closure_runs(
            id,source,epoch,phase,not_before,created_at,updated_at
          ) VALUES(?,?,?,'waiting',${CLOCK}+?,${CLOCK},${CLOCK})`,
          values: [id, source, epoch, quietMs],
        },
        assertOneChange,
      ]);
      return {
        action: "waiting",
        status: await multipartClosureStatus(db, epoch, limit),
      };
    }
    if (run.phase === "waiting") {
      if (run.not_before > Date.now())
        return {
          action: "waiting",
          status: await multipartClosureStatus(db, epoch, limit),
        };
      const scanned = await scanVerifiedMultipartBucket(env, verified, epoch, limit);
      const currentScan = await scanRow(db);
      if (!currentScan || currentScan.source !== source || currentScan.epoch !== epoch)
        throw new Error("multipart_closure_scan_unconfirmed");
      const admission = await acquireGlobalMutation(env, "bucket.closure-phase");
      await commitGlobalMutation(db, admission, [
        verified.fence(),
        controlFence(epoch, true),
        runFence(run),
        scanFence(currentScan),
        {
          sql: `UPDATE multipart_closure_runs SET phase='scanning',scan_round_id=?,
            calls=calls+1,updated_at=${CLOCK} WHERE id=?`,
          values: [currentScan.round_id, run.id],
        },
        assertOneChange,
      ]);
      return {
        action: "scanned",
        inventory: { examined: scanned.examined, completed: scanned.completed },
        status: await multipartClosureStatus(db, epoch, limit),
      };
    }
    let currentScan = await scanRow(db);
    if (
      !currentScan ||
      currentScan.source !== source ||
      currentScan.epoch !== epoch ||
      currentScan.round_id !== run.scan_round_id
    ) {
      const admission = await acquireGlobalMutation(env, "bucket.closure-phase");
      await commitGlobalMutation(db, admission, [
        verified.fence(),
        controlFence(epoch, true),
        runFence(run),
        {
          sql: `UPDATE multipart_closure_runs SET phase='stale',updated_at=${CLOCK}
            WHERE id=? AND phase='scanning'`,
          values: [run.id],
        },
        assertOneChange,
      ]);
      return {
        action: "blocked",
        status: await multipartClosureStatus(db, epoch, limit),
      };
    }
    if (currentScan.completed_at === null) {
      const scanned = await scanVerifiedMultipartBucket(env, verified, epoch, limit);
      return {
        action: "scanned",
        inventory: { examined: scanned.examined, completed: scanned.completed },
        status: await multipartClosureStatus(db, epoch, limit),
      };
    }
    const status = await multipartClosureStatus(db, epoch, limit);
    if (status.blockers.present > 0) {
      if (
        status.blockers.parts > 0 ||
        status.blockers.aborts > 0 ||
        status.blockers.tracked > 0 ||
        status.blockers.uploads > 0
      )
        return { action: "blocked", status };
      const admission = await acquireGlobalMutation(env, "bucket.closure-phase");
      await commitGlobalMutation(db, admission, [
        verified.fence(),
        controlFence(epoch, true),
        runFence(run),
        scanFence(currentScan),
        {
          sql: `UPDATE multipart_closure_runs SET phase='waiting',generation=generation+1,
            not_before=${CLOCK}+?,scan_round_id=NULL,calls=calls+1,updated_at=${CLOCK}
            WHERE id=? AND phase='scanning'`,
          values: [quietMs, run.id],
        },
        assertOneChange,
      ]);
      return {
        action: "rescanning",
        status: await multipartClosureStatus(db, epoch, limit),
      };
    }
    const admission = await acquireGlobalMutation(env, "bucket.closure-phase");
    await commitGlobalMutation(db, admission, [
      verified.fence(),
      controlFence(epoch, true),
      runFence(run),
      scanFence(currentScan),
      assertExists(
        `SELECT 1 WHERE
          NOT EXISTS(SELECT 1 FROM multipart_bucket_handles h
            WHERE h.last_round_id=? AND NOT EXISTS(
              SELECT 1 FROM multipart_bucket_handle_settlements x WHERE x.handle_id=h.id))
          AND NOT EXISTS(SELECT 1 FROM multipart_bucket_handles h
            WHERE h.state='quarantined' AND NOT EXISTS(
              SELECT 1 FROM multipart_bucket_handle_settlements x WHERE x.handle_id=h.id)
            AND (h.parts_completed_at IS NULL OR NOT EXISTS(
              SELECT 1 FROM multipart_bucket_abort_attempts a
              WHERE a.handle_id=h.id AND a.outcome='confirmed' AND a.finished_at>=h.last_seen_at)))
          AND NOT EXISTS(SELECT 1 FROM uploads u WHERE u.mode='multipart' AND (
            u.state IN ('created','uploading','completing','aborting')
            OR COALESCE(u.write_lease_expires_at,0)>${CLOCK}
            OR COALESCE(u.multipart_complete_lease,0)>${CLOCK}
            OR EXISTS(SELECT 1 FROM upload_parts p WHERE p.upload_id=u.id
              AND p.state IN ('in_flight','unknown') AND p.lease_expires_at>${CLOCK})
            OR EXISTS(SELECT 1 FROM multipart_inventory_scans s WHERE s.upload_id=u.id
              AND (s.completed_at IS NULL OR EXISTS(SELECT 1 FROM multipart_inventory_handles ih
                WHERE ih.upload_id=u.id AND ih.state<>'aborted')))))`,
        [run.scan_round_id],
      ),
      {
        sql: `UPDATE multipart_closure_runs SET phase='proven',calls=calls+1,
          updated_at=${CLOCK},proven_at=${CLOCK} WHERE id=? AND phase='scanning'`,
        values: [run.id],
      },
      assertOneChange,
    ]);
    return {
      action: "proven",
      status: await multipartClosureStatus(db, epoch, limit),
    };
  });
}

function uploadClaimFence(row: UploadCandidate, closureId: string, token: string): SqlStatement {
  return assertExists(
    `SELECT 1 FROM multipart_upload_settlements x
      JOIN multipart_closure_runs c ON c.id=x.closure_id
      JOIN uploads u ON u.id=x.upload_id
      JOIN blobs b ON b.id=u.blob_id
      JOIN reservations r ON r.id=x.reservation_id
      WHERE x.upload_id=? AND x.closure_id=? AND x.owner_id=? AND x.reservation_id=?
        AND x.share_id IS ? AND x.token=? AND x.state='claimed'
        AND x.lease_expires_at>${CLOCK} AND x.head_calls<64
        AND c.phase='proven' AND u.owner_id=x.owner_id AND u.blob_id=?
        AND u.reservation_id=x.reservation_id AND u.state IN (${TERMINAL})
        AND u.cleanup_pending=1 AND b.state='orphan' AND b.ref_count=0
        AND r.state='reserved' AND r.owner_id=x.owner_id AND r.share_id IS x.share_id
        AND ${UNPUBLISHED}
        AND NOT EXISTS(SELECT 1 FROM blob_pins WHERE blob_id=b.id)
        AND NOT EXISTS(SELECT 1 FROM gc_candidates WHERE blob_id=b.id)`,
    [row.id, closureId, row.owner_id, row.reservation_id, row.share_id, token, row.blob_id],
  );
}

async function claimUpload(
  env: InventoryMutationSource,
  verified: VerifiedR2Inventory,
  closureId: string,
  row: UploadCandidate,
  epoch: number,
  token: string,
  deadline: number,
): Promise<boolean> {
  const admission = await acquireSystemMutation(
    env,
    row.owner_id,
    "upload.closure-claim",
    deadline,
  );
  await commitSystemMutation(env.DB, admission, row.owner_id, [
    verified.fence(),
    controlFence(epoch, true),
    closureProof(closureId, epoch, JSON.stringify(verified.observation.source)),
    {
      sql: `INSERT INTO multipart_upload_settlements(
        upload_id,closure_id,owner_id,reservation_id,share_id,token,lease_expires_at,state,claimed_at
      ) VALUES(?,?,?,?,?,?,${CLOCK}+?,'claimed',${CLOCK})
      ON CONFLICT(upload_id) DO UPDATE SET closure_id=excluded.closure_id,token=excluded.token,
        lease_expires_at=excluded.lease_expires_at,error=NULL
      WHERE multipart_upload_settlements.state='claimed'
        AND multipart_upload_settlements.owner_id=excluded.owner_id
        AND multipart_upload_settlements.reservation_id=excluded.reservation_id
        AND multipart_upload_settlements.share_id IS excluded.share_id
        AND multipart_upload_settlements.lease_expires_at<=${CLOCK}
        AND multipart_upload_settlements.head_calls<64`,
      values: [row.id, closureId, row.owner_id, row.reservation_id, row.share_id, token, LEASE_MS],
    },
    assertOneChange,
  ]);
  return (
    (await primary(env.DB)
      .prepare(`SELECT 1 FROM multipart_upload_settlements
        WHERE upload_id=? AND closure_id=? AND owner_id=? AND reservation_id=?
          AND share_id IS ? AND token=? AND state='claimed' AND lease_expires_at>${CLOCK}`)
      .bind(row.id, closureId, row.owner_id, row.reservation_id, row.share_id, token)
      .first()) !== null
  );
}

async function settleUpload(
  env: InventoryMutationSource,
  verified: VerifiedR2Inventory,
  closureId: string,
  row: UploadCandidate,
  epoch: number,
  token: string,
  object: R2Object | null,
): Promise<"absent" | "queued"> {
  if (object && !matches(row, object)) {
    const admission = await acquireSystemMutation(env, row.owner_id, "upload.closure-error");
    await commitSystemMutation(env.DB, admission, row.owner_id, [
      verified.fence(),
      controlFence(epoch, true),
      uploadClaimFence(row, closureId, token),
      ...observedObject(row, object),
      {
        sql: `UPDATE multipart_upload_settlements SET error='upload_object_mismatch'
          WHERE upload_id=? AND token=? AND state='claimed'`,
        values: [row.id, token],
      },
      assertOneChange,
    ]);
    throw new Error("upload_object_mismatch");
  }
  const statements: SqlStatement[] = [
    verified.fence(),
    controlFence(epoch, true),
    uploadClaimFence(row, closureId, token),
  ];
  if (object) statements.push(...observedObject(row, object));
  else
    statements.push(
      {
        sql: "UPDATE blobs SET state='deleted' WHERE id=? AND state='orphan' AND ref_count=0",
        values: [row.blob_id],
      },
      assertOneChange,
      {
        sql: `UPDATE blob_storage SET removed_at=MAX(observed_at,${CLOCK})
          WHERE blob_id=? AND removed_at IS NULL`,
        values: [row.blob_id],
      },
    );
  statements.push(
    {
      sql: "UPDATE reservations SET state='released' WHERE id=? AND state='reserved'",
      values: [row.reservation_id],
    },
    assertOneChange,
    {
      sql: `INSERT INTO gc_candidates(blob_id,state,not_before)
        VALUES(?,?,${object ? GC_NOT_BEFORE_SQL : CLOCK})`,
      values: [row.blob_id, object ? "candidate" : "deleted"],
    },
    assertOneChange,
    {
      sql: `UPDATE uploads SET cleanup_token=NULL,cleanup_lease_expires_at=NULL,
        cleanup_pending=?,cleanup_error=NULL WHERE id=? AND owner_id=? AND state IN (${TERMINAL})`,
      values: [object ? 1 : 0, row.id, row.owner_id],
    },
    assertOneChange,
    {
      sql: `UPDATE multipart_upload_settlements SET state='settled',object_state=?,
        object_bytes=?,object_etag=?,error=NULL,settled_at=${CLOCK}
        WHERE upload_id=? AND token=? AND state='claimed'`,
      values: [
        object ? "present" : "absent",
        object?.size ?? null,
        object?.etag ?? null,
        row.id,
        token,
      ],
    },
    assertOneChange,
  );
  const admission = await acquireSystemMutation(env, row.owner_id, "upload.closure-settle");
  try {
    await commitSystemMutation(env.DB, admission, row.owner_id, statements);
  } catch (error) {
    const saved = await primary(env.DB)
      .prepare(`SELECT 1 FROM multipart_upload_settlements x
        JOIN reservations r ON r.id=x.reservation_id
        JOIN uploads u ON u.id=x.upload_id
        JOIN gc_candidates g ON g.blob_id=u.blob_id
        WHERE x.upload_id=? AND x.closure_id=? AND x.owner_id=? AND x.reservation_id=?
          AND x.share_id IS ? AND x.state='settled' AND r.state='released'
          AND ((x.object_state='absent' AND g.state='deleted' AND u.cleanup_pending=0)
            OR (x.object_state='present' AND g.state IN ('candidate','deleting')
              AND u.cleanup_pending=1))`)
      .bind(row.id, closureId, row.owner_id, row.reservation_id, row.share_id)
      .first();
    if (!saved) throw error;
  }
  return object ? "queued" : "absent";
}

/** Settle at most limit total handle/upload receipts. Ambiguous HEAD outcomes retain every hold. */
export async function settleMultipartClosure(
  env: InventoryMutationSource,
  bucket: R2Bucket,
  inventory: R2S3Inventory,
  epoch: number,
  closureId: string,
  options: { limit?: number; maxWallMs?: number } = {},
): Promise<MultipartClosureSettlementResult> {
  const limit = options.limit ?? 20;
  const wall = options.maxWallMs ?? 20_000;
  validate(epoch, limit);
  if (
    typeof closureId !== "string" ||
    !/^[a-f\d-]{36}$/.test(closureId) ||
    !Number.isSafeInteger(wall) ||
    wall < 1 ||
    wall > 25_000
  )
    throw new Error("invalid_multipart_closure_settlement");
  const started = Date.now();
  return withVerifiedR2Inventory(env, bucket, inventory, epoch, async (verified) => {
    const source = JSON.stringify(verified.observation.source);
    const proof = await primary(env.DB)
      .prepare(
        "SELECT 1 FROM multipart_closure_runs WHERE id=? AND source=? AND epoch=? AND phase='proven'",
      )
      .bind(closureId, source, epoch)
      .first();
    if (!proof) throw new Error("multipart_closure_unavailable");
    const result: MultipartClosureSettlementResult = {
      closureId,
      handles: 0,
      uploads: 0,
      absent: 0,
      queued: 0,
      retried: 0,
      r2Calls: 0,
      status: await multipartClosureStatus(env.DB, epoch, limit),
    };
    const handles = await primary(env.DB)
      .prepare(`SELECT h.id,h.owner_id,h.held_bytes FROM multipart_bucket_handles h
        JOIN multipart_closure_runs c ON c.id=?
        WHERE h.state='quarantined' AND h.source=c.source
          AND h.last_round_id<>c.scan_round_id
          AND h.parts_completed_at IS NOT NULL
          AND NOT EXISTS(SELECT 1 FROM multipart_bucket_handle_settlements x WHERE x.handle_id=h.id)
          AND EXISTS(SELECT 1 FROM multipart_bucket_abort_attempts a
            WHERE a.handle_id=h.id AND a.outcome='confirmed' AND a.finished_at>=h.last_seen_at)
        ORDER BY h.last_seen_at,h.id LIMIT ?`)
      .bind(closureId, limit)
      .all<{ id: string; owner_id: string | null; held_bytes: number }>();
    for (const handle of handles.results) {
      if (Date.now() - started >= wall) break;
      const admission = await acquireGlobalMutation(env, "bucket.closure-settle", started + wall);
      await commitGlobalMutation(env.DB, admission, [
        verified.fence(),
        controlFence(epoch, true),
        closureProof(closureId, epoch, source),
        {
          sql: `INSERT INTO multipart_bucket_handle_settlements(
            handle_id,closure_id,owner_id,held_bytes,settled_at
          ) VALUES(?,?,?,?,${CLOCK})`,
          values: [handle.id, closureId, handle.owner_id, handle.held_bytes],
        },
        assertOneChange,
      ]);
      result.handles++;
    }
    let remaining = limit - result.handles;
    if (remaining > 0 && Date.now() - started < wall) {
      const rows = await primary(env.DB)
        .prepare(`SELECT u.id,u.owner_id,u.blob_id,u.reservation_id,r.share_id,u.epoch,
          u.write_attempt_id,b.r2_key
          FROM uploads u JOIN blobs b ON b.id=u.blob_id
          JOIN reservations r ON r.id=u.reservation_id
          JOIN multipart_inventory_scans s ON s.upload_id=u.id
          JOIN multipart_closure_runs c ON c.id=?
          WHERE r.state='reserved' AND u.mode='multipart' AND u.state IN (${TERMINAL})
            AND u.cleanup_pending=1 AND u.multipart_cleanup_started_at IS NOT NULL
            AND b.state='orphan' AND b.ref_count=0 AND s.completed_at IS NOT NULL
            AND s.source=c.source AND NOT EXISTS(SELECT 1 FROM multipart_inventory_handles ih
              WHERE ih.upload_id=u.id AND ih.state<>'aborted')
            AND NOT EXISTS(SELECT 1 FROM multipart_bucket_handles h
              WHERE h.r2_key=b.r2_key AND h.last_round_id=c.scan_round_id)
            AND NOT EXISTS(SELECT 1 FROM multipart_upload_settlements x
              WHERE x.upload_id=u.id AND (x.state='settled' OR x.lease_expires_at>${CLOCK}))
            AND ${UNPUBLISHED}
          ORDER BY u.cleanup_next_at,u.expires_at,u.id LIMIT ?`)
        .bind(closureId, remaining)
        .all<UploadCandidate>();
      for (const row of rows.results) {
        if (Date.now() - started >= wall) break;
        const token = crypto.randomUUID();
        try {
          if (!(await claimUpload(env, verified, closureId, row, epoch, token, started + wall)))
            continue;
          result.uploads++;
          const call = await acquireSystemMutation(
            env,
            row.owner_id,
            "upload.closure-call",
            started + wall,
          );
          if (Date.now() >= started + wall) throw new Error("multipart_closure_budget");
          await atomicBatch(
            env.DB,
            systemMutationStatements(call, row.owner_id, [
              verified.fence(),
              controlFence(epoch, true),
              uploadClaimFence(row, closureId, token),
              {
                sql: `UPDATE multipart_upload_settlements
                  SET head_calls=head_calls+1 WHERE upload_id=? AND token=? AND state='claimed'`,
                values: [row.id, token],
              },
              assertOneChange,
            ]),
          );
          if (Date.now() >= started + wall) throw new Error("multipart_closure_budget");
          result.r2Calls++;
          const object = await bucket.head(row.r2_key);
          result[await settleUpload(env, verified, closureId, row, epoch, token, object)]++;
        } catch (error) {
          result.retried++;
          try {
            const admission = await acquireSystemMutation(
              env,
              row.owner_id,
              "upload.closure-error",
            );
            await commitSystemMutation(env.DB, admission, row.owner_id, [
              verified.fence(),
              controlFence(epoch, true),
              {
                sql: `UPDATE multipart_upload_settlements SET error=?
                  WHERE upload_id=? AND token=? AND state='claimed'`,
                values: [
                  error instanceof Error && error.message === "upload_object_mismatch"
                    ? error.message
                    : "head_unconfirmed",
                  row.id,
                  token,
                ],
              },
              assertOneChange,
            ]);
          } catch {
            // The exact claim and all accounting holds remain durable.
          }
        }
        remaining--;
      }
    }
    result.status = await multipartClosureStatus(env.DB, epoch, limit);
    return result;
  });
}
