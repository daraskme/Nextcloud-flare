import { multipartCleanupFence } from "../jobs/multipartCleanup";
import { assertExists, primary, type SqlStatement } from "./primary";
import { copyAbortWriteProof } from "./r2CopyAbort";
import type { R2WriteRequest } from "./r2Write";

export interface InventoryBindingProof {
  epoch: number;
  token: string;
  nonce: string;
  source: string;
}
export interface R2AbortProof {
  source: "initialization" | "cleanup" | "inventory" | "bucket" | "copy";
  r2UploadId: string;
  attemptId: string;
  maintenance: boolean;
  uploadId?: string;
  sourceEpoch?: number;
  handleId?: string;
  scanRound?: string;
  knownUploadId?: string | null;
  binding?: InventoryBindingProof;
  jobId?: string;
  sourceBlobId?: string;
}
const uuid = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
export function isAbortWrite(kind: string): kind is "multipart.abort" | "bucket.abort" {
  return kind === "multipart.abort" || kind === "bucket.abort";
}
export function validateAbortWrite(request: R2WriteRequest): void {
  const p = request.abort;
  if (
    !p ||
    request.upload !== undefined ||
    request.gc !== undefined ||
    !["initialization", "cleanup", "inventory", "bucket", "copy"].includes(p.source) ||
    !uuid.test(p.attemptId) ||
    typeof p.maintenance !== "boolean" ||
    typeof p.r2UploadId !== "string" ||
    !p.r2UploadId ||
    p.r2UploadId.length > 1024 ||
    (request.kind === "bucket.abort") !== (p.source === "bucket") ||
    (p.source === "bucket" || p.source === "copy"
      ? p.uploadId !== undefined || p.sourceEpoch !== undefined
      : !/^up_[a-f0-9]{64}$/.test(p.uploadId ?? "") ||
        !Number.isSafeInteger(p.sourceEpoch) ||
        p.sourceEpoch! < 1 ||
        p.sourceEpoch! > request.epoch) ||
    (p.source === "inventory" || p.source === "bucket"
      ? !p.maintenance ||
        !uuid.test(p.handleId ?? "") ||
        !p.binding ||
        p.binding.epoch !== request.epoch ||
        !uuid.test(p.binding.token) ||
        !/^[a-f0-9]{64}$/.test(p.binding.nonce) ||
        typeof p.binding.source !== "string" ||
        p.binding.source.length < 1 ||
        p.binding.source.length > 1024
      : p.binding !== undefined || p.handleId !== undefined) ||
    (p.source === "inventory"
      ? !uuid.test(p.scanRound ?? "") ||
        !(
          p.knownUploadId === null ||
          (typeof p.knownUploadId === "string" &&
            p.knownUploadId.length > 0 &&
            p.knownUploadId.length <= 1024)
        )
      : p.scanRound !== undefined || p.knownUploadId !== undefined) ||
    (p.source === "copy"
      ? typeof p.jobId !== "string" ||
        typeof p.sourceBlobId !== "string" ||
        !/^copy_[a-f0-9]{64}$/.test(p.jobId ?? "") ||
        !/^[A-Za-z0-9_-]{1,128}$/.test(p.sourceBlobId ?? "")
      : p.jobId !== undefined || p.sourceBlobId !== undefined)
  )
    throw new Error("invalid_r2_write");
}
export function inventoryBindingFence(p: InventoryBindingProof, deadline: number): SqlStatement {
  return assertExists(
    `SELECT 1 FROM r2_binding_probe p JOIN control c ON c.singleton=p.singleton
    WHERE p.singleton=1 AND p.epoch=? AND c.epoch=p.epoch AND c.maintenance=1 AND c.gc_paused=1
    AND p.lease_token=? AND p.lease_expires_at>=? AND p.nonce=? AND p.source=? AND p.phase='verified'`,
    [p.epoch, p.token, deadline, p.nonce, p.source],
  );
}

/** A cleanup grant is scoped to its original claim/handle, even when the owner is disabled or absent. */
export async function abortWriteProof(
  db: D1Database,
  request: R2WriteRequest,
): Promise<SqlStatement[]> {
  const p = request.abort!;
  const guards = [
    assertExists(
      "SELECT 1 FROM control WHERE singleton=1 AND epoch=? AND maintenance=? AND (?=0 OR gc_paused=1)",
      [request.epoch, p.maintenance ? 1 : 0, p.maintenance ? 1 : 0],
    ),
  ];
  if (p.binding) guards.push(inventoryBindingFence(p.binding, request.deadline));
  if (p.source === "copy") return [...guards, copyAbortWriteProof(request)];
  if (p.source === "bucket") {
    guards.push(
      assertExists(
        `SELECT 1 FROM multipart_bucket_abort_attempts a
      JOIN multipart_bucket_handles h ON h.id=a.handle_id JOIN multipart_bucket_scan s ON s.singleton=1
      JOIN r2_binding_probe p ON p.singleton=1
      WHERE a.id=? AND a.handle_id=? AND a.epoch=? AND a.outcome='started'
      AND h.r2_key=? AND h.r2_upload_id=? AND h.state='quarantined'
      AND h.source=s.source AND s.source=p.source AND s.epoch=a.epoch AND h.part_epoch=a.epoch
      AND p.generation=a.proof_generation AND s.round_id=a.scan_round_id AND s.completed_at IS NOT NULL
      AND h.part_round_id=a.part_round_id AND h.parts_completed_at IS NOT NULL AND h.held_bytes=a.held_bytes
      AND NOT EXISTS(SELECT 1 FROM multipart_inventory_scans WHERE r2_key=h.r2_key AND completed_at IS NULL)
      AND NOT EXISTS(SELECT 1 FROM copy_job_blobs cb JOIN blobs b ON b.id=cb.destination_blob_id WHERE b.r2_key=h.r2_key)
      AND NOT EXISTS(SELECT 1 FROM uploads u JOIN blobs b ON b.id=u.blob_id WHERE b.r2_key=h.r2_key
        AND (u.state IN ('created','receiving','uploading','completing','aborting')
          OR COALESCE(u.write_lease_expires_at,0)>strftime('%s','now')*1000
          OR COALESCE(u.multipart_complete_lease,0)>strftime('%s','now')*1000
          OR COALESCE(u.cleanup_lease_expires_at,0)>strftime('%s','now')*1000
          OR EXISTS(SELECT 1 FROM upload_parts up WHERE up.upload_id=u.id
            AND up.state IN ('in_flight','unknown') AND up.lease_expires_at>strftime('%s','now')*1000)))`,
        [p.attemptId, p.handleId!, request.epoch, request.key, p.r2UploadId],
      ),
    );
    return guards;
  }
  guards.push(
    assertExists(
      `SELECT 1 FROM uploads u JOIN blobs b ON b.id=u.blob_id
    WHERE u.id=? AND u.owner_id=? AND u.epoch=? AND u.mode='multipart'
    AND b.owner_id=u.owner_id AND b.r2_key=? AND u.cleanup_pending=1`,
      [p.uploadId!, request.ownerId, p.sourceEpoch!, request.key],
    ),
  );
  if (p.source === "initialization") {
    guards.push(
      assertExists(
        `SELECT 1 FROM uploads WHERE id=? AND write_attempt_id=?
      AND (r2_upload_id IS NULL OR r2_upload_id=?) AND state IN ('created','failed','aborting','aborted','expired')`,
        [p.uploadId!, p.attemptId, p.r2UploadId],
      ),
    );
    return guards;
  }
  const row = await primary(db)
    .prepare("SELECT id,blob_id,r2_upload_id FROM uploads WHERE id=?")
    .bind(p.uploadId!)
    .first<{ id: string; blob_id: string; r2_upload_id: string | null }>();
  if (!row) throw new Error("r2_abort_unavailable");
  guards.push(
    multipartCleanupFence(row, p.attemptId),
    assertExists(
      "SELECT 1 FROM uploads WHERE id=? AND cleanup_lease_expires_at>=? AND multipart_cleanup_closed IS NULL",
      [p.uploadId!, request.deadline],
    ),
  );
  if (p.source === "cleanup")
    guards.push(
      assertExists("SELECT 1 FROM uploads WHERE id=? AND r2_upload_id=?", [
        p.uploadId!,
        p.r2UploadId,
      ]),
    );
  else
    guards.push(
      assertExists(
        `SELECT 1 FROM multipart_inventory_handles h
    JOIN multipart_inventory_scans s ON s.upload_id=h.upload_id JOIN uploads u ON u.id=h.upload_id
    WHERE h.id=? AND h.upload_id=? AND h.r2_upload_id=? AND h.state='observed'
    AND s.r2_key=? AND s.source=? AND s.epoch=? AND s.round_id=? AND s.completed_at IS NOT NULL
    AND u.r2_upload_id IS ? AND h.abort_source=s.source AND h.abort_token=?`,
        [
          p.handleId!,
          p.uploadId!,
          p.r2UploadId,
          request.key,
          p.binding!.source,
          request.epoch,
          p.scanRound!,
          p.knownUploadId!,
          p.attemptId,
        ],
      ),
    );
  return guards;
}
