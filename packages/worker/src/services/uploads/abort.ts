import { authorizationAssertion, type Principal } from "../../auth/authorize";
import type { UploadCapabilities } from "../../auth/uploadCapability";
import { assertExists, assertOneChange, atomicBatch } from "../../db/primary";
import { accessUpload, uploadFence, uploadReceiptFence, uploadRow, uploadStatus } from "./access";
import { readUpload } from "./read";

/** D1 is the dispatch/publication fence, including initialization without a known R2 ID. */
export async function abortMultipartUpload(
  db: D1Database,
  principal: Principal,
  id: string,
  token: string,
  capabilities: UploadCapabilities,
) {
  const { row, authorized } = await accessUpload(
    db,
    principal,
    id,
    token,
    capabilities,
    false,
    "receipt",
  );
  if (row.mode !== "multipart") throw new Error("upload_mode_conflict");
  if (["completing", "completed"].includes(row.state)) throw new Error("upload_abort_conflict");
  if (["created", "uploading"].includes(row.state)) {
    try {
      await atomicBatch(db, [
        authorizationAssertion(authorized),
        uploadReceiptFence(row),
        {
          sql: `UPDATE uploads SET state='aborting',accept_parts=0,cleanup_pending=1,
            error_code='upload_aborted',control_calls=control_calls+1
            WHERE id=? AND state IN ('created','uploading') AND multipart_cleanup_started_at IS NULL`,
          values: [id],
        },
        assertOneChange,
      ]);
    } catch (error) {
      // Re-read authorization and terminal state before accepting a lost acknowledgement.
      const current = await readUpload(db, principal, id, token, capabilities);
      if (["completing", "completed"].includes(current.state))
        throw new Error("upload_abort_conflict");
      if (!["aborting", "aborted", "expired", "failed"].includes(current.state)) throw error;
      return current;
    }
  }
  // Reservations survive until independently fenced R2 cleanup. Late part/initialize replies
  // may still carry external facts; no new part/complete dispatch may pass the stopped D1 state.
  return readUpload(db, principal, id, token, capabilities);
}

/** Stop publication first. R2 outcome/cleanup remains durable even if an old PUT finishes late. */
export async function abortSingleUpload(
  db: D1Database,
  principal: Principal,
  id: string,
  token: string,
  capabilities: UploadCapabilities,
) {
  const { row, authorized } = await accessUpload(db, principal, id, token, capabilities, false);
  if (row.state === "aborted") return uploadStatus(row);
  if (row.mode !== "single" || !["created", "receiving"].includes(row.state))
    throw new Error("upload_abort_conflict");
  await atomicBatch(db, [
    authorizationAssertion(authorized),
    uploadFence(row, ["created", "receiving"]),
    {
      sql: `UPDATE uploads SET state='aborted',accept_parts=0,cleanup_pending=1,
      control_calls=control_calls+1,error_code='upload_aborted' WHERE id=? AND state IN ('created','receiving')`,
      values: [id],
    },
    assertOneChange,
    {
      sql: "UPDATE blobs SET state='orphan' WHERE id=? AND state='staging'",
      values: [row.blob_id],
    },
    assertOneChange,
    {
      // A receiving write may still finish. Its reservation survives until expiry repair.
      // Inspect the attempt inside this batch: a claim may have raced the preflight read.
      sql: `UPDATE reservations SET state='released' WHERE id=? AND state='reserved'
        AND EXISTS(SELECT 1 FROM uploads WHERE id=? AND write_attempt_id IS NULL)`,
      values: [row.reservation_id, id],
    },
    assertExists(
      `SELECT 1 FROM reservations r JOIN uploads u ON u.reservation_id=r.id
      WHERE u.id=? AND r.state=CASE WHEN u.write_attempt_id IS NULL THEN 'released' ELSE 'reserved' END`,
      [id],
    ),
  ]);
  return uploadStatus((await uploadRow(db, id))!);
}
