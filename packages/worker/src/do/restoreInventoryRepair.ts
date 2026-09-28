import { type RestoreBlobsTarget, restoreBlobsTarget } from "../../../shared/src/restoreBlobs";
import type { RestoreInventoryRequest } from "../../../shared/src/restoreInventory";
import { primary } from "../db/primary";
import type { Env } from "../env";
import {
  abortMultipartBucketHandle,
  type MultipartBucketAbortResult,
} from "../jobs/multipartBucketAbort";
import {
  type MultipartBucketScanResult,
  type MultipartPartObservationResult,
  observeMultipartBucketParts,
  scanMultipartBucket,
} from "../jobs/multipartBucketInventory";
import {
  type MultipartInventoryRepairResult,
  repairUnidentifiedMultipartUploads,
} from "../jobs/multipartInventoryRepair";
import {
  type BindingVerificationScope,
  withVerifiedR2Inventory,
} from "../jobs/r2BindingVerification";
import { R2S3Inventory } from "../r2/s3Inventory";
import { NativeHistory } from "./nativeHistory";
import {
  reconcileRestoredBucketAbort,
  restoredInventoryAbortReconciler,
} from "./restoreInventoryAbort";
import { type RestoreRepairControl, restoreRepairContext } from "./restoreRepairContext";

type InventoryResult =
  | { verification: { bindingVerified: true; verifiedAt: number } }
  | { uploads: MultipartInventoryRepairResult }
  | { bucket: MultipartBucketScanResult }
  | { parts: MultipartPartObservationResult }
  | { abort: MultipartBucketAbortResult };
export type RestoreInventoryStatus = {
  action: RestoreInventoryRequest["action"];
  pending: boolean;
} & InventoryResult;

/** One request-bound inventory operation. Empty listings and abort ACKs never release holds. */
export async function repairRestoredInventory(
  sql: SqlStorage,
  env: Env,
  control: RestoreRepairControl,
  request: RestoreInventoryRequest,
  target: RestoreBlobsTarget,
  transition: { epoch: number; revision: number; token: string },
  stopped: () => void,
): Promise<RestoreInventoryStatus> {
  const started = Date.now(),
    deadline = started + 25000;
  let active = true,
    timer: ReturnType<typeof setTimeout> | undefined;
  const current = () => {
    stopped();
    if (!active || Date.now() < started || Date.now() >= deadline)
      throw new Error("database_restore_inventory_timeout");
  };
  const run = async () => {
    const { source, bucket, stop, stopQuery, stopValues } = await restoreRepairContext(
      env.DB,
      env.BLOBS,
      control,
      transition,
      current,
    );
    const inventory = new R2S3Inventory(env, {
      fetch: async (req) => {
        current();
        const response = await fetch(req);
        try {
          current();
        } catch (error) {
          void response.body?.cancel().catch(() => {});
          throw error;
        }
        return response;
      },
    });
    if (
      JSON.stringify(restoreBlobsTarget(inventory.source)) !==
      JSON.stringify(restoreBlobsTarget(target))
    )
      throw new Error("database_restore_inventory_target_mismatch");
    const scope: BindingVerificationScope = {
      stop: { revision: transition.revision, token: transition.token, expiresAt: deadline },
      current,
      fence: () => {
        current();
        return stop;
      },
    };
    const epoch = transition.epoch;
    const history = new NativeHistory(sql);
    let result: InventoryResult;
    if (request.action === "verify")
      result = {
        verification: await withVerifiedR2Inventory(
          source,
          bucket,
          inventory,
          epoch,
          async (verified) => ({
            bindingVerified: true as const,
            verifiedAt: verified.observation.verifiedAt,
          }),
          scope,
        ),
      };
    else if (request.action === "uploads")
      result = {
        uploads: await repairUnidentifiedMultipartUploads(source, bucket, inventory, epoch, {
          maxUploads: request.limit,
          scope,
          reconcileAbort: restoredInventoryAbortReconciler(history, source, epoch, stop, current),
        }),
      };
    else if (request.action === "bucket")
      result = {
        bucket: await scanMultipartBucket(source, bucket, inventory, epoch, request.limit, scope),
      };
    else if (request.action === "parts")
      result = {
        parts: await observeMultipartBucketParts(
          source,
          bucket,
          inventory,
          epoch,
          request.handleId,
          request.limit,
          scope,
        ),
      };
    else
      result = {
        abort: await abortMultipartBucketHandle(
          source,
          bucket,
          inventory,
          epoch,
          request.handleId,
          request.attemptId,
          {
            scope,
            reconcile: (verified, abortDeadline) =>
              reconcileRestoredBucketAbort(
                history,
                source,
                verified,
                request.handleId,
                request.attemptId,
                epoch,
                stop,
                current,
                Math.min(deadline, abortDeadline),
              ),
          },
        ),
      };
    current();
    const saved = await primary(env.DB)
      .prepare(`SELECT (
      EXISTS(SELECT 1 FROM multipart_inventory_scans)
      OR EXISTS(SELECT 1 FROM uploads WHERE mode='multipart' AND r2_upload_id IS NULL AND state<>'completed' AND multipart_cleanup_closed IS NULL)
      OR EXISTS(SELECT 1 FROM multipart_bucket_scan WHERE completed_at IS NULL OR epoch<>? OR source<>?)
      OR EXISTS(SELECT 1 FROM multipart_bucket_handles h WHERE state='quarantined' OR source<>? OR NOT EXISTS(SELECT 1 FROM uploads u JOIN blobs b ON b.id=u.blob_id WHERE b.r2_key=h.r2_key AND u.r2_upload_id=h.r2_upload_id))
      OR EXISTS(SELECT 1 FROM r2_write_attempts WHERE state='pending')
      OR EXISTS(SELECT 1 FROM image_transform_attempts WHERE state='pending')
    ) AS pending FROM control WHERE singleton=1 AND EXISTS (${stopQuery})`)
      .bind(
        epoch,
        JSON.stringify(inventory.source),
        JSON.stringify(inventory.source),
        ...stopValues,
      )
      .first<{ pending: 0 | 1 }>();
    current();
    if (!saved) throw new Error("database_restore_recovery_conflict");
    return {
      action: request.action,
      ...result,
      pending:
        saved.pending === 1 ||
        ("bucket" in result && !result.bucket.completed) ||
        ("parts" in result && !result.parts.completed) ||
        ("abort" in result && result.abort.outcome === "unconfirmed"),
    };
  };
  try {
    return await Promise.race([
      run(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          active = false;
          reject(new Error("database_restore_inventory_timeout"));
        }, 25000);
      }),
    ]);
  } catch (error) {
    if (error instanceof Error && /^database_restore_[a-z_]+$/.test(error.message)) throw error;
    throw new Error(
      error instanceof Error && error.message === "s3_inventory_unconfigured"
        ? "database_restore_inventory_unconfigured"
        : "database_restore_inventory_unconfirmed",
    );
  } finally {
    active = false;
    clearTimeout(timer);
  }
}
