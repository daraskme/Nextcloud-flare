import { authorizationAssertion, type Principal } from "../../auth/authorize";
import type { UploadCapabilities } from "../../auth/uploadCapability";
import { assertOneChange, atomicBatch } from "../../db/primary";
import { CONTROL_NAME } from "../../do/ControlDO";
import { UPLOAD_LIMITS } from "../../do/uploadPlan";
import type { Env } from "../../env";
import { consumeKnownLength } from "../../platform/stream";
import { accessUpload, uploadFence, uploadRow } from "./access";
import { type CreateSingleUpload, reserveMultipartUpload } from "./create";
import { readUpload } from "./read";

/** Return the durable receipt even when one-time initialization cannot be confirmed. */
export async function createMultipartUploadReceipt(
  env: Env,
  input: CreateSingleUpload,
  capabilities: UploadCapabilities,
) {
  const control = await env.CONTROL.get(env.CONTROL.idFromName(CONTROL_NAME)).status();
  if (control.maintenance || control.epoch !== input.principal.epoch)
    throw new Error("admission_closed");
  const reserved = await reserveMultipartUpload(env, input, capabilities);
  let pending = false;
  try {
    await createMultipartUpload(env, input, capabilities);
  } catch (error) {
    const { row } = await accessUpload(
      env.DB,
      input.principal,
      reserved.id,
      reserved.capability,
      capabilities,
      false,
      "receipt",
    );
    pending =
      // A changed revision must stop initialization, but need not hide an authorized receipt.
      (error instanceof Error && error.message === "upload_target_changed") ||
      ["failed", "aborting", "aborted", "expired"].includes(row.state) ||
      (row.write_attempt_id !== null && row.r2_upload_id === null);
    if (!pending) throw error;
  }
  return {
    pending,
    receipt: {
      ...(await readUpload(
        env.DB,
        input.principal,
        reserved.id,
        reserved.capability,
        capabilities,
      )),
      capability: reserved.capability,
    },
  };
}

/** Only a confirmed, one-time initialization claim may dispatch R2 creation. */
export async function createMultipartUpload(
  env: Env,
  input: CreateSingleUpload,
  capabilities: UploadCapabilities,
) {
  const control = await env.CONTROL.get(env.CONTROL.idFromName(CONTROL_NAME)).status();
  if (control.maintenance || control.epoch !== input.principal.epoch)
    throw new Error("admission_closed");
  const created = await reserveMultipartUpload(env, input, capabilities);
  const { row, authorized } = await accessUpload(
    env.DB,
    input.principal,
    created.id,
    created.capability,
    capabilities,
  );
  const request = { uploadId: row.id, principal: input.principal, capability: created.capability };
  const stub = env.UPLOADS.get(env.UPLOADS.idFromName(row.id));
  if (row.r2_upload_id) {
    await stub.status(request);
    return created;
  }
  if (row.state !== "created" || row.write_attempt_id) throw new Error("upload_init_unknown");
  const attempt = crypto.randomUUID();
  const lease = Math.min(Date.now() + UPLOAD_LIMITS.leaseMs, row.expires_at);
  // Only this confirmed claim permits createMultipartUpload. Retrying the same request never
  // creates another R2 upload ID, even when the first call or its acknowledgement was lost.
  try {
    await atomicBatch(env.DB, [
      authorizationAssertion(authorized),
      uploadFence(row, ["created"]),
      {
        sql: `UPDATE uploads SET write_attempt_id=?,write_lease_expires_at=?,control_calls=control_calls+1
        WHERE id=? AND write_attempt_id IS NULL AND r2_upload_id IS NULL`,
        values: [attempt, lease, row.id],
      },
      assertOneChange,
    ]);
  } catch (error) {
    // A committed claim with a lost reply never grants dispatch. Do not stop a concurrent
    // caller's different claim; only this attempt can be declared not dispatched here.
    await atomicBatch(env.DB, [
      {
        sql: `UPDATE uploads SET state='failed',accept_parts=0,cleanup_pending=1,error_code='upload_init_unknown'
        WHERE id=? AND state='created' AND write_attempt_id=?`,
        values: [row.id, attempt],
      },
    ]);
    throw error;
  }
  const key = `u/${row.owner_id}/b/${row.blob_id}`;
  try {
    if (Date.now() >= lease) throw new Error("upload_init_lease_expired");
    const multipart = await env.BLOBS.createMultipartUpload(key, {
      customMetadata: {
        upload_id: row.id,
        blob_id: row.blob_id,
        epoch: String(row.epoch),
        attempt_id: attempt,
      },
    });
    if (!multipart.uploadId || multipart.key !== key) throw new Error("upload_object_mismatch");
    try {
      // Recording a known external ID must still work after credential revocation. It grants
      // no permission to send parts, and makes eventual cleanup possible under the old epoch.
      await atomicBatch(env.DB, [
        {
          sql: `UPDATE uploads SET r2_upload_id=? WHERE id=? AND write_attempt_id=? AND r2_upload_id IS NULL`,
          values: [multipart.uploadId, row.id, attempt],
        },
        assertOneChange,
      ]);
    } catch (error) {
      const saved = await uploadRow(env.DB, row.id);
      if (saved?.r2_upload_id !== multipart.uploadId) {
        // Keep the reservation: abort response loss and late control calls need durable repair.
        try {
          await atomicBatch(env.DB, [
            {
              sql: `UPDATE uploads SET cleanup_pending=1,cleanup_calls=cleanup_calls+1 WHERE id=? AND write_attempt_id=?`,
              values: [row.id, attempt],
            },
            assertOneChange,
          ]);
          await multipart.abort();
        } catch {
          /* cleanup remains pending */
        }
        throw error;
      }
    }
  } catch (error) {
    await atomicBatch(env.DB, [
      {
        sql: `UPDATE uploads SET state='failed',accept_parts=0,cleanup_pending=1,error_code='upload_init_unknown'
        WHERE id=? AND state='created' AND write_attempt_id=?`,
        values: [row.id, attempt],
      },
    ]);
    throw error;
  }
  await stub.status(request);
  return created;
}

export async function writeMultipartPart(
  env: Env,
  principal: Principal,
  id: string,
  capability: string,
  capabilities: UploadCapabilities,
  partNumber: number,
  attemptId: string,
  body: ReadableStream<Uint8Array>,
  bytes: number,
) {
  const request = { uploadId: id, principal, capability };
  const stub = env.UPLOADS.get(env.UPLOADS.idFromName(id));
  let started = false;
  let dispatched = false;
  try {
    const lease = await stub.claimPart({ ...request, partNumber, attemptId, bytes });
    if (lease.disposition !== "dispatch") {
      await body.cancel();
      return lease;
    }
    dispatched = true;
    // Recheck the current credential and D1 state immediately before external I/O.
    const { row, authorized } = await accessUpload(env.DB, principal, id, capability, capabilities);
    if (row.mode !== "multipart" || !row.r2_upload_id)
      throw new Error("upload_multipart_not_initialized");
    await atomicBatch(env.DB, [
      authorizationAssertion(authorized),
      uploadFence(row, ["uploading"]),
    ]);
    const remaining = lease.expiresAt - Date.now();
    if (remaining <= 0) throw new Error("upload_part_lease_expired");
    const result = await consumeKnownLength(
      body,
      bytes,
      (stream) => {
        // resumeMultipartUpload only constructs a handle; it does not verify existence.
        const multipart = env.BLOBS.resumeMultipartUpload(
          `u/${row.owner_id}/b/${row.blob_id}`,
          row.r2_upload_id!,
        );
        started = true;
        return multipart.uploadPart(partNumber, stream);
      },
      AbortSignal.timeout(remaining),
    );
    if (result.value.partNumber !== partNumber) throw new Error("invalid_part_result");
    const settled = await stub.settlePart({
      ...request,
      attemptId,
      outcome: { kind: "completed", bytes, etag: result.value.etag, sha256: result.sha256 },
    });
    if (!settled) throw new Error("upload_not_accepting_parts");
    return { ...lease, disposition: "completed" as const };
  } catch (error) {
    if (!body.locked) {
      try {
        await body.cancel();
      } catch {
        /* source may already be disconnected */
      }
    }
    if (dispatched) {
      try {
        // If a successful settle was committed but its reply was lost, the ledger rejects
        // this conflicting unknown result and preserves that immutable completed record.
        await stub.settlePart({
          ...request,
          attemptId,
          outcome: { kind: started ? "unknown" : "not_started" },
        });
      } catch {
        /* Persisted lease and alarm fence any unresolved result; never redispatch. */
      }
    }
    throw error;
  }
}
