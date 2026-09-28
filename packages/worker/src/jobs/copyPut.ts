import { assertExists, assertOneChange, atomicBatch, primary } from "../db/primary";
import type { Env } from "../env";
import { hex } from "../platform/stream";
import { trackedR2Write } from "../services/r2Write";
import {
  acquireSystemMutation,
  commitSystemMutation,
  systemMutationStatements,
} from "../services/systemMutation";
import {
  advancedCopyClaim,
  COPY_EXECUTION_LIMITS,
  type CopyJobClaim,
  checkCopyClaim,
  copyAuthorityStatements,
  copyClaimFence,
  copyClaimPosition,
} from "./copyClaim";
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
      if (
        object.key !== key ||
        !object.etag ||
        object.etag.length > 256 ||
        object.size !== blob.size ||
        !object.checksums.sha256 ||
        hex(object.checksums.sha256) !== sha256
      )
        throw new Error("copy_destination_mismatch");
      const receipt = await acquireSystemMutation(
        env,
        claim.plan.destinationOwnerId,
        "copy.observe-put",
      );
      // Actual native facts must survive a revoked grant, disabled owner or expired execution lease.
      await commitSystemMutation(env.DB, receipt, claim.plan.destinationOwnerId, [
        assertExists(
          "SELECT 1 FROM copy_job_blobs WHERE job_id=? AND source_blob_id=? AND destination_blob_id=? AND transfer_attempt=? AND transfer_claim=? AND transfer_sha256=? AND transfer_state IN ('claimed','stored')",
          [claim.id, blob.id, destinationId, attemptId, claim.token, sha256],
        ),
        {
          sql: `INSERT INTO blob_storage(blob_id,bytes,r2_etag,observed_at) VALUES(?,?,?,${CLOCK}) ON CONFLICT(blob_id) DO NOTHING`,
          values: [destinationId, blob.size, object.etag],
        },
        assertExists(
          "SELECT 1 FROM blob_storage WHERE blob_id=? AND bytes=? AND r2_etag=? AND removed_at IS NULL",
          [destinationId, blob.size, object.etag],
        ),
        {
          sql: "UPDATE blobs SET sha256_verified=?,r2_etag=? WHERE id=? AND state='staging'",
          values: [sha256, object.etag, destinationId],
        },
        assertOneChange,
        {
          sql: "UPDATE copy_job_blobs SET transfer_state='stored' WHERE job_id=? AND source_blob_id=? AND transfer_attempt=?",
          values: [claim.id, blob.id, attemptId],
        },
        assertOneChange,
      ]);
    };
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
    await observe(result);
  }
  checkCopyClaim(claim);
  const authority = await copyAuthorityStatements(env.DB, claim.plan, witness.id);
  const advance = await acquireSystemMutation(
    env,
    claim.plan.destinationOwnerId,
    "copy.advance",
    claim.expiresAt,
  );
  checkCopyClaim(claim);
  await commitSystemMutation(env.DB, advance, claim.plan.destinationOwnerId, [
    copyClaimFence(claim),
    ...authority,
    assertExists(
      `SELECT 1 FROM copy_job_blobs cb JOIN blobs b ON b.id=cb.destination_blob_id
      JOIN blob_storage s ON s.blob_id=b.id WHERE cb.job_id=? AND cb.source_blob_id=? AND cb.transfer_state='stored'
        AND b.state='staging' AND b.sha256_verified=cb.transfer_sha256 AND s.bytes=b.size AND s.removed_at IS NULL
        AND EXISTS(SELECT 1 FROM r2_write_attempts w WHERE w.kind='copy.put' AND w.state='succeeded' AND w.r2_key=b.r2_key
          AND w.source_ref=json_array(cb.job_id,cb.source_blob_id,cb.transfer_attempt))
        AND NOT EXISTS(SELECT 1 FROM r2_write_attempts WHERE r2_key=b.r2_key AND state='pending')`,
      [claim.id, blob.id],
    ),
    {
      sql: `UPDATE bulk_jobs SET checkpoint=?,updated_at=MAX(updated_at,${CLOCK}) WHERE id=?`,
      values: [JSON.stringify({ v: 1, blob: position + 1, offset: 0 }), claim.id],
    },
    assertOneChange,
    {
      sql: "UPDATE job_leases SET attempt=1 WHERE job_id=? AND claim_token=?",
      values: [claim.id, claim.token],
    },
    assertOneChange,
  ]);
  advancedCopyClaim(claim, position + 1);
  return "stored";
}
