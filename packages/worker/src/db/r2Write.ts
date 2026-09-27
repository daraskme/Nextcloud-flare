import type { SqlStatement } from "./primary";
import { type RestorePause, restorePauseCondition } from "./restorePause";

export type R2WriteKind =
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
    (request.kind === "orphan.delete"
      ? request.ownerId !== null
      : typeof request.ownerId !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(request.ownerId)) ||
    !Number.isSafeInteger(request.deadline) ||
    typeof request.key !== "string" ||
    (request.kind === "blob.delete" || request.kind === "orphan.delete"
      ? !request.key.startsWith("u/") || new TextEncoder().encode(request.key).length > 1024
      : request.kind === "empty.put"
        ? !request.key.startsWith(`u/${request.ownerId}/b/op_`) ||
          !/^u\/[A-Za-z0-9_-]+\/b\/op_[a-f0-9]{64}_blob$/.test(request.key)
        : !["manifest.put", "manifest.delete"].includes(request.kind) ||
          !request.key.startsWith("target-sets/") ||
          !uuid.test(request.key.slice(12)))
  )
    throw new Error("invalid_r2_write");
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
  "id=? AND token=? AND epoch=? AND owner_id IS ? AND kind=? AND r2_key=? AND dispatch_before=? AND started_at=?";
export function r2WriteValues(g: R2WriteGrant) {
  return [g.id, g.token, g.epoch, g.ownerId, g.kind, g.key, g.deadline, g.startedAt];
}
export function insertR2Write(g: R2WriteGrant, state: "pending" | R2WriteTerminal): SqlStatement {
  return {
    sql: `INSERT INTO r2_write_attempts(id,token,epoch,owner_id,kind,r2_key,dispatch_before,started_at,state,finished_at)
      VALUES(?,?,?,?,?,?,?,?,?,${state === "pending" ? "NULL" : "MAX(?,strftime('%s','now')*1000)"})`,
    values: [...r2WriteValues(g), state, ...(state === "pending" ? [] : [g.startedAt])],
  };
}
