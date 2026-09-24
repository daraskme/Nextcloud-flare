import type { SystemMutationKind } from "../db/mutationAdmission";
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
  acquireSystemMutation,
  commitSystemMutation,
  systemMutationStatements,
} from "../services/systemMutation";
import {
  claimMultipartCleanup,
  MULTIPART_INVENTORY_ELIGIBLE,
  type MultipartCleanupCandidate,
  multipartCleanupFence,
} from "./multipartCleanup";
import { type VerifiedR2Inventory, withVerifiedR2Inventory } from "./r2BindingVerification";
import { controlFence, observedObject } from "./uploadCleanup";

const CLOCK = "strftime('%s','now')*1000";
const PAGE_SIZE = 20;
interface Scan {
  upload_id: string;
  r2_key: string;
  source: string;
  epoch: number;
  round_id: string;
  cursor_key: string | null;
  cursor_upload_id: string | null;
  pages: number;
  completed_at: number | null;
  next_scan_at: number;
  last_token: string | null;
}
interface Handle {
  id: string;
  r2_upload_id: string;
}
export interface MultipartInventoryRepairResult {
  claimed: number;
  pages: number;
  observed: number;
  aborted: number;
  retried: number;
  r2Calls: number;
}
const scanRow = (db: D1Database, id: string) =>
  primary(db)
    .prepare("SELECT * FROM multipart_inventory_scans WHERE upload_id=?")
    .bind(id)
    .first<Scan>();

function scanFence(scan: Scan): SqlStatement {
  return assertExists(
    `SELECT 1 FROM multipart_inventory_scans WHERE upload_id=? AND r2_key=?
    AND source=? AND epoch=? AND round_id=? AND pages=? AND cursor_key IS ? AND cursor_upload_id IS ?
    AND completed_at IS ?`,
    [
      scan.upload_id,
      scan.r2_key,
      scan.source,
      scan.epoch,
      scan.round_id,
      scan.pages,
      scan.cursor_key,
      scan.cursor_upload_id,
      scan.completed_at,
    ],
  );
}

/** Verify the binding afresh, discover stopped handles, and retain unresolved reservations. */
export async function repairUnidentifiedMultipartUploads(
  env: InventoryMutationSource,
  bucket: R2Bucket,
  inventory: R2S3Inventory,
  epoch: number,
  options: {
    maxUploads?: number;
    maxHandles?: number;
    maxWallMs?: number;
  } = {},
): Promise<MultipartInventoryRepairResult> {
  const limit = options.maxUploads ?? 5;
  const maxHandles = options.maxHandles ?? 10;
  const wall = options.maxWallMs ?? 20_000;
  if (
    !Number.isSafeInteger(epoch) ||
    epoch < 1 ||
    !Number.isSafeInteger(limit) ||
    limit < 1 ||
    limit > 20 ||
    !Number.isSafeInteger(maxHandles) ||
    maxHandles < 1 ||
    maxHandles > 20 ||
    !Number.isSafeInteger(wall) ||
    wall < 1 ||
    wall > 25_000
  )
    throw new Error("invalid_multipart_inventory_limit");
  return withVerifiedR2Inventory(env, bucket, inventory, epoch, (verified) =>
    repairVerified(env, verified, epoch, { limit, maxHandles, wall }),
  );
}

async function repairVerified(
  env: InventoryMutationSource,
  verified: VerifiedR2Inventory,
  epoch: number,
  { limit, maxHandles, wall }: { limit: number; maxHandles: number; wall: number },
): Promise<MultipartInventoryRepairResult> {
  const { DB: db } = env;
  const { bucket, inventory } = verified;
  const maintenance = true;
  const source = JSON.stringify(verified.observation.source);
  const started = Date.now();
  const result: MultipartInventoryRepairResult = {
    claimed: 0,
    pages: 0,
    observed: 0,
    aborted: 0,
    retried: 0,
    r2Calls: 0,
  };
  const rows = await primary(db)
    .prepare(`SELECT u.id FROM uploads u JOIN blobs b ON b.id=u.blob_id
    WHERE u.epoch<=? AND ${MULTIPART_INVENTORY_ELIGIBLE}
    AND EXISTS(SELECT 1 FROM control WHERE singleton=1 AND epoch=? AND maintenance=? AND (?=0 OR gc_paused=1))
    ORDER BY u.cleanup_next_at,u.expires_at,u.id LIMIT ?`)
    .bind(epoch, epoch, epoch, maintenance ? 1 : 0, maintenance ? 1 : 0, limit)
    .all<{ id: string }>();
  for (const { id } of rows.results) {
    if (Date.now() - started >= wall) break;
    const token = crypto.randomUUID();
    const row = await claimMultipartCleanup(env, id, epoch, maintenance, token, started + wall, {
      source,
      fence: verified.fence,
    });
    if (!row) continue;
    result.claimed++;
    const commit = async (kind: SystemMutationKind, statements: () => readonly SqlStatement[]) => {
      const admission = await acquireSystemMutation(env, row.owner_id, kind);
      // Rebuild domain proofs after the wait. A shared grant never extends the binding lease.
      await commitSystemMutation(db, admission, row.owner_id, statements());
    };
    try {
      let scan = await scanRow(db, id);
      if (!scan) throw new Error("multipart_inventory_missing");
      if (
        scan.source !== source ||
        scan.epoch !== epoch ||
        (scan.completed_at !== null && scan.next_scan_at <= Date.now())
      ) {
        const round = crypto.randomUUID();
        try {
          await commit("upload.inventory-reset", () => [
            verified.fence(),
            controlFence(epoch, maintenance),
            multipartCleanupFence(row, token),
            scanFence(scan!),
            {
              sql: `UPDATE multipart_inventory_scans SET source=?,epoch=?,round_id=?,cursor_key=NULL,cursor_upload_id=NULL,
              pages=0,completed_at=NULL,next_scan_at=0,last_token=? WHERE upload_id=?`,
              values: [source, epoch, round, token, id],
            },
            assertOneChange,
          ]);
        } catch {
          const saved = await scanRow(db, id);
          if (
            !saved ||
            saved.round_id !== round ||
            saved.source !== source ||
            saved.epoch !== epoch ||
            saved.last_token !== token
          )
            throw new Error("multipart_inventory_reset_unconfirmed");
        }
        scan = (await scanRow(db, id))!;
      }
      const fences = () => [
        verified.fence(),
        controlFence(epoch, maintenance),
        multipartCleanupFence(row, token),
        scanFence(scan!),
      ];
      const charge = async (handle?: Handle) => {
        const admission = await acquireSystemMutation(
          env,
          row.owner_id,
          "upload.inventory-call",
          started + wall,
        );
        if (Date.now() - started >= wall) throw new Error("multipart_inventory_budget");
        await atomicBatch(
          db,
          systemMutationStatements(admission, row.owner_id, [
            ...fences(),
            {
              sql: "UPDATE uploads SET cleanup_calls=cleanup_calls+1 WHERE id=? AND cleanup_token=?",
              values: [id, token],
            },
            assertOneChange,
            ...(handle
              ? [
                  {
                    sql: `UPDATE multipart_inventory_handles SET attempts=attempts+1,last_attempt_at=MAX(last_attempt_at,${CLOCK}),last_error=NULL
            WHERE id=? AND upload_id=? AND state='observed'`,
                    values: [handle.id, id],
                  },
                  assertOneChange,
                ]
              : []),
          ]),
        );
        // Unknown counter acknowledgement never grants permission to dispatch.
        if (Date.now() - started >= wall) throw new Error("multipart_inventory_budget");
        result.r2Calls++;
      };
      const observeHead = async () => {
        await charge();
        const object = await bucket.head(row.r2_key);
        if (object)
          await commit("upload.inventory-observe", () => [
            ...fences(),
            ...observedObject(row, object),
          ]);
      };

      // Late initialization may reveal the original ID. Retain it alongside every discovered ID.
      if (row.r2_upload_id)
        await commit("upload.inventory-handle", () => [
          ...fences(),
          handleInsert(row, source, row.r2_upload_id!),
        ]);

      if (scan.completed_at === null) {
        // Even unavailable or malformed S3 inventory must not hide a completed object's charge.
        await observeHead();
        await charge();
        const page = await inventory.listMultipartUploads({
          prefix: row.r2_key,
          limit: PAGE_SIZE,
          marker:
            scan.cursor_key === null
              ? null
              : { key: scan.cursor_key, uploadId: scan.cursor_upload_id! },
        });
        const exact = page.uploads.filter((upload) => upload.key === row.r2_key);
        // The S3 operation is a prefix scan. Neighbour keys are never handed to abort.
        const next = page.uploads.some((upload) => upload.key !== row.r2_key) ? null : page.next;
        const statements: SqlStatement[] = [];
        for (const upload of exact) {
          statements.push(
            {
              sql: `INSERT INTO multipart_inventory_handles(id,upload_id,r2_upload_id,first_source,initiated_at,first_seen_at,last_seen_at,last_round_id)
              VALUES(?,?,?,?,?,${CLOCK},${CLOCK},?) ON CONFLICT(upload_id,r2_upload_id) DO UPDATE SET
              last_seen_at=MAX(last_seen_at,excluded.last_seen_at),initiated_at=COALESCE(initiated_at,excluded.initiated_at),last_round_id=excluded.last_round_id
              WHERE state='observed' AND last_round_id IS NOT excluded.last_round_id
                AND (initiated_at IS NULL OR initiated_at=excluded.initiated_at)`,
              values: [
                crypto.randomUUID(),
                id,
                upload.uploadId,
                source,
                upload.initiatedAt,
                scan.round_id,
              ],
            },
            assertOneChange,
          );
        }
        const oldPages = scan.pages;
        statements.push(
          {
            sql: `UPDATE multipart_inventory_scans SET cursor_key=?,cursor_upload_id=?,pages=pages+1,
            completed_at=CASE WHEN ?=1 THEN ${CLOCK} ELSE NULL END,next_scan_at=CASE WHEN ?=1 THEN ${CLOCK}+3600000 ELSE 0 END,
            last_token=? WHERE upload_id=?`,
            values: [
              next?.key ?? null,
              next?.uploadId ?? null,
              next === null ? 1 : 0,
              next === null ? 1 : 0,
              token,
              id,
            ],
          },
          assertOneChange,
        );
        try {
          await commit("upload.inventory-page", () => [...fences(), ...statements]);
        } catch {
          const saved = await scanRow(db, id);
          if (
            !saved ||
            saved.last_token !== token ||
            saved.round_id !== scan.round_id ||
            saved.pages !== oldPages + 1 ||
            saved.source !== source ||
            saved.epoch !== epoch ||
            saved.cursor_key !== (next?.key ?? null) ||
            saved.cursor_upload_id !== (next?.uploadId ?? null) ||
            (saved.completed_at !== null) !== (next === null)
          )
            throw new Error("multipart_inventory_page_unconfirmed");
        }
        result.pages++;
        result.observed += exact.length;
        scan = (await scanRow(db, id))!;
      }

      // Do not invalidate an in-progress S3 cursor by aborting its marker handle between pages.
      let uncertain = false;
      if (scan.completed_at !== null) {
        const handles = await primary(db)
          .prepare(`SELECT id,r2_upload_id FROM multipart_inventory_handles
          WHERE upload_id=? AND state='observed' ORDER BY last_attempt_at,id LIMIT ?`)
          .bind(id, maxHandles)
          .all<Handle>();
        for (const handle of handles.results) {
          if (Date.now() - started >= wall) break;
          await charge(handle);
          try {
            await bucket.resumeMultipartUpload(row.r2_key, handle.r2_upload_id).abort();
          } catch {
            uncertain = true;
            await commit("upload.inventory-error", () => [
              ...fences(),
              {
                sql: "UPDATE multipart_inventory_handles SET last_error='abort_unconfirmed' WHERE id=? AND state='observed'",
                values: [handle.id],
              },
            ]);
            continue;
          }
          try {
            await commit("upload.inventory-abort", () => [
              ...fences(),
              {
                sql: `UPDATE multipart_inventory_handles SET state='aborted',aborted_at=MAX(first_seen_at,${CLOCK}),last_error=NULL WHERE id=? AND state='observed'`,
                values: [handle.id],
              },
              assertOneChange,
            ]);
          } catch {
            const saved = await primary(db)
              .prepare(
                "SELECT 1 FROM multipart_inventory_handles WHERE id=? AND upload_id=? AND r2_upload_id=? AND state='aborted'",
              )
              .bind(handle.id, id, handle.r2_upload_id)
              .first();
            if (!saved) throw new Error("multipart_inventory_abort_unconfirmed");
          }
          result.aborted++;
        }
      }
      await observeHead();
      if (uncertain) throw new Error("multipart_inventory_abort_unconfirmed");
      const pending = await primary(db)
        .prepare(
          "SELECT 1 FROM multipart_inventory_handles WHERE upload_id=? AND state='observed' LIMIT 1",
        )
        .bind(id)
        .first();
      await commit("upload.inventory-release", () => [
        ...fences(),
        {
          sql: `UPDATE uploads SET cleanup_token=NULL,cleanup_lease_expires_at=NULL,cleanup_error='multipart_inventory_closure_required',cleanup_next_at=? WHERE id=? AND cleanup_token=?`,
          values: [scan!.completed_at === null || pending ? 0 : scan!.next_scan_at, id, token],
        },
        assertOneChange,
      ]);
    } catch {
      result.retried++;
      // Keep the lease after unknown I/O. Every partial page and every confirmed abort is durable.
      await commit("upload.inventory-error", () => [
        verified.fence(),
        controlFence(epoch, maintenance),
        {
          sql: "UPDATE uploads SET cleanup_error='multipart_inventory_unconfirmed' WHERE id=? AND cleanup_token=?",
          values: [id, token],
        },
      ]).catch(() => {});
    }
  }
  return result;
}

function handleInsert(
  row: MultipartCleanupCandidate,
  source: string,
  r2UploadId: string,
): SqlStatement {
  return {
    sql: `INSERT INTO multipart_inventory_handles(id,upload_id,r2_upload_id,first_source,first_seen_at,last_seen_at)
    VALUES(?,?,?,?,${CLOCK},${CLOCK}) ON CONFLICT(upload_id,r2_upload_id) DO NOTHING`,
    values: [crypto.randomUUID(), row.id, r2UploadId, source],
  };
}
