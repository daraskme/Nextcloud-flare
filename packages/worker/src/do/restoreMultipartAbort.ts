import {
  assertExists,
  assertOneChange,
  type BindValue,
  primary,
  type SqlStatement,
} from "../db/primary";
import { R2_WRITE_IDENTITY } from "../db/r2Write";
import { MULTIPART_CLEANUP_ELIGIBLE } from "../jobs/multipartCleanup";
import {
  acquireSystemMutation,
  commitSystemMutation,
  type SystemMutationSource,
} from "../services/systemMutation";
import { type NativeHistory, nativeIdentity } from "./nativeHistory";

interface Upload {
  id: string;
  owner_id: string;
  blob_id: string;
  epoch: number;
  r2_key: string;
  r2_upload_id: string | null;
  cleanup_token: string | null;
  multipart_cleanup_started_at: number | null;
  multipart_cleanup_closed: "aborted" | "completed" | null;
}
interface Abort {
  id: string;
  token: string;
  epoch: number;
  owner_id: string;
  kind: string;
  r2_key: string;
  dispatch_before: number;
  started_at: number;
  source_ref: string;
  state: "succeeded" | "not_started";
}
const ELIGIBLE = `${MULTIPART_CLEANUP_ELIGIBLE}
  AND NOT EXISTS(SELECT 1 FROM multipart_inventory_scans WHERE upload_id=u.id)`;

/** Resolve the previous cleanup before its token can be replaced. Never dispatches native I/O. */
export async function reconcileRestoredMultipartAbort(
  history: NativeHistory,
  env: SystemMutationSource,
  id: string,
  epoch: number,
  stop: SqlStatement,
  current: () => void,
  deadline: number,
): Promise<SqlStatement | false> {
  current();
  const row = await primary(env.DB)
    .prepare(`SELECT u.id,u.owner_id,u.blob_id,u.epoch,b.r2_key,
    u.r2_upload_id,u.cleanup_token,u.multipart_cleanup_started_at,u.multipart_cleanup_closed
    FROM uploads u JOIN blobs b ON b.id=u.blob_id WHERE u.id=? AND u.epoch<=? AND ${ELIGIBLE}`)
    .bind(id, epoch, epoch)
    .first<Upload>();
  current();
  if (!row) return false;
  const match = (closed = row.multipart_cleanup_closed) => ({
    query: `SELECT 1 FROM uploads u JOIN blobs b ON b.id=u.blob_id
      WHERE u.id=? AND u.owner_id=? AND u.blob_id=? AND u.epoch=? AND b.r2_key=?
      AND u.r2_upload_id IS ? AND u.cleanup_token IS ?
      AND u.multipart_cleanup_started_at IS ? AND u.multipart_cleanup_closed IS ? AND ${ELIGIBLE}`,
    values: [
      row.id,
      row.owner_id,
      row.blob_id,
      row.epoch,
      row.r2_key,
      row.r2_upload_id,
      row.cleanup_token,
      row.multipart_cleanup_started_at,
      closed,
      epoch,
    ] satisfies BindValue[],
  });
  const prior = match();
  if (row.multipart_cleanup_closed !== null || row.multipart_cleanup_started_at === null)
    return assertExists(prior.query, prior.values);
  const receipt =
    row.r2_upload_id && row.cleanup_token
      ? await primary(env.DB)
          .prepare(
            `SELECT * FROM r2_write_attempts WHERE kind='multipart.abort' AND source_ref=?
      AND owner_id=? AND r2_key=? AND epoch>=? AND epoch<=? AND state IN ('succeeded','not_started')`,
          )
          .bind(
            JSON.stringify(["cleanup", row.id, row.cleanup_token, null]),
            row.owner_id,
            row.r2_key,
            row.epoch,
            epoch,
          )
          .first<Abort>()
      : null;
  current();
  const values = receipt
    ? [
        receipt.id,
        receipt.token,
        receipt.epoch,
        receipt.owner_id,
        receipt.kind,
        receipt.r2_key,
        receipt.dispatch_before,
        receipt.started_at,
        receipt.source_ref,
      ]
    : [];
  const identity = receipt ? await nativeIdentity("r2", values) : null;
  current();
  const proof = identity ? history.find(identity) : undefined;
  if (!receipt || proof?.outcome !== receipt.state || proof.deadline !== receipt.dispatch_before) {
    // Preserve the original token for later proof. Backoff lets a later page reach other uploads.
    const admission = await acquireSystemMutation(
      env,
      row.owner_id,
      "upload.cleanup-error",
      deadline,
    );
    current();
    await commitSystemMutation(env.DB, admission, row.owner_id, [
      stop,
      assertExists(prior.query, prior.values),
      {
        sql: "UPDATE uploads SET cleanup_next_at=strftime('%s','now')*1000+60000,cleanup_error='multipart_cleanup_unconfirmed' WHERE id=?",
        values: [row.id],
      },
      assertOneChange,
    ]);
    current();
    return false;
  }
  const endedQuery = `SELECT 1 FROM r2_write_attempts WHERE ${R2_WRITE_IDENTITY} AND state=?`,
    endedValues = [...values, receipt.state],
    ended = assertExists(endedQuery, endedValues);
  if (receipt.state === "not_started")
    return assertExists(`${prior.query} AND EXISTS (${endedQuery})`, [
      ...prior.values,
      ...endedValues,
    ]);
  const admission = await acquireSystemMutation(
    env,
    row.owner_id,
    "upload.cleanup-close",
    deadline,
  );
  current();
  const closed = match("aborted");
  try {
    await commitSystemMutation(env.DB, admission, row.owner_id, [
      stop,
      ended,
      assertExists(prior.query, prior.values),
      { sql: "UPDATE uploads SET multipart_cleanup_closed='aborted' WHERE id=?", values: [row.id] },
      assertOneChange,
    ]);
  } catch {
    // Only the same native proof and exact closed upload can recover an unknown DB reply.
  }
  current();
  if (
    !(await primary(env.DB)
      .prepare(closed.query)
      .bind(...closed.values)
      .first())
  )
    throw new Error("database_restore_multipart_close_unconfirmed");
  current();
  return assertExists(`${closed.query} AND EXISTS (${endedQuery})`, [
    ...closed.values,
    ...endedValues,
  ]);
}
