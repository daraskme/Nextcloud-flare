import {
  assertExists,
  assertOneChange,
  atomicBatch,
  primary,
  type SqlStatement,
} from "../db/primary";
import type { CopyWriteKind } from "../db/r2Copy";
import { copyMultipartPartsProof } from "../db/r2Copy";
import { multipartPlan, UPLOAD_LIMITS } from "../do/uploadPlan";
import type { Env } from "../env";
import { consumeKnownLength } from "../platform/stream";
import { trackedR2Write } from "../services/r2Write";
import {
  acquireSystemMutation,
  commitSystemMutation,
  systemMutationStatements,
} from "../services/systemMutation";
import {
  advancedCopyPart,
  COPY_EXECUTION_LIMITS,
  type CopyJobClaim,
  checkCopyClaim,
  copyAuthorityStatements,
  copyClaimFence,
  copyClaimOffset,
  copyClaimPosition,
} from "./copyClaim";
import { copyObjectStatements } from "./copyObject";
import { advanceCopyBlob } from "./copyProgress";
import { copyNextSmallBlob } from "./copyPut";
import { withCopyJobRange } from "./copyRead";

type CopyEnv = Pick<Env, "DB" | "CONTROL" | "BLOBS">;
const CLOCK = "strftime('%s','now')*1000";
interface MultipartRow {
  destination_blob_id: string;
  init_attempt: string;
  init_claim: string;
  part_bytes: number;
  part_count: number;
  r2_upload_id: string | null;
  state: "creating" | "uploading" | "completing" | "stored";
  complete_attempt: string | null;
  complete_claim: string | null;
}
interface PartRow {
  part_number: number;
  expected_size: number;
  attempt_id: string;
  claim_token: string;
  state: "claimed" | "stored";
  sha256: string | null;
  etag: string | null;
}
const noPending = (key: string) =>
  assertExists(
    "SELECT 1 WHERE NOT EXISTS(SELECT 1 FROM r2_write_attempts WHERE r2_key=? AND state='pending')",
    [key],
  );
function nativeReceipt(
  claim: CopyJobClaim,
  sourceId: string,
  key: string,
  kind: CopyWriteKind,
  attempt: string,
) {
  return assertExists(
    "SELECT 1 FROM r2_write_attempts WHERE kind=? AND r2_key=? AND source_ref=? AND state='succeeded'",
    [kind, key, JSON.stringify([claim.id, sourceId, attempt])],
  );
}

/** One bounded step: initialize, stream a part, reconcile part progress, or finish one blob. */
export async function copyNextBlob(
  env: CopyEnv,
  claim: CopyJobClaim,
  partBytes: number = UPLOAD_LIMITS.defaultPartBytes,
): Promise<"initialized" | "part" | "stored" | "ready"> {
  checkCopyClaim(claim);
  const position = copyClaimPosition(claim),
    blob = claim.plan.source.blobs[position];
  if (!blob || blob.size <= COPY_EXECUTION_LIMITS.rangeBytes) return copyNextSmallBlob(env, claim);
  const witness = claim.plan.source.entries.find((n) => n.blobId === blob.id)!;
  const mapping = await primary(env.DB)
    .prepare(
      "SELECT destination_blob_id,transfer_state,transfer_mode FROM copy_job_blobs WHERE job_id=? AND source_blob_id=?",
    )
    .bind(claim.id, blob.id)
    .first<{ destination_blob_id: string; transfer_state: string; transfer_mode: string }>();
  if (!mapping) throw new Error("copy_transfer_unavailable");
  const id = mapping.destination_blob_id,
    key = `u/${claim.plan.destinationOwnerId}/b/${id}`;
  const prepare = async (
    kind: "copy.multipart-init" | "copy.multipart-part" | "copy.multipart-complete",
    statements: SqlStatement[],
  ) => {
    const authority = await copyAuthorityStatements(env.DB, claim.plan, witness.id);
    const admission = await acquireSystemMutation(
      env,
      claim.plan.destinationOwnerId,
      kind,
      claim.expiresAt,
    );
    checkCopyClaim(claim);
    await atomicBatch(
      env.DB,
      systemMutationStatements(admission, claim.plan.destinationOwnerId, [
        copyClaimFence(claim),
        ...authority,
        noPending(key),
        ...statements,
      ]),
    );
    checkCopyClaim(claim);
  };
  const proof = (attemptId: string, r2UploadId?: string, partNumber?: number) => ({
    jobId: claim.id,
    sourceBlobId: blob.id,
    attemptId,
    claimToken: claim.token,
    expiresAt: claim.expiresAt,
    ...(r2UploadId ? { r2UploadId } : {}),
    ...(partNumber ? { partNumber } : {}),
  });
  const facts = async (
    kind: "copy.multipart-handle" | "copy.multipart-part-stored" | "copy.multipart-stored",
    statements: SqlStatement[],
  ) => {
    const admission = await acquireSystemMutation(env, claim.plan.destinationOwnerId, kind);
    await commitSystemMutation(env.DB, admission, claim.plan.destinationOwnerId, statements);
  };
  const partProgress = async (part: PartRow, row: MultipartRow) => {
    const offset = Math.min(blob.size, part.part_number * row.part_bytes);
    const authority = await copyAuthorityStatements(env.DB, claim.plan, witness.id);
    const admission = await acquireSystemMutation(
      env,
      claim.plan.destinationOwnerId,
      "copy.multipart-progress",
      claim.expiresAt,
    );
    checkCopyClaim(claim);
    await commitSystemMutation(env.DB, admission, claim.plan.destinationOwnerId, [
      copyClaimFence(claim),
      ...authority,
      noPending(key),
      nativeReceipt(claim, blob.id, key, "copy.multipart.part", part.attempt_id),
      assertExists(
        "SELECT 1 FROM copy_multipart_parts WHERE destination_blob_id=? AND part_number=? AND attempt_id=? AND state='stored' AND expected_size=?",
        [id, part.part_number, part.attempt_id, part.expected_size],
      ),
      {
        sql: `UPDATE bulk_jobs SET checkpoint=?,updated_at=MAX(updated_at,${CLOCK}) WHERE id=?`,
        values: [JSON.stringify({ v: 1, blob: position, offset }), claim.id],
      },
      assertOneChange,
      {
        sql: "UPDATE job_leases SET attempt=1 WHERE job_id=? AND claim_token=?",
        values: [claim.id, claim.token],
      },
      assertOneChange,
    ]);
    advancedCopyPart(claim, offset);
  };
  if (mapping.transfer_state === "pending") {
    const geometry = multipartPlan(blob.size, partBytes),
      attempt = crypto.randomUUID();
    await prepare("copy.multipart-init", [
      {
        sql: "UPDATE copy_job_blobs SET transfer_mode='multipart',transfer_state='claimed',transfer_attempt=?,transfer_claim=?,transfer_node_id=? WHERE job_id=? AND source_blob_id=? AND transfer_state='pending'",
        values: [attempt, claim.token, witness.id, claim.id, blob.id],
      },
      assertOneChange,
      {
        sql: `INSERT INTO blobs(id,owner_id,r2_key,size,content_etag,mime_sniffed,state,created_at) VALUES(?,?,?,?,?,?,'staging',${CLOCK})`,
        values: [id, claim.plan.destinationOwnerId, key, blob.size, '"b-' + id + '"', blob.mime],
      },
      {
        sql: "INSERT INTO copy_multipart_uploads(destination_blob_id,init_attempt,init_claim,part_bytes,part_count,state) VALUES(?,?,?,?,?,'creating')",
        values: [id, attempt, claim.token, geometry.partBytes, geometry.partCount],
      },
    ]);
    const record = async (handle: R2MultipartUpload) => {
      if (handle.key !== key || !handle.uploadId || handle.uploadId.length > 1024)
        throw new Error("copy_multipart_mismatch");
      await facts("copy.multipart-handle", [
        {
          sql: "UPDATE copy_multipart_uploads SET r2_upload_id=?,state='uploading' WHERE destination_blob_id=? AND init_attempt=? AND init_claim=? AND state IN ('creating','uploading') AND (r2_upload_id IS NULL OR r2_upload_id=?)",
          values: [handle.uploadId, id, attempt, claim.token, handle.uploadId],
        },
        assertOneChange,
      ]);
    };
    const handle = await trackedR2Write(
      env,
      {
        epoch: claim.epoch,
        ownerId: claim.plan.destinationOwnerId,
        kind: "copy.multipart.create",
        key,
        copy: proof(attempt),
      },
      async () => {
        const handle = await env.BLOBS.createMultipartUpload(key, {
          customMetadata: { copy_job: claim.id, copy_blob: id, copy_attempt: attempt },
        });
        try {
          await record(handle);
        } catch {
          /* Preserve native completion independently of observation ACK. */
        }
        return handle;
      },
      claim.expiresAt,
      () => checkCopyClaim(claim),
    );
    await record(handle);
    checkCopyClaim(claim);
    return "initialized";
  }
  if (mapping.transfer_mode !== "multipart") throw new Error("copy_transfer_unavailable");
  const row = await primary(env.DB)
    .prepare("SELECT * FROM copy_multipart_uploads WHERE destination_blob_id=?")
    .bind(id)
    .first<MultipartRow>();
  if (!row || row.state === "creating" || !row.r2_upload_id)
    throw new Error("copy_multipart_unsettled");
  if (row.state === "stored") {
    await advanceCopyBlob(env, claim);
    return "stored";
  }
  if (row.state === "completing") throw new Error("copy_multipart_unsettled");
  const last = await primary(env.DB)
    .prepare(
      "SELECT * FROM copy_multipart_parts WHERE destination_blob_id=? ORDER BY part_number DESC LIMIT 1",
    )
    .bind(id)
    .first<PartRow>();
  if (last?.state === "claimed") throw new Error("copy_part_unsettled");
  if (last && copyClaimOffset(claim) < Math.min(blob.size, last.part_number * row.part_bytes)) {
    await partProgress(last, row);
    return "part";
  }
  const number = (last?.part_number ?? 0) + 1;
  if (number <= row.part_count) {
    const expected = Math.min(row.part_bytes, blob.size - (number - 1) * row.part_bytes),
      attempt = crypto.randomUUID();
    await prepare("copy.multipart-part", [
      {
        sql: "INSERT INTO copy_multipart_parts(destination_blob_id,part_number,expected_size,attempt_id,claim_token,state) VALUES(?,?,?,?,?,'claimed')",
        values: [id, number, expected, attempt, claim.token],
      },
    ]);
    let actual: R2UploadedPart | undefined, produced: { bytes: number; sha256: string } | undefined;
    let observation: Promise<void> | undefined, settlementError: unknown;
    const observe = () => {
      if (!actual || !produced || observation) return;
      const native = actual,
        source = produced;
      observation = (async () => {
        if (
          native.partNumber !== number ||
          !native.etag ||
          native.etag.length > 1024 ||
          source.bytes !== expected
        )
          throw new Error("copy_part_mismatch");
        await facts("copy.multipart-part-stored", [
          assertExists(
            "SELECT 1 FROM copy_multipart_uploads WHERE destination_blob_id=? AND r2_upload_id=?",
            [id, row.r2_upload_id],
          ),
          {
            sql: "UPDATE copy_multipart_parts SET state='stored',sha256=?,etag=? WHERE destination_blob_id=? AND part_number=? AND attempt_id=? AND claim_token=?",
            values: [source.sha256, native.etag, id, number, attempt, claim.token],
          },
          assertOneChange,
        ]);
      })();
      void observation.catch(() => undefined);
    };
    await withCopyJobRange(
      env,
      claim,
      { blobId: blob.id, offset: (number - 1) * row.part_bytes, length: expected },
      (source) =>
        consumeKnownLength(
          source,
          expected,
          async (body) => {
            try {
              return await trackedR2Write(
                env,
                {
                  epoch: claim.epoch,
                  ownerId: claim.plan.destinationOwnerId,
                  kind: "copy.multipart.part",
                  key,
                  copy: proof(attempt, row.r2_upload_id!, number),
                },
                async () => {
                  actual = await env.BLOBS.resumeMultipartUpload(key, row.r2_upload_id!).uploadPart(
                    number,
                    body,
                  );
                  observe();
                  return actual;
                },
                claim.expiresAt,
                () => checkCopyClaim(claim),
              );
            } catch (error) {
              if (!actual) throw error;
              settlementError = error;
              return actual;
            }
          },
          undefined,
          (value) => {
            produced = value;
            observe();
          },
        ),
    );
    observe();
    if (!observation) throw new Error("copy_part_unsettled");
    await observation;
    if (settlementError) throw settlementError;
    await partProgress(
      {
        part_number: number,
        expected_size: expected,
        attempt_id: attempt,
        claim_token: claim.token,
        state: "stored",
        sha256: produced!.sha256,
        etag: actual!.etag,
      },
      row,
    );
    return "part";
  }
  const attempt = crypto.randomUUID();
  await prepare("copy.multipart-complete", [
    copyMultipartPartsProof(key),
    {
      sql: "UPDATE copy_multipart_uploads SET state='completing',complete_attempt=?,complete_claim=? WHERE destination_blob_id=? AND state='uploading'",
      values: [attempt, claim.token, id],
    },
    assertOneChange,
  ]);
  const parts = await primary(env.DB)
    .prepare(
      "SELECT part_number AS partNumber,etag FROM copy_multipart_parts WHERE destination_blob_id=? ORDER BY part_number LIMIT 10000",
    )
    .bind(id)
    .all<R2UploadedPart>();
  if (parts.results.length !== row.part_count) throw new Error("copy_parts_incomplete");
  const observe = (object: R2Object) =>
    facts(
      "copy.multipart-stored",
      copyObjectStatements(
        {
          jobId: claim.id,
          sourceBlobId: blob.id,
          destinationBlobId: id,
          ownerId: claim.plan.destinationOwnerId,
          size: blob.size,
          attemptId: attempt,
          claimToken: claim.token,
          mode: "multipart",
          r2UploadId: row.r2_upload_id!,
        },
        object,
      ),
    );
  const object = await trackedR2Write(
    env,
    {
      epoch: claim.epoch,
      ownerId: claim.plan.destinationOwnerId,
      kind: "copy.multipart.complete",
      key,
      copy: proof(attempt, row.r2_upload_id),
    },
    async () => {
      const result = await env.BLOBS.resumeMultipartUpload(key, row.r2_upload_id!).complete(
        parts.results,
      );
      try {
        await observe(result);
      } catch {
        /* Keep the independent native completion fact. */
      }
      return result;
    },
    claim.expiresAt,
    () => checkCopyClaim(claim),
  );
  await observe(object);
  await advanceCopyBlob(env, claim);
  return "stored";
}
