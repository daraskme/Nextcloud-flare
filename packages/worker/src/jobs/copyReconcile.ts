import { assertExists, assertOneChange, atomicBatch, primary } from "../db/primary";
import { copyMultipartPartsProof } from "../db/r2Copy";
import type { Env } from "../env";
import {
  acquireSystemMutation,
  commitSystemMutation,
  type SystemMutationSource,
  systemMutationStatements,
} from "../services/systemMutation";
import {
  COPY_EXECUTION_LIMITS,
  type CopyJobClaim,
  checkCopyClaim,
  copyAuthorityStatements,
  copyClaimFence,
  copyClaimPosition,
} from "./copyClaim";
import { loadCopyJobManifest } from "./copyManifest";
import { type CopyObjectIdentity, copyObjectStatements } from "./copyObject";

// A HEAD can recover a missing observation, never the completion of an unknown write.
const PROVEN_OBJECT = `FROM copy_job_blobs cb JOIN bulk_jobs j ON j.id=cb.job_id
  JOIN copy_job_manifests manifest ON manifest.job_id=j.id JOIN blobs b ON b.id=cb.destination_blob_id
  JOIN reservations r ON r.id=cb.reservation_id JOIN blob_pins pin ON pin.pin_id=cb.pin_id
  JOIN control c ON c.singleton=1 LEFT JOIN copy_multipart_uploads m ON m.destination_blob_id=b.id
  JOIN r2_write_attempts w INDEXED BY r2_write_source
    ON w.kind=CASE cb.transfer_mode WHEN 'single' THEN 'copy.put' ELSE 'copy.multipart.complete' END
    AND w.source_ref=json_array(cb.job_id,cb.source_blob_id,CASE cb.transfer_mode WHEN 'single' THEN cb.transfer_attempt ELSE m.complete_attempt END)
  LEFT JOIN blob_storage s ON s.blob_id=b.id
  WHERE cb.job_id=? AND cb.source_blob_id=? AND cb.transfer_state IN ('claimed','stored')
    AND j.kind='node.copy' AND j.state IN ('running','cancelled','failed') AND j.epoch<=c.epoch
    AND (c.maintenance=0 OR c.gc_paused=1)
    AND b.owner_id=j.owner_id AND b.r2_key='u/'||j.owner_id||'/b/'||b.id AND b.state='staging' AND b.ref_count=0
    AND r.owner_id=j.owner_id AND r.bytes=b.size AND r.epoch=j.epoch AND r.state='reserved'
    AND r.expires_at=manifest.expires_at AND pin.blob_id=cb.source_blob_id AND pin.purpose='copy' AND pin.expires_at=manifest.expires_at
    AND w.state='succeeded' AND w.state<>'not_started' AND w.r2_key=b.r2_key AND w.owner_id=j.owner_id AND w.epoch=j.epoch
    AND ((cb.transfer_mode='single' AND m.destination_blob_id IS NULL AND cb.transfer_sha256 IS NOT NULL)
      OR (cb.transfer_mode='multipart' AND m.state IN ('completing','stored') AND m.r2_upload_id IS NOT NULL
        AND m.init_attempt=cb.transfer_attempt AND m.init_claim=cb.transfer_claim AND m.abort_attempt IS NULL))
    AND NOT EXISTS(SELECT 1 FROM r2_write_attempts WHERE r2_key=b.r2_key AND state='pending')
    AND NOT EXISTS(SELECT 1 FROM r2_write_attempts other WHERE other.r2_key=b.r2_key AND other.state<>'not_started'
      AND (other.epoch<>j.epoch OR other.owner_id IS NOT j.owner_id
        OR (cb.transfer_mode='single' AND other.id<>w.id)
        OR (cb.transfer_mode='multipart' AND other.kind NOT IN ('copy.multipart.create','copy.multipart.part','copy.multipart.complete'))))
    AND NOT EXISTS(SELECT 1 FROM gc_candidates WHERE blob_id=b.id)
    AND NOT EXISTS(SELECT 1 FROM orphan_objects WHERE r2_key=b.r2_key)`;

interface ObjectRow {
  destination_blob_id: string;
  size: number;
  r2_key: string;
  transfer_mode: "single" | "multipart";
  transfer_attempt: string;
  transfer_claim: string;
  transfer_sha256: string | null;
  complete_attempt: string | null;
  complete_claim: string | null;
  r2_upload_id: string | null;
  native_id: string;
  recorded: number;
}

/** One HEAD, 25 seconds. Restores facts without resending writes, advancing or releasing holds. */
export async function reconcileCopyObject(
  env: SystemMutationSource & Pick<Env, "BLOBS">,
  jobId: string,
  sourceBlobId: string,
  claim?: CopyJobClaim,
): Promise<"stored" | "held"> {
  if (claim) {
    checkCopyClaim(claim);
    if (
      claim.id !== jobId ||
      claim.plan.source.blobs[copyClaimPosition(claim)]?.id !== sourceBlobId
    )
      throw new Error("invalid_copy_reconciliation");
  }
  const deadline = Math.min(Date.now() + 25_000, claim?.expiresAt ?? Infinity);
  if (!/^copy_[a-f0-9]{64}$/.test(jobId) || !/^[A-Za-z0-9_-]{1,128}$/.test(sourceBlobId))
    throw new Error("invalid_copy_reconciliation");
  const plan = claim?.plan ?? (await loadCopyJobManifest(env.DB, jobId)).plan;
  const source = plan.source.blobs.find((b) => b.id === sourceBlobId);
  if (!source) throw new Error("invalid_copy_reconciliation");
  const row = await primary(env.DB)
    .prepare(`SELECT b.id AS destination_blob_id,b.size,b.r2_key,cb.transfer_mode,cb.transfer_attempt,
      cb.transfer_claim,cb.transfer_sha256,m.complete_attempt,m.complete_claim,m.r2_upload_id,w.id AS native_id,
      (cb.transfer_state='stored' AND s.bytes=b.size AND s.removed_at IS NULL AND s.r2_etag=b.r2_etag
        AND ((cb.transfer_mode='single' AND b.sha256_verified=cb.transfer_sha256)
          OR (cb.transfer_mode='multipart' AND m.state='stored' AND m.object_etag=s.r2_etag AND b.sha256_verified IS NULL))) AS recorded
      ${PROVEN_OBJECT}`)
    .bind(jobId, sourceBlobId)
    .first<ObjectRow>();
  if (!row || row.size !== source.size) return "held";
  if (row.recorded) return "stored";
  const owner = plan.destinationOwnerId;
  const admission = await acquireSystemMutation(env, owner, "copy.reconcile-object", deadline);
  const proof = [
    assertExists(
      `SELECT 1 ${PROVEN_OBJECT} AND w.id=? AND j.owner_id=? AND b.id=? AND b.size=? AND c.epoch=? AND c.maintenance=?`,
      [
        jobId,
        sourceBlobId,
        row.native_id,
        owner,
        row.destination_blob_id,
        source.size,
        admission.epoch,
        admission.maintenance,
      ],
    ),
    ...(row.transfer_mode === "multipart" ? [copyMultipartPartsProof(row.r2_key)] : []),
  ];
  const charged = claim
    ? [
        copyClaimFence(claim),
        ...(await copyAuthorityStatements(
          env.DB,
          claim.plan,
          claim.plan.source.entries.find((n) => n.blobId === sourceBlobId)!.id,
        )),
        {
          sql: "UPDATE job_leases SET r2_calls=r2_calls+1 WHERE job_id=? AND claim_token=? AND r2_calls<?",
          values: [claim.id, claim.token, COPY_EXECUTION_LIMITS.rangeReads],
        },
        assertOneChange,
        {
          sql: "UPDATE bulk_jobs SET r2_calls=r2_calls+1 WHERE id=? AND r2_calls<?",
          values: [claim.id, COPY_EXECUTION_LIMITS.r2Calls],
        },
        assertOneChange,
      ]
    : [];
  if (claim) checkCopyClaim(claim);
  // A recovered DB-only receipt does not authorize this HEAD. A lost ACK consumes its budget.
  await atomicBatch(env.DB, systemMutationStatements(admission, owner, [...proof, ...charged]));
  if (claim) checkCopyClaim(claim);
  if (Date.now() >= deadline) return "held";
  let timer: ReturnType<typeof setTimeout> | undefined;
  let object: R2Object | null;
  try {
    object = await Promise.race([
      env.BLOBS.head(row.r2_key),
      new Promise<null>((resolve) => {
        timer = setTimeout(() => resolve(null), deadline - Date.now());
      }),
    ]);
  } catch {
    return "held";
  } finally {
    clearTimeout(timer);
  }
  if (!object || Date.now() >= deadline) return "held";
  if (
    row.transfer_mode === "multipart" &&
    (object.customMetadata?.copy_job !== jobId ||
      object.customMetadata?.copy_blob !== row.destination_blob_id ||
      object.customMetadata?.copy_attempt !== row.transfer_attempt)
  )
    return "held";
  const identity: CopyObjectIdentity = {
    jobId,
    sourceBlobId,
    destinationBlobId: row.destination_blob_id,
    ownerId: owner,
    size: source.size,
    ...(row.transfer_mode === "single"
      ? {
          mode: "single",
          attemptId: row.transfer_attempt,
          claimToken: row.transfer_claim,
          sha256: row.transfer_sha256!,
        }
      : {
          mode: "multipart",
          attemptId: row.complete_attempt!,
          claimToken: row.complete_claim!,
          r2UploadId: row.r2_upload_id!,
        }),
  };
  let facts;
  try {
    facts = copyObjectStatements(identity, object);
  } catch {
    return "held";
  }
  const receipt = await acquireSystemMutation(env, owner, "copy.reconcile-object", deadline);
  await commitSystemMutation(env.DB, receipt, owner, [...proof, ...facts]);
  return "stored";
}
