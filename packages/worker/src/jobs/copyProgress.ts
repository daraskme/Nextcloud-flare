import { assertExists, assertOneChange } from "../db/primary";
import type { Env } from "../env";
import { acquireSystemMutation, commitSystemMutation } from "../services/systemMutation";
import {
  advancedCopyClaim,
  type CopyJobClaim,
  checkCopyClaim,
  copyAuthorityStatements,
  copyClaimFence,
  copyClaimPosition,
} from "./copyClaim";

const CLOCK = "strftime('%s','now')*1000";
export async function advanceCopyBlob(
  env: Pick<Env, "DB" | "CONTROL">,
  claim: CopyJobClaim,
): Promise<void> {
  const position = copyClaimPosition(claim),
    blob = claim.plan.source.blobs[position];
  if (!blob) throw new Error("invalid_copy_checkpoint");
  const witness = claim.plan.source.entries.find((n) => n.blobId === blob.id)!;
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
      JOIN blob_storage s ON s.blob_id=b.id LEFT JOIN copy_multipart_uploads m ON m.destination_blob_id=b.id
      WHERE cb.job_id=? AND cb.source_blob_id=? AND cb.transfer_state='stored'
        AND b.state='staging' AND s.bytes=b.size AND s.removed_at IS NULL
        AND ((cb.transfer_mode='single' AND b.sha256_verified=cb.transfer_sha256)
          OR (cb.transfer_mode='multipart' AND b.sha256_verified IS NULL AND cb.transfer_sha256 IS NULL AND m.state='stored' AND m.object_etag=s.r2_etag))
        AND EXISTS(SELECT 1 FROM r2_write_attempts w WHERE w.kind=CASE cb.transfer_mode WHEN 'single' THEN 'copy.put' ELSE 'copy.multipart.complete' END
          AND w.state='succeeded' AND w.r2_key=b.r2_key
          AND w.source_ref=json_array(cb.job_id,cb.source_blob_id,CASE cb.transfer_mode WHEN 'single' THEN cb.transfer_attempt ELSE m.complete_attempt END))
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
}
