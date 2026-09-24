import { assertExists, assertOneChange, atomicBatch, primary } from "../db/primary";
import type { R2S3Inventory } from "../r2/s3Inventory";
import { type VerifiedR2Inventory, withVerifiedR2Inventory } from "./r2BindingVerification";

const CLOCK = "strftime('%s','now')*1000";
const UUID = /^[a-f\d]{8}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{12}$/;
interface Handle {
  id: string;
  source: string;
  r2_key: string;
  r2_upload_id: string;
  held_bytes: number;
}
interface Attempt {
  id: string;
  handle_id: string;
  epoch: number;
  outcome: "started" | "confirmed" | "unconfirmed";
}
export interface MultipartBucketAbortResult {
  attemptId: string;
  outcome: "confirmed" | "unconfirmed";
  replayed: boolean;
  heldBytes: number;
}

/** One explicit attempt. A retry of its ID never dispatches R2 again, even after an unknown ACK. */
export async function abortMultipartBucketHandle(
  db: D1Database,
  bucket: R2Bucket,
  inventory: R2S3Inventory,
  epoch: number,
  handleId: string,
  attemptId: string,
  options: { maxWaitMs?: number } = {},
): Promise<MultipartBucketAbortResult> {
  const wait = options.maxWaitMs ?? 10_000;
  if (
    !Number.isSafeInteger(epoch) ||
    epoch < 1 ||
    typeof handleId !== "string" ||
    !UUID.test(handleId) ||
    typeof attemptId !== "string" ||
    !UUID.test(attemptId) ||
    !Number.isSafeInteger(wait) ||
    wait < 1 ||
    wait > 10_000
  )
    throw new Error("invalid_multipart_bucket_abort");
  return withVerifiedR2Inventory(db, bucket, inventory, epoch, (verified) =>
    abortVerified(db, verified, epoch, handleId, attemptId, wait),
  );
}

async function abortVerified(
  db: D1Database,
  verified: VerifiedR2Inventory,
  epoch: number,
  handleId: string,
  attemptId: string,
  wait: number,
): Promise<MultipartBucketAbortResult> {
  const source = JSON.stringify(verified.observation.source);
  const handle = await primary(db)
    .prepare(
      "SELECT id,source,r2_key,r2_upload_id,held_bytes FROM multipart_bucket_handles WHERE id=? AND source=? AND state='quarantined'",
    )
    .bind(handleId, source)
    .first<Handle>();
  if (!handle) throw new Error("multipart_bucket_handle_unavailable");
  const previous = await primary(db)
    .prepare("SELECT id,handle_id,epoch,outcome FROM multipart_bucket_abort_attempts WHERE id=?")
    .bind(attemptId)
    .first<Attempt>();
  if (previous) {
    if (previous.handle_id !== handleId || previous.epoch > epoch)
      throw new Error("multipart_bucket_abort_identity_conflict");
    await verified.assertCurrent();
    return {
      attemptId,
      outcome: previous.outcome === "confirmed" ? "confirmed" : "unconfirmed",
      replayed: true,
      heldBytes: handle.held_bytes,
    };
  }

  // The trigger checks completed bucket/part walks, current proof and competing uploads.
  // Its immutable ordinal is also the lifetime budget; unknown ACKs consume a slot.
  await atomicBatch(db, [
    verified.fence(),
    {
      sql: `INSERT INTO multipart_bucket_abort_attempts(
        id,handle_id,ordinal,epoch,proof_generation,scan_round_id,part_round_id,held_bytes,started_at)
      SELECT ?,h.id,(SELECT COALESCE(MAX(ordinal),0)+1 FROM multipart_bucket_abort_attempts WHERE handle_id=h.id),
        ?,p.generation,s.round_id,h.part_round_id,h.held_bytes,${CLOCK}
      FROM multipart_bucket_handles h JOIN multipart_bucket_scan s ON s.singleton=1
        JOIN r2_binding_probe p ON p.singleton=1
      WHERE h.id=? AND h.source=? AND h.r2_key=? AND h.r2_upload_id=? AND h.state='quarantined'`,
      values: [attemptId, epoch, handleId, source, handle.r2_key, handle.r2_upload_id],
    },
    assertOneChange,
  ]);

  // Only the confirmed insert dispatches. A lost insert reply must exit without R2 I/O.
  await verified.assertCurrent();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let error: "abort_unconfirmed" | "abort_timeout" | null;
  try {
    const abort = Promise.resolve()
      .then(() => verified.bucket.resumeMultipartUpload(handle.r2_key, handle.r2_upload_id).abort())
      .then(
        () => null,
        () => "abort_unconfirmed" as const,
      );
    error = await Promise.race([
      abort,
      new Promise<"abort_timeout">((resolve) => {
        timer = setTimeout(() => resolve("abort_timeout"), wait);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }

  // Late or ambiguous results never release held bytes or reopen recovery.
  await atomicBatch(db, [
    verified.fence(),
    assertExists(
      "SELECT 1 FROM multipart_bucket_abort_attempts WHERE id=? AND handle_id=? AND epoch=? AND outcome='started'",
      [attemptId, handleId, epoch],
    ),
    {
      sql: `UPDATE multipart_bucket_abort_attempts SET outcome=?,finished_at=MAX(started_at,${CLOCK}),error=? WHERE id=?`,
      values: [error === null ? "confirmed" : "unconfirmed", error, attemptId],
    },
    assertOneChange,
  ]);
  return {
    attemptId,
    outcome: error === null ? "confirmed" : "unconfirmed",
    replayed: false,
    heldBytes: handle.held_bytes,
  };
}
