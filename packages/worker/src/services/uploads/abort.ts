import { authorizationAssertion, type Principal } from "../../auth/authorize";
import type { UploadCapabilities } from "../../auth/uploadCapability";
import { assertExists, assertOneChange, atomicBatch } from "../../db/primary";
import { accessUpload, uploadFence, uploadRow, uploadStatus } from "./access";

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
