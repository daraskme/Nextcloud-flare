import type { RestoreDomainKind } from "../../../shared/src/restoreDomain";
import { primary } from "../db/primary";
import { drainStoppedBlobGarbageCollection, type GcResult } from "../jobs/gc";
import { repairMultipartUploads } from "../jobs/multipartCleanup";
import {
  drainStoppedOrphanGarbageCollection,
  type OrphanGcResult,
  type OrphanScanResult,
  scanOrphanObjects,
} from "../jobs/orphanInventory";
import { repairSingleUploads, type UploadCleanupResult } from "../jobs/uploadCleanup";
import { NativeHistory } from "./nativeHistory";
import { failStaleRecoveryOutbox, releaseStaleRecoveryReservations } from "./recoveryAudit";
import { reconcileRestoredMultipartAbort } from "./restoreMultipartAbort";
import { type RestoreRepairControl, restoreRepairContext } from "./restoreRepairContext";

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
  control: RestoreRepairControl,
  kind: RestoreDomainKind,
  limit: number,
  transition: { epoch: number; revision: number; token: string },
  current: () => void,
): Promise<RestoreDomainRepairStatus> {
  const { epoch } = transition;
  const {
    source,
    bucket: guardedBucket,
    stop,
    stopQuery,
    stopValues,
  } = await restoreRepairContext(db, bucket, control, transition, current);
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
