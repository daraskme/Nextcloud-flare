import type { SqlStatement } from "./primary";
import { isAbortWrite, type R2AbortProof, validateAbortWrite } from "./r2Abort";
import { type R2BackupDeleteProof, validateBackupDelete } from "./r2BackupDelete";
import { type R2BackupsProbeProof, validateBackupsProbeWrite } from "./r2BackupsProbe";
import { type CopyWriteKind, isCopyWrite, type R2CopyProof, validateCopyWrite } from "./r2Copy";
import { type R2ProbeProof, validateProbeWrite } from "./r2Probe";
import {
  isUploadWrite,
  type R2UploadProof,
  type UploadWriteKind,
  validateUploadWrite,
} from "./r2Upload";
import { type RestorePause, restorePauseCondition } from "./restorePause";

export type R2WriteKind =
  | CopyWriteKind
  | "backup.delete"
  | "backups.probe.put"
  | "probe.put"
  | "multipart.abort"
  | "bucket.abort"
  | UploadWriteKind
  | "empty.put"
  | "manifest.put"
  | "manifest.delete"
  | "blob.delete"
  | "orphan.delete";
export type R2WriteTerminal = "succeeded" | "not_started";
export interface R2GcProof {
  claimToken: string;
  mode: boolean | RestorePause;
  blobId?: string;
  object?: {
    bytes: number;
    r2_etag: string;
    r2_version: string;
    uploaded_at: number;
    first_seen_at: number;
  };
}
export interface R2WriteRequest {
  id: string;
  epoch: number;
  ownerId: string | null;
  kind: R2WriteKind;
  key: string;
  deadline: number;
  gc?: R2GcProof;
  upload?: R2UploadProof;
  abort?: R2AbortProof;
  probe?: R2ProbeProof;
  backups?: R2BackupsProbeProof;
  prune?: R2BackupDeleteProof;
  copy?: R2CopyProof;
}
export interface R2WriteGrant extends R2WriteRequest {
  token: string;
  startedAt: number;
}
const uuid = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
export function validateR2Write(request: R2WriteRequest): void {
  if (
    !request ||
    !uuid.test(request.id) ||
    !Number.isSafeInteger(request.epoch) ||
    request.epoch < 1 ||
    (request.kind === "orphan.delete" ||
    request.kind === "bucket.abort" ||
    request.kind === "backup.delete" ||
    request.kind === "backups.probe.put" ||
    request.kind === "probe.put"
      ? request.ownerId !== null
      : typeof request.ownerId !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(request.ownerId)) ||
    !Number.isSafeInteger(request.deadline) ||
    typeof request.key !== "string" ||
    (request.kind === "probe.put" ||
    request.kind === "backups.probe.put" ||
    request.kind === "backup.delete"
      ? false
      : request.kind === "blob.delete" ||
          request.kind === "orphan.delete" ||
          isUploadWrite(request.kind) ||
          isCopyWrite(request.kind) ||
          isAbortWrite(request.kind)
        ? !request.key.startsWith("u/") || new TextEncoder().encode(request.key).length > 1024
        : request.kind === "empty.put"
          ? !request.key.startsWith(`u/${request.ownerId}/b/op_`) ||
            !/^u\/[A-Za-z0-9_-]+\/b\/op_[a-f0-9]{64}_blob$/.test(request.key)
          : !["manifest.put", "manifest.delete"].includes(request.kind) ||
            !request.key.startsWith("target-sets/") ||
            !uuid.test(request.key.slice(12)))
  )
    throw new Error("invalid_r2_write");
  if (isCopyWrite(request.kind)) {
    validateCopyWrite(request);
    return;
  }
  if (request.copy !== undefined) throw new Error("invalid_r2_write");
  if (request.kind === "backup.delete") {
    validateBackupDelete(request);
    return;
  }
  if (request.prune !== undefined) throw new Error("invalid_r2_write");
  if (request.kind === "backups.probe.put") {
    validateBackupsProbeWrite(request);
    return;
  }
  if (request.backups !== undefined) throw new Error("invalid_r2_write");
  if (request.kind === "probe.put") {
    validateProbeWrite(request);
    return;
  }
  if (request.probe !== undefined) throw new Error("invalid_r2_write");
  if (isUploadWrite(request.kind)) {
    if (request.abort !== undefined) throw new Error("invalid_r2_write");
    validateUploadWrite(request);
    return;
  }
  if (isAbortWrite(request.kind)) {
    validateAbortWrite(request);
    return;
  }
  if (request.abort !== undefined) throw new Error("invalid_r2_write");
  if (request.upload !== undefined) throw new Error("invalid_r2_write");
  if (request.kind !== "blob.delete" && request.kind !== "orphan.delete") {
    if (request.gc !== undefined) throw new Error("invalid_r2_write");
    return;
  }
  const gc = request.gc;
  if (!gc || !uuid.test(gc.claimToken)) throw new Error("invalid_r2_write");
  if (typeof gc.mode !== "boolean") {
    if (
      !gc.mode ||
      request.kind !== "blob.delete" ||
      gc.mode.epoch !== request.epoch ||
      gc.mode.expiresAt < request.deadline
    )
      throw new Error("invalid_r2_write");
    restorePauseCondition(gc.mode);
  }
  if (request.kind === "blob.delete") {
    if (typeof gc.blobId !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(gc.blobId) || gc.object)
      throw new Error("invalid_r2_write");
  } else {
    const object = gc.object;
    if (
      gc.blobId ||
      !object ||
      !Number.isSafeInteger(object.bytes) ||
      object.bytes < 0 ||
      typeof object.r2_etag !== "string" ||
      !object.r2_etag ||
      object.r2_etag.length > 256 ||
      typeof object.r2_version !== "string" ||
      !object.r2_version ||
      object.r2_version.length > 1024 ||
      !Number.isSafeInteger(object.uploaded_at) ||
      object.uploaded_at < 0 ||
      !Number.isSafeInteger(object.first_seen_at) ||
      object.first_seen_at < 0
    )
      throw new Error("invalid_r2_write");
  }
}
export function validateR2WriteGrant(grant: R2WriteGrant): void {
  validateR2Write(grant);
  if (
    !uuid.test(grant.token) ||
    !Number.isSafeInteger(grant.startedAt) ||
    grant.startedAt < 0 ||
    grant.deadline <= grant.startedAt ||
    grant.deadline > grant.startedAt + 5000
  )
    throw new Error("invalid_r2_write");
}
export const R2_WRITE_IDENTITY =
  "id=? AND token=? AND epoch=? AND owner_id IS ? AND kind=? AND r2_key=? AND dispatch_before=? AND started_at=? AND source_ref IS ?";
export function r2WriteSourceRef(g: R2WriteRequest): string | null {
  if (g.copy) return JSON.stringify([g.copy.jobId, g.copy.sourceBlobId, g.copy.attemptId]);
  if (g.prune)
    return JSON.stringify([g.epoch, g.prune.generation.id, g.prune.attemptId, g.prune.phase]);
  if (g.backups)
    return JSON.stringify([g.epoch, g.backups.id, g.backups.attemptId, g.backups.nonce]);
  if (g.probe) return JSON.stringify([g.epoch, g.probe.token, g.probe.nonce]);
  if (g.upload) return JSON.stringify([g.upload.id, g.upload.attemptId]);
  if (g.abort?.source === "copy")
    return JSON.stringify(["copy", g.abort.jobId, g.abort.sourceBlobId, g.abort.attemptId]);
  if (g.abort)
    return JSON.stringify([
      g.abort.source,
      g.abort.uploadId ?? g.abort.handleId,
      g.abort.attemptId,
      g.abort.source === "inventory" ? g.abort.handleId : null,
    ]);
  return null;
}
export function r2WriteValues(g: R2WriteGrant) {
  return [
    g.id,
    g.token,
    g.epoch,
    g.ownerId,
    g.kind,
    g.key,
    g.deadline,
    g.startedAt,
    r2WriteSourceRef(g),
  ];
}
export function insertR2Write(g: R2WriteGrant, state: "pending" | R2WriteTerminal): SqlStatement {
  return {
    sql: `INSERT INTO r2_write_attempts(id,token,epoch,owner_id,kind,r2_key,dispatch_before,started_at,source_ref,state,finished_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,${state === "pending" ? "NULL" : "MAX(?,strftime('%s','now')*1000)"})`,
    values: [...r2WriteValues(g), state, ...(state === "pending" ? [] : [g.startedAt])],
  };
}
