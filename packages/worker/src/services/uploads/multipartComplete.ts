import { authorizationAssertion, type Principal } from "../../auth/authorize";
import type { UploadCapabilities } from "../../auth/uploadCapability";
import { assertExists, assertOneChange, atomicBatch } from "../../db/primary";
import { CONTROL_NAME } from "../../do/ControlDO";
import { expectedPartBytes, multipartPlan, UPLOAD_LIMITS } from "../../do/uploadPlan";
import type { Env } from "../../env";
import {
  accountMutationStatements,
  acquireAccountMutation,
  commitAccountMutation,
} from "../accountMutation";
import type { MutationOutcome } from "../fsMutation";
import {
  acquireSystemMutation,
  commitSystemMutation,
  systemMutationStatements,
} from "../systemMutation";
import { accessUpload, type UploadRow, uploadFence, uploadRow } from "./access";
import { publishMultipartUpload } from "./complete";
import { multipartHeadCharge, multipartPartsProof } from "./multipartProof";

/** R2 requires an array of etags. Build only that transient array from bounded journal pages. */
async function completedManifest(
  env: Env,
  row: UploadRow,
  principal: Principal,
  capability: string,
) {
  const plan = multipartPlan(row.declared_size, row.part_bytes!);
  const stub = env.UPLOADS.get(env.UPLOADS.idFromName(row.id));
  const parts: R2UploadedPart[] = [];
  while (parts.length < plan.partCount) {
    const page = await stub.completedParts({
      uploadId: row.id,
      principal,
      capability,
      after: parts.length,
      limit: Math.min(200, plan.partCount - parts.length),
    });
    if (!page.length) throw new Error("upload_parts_incomplete");
    for (const part of page) {
      if (
        part.partNumber !== parts.length + 1 ||
        part.bytes !== expectedPartBytes(plan, part.partNumber) ||
        !part.etag ||
        part.etag.length > 1024 ||
        !part.sha256 ||
        !/^[a-f0-9]{64}$/.test(part.sha256)
      )
        throw new Error("invalid_multipart_manifest");
      parts.push({ partNumber: part.partNumber, etag: part.etag });
    }
    if (parts.length > plan.partCount) throw new Error("invalid_multipart_manifest");
  }
  return parts;
}

async function observeCompletedObject(
  env: Env,
  row: UploadRow,
  principal: Principal,
  capability: string,
  capabilities: UploadCapabilities,
) {
  const headAdmission = await acquireSystemMutation(env, row.owner_id, "upload.multipart-head");
  await atomicBatch(
    env.DB,
    systemMutationStatements(headAdmission, row.owner_id, [
      // The authorized caller may have been revoked while complete was in flight. Recording
      // external storage facts is still necessary; only the later publication requires live auth.
      assertExists(
        `SELECT 1 FROM uploads u JOIN control c ON c.singleton=1
      WHERE u.id=? AND u.epoch=? AND c.epoch=u.epoch AND u.mode='multipart'
        AND u.state='completing' AND u.blob_id=? AND u.r2_upload_id=?
        AND u.multipart_complete_attempt IS NOT NULL`,
        [row.id, row.epoch, row.blob_id, row.r2_upload_id],
      ),
      multipartPartsProof(row),
      ...multipartHeadCharge(row),
    ]),
  );
  const key = `u/${row.owner_id}/b/${row.blob_id}`;
  const object = await env.BLOBS.head(key);
  // A missing object says nothing about whether an already dispatched complete is still running.
  if (!object) throw new Error("upload_complete_pending");
  if (!Number.isSafeInteger(object.size) || object.size < 0 || !object.etag)
    throw new Error("upload_object_mismatch");
  // Charge observed bytes even for a malformed object or a subsequently revoked credential.
  // No reservation refund is allowed until a valid complete object or cleanup proves safety.
  const physicalAdmission = await acquireSystemMutation(
    env,
    row.owner_id,
    "upload.multipart-observe",
  );
  await commitSystemMutation(env.DB, physicalAdmission, row.owner_id, [
    assertExists("SELECT 1 FROM control WHERE singleton=1 AND epoch=?", [row.epoch]),
    assertExists(
      `SELECT 1 FROM blobs WHERE id=? AND owner_id=? AND r2_key=? AND state IN ('staging','orphan')`,
      [row.blob_id, row.owner_id, key],
    ),
    {
      sql: `INSERT INTO blob_storage(blob_id,bytes,r2_etag,observed_at) VALUES(?,?,?,strftime('%s','now')*1000)
        ON CONFLICT(blob_id) DO NOTHING`,
      values: [row.blob_id, object.size, object.etag],
    },
    assertExists(
      "SELECT 1 FROM blob_storage WHERE blob_id=? AND bytes=? AND r2_etag=? AND removed_at IS NULL",
      [row.blob_id, object.size, object.etag],
    ),
  ]);
  if (
    object.size !== row.declared_size ||
    object.customMetadata?.upload_id !== row.id ||
    object.customMetadata.blob_id !== row.blob_id ||
    object.customMetadata.epoch !== String(row.epoch) ||
    object.customMetadata.attempt_id !== row.write_attempt_id
  )
    throw new Error("upload_object_mismatch");
  const current = await accessUpload(env.DB, principal, row.id, capability, capabilities);
  const admission = await acquireAccountMutation(
    env,
    row.owner_id,
    row.epoch,
    "upload.multipart-verify",
  );
  await commitAccountMutation(env.DB, admission, row.owner_id, [
    authorizationAssertion(current.authorized),
    uploadFence(row, ["completing"]),
    multipartPartsProof(row),
    assertExists(
      "SELECT 1 FROM blob_storage WHERE blob_id=? AND bytes=? AND r2_etag=? AND removed_at IS NULL",
      [row.blob_id, row.declared_size, object.etag],
    ),
    {
      sql: `UPDATE blobs SET r2_etag=? WHERE id=? AND state='staging' AND sha256_verified IS NULL`,
      values: [object.etag, row.blob_id],
    },
    assertOneChange,
    {
      sql: `UPDATE uploads SET multipart_object_etag=? WHERE id=? AND multipart_complete_attempt IS NOT NULL
        AND (multipart_object_etag IS NULL OR multipart_object_etag=?)`,
      values: [object.etag, row.id, object.etag],
    },
    assertOneChange,
  ]);
}

/** Complete once, reconcile unknown R2 outcomes, then publish through the atomic namespace path. */
export async function completeMultipartUpload(
  env: Env,
  principal: Principal,
  id: string,
  capability: string,
  capabilities: UploadCapabilities,
  requestId: string,
  lockTokens: readonly string[],
): Promise<MutationOutcome> {
  const control = await env.CONTROL.get(env.CONTROL.idFromName(CONTROL_NAME)).status();
  if (control.maintenance || control.epoch !== principal.epoch) throw new Error("admission_closed");
  if (!/^[\x21-\x7e]{1,200}$/.test(requestId)) throw new Error("invalid_upload_complete");
  let { row } = await accessUpload(
    env.DB,
    principal,
    id,
    capability,
    capabilities,
    false,
    "receipt",
  );
  if (row.mode !== "multipart") throw new Error("invalid_upload_complete");
  const request = { uploadId: id, principal, capability };
  const stub = env.UPLOADS.get(env.UPLOADS.idFromName(id));
  const publish = async () => {
    const result = await publishMultipartUpload(
      env,
      principal,
      id,
      capability,
      capabilities,
      requestId,
      lockTokens,
    );
    if (result.kind === "terminal" && result.operation.state === "committed") {
      try {
        await stub.acknowledgeCompletion(request);
      } catch {
        /* D1 is authoritative; status/alarm retries the acknowledgement. */
      }
    }
    return result;
  };
  // A completed/failed operation and a saved object proof never cause another R2 complete.
  if (row.completion_op_id || row.multipart_object_etag || row.state === "completed")
    return publish();
  if (!["created", "uploading", "completing"].includes(row.state))
    throw new Error("upload_not_completable");
  if (row.expires_at <= Date.now() || row.last_progress_at <= Date.now() - 86400000)
    throw new Error("upload_expired");
  try {
    await stub.beginComplete(request);
    let authorized;
    ({ row, authorized } = await accessUpload(env.DB, principal, id, capability, capabilities));
    if (row.state !== "completing") throw new Error("upload_not_completable");
    if (!row.multipart_complete_attempt) {
      const parts = await completedManifest(env, row, principal, capability);
      const attempt = crypto.randomUUID();
      const lease = Math.min(Date.now() + UPLOAD_LIMITS.leaseMs, row.expires_at);
      let dispatch = false;
      const admission = await acquireAccountMutation(
        env,
        row.owner_id,
        row.epoch,
        "upload.multipart-complete",
      );
      try {
        await atomicBatch(
          env.DB,
          accountMutationStatements(admission, row.owner_id, [
            authorizationAssertion(authorized),
            uploadFence(row, ["completing"]),
            multipartPartsProof(row),
            {
              sql: `UPDATE uploads SET multipart_complete_attempt=?,multipart_complete_lease=?
              WHERE id=? AND multipart_complete_attempt IS NULL`,
              values: [attempt, lease, id],
            },
            assertOneChange,
          ]),
        );
        dispatch = true;
      } catch (error) {
        const current = await uploadRow(env.DB, id);
        if (!current?.multipart_complete_attempt) throw error;
        // Even finding our own attempt does not turn a lost claim acknowledgement into dispatch.
      }
      if (dispatch && Date.now() < lease) {
        try {
          await env.BLOBS.resumeMultipartUpload(
            `u/${row.owner_id}/b/${row.blob_id}`,
            row.r2_upload_id!,
          ).complete(parts);
        } catch {
          /* Reconcile the immutable key. Never dispatch complete again after an unknown result. */
        }
      }
    }
    await observeCompletedObject(env, row, principal, capability, capabilities);
  } catch (error) {
    // A concurrent request may have published while this request was observing/mirroring.
    // Reconcile only a durably bound operation/object proof, never manufacture a successful result.
    const current = await uploadRow(env.DB, id);
    if (!current?.completion_op_id && !current?.multipart_object_etag) throw error;
  }
  return publish();
}
