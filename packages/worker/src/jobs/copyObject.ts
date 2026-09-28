import { assertExists, assertOneChange, type SqlStatement } from "../db/primary";
import { hex } from "../platform/stream";

export type CopyObjectIdentity = {
  jobId: string;
  sourceBlobId: string;
  destinationBlobId: string;
  ownerId: string;
  size: number;
  attemptId: string;
  claimToken: string;
} & ({ mode: "single"; sha256: string } | { mode: "multipart"; r2UploadId: string });

/** Actual storage facts only; the caller supplies native-result or reconciliation evidence. */
export function copyObjectStatements(p: CopyObjectIdentity, object: R2Object): SqlStatement[] {
  if (
    object.key !== `u/${p.ownerId}/b/${p.destinationBlobId}` ||
    object.size !== p.size ||
    !object.etag ||
    object.etag.length > 256 ||
    (p.mode === "single" && (!object.checksums.sha256 || hex(object.checksums.sha256) !== p.sha256))
  )
    throw new Error("copy_destination_mismatch");
  return [
    p.mode === "single"
      ? assertExists(
          "SELECT 1 FROM copy_job_blobs WHERE job_id=? AND source_blob_id=? AND destination_blob_id=? AND transfer_attempt=? AND transfer_claim=? AND transfer_sha256=? AND transfer_state IN ('claimed','stored')",
          [p.jobId, p.sourceBlobId, p.destinationBlobId, p.attemptId, p.claimToken, p.sha256],
        )
      : assertExists(
          "SELECT 1 FROM copy_multipart_uploads WHERE destination_blob_id=? AND complete_attempt=? AND complete_claim=? AND state IN ('completing','stored') AND r2_upload_id=?",
          [p.destinationBlobId, p.attemptId, p.claimToken, p.r2UploadId],
        ),
    {
      sql: "INSERT INTO blob_storage(blob_id,bytes,r2_etag,observed_at) VALUES(?,?,?,strftime('%s','now')*1000) ON CONFLICT(blob_id) DO NOTHING",
      values: [p.destinationBlobId, p.size, object.etag],
    },
    assertExists(
      "SELECT 1 FROM blob_storage WHERE blob_id=? AND bytes=? AND r2_etag=? AND removed_at IS NULL",
      [p.destinationBlobId, p.size, object.etag],
    ),
    p.mode === "single"
      ? {
          sql: "UPDATE blobs SET sha256_verified=?,r2_etag=? WHERE id=? AND state='staging'",
          values: [p.sha256, object.etag, p.destinationBlobId],
        }
      : {
          sql: "UPDATE blobs SET r2_etag=? WHERE id=? AND state='staging' AND sha256_verified IS NULL",
          values: [object.etag, p.destinationBlobId],
        },
    assertOneChange,
    ...(p.mode === "multipart"
      ? [
          {
            sql: "UPDATE copy_multipart_uploads SET state='stored',object_etag=? WHERE destination_blob_id=? AND complete_attempt=?",
            values: [object.etag, p.destinationBlobId, p.attemptId],
          },
          assertOneChange,
        ]
      : []),
    {
      sql: `UPDATE copy_job_blobs SET transfer_state='stored' WHERE job_id=? AND source_blob_id=? AND ${p.mode === "single" ? "transfer_attempt=?" : "transfer_mode='multipart'"}`,
      values: [p.jobId, p.sourceBlobId, ...(p.mode === "single" ? [p.attemptId] : [])],
    },
    assertOneChange,
  ];
}
