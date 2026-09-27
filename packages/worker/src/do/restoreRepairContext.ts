import { assertExists, atomicBatch } from "../db/primary";
import type { ControlDO } from "./ControlDO";

export type RestoreRepairControl = Pick<
  ControlDO,
  "status" | "acquireSystemMutation" | "acquireGlobalMutation" | "beginR2Write" | "finishR2Write"
>;

/** Shared request-stop guards. Only actual native completion may outlive this scope. */
export async function restoreRepairContext(
  db: D1Database,
  bucket: R2Bucket,
  control: RestoreRepairControl,
  transition: { epoch: number; revision: number; token: string },
  current: () => void,
) {
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
    get: async (key: string) => {
      current();
      const object = await bucket.get(key);
      try {
        current();
      } catch (error) {
        if (object) void object.body.cancel().catch(() => {});
        throw error;
      }
      return object;
    },
    put: (key: string, value: string, options: R2PutOptions) => bucket.put(key, value, options),
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
  return { source, bucket: guardedBucket, stop, stopQuery, stopValues };
}
