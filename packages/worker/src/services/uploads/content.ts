import { authorizationAssertion, type Principal } from "../../auth/authorize";
import type { UploadCapabilities } from "../../auth/uploadCapability";
import { assertExists, assertOneChange, atomicBatch } from "../../db/primary";
import type { Env } from "../../env";
import { consumeKnownLength } from "../../platform/stream";
import {
  accountMutationStatements,
  acquireAccountMutation,
  commitAccountMutation,
} from "../accountMutation";
import { observePhysicalObject } from "../physical";
import { accessUpload, type UploadRow, uploadFence, uploadRow, uploadStatus } from "./access";

function metadata(row: UploadRow) {
  return {
    upload_id: row.id,
    attempt_id: row.write_attempt_id!,
    epoch: String(row.epoch),
    blob_id: row.blob_id,
  };
}
function matches(row: UploadRow, object: R2Object) {
  return (
    object.size === row.declared_size &&
    Object.entries(metadata(row)).every(([key, value]) => object.customMetadata?.[key] === value)
  );
}

/** A replay may inspect the one immutable write, but can never dispatch another PUT. */
async function recoverBody(env: Pick<Env, "DB" | "BLOBS">, row: UploadRow): Promise<string> {
  const key = `u/${row.owner_id}/b/${row.blob_id}`;
  const object = await env.BLOBS.get(key);
  if (!object) throw new Error("upload_content_pending");
  if (!matches(row, object)) {
    await object.body.cancel();
    throw new Error("upload_object_mismatch");
  }
  const result = await consumeKnownLength(object.body, row.declared_size, (stream) =>
    stream.pipeTo(new WritableStream<Uint8Array>({ write() {} })),
  );
  return result.sha256;
}

export async function writeSingleUpload(
  env: Pick<Env, "DB" | "BLOBS" | "CONTROL">,
  principal: Principal,
  id: string,
  capability: string,
  capabilities: UploadCapabilities,
  body: ReadableStream<Uint8Array>,
  size: number,
) {
  let { row, authorized } = await accessUpload(env.DB, principal, id, capability, capabilities);
  if (row.mode !== "single" || size !== row.declared_size) throw new Error("upload_size_mismatch");
  if (row.state === "completing" || row.state === "completed") return uploadStatus(row);
  if (row.state !== "created" && row.state !== "receiving") throw new Error("upload_not_receiving");
  const attempt = crypto.randomUUID();
  const leaseExpires = Math.min(Date.now() + 900000, row.expires_at);
  let dispatch = false;
  if (row.state === "created") {
    const admission = await acquireAccountMutation(
      env,
      row.owner_id,
      row.epoch,
      "upload.single-start",
    );
    try {
      await atomicBatch(
        env.DB,
        accountMutationStatements(admission, row.owner_id, [
          authorizationAssertion(authorized),
          uploadFence(row, ["created"]),
          {
            sql: `UPDATE uploads SET state='receiving',write_attempt_id=?,write_lease_expires_at=?,
          in_flight=1,data_calls=data_calls+1,data_bytes=data_bytes+declared_size WHERE id=? AND state='created'`,
            values: [attempt, leaseExpires, id],
          },
          assertOneChange,
        ]),
      );
      dispatch = true;
    } catch {
      // Even if this attempt is recorded, a lost claim response does not grant dispatch.
      // A pending write is recovered by HEAD/GET or expiry repair.
    }
    ({ row, authorized } = await accessUpload(env.DB, principal, id, capability, capabilities));
    if (row.state === "completing") return uploadStatus(row);
    if (row.state !== "receiving") throw new Error("upload_not_receiving");
  }
  if (!row.write_attempt_id) throw new Error("upload_attempt_missing");
  let hash: string;
  const key = `u/${row.owner_id}/b/${row.blob_id}`;
  try {
    if (dispatch) {
      if (row.write_attempt_id !== attempt) throw new Error("upload_attempt_conflict");
      const remaining = (row.write_lease_expires_at ?? 0) - Date.now();
      if (remaining <= 0) throw new Error("upload_write_lease_expired");
      const result = await consumeKnownLength(
        body,
        size,
        async (stream) => {
          const object = await env.BLOBS.put(key, stream, {
            onlyIf: { etagDoesNotMatch: "*" },
            customMetadata: metadata(row),
          });
          if (!object || !matches(row, object)) throw new Error("upload_object_mismatch");
          return object;
        },
        AbortSignal.timeout(remaining),
      );
      hash = result.sha256;
    } else {
      await body.cancel();
      const admission = await acquireAccountMutation(
        env,
        row.owner_id,
        row.epoch,
        "upload.single-recover",
      );
      await atomicBatch(
        env.DB,
        accountMutationStatements(admission, row.owner_id, [
          authorizationAssertion(authorized),
          uploadFence(row, ["receiving"]),
          {
            sql: "UPDATE uploads SET control_calls=control_calls+1 WHERE id=? AND control_calls<32",
            values: [id],
          },
          assertOneChange,
        ]),
      );
      hash = await recoverBody(env, row);
    }
  } catch (error) {
    // R2 may have committed despite a lost response. Charge any observed bytes before returning.
    try {
      await observePhysicalObject(env, env.BLOBS, row.blob_id, row.epoch);
    } catch {
      /* repair retries observation */
    }
    throw error;
  }
  await observePhysicalObject(env, env.BLOBS, row.blob_id, row.epoch);
  ({ row, authorized } = await accessUpload(env.DB, principal, id, capability, capabilities));
  if (row.state === "completing") return uploadStatus(row);
  const admission = await acquireAccountMutation(
    env,
    row.owner_id,
    row.epoch,
    "upload.single-verify",
  );
  await commitAccountMutation(env.DB, admission, row.owner_id, [
    authorizationAssertion(authorized),
    uploadFence(row, ["receiving"]),
    assertExists("SELECT 1 FROM blob_storage WHERE blob_id=? AND bytes=? AND removed_at IS NULL", [
      row.blob_id,
      size,
    ]),
    {
      sql: `UPDATE blobs SET sha256_verified=?,r2_etag=(SELECT r2_etag FROM blob_storage WHERE blob_id=?)
      WHERE id=? AND state='staging' AND size=?`,
      values: [hash, row.blob_id, row.blob_id, size],
    },
    assertOneChange,
    {
      sql: `UPDATE uploads SET state='completing',in_flight=0,accept_parts=0,
      last_progress_at=MAX(last_progress_at,strftime('%s','now')*1000) WHERE id=? AND state='receiving' AND write_attempt_id=?`,
      values: [id, row.write_attempt_id],
    },
    assertOneChange,
  ]);
  return uploadStatus((await uploadRow(env.DB, id))!);
}
