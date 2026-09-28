import { assertOneChange, atomicBatch, primary } from "../db/primary";
import type { Env } from "../env";
import { hex } from "../platform/stream";
import { trackedR2Write } from "../services/r2Write";
import {
  acquireSystemMutation,
  commitSystemMutation,
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
import { copyObjectStatements } from "./copyObject";
import { advanceCopyBlob } from "./copyProgress";
import { readCopyJobRange } from "./copyRead";

type CopyPutEnv = Pick<Env, "DB" | "CONTROL" | "BLOBS">;
const CLOCK = "strftime('%s','now')*1000";

/** Copy one complete small blob; larger blobs use the subsequent multipart executor. */
export async function copyNextSmallBlob(
  env: CopyPutEnv,
  claim: CopyJobClaim,
): Promise<"stored" | "ready"> {
  checkCopyClaim(claim);
  const position = copyClaimPosition(claim),
    blob = claim.plan.source.blobs[position];
  if (!blob) {
    const authority = await copyAuthorityStatements(env.DB, claim.plan);
    checkCopyClaim(claim);
    await atomicBatch(env.DB, [copyClaimFence(claim), ...authority]);
    checkCopyClaim(claim);
    return "ready";
  }
  if (blob.size > COPY_EXECUTION_LIMITS.rangeBytes) throw new Error("copy_multipart_required");
  const mapping = await primary(env.DB)
    .prepare(
      "SELECT destination_blob_id,transfer_state FROM copy_job_blobs WHERE job_id=? AND source_blob_id=?",
    )
    .bind(claim.id, blob.id)
    .first<{ destination_blob_id: string; transfer_state: string }>();
  if (!mapping) throw new Error("copy_transfer_unavailable");
  const destinationId = mapping.destination_blob_id,
    key = `u/${claim.plan.destinationOwnerId}/b/${destinationId}`;
  const witness = claim.plan.source.entries.find((n) => n.blobId === blob.id)!;
  if (mapping.transfer_state !== "stored") {
    if (mapping.transfer_state !== "pending") throw new Error("copy_write_unsettled");
    const bytes = await readCopyJobRange(env, claim, {
      blobId: blob.id,
      offset: 0,
      length: blob.size,
    });
    const checksum = await crypto.subtle.digest("SHA-256", bytes),
      sha256 = hex(checksum);
    if (blob.sha256 !== null && blob.sha256 !== sha256)
      throw new Error("copy_source_hash_mismatch");
    const attemptId = crypto.randomUUID();
    const authority = await copyAuthorityStatements(env.DB, claim.plan, witness.id);
    const admission = await acquireSystemMutation(
      env,
      claim.plan.destinationOwnerId,
      "copy.prepare-put",
      claim.expiresAt,
    );
    checkCopyClaim(claim);
    // No PUT after an ambiguous prepare ACK. The durable attempt is retained for reconciliation.
    await atomicBatch(
      env.DB,
      systemMutationStatements(admission, claim.plan.destinationOwnerId, [
        copyClaimFence(claim),
        ...authority,
        {
          sql: `UPDATE copy_job_blobs SET transfer_state='claimed',transfer_attempt=?,transfer_claim=?,transfer_sha256=?,transfer_node_id=?
          WHERE job_id=? AND source_blob_id=? AND transfer_state='pending'`,
          values: [attemptId, claim.token, sha256, witness.id, claim.id, blob.id],
        },
        assertOneChange,
        {
          sql: `INSERT INTO blobs(id,owner_id,r2_key,size,content_etag,mime_sniffed,state,created_at)
          VALUES(?,?,?,?,?,?,'staging',${CLOCK})`,
          values: [
            destinationId,
            claim.plan.destinationOwnerId,
            key,
            blob.size,
            '"b-' + destinationId + '"',
            blob.mime,
          ],
        },
      ]),
    );
    checkCopyClaim(claim);
    const observe = async (object: R2Object) => {
      const statements = copyObjectStatements(
        {
          jobId: claim.id,
          sourceBlobId: blob.id,
          destinationBlobId: destinationId,
          ownerId: claim.plan.destinationOwnerId,
          size: blob.size,
          attemptId,
          claimToken: claim.token,
          mode: "single",
          sha256,
        },
        object,
      );
      const receipt = await acquireSystemMutation(
        env,
        claim.plan.destinationOwnerId,
        "copy.observe-put",
      );
      // Record actual facts even after revocation or execution lease expiry.
      await commitSystemMutation(env.DB, receipt, claim.plan.destinationOwnerId, statements);
    };
    let observed = false;
    const result = await trackedR2Write(
      env,
      {
        epoch: claim.epoch,
        ownerId: claim.plan.destinationOwnerId,
        kind: "copy.put",
        key,
        copy: {
          jobId: claim.id,
          sourceBlobId: blob.id,
          attemptId,
          claimToken: claim.token,
          expiresAt: claim.expiresAt,
        },
      },
      async () => {
        const object = await env.BLOBS.put(key, bytes, {
          onlyIf: { etagDoesNotMatch: "*" },
          sha256: checksum,
        });
        if (object) {
          try {
            await observe(object);
            observed = true;
          } catch {
            /* Native completion still gets its independent receipt. */
          }
        }
        return object;
      },
      claim.expiresAt,
      () => checkCopyClaim(claim),
    );
    if (!result) throw new Error("copy_destination_exists");
    if (!observed) await observe(result);
  }
  await advanceCopyBlob(env, claim);
  return "stored";
}
