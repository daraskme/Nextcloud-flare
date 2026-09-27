import type { RestoreDomainKind } from "../../../shared/src/restoreDomain";
import { assertExists, atomicBatch, primary } from "../db/primary";
import { drainStoppedBlobGarbageCollection, type GcResult } from "../jobs/gc";
import { repairMultipartUploads } from "../jobs/multipartCleanup";
import {
  drainStoppedOrphanGarbageCollection,
  type OrphanGcResult,
  type OrphanScanResult,
  scanOrphanObjects,
} from "../jobs/orphanInventory";
import { repairSingleUploads, type UploadCleanupResult } from "../jobs/uploadCleanup";
import type { ControlDO } from "./ControlDO";
import { NativeHistory } from "./nativeHistory";
import { failStaleRecoveryOutbox, releaseStaleRecoveryReservations } from "./recoveryAudit";
import { reconcileRestoredMultipartAbort } from "./restoreMultipartAbort";

type DomainRepairResult =
  | { cleanup: UploadCleanupResult; held: number }
  | { cleanup: GcResult | OrphanGcResult }
  | { inventory: OrphanScanResult }
  | { released: number }
  | { failed: number };
export type RestoreDomainRepairStatus = {
  kind: RestoreDomainKind;
  pending: boolean;
} & DomainRepairResult;
export type RestoreDomainControl = Pick<
  ControlDO,
  "status" | "acquireSystemMutation" | "acquireGlobalMutation" | "beginR2Write" | "finishR2Write"
>;
const REMAINING: Record<RestoreDomainKind, string> = {
  single:
    "SELECT 1 FROM uploads WHERE mode='single' AND (state NOT IN ('completed','expired','aborted','failed') OR cleanup_pending=1 OR cleanup_token IS NOT NULL)",
  multipart:
    "SELECT 1 FROM uploads WHERE mode='multipart' AND (state NOT IN ('completed','expired','aborted','failed') OR cleanup_pending=1 OR cleanup_token IS NOT NULL OR (state<>'completed' AND multipart_cleanup_closed IS NULL))",
  reservations: "SELECT 1 FROM reservations WHERE state='reserved'",
  outbox: "SELECT 1 FROM outbox WHERE state IN ('pending','dispatching','sent')",
  "blob-gc": "SELECT 1 FROM gc_candidates WHERE state='deleting'",
  "orphan-gc": "SELECT 1 FROM orphan_objects WHERE state='deleting'",
  // Page completion is checked separately; quarantined objects remain charged for normal GC.
  "orphan-inventory": "SELECT 1 WHERE 0",
};

/** One bounded maintenance pass. Unknown native execution must be resolved separately. */
export async function repairRestoredDomain(
  sql: SqlStorage,
  db: D1Database,
  bucket: R2Bucket,
  control: RestoreDomainControl,
  kind: RestoreDomainKind,
  limit: number,
  transition: { epoch: number; revision: number; token: string },
  current: () => void,
): Promise<RestoreDomainRepairStatus> {
  const { epoch, revision, token } = transition;
  const stopQuery = `SELECT 1 FROM control WHERE singleton=1 AND epoch=? AND maintenance=1
    AND gc_paused=1 AND admission_revision=? AND admission_token=?
    AND backup_token IS NULL AND backup_frozen=0 AND restore_freeze_token IS NULL`,
    stopValues = [epoch, revision, token],
    stop = assertExists(stopQuery, stopValues);
  current();
  try {
    await atomicBatch(db, [
      stop,
      assertExists(`SELECT 1 WHERE
    NOT EXISTS(SELECT 1 FROM kdf_attempts WHERE state='claimed')
    AND NOT EXISTS(SELECT 1 FROM r2_write_attempts WHERE state='pending')`),
    ]);
  } catch {
    current();
    throw new Error("database_restore_domain_preflight_pending");
  }
  current();
  const source = {
    DB: db,
    systemControl: {
      status: async () => {
        current();
        const result = await control.status();
        current();
        return result;
      },
      acquireSystemMutation: async (input: Parameters<ControlDO["acquireSystemMutation"]>[0]) => {
        current();
        const result = await control.acquireSystemMutation(input);
        current();
        return result;
      },
      acquireGlobalMutation: async (input: Parameters<ControlDO["acquireGlobalMutation"]>[0]) => {
        current();
        const result = await control.acquireGlobalMutation(input);
        current();
        return result;
      },
      beginR2Write: async (input: Parameters<ControlDO["beginR2Write"]>[0]) => {
        current();
        const grant = await control.beginR2Write(input);
        try {
          current();
        } catch (error) {
          // This wrapper did not return the grant, so no caller could dispatch it.
          try {
            await control.finishR2Write(grant, "not_started");
          } catch {
            /* keep proof */
          }
          throw error;
        }
        return grant;
      },
      // Actual late native completion must still be recorded after the request loses its stop.
      finishR2Write: (
        grant: Parameters<ControlDO["finishR2Write"]>[0],
        outcome: Parameters<ControlDO["finishR2Write"]>[1],
      ) => control.finishR2Write(grant, outcome),
    },
  };
  const guardedBucket = {
    list: async (options: R2ListOptions) => {
      current();
      const page = await bucket.list(options);
      current();
      return page;
    },
    head: async (key: string) => {
      current();
      const object = await bucket.head(key);
      current();
      return object;
    },
    resumeMultipartUpload: (key: string, id: string) => bucket.resumeMultipartUpload(key, id),
    // Dispatch is guarded by trackedR2Write; preserve actual late completion for settlement.
    delete: (key: string) => bucket.delete(key),
  } as R2Bucket;
  let result: DomainRepairResult;
  if (kind === "single")
    result = {
      cleanup: await repairSingleUploads(source, guardedBucket, epoch, {
        maxUploads: limit,
        maintenance: true,
      }),
      held: 0,
    };
  else if (kind === "multipart") {
    let held = 0;
    const history = new NativeHistory(sql);
    const cleanup = await repairMultipartUploads(source, guardedBucket, epoch, {
      maxUploads: limit,
      maintenance: true,
      current,
      beforeClaim: async (id, deadline) => {
        const proof = await reconcileRestoredMultipartAbort(
          history,
          source,
          id,
          epoch,
          stop,
          current,
          deadline,
        );
        if (proof === false) held++;
        return proof;
      },
    });
    result = { cleanup, held };
  } else if (kind === "reservations")
    result = { released: await releaseStaleRecoveryReservations(source, epoch, limit) };
  else if (kind === "outbox")
    result = { failed: await failStaleRecoveryOutbox(source, epoch, limit) };
  else if (kind === "blob-gc")
    result = {
      cleanup: await drainStoppedBlobGarbageCollection(source, guardedBucket, epoch, {
        maxBlobs: limit,
        current,
      }),
    };
  else if (kind === "orphan-gc")
    result = {
      cleanup: await drainStoppedOrphanGarbageCollection(source, guardedBucket, epoch, {
        limit,
        current,
      }),
    };
  else
    result = {
      inventory: await scanOrphanObjects(source, guardedBucket, epoch, {
        limit,
        maintenance: true,
      }),
    };
  current();
  const saved = await primary(db)
    .prepare(`SELECT EXISTS (${REMAINING[kind]}) AS pending FROM control
    WHERE singleton=1 AND EXISTS (${stopQuery})`)
    .bind(...stopValues)
    .first<{ pending: 0 | 1 }>();
  current();
  if (!saved) throw new Error("database_restore_recovery_conflict");
  const pending =
    saved.pending === 1 ||
    ("inventory" in result && (!result.inventory.advanced || !result.inventory.completed));
  return { kind, ...result, pending };
}
