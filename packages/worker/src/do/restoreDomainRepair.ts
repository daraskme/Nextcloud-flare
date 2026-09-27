import type { RestoreDomainKind } from "../../../shared/src/restoreDomain";
import { assertExists, atomicBatch, primary } from "../db/primary";
import { repairMultipartUploads } from "../jobs/multipartCleanup";
import { repairSingleUploads, type UploadCleanupResult } from "../jobs/uploadCleanup";
import type { ControlDO } from "./ControlDO";
import { NativeHistory } from "./nativeHistory";
import { failStaleRecoveryOutbox, releaseStaleRecoveryReservations } from "./recoveryAudit";
import { reconcileRestoredMultipartAbort } from "./restoreMultipartAbort";

type DomainRepairResult =
  | { cleanup: UploadCleanupResult; held: number }
  | { released: number }
  | { failed: number };
export type RestoreDomainRepairStatus = {
  kind: RestoreDomainKind;
  pending: boolean;
} & DomainRepairResult;
export type RestoreDomainControl = Pick<
  ControlDO,
  "status" | "acquireSystemMutation" | "beginR2Write" | "finishR2Write"
>;
const REMAINING: Record<RestoreDomainKind, string> = {
  single:
    "SELECT 1 FROM uploads WHERE mode='single' AND (state NOT IN ('completed','expired','aborted','failed') OR cleanup_pending=1 OR cleanup_token IS NOT NULL)",
  multipart:
    "SELECT 1 FROM uploads WHERE mode='multipart' AND (state NOT IN ('completed','expired','aborted','failed') OR cleanup_pending=1 OR cleanup_token IS NOT NULL OR (state<>'completed' AND multipart_cleanup_closed IS NULL))",
  reservations: "SELECT 1 FROM reservations WHERE state='reserved'",
  outbox: "SELECT 1 FROM outbox WHERE state IN ('pending','dispatching','sent')",
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
    head: async (key: string) => {
      current();
      const object = await bucket.head(key);
      current();
      return object;
    },
    resumeMultipartUpload: (key: string, id: string) => bucket.resumeMultipartUpload(key, id),
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
  else result = { failed: await failStaleRecoveryOutbox(source, epoch, limit) };
  current();
  const saved = await primary(db)
    .prepare(`SELECT EXISTS (${REMAINING[kind]}) AS pending FROM control
    WHERE singleton=1 AND EXISTS (${stopQuery})`)
    .bind(...stopValues)
    .first<{ pending: 0 | 1 }>();
  current();
  if (!saved) throw new Error("database_restore_recovery_conflict");
  return { kind, ...result, pending: saved.pending === 1 };
}
