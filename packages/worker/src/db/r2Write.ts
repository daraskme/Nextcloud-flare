import type { SqlStatement } from "./primary";

export type R2WriteKind = "empty.put" | "manifest.put" | "manifest.delete";
export type R2WriteTerminal = "succeeded" | "not_started";
export interface R2WriteRequest {
  id: string;
  epoch: number;
  ownerId: string;
  kind: R2WriteKind;
  key: string;
  deadline: number;
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
    typeof request.ownerId !== "string" ||
    !/^[A-Za-z0-9_-]{1,128}$/.test(request.ownerId) ||
    !Number.isSafeInteger(request.deadline) ||
    typeof request.key !== "string" ||
    (request.kind === "empty.put"
      ? !request.key.startsWith(`u/${request.ownerId}/b/op_`) ||
        !/^u\/[A-Za-z0-9_-]+\/b\/op_[a-f0-9]{64}_blob$/.test(request.key)
      : !["manifest.put", "manifest.delete"].includes(request.kind) ||
        !request.key.startsWith("target-sets/") ||
        !uuid.test(request.key.slice(12)))
  )
    throw new Error("invalid_r2_write");
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
  "id=? AND token=? AND epoch=? AND owner_id=? AND kind=? AND r2_key=? AND dispatch_before=? AND started_at=?";
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
