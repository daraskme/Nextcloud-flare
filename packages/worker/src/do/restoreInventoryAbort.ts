import { assertExists, assertOneChange, primary, type SqlStatement } from "../db/primary";
import { R2_WRITE_IDENTITY } from "../db/r2Write";
import type { InventoryAbortReconciler } from "../jobs/multipartInventoryRepair";
import type { VerifiedR2Inventory } from "../jobs/r2BindingVerification";
import {
  acquireGlobalMutation,
  commitGlobalMutation,
  type InventoryMutationSource,
} from "../services/globalMutation";
import { acquireSystemMutation, commitSystemMutation } from "../services/systemMutation";
import { type NativeHistory, nativeIdentity } from "./nativeHistory";

interface NativeAbort {
  id: string;
  token: string;
  epoch: number;
  owner_id: string | null;
  kind: string;
  r2_key: string;
  dispatch_before: number;
  started_at: number;
  source_ref: string;
}
const noPending = () =>
  assertExists(`SELECT 1 WHERE NOT EXISTS(SELECT 1 FROM r2_write_attempts WHERE state='pending')
    AND NOT EXISTS(SELECT 1 FROM image_transform_attempts WHERE state='pending')`);

/** An immutable D1 tuple alone is insufficient after rollback: require the independent native history. */
async function successProof(
  history: NativeHistory,
  row: NativeAbort | null,
  current: () => void,
): Promise<{ identity: ArrayBuffer; fence: SqlStatement } | null> {
  current();
  if (!row) return null;
  const values = [
    row.id,
    row.token,
    row.epoch,
    row.owner_id,
    row.kind,
    row.r2_key,
    row.dispatch_before,
    row.started_at,
    row.source_ref,
  ];
  const identity = await nativeIdentity("r2", values);
  current();
  const saved = history.find(identity);
  if (saved?.outcome !== "succeeded" || saved.deadline !== row.dispatch_before) return null;
  return {
    identity,
    fence: assertExists(
      `SELECT 1 FROM r2_write_attempts WHERE ${R2_WRITE_IDENTITY} AND state='succeeded'`,
      values,
    ),
  };
}

/** Replay the same operator attempt without changing its original diagnostic or sending another abort. */
export async function reconcileRestoredBucketAbort(
  history: NativeHistory,
  env: InventoryMutationSource,
  verified: VerifiedR2Inventory,
  handleId: string,
  attemptId: string,
  epoch: number,
  stop: SqlStatement,
  current: () => void,
  deadline: number,
): Promise<boolean> {
  current();
  const source = JSON.stringify(verified.observation.source);
  const query = `SELECT 1 FROM multipart_bucket_abort_attempts a
    JOIN multipart_bucket_handles h ON h.id=a.handle_id
    WHERE a.id=? AND a.handle_id=? AND a.epoch<=? AND a.outcome IN ('started','unconfirmed')
    AND h.source=? AND h.state='quarantined'`;
  const values = [attemptId, handleId, epoch, source];
  const row = await primary(env.DB)
    .prepare(`SELECT r.* FROM r2_write_attempts r
      JOIN multipart_bucket_abort_attempts a ON a.id=? AND a.epoch=r.epoch
      JOIN multipart_bucket_handles h ON h.id=a.handle_id
      WHERE a.handle_id=? AND a.epoch<=? AND a.outcome IN ('started','unconfirmed')
      AND h.source=? AND h.state='quarantined' AND r.kind='bucket.abort'
      AND r.owner_id IS NULL AND r.r2_key=h.r2_key AND r.state='succeeded'
      AND r.source_ref=json_array('bucket',h.id,a.id,NULL)`)
    .bind(...values)
    .first<NativeAbort>();
  const proof = await successProof(history, row, current);
  if (!proof || !row) return false;
  const admission = await acquireGlobalMutation(env, "bucket.abort-reconcile", deadline);
  current();
  await commitGlobalMutation(env.DB, admission, [
    stop,
    verified.fence(),
    noPending(),
    proof.fence,
    assertExists(query, values),
    {
      sql: `INSERT INTO multipart_bucket_abort_reconciliations(attempt_id,native_id,native_identity,epoch,reconciled_at)
        VALUES(?,?,?,?,strftime('%s','now')*1000)`,
      values: [attemptId, row.id, proof.identity, epoch],
    },
    assertOneChange,
  ]);
  current();
  return true;
}

/** The handle identity survives a new cleanup token/scan round; recover its earlier actual abort. */
export function restoredInventoryAbortReconciler(
  history: NativeHistory,
  env: InventoryMutationSource,
  epoch: number,
  stop: SqlStatement,
  current: () => void,
): InventoryAbortReconciler {
  return async (verified, upload, handle, fences, deadline) => {
    current();
    const source = JSON.stringify(verified.observation.source);
    const row = await primary(env.DB)
      .prepare(`SELECT r.* FROM r2_write_attempts r
        WHERE r.kind='multipart.abort' AND r.r2_key=? AND r.owner_id=? AND r.state='succeeded'
        AND r.epoch>=? AND r.epoch<=? AND json_valid(r.source_ref)
        AND json_extract(r.source_ref,'$[1]')=? AND json_extract(r.source_ref,'$[3]')=?
        AND r.source_ref=json_array('inventory',?,json_extract(r.source_ref,'$[2]'),?)
        ORDER BY r.epoch DESC,r.started_at DESC,r.id LIMIT 1`)
      .bind(
        upload.r2_key,
        upload.owner_id,
        upload.epoch,
        epoch,
        upload.id,
        handle.id,
        upload.id,
        handle.id,
      )
      .first<NativeAbort>();
    const proof = await successProof(history, row, current);
    if (!proof || !row) {
      if (row) throw new Error("database_restore_inventory_abort_unconfirmed");
      return false;
    }
    const admission = await acquireSystemMutation(
      env,
      upload.owner_id,
      "upload.inventory-abort",
      deadline,
    );
    current();
    await commitSystemMutation(env.DB, admission, upload.owner_id, [
      stop,
      ...fences(),
      noPending(),
      proof.fence,
      assertExists(
        `SELECT 1 FROM multipart_inventory_handles h
        JOIN multipart_inventory_scans s ON s.upload_id=h.upload_id
        WHERE h.id=? AND h.upload_id=? AND h.r2_upload_id=? AND h.first_source=?
        AND s.source=? AND s.r2_key=? AND s.epoch=? AND s.completed_at IS NOT NULL
        AND h.state='observed' AND h.attempts>0 AND h.abort_source=? AND h.abort_token=?`,
        [
          handle.id,
          upload.id,
          handle.r2_upload_id,
          source,
          source,
          upload.r2_key,
          epoch,
          source,
          JSON.parse(row.source_ref)[2],
        ],
      ),
      {
        sql: `UPDATE multipart_inventory_handles SET state='aborted',
          aborted_at=MAX(first_seen_at,strftime('%s','now')*1000),last_error=NULL WHERE id=? AND state='observed'`,
        values: [handle.id],
      },
      assertOneChange,
    ]);
    current();
    return true;
  };
}
