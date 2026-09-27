import { restoreBookmark, restoreBookmarkTimestamp } from "./restoreBookmark.ts";
import { type RestoreFreezeTargets, restoreFreezeTargets } from "./restoreFreeze.ts";

export const RESTORE_DISPATCH_MS = 5000;
export interface RestoreTimeTravelResult {
  bookmark: string;
  previousBookmark: string;
}
export interface RestoreTimeTravelGrant {
  validator: "time-travel-dispatch-v1";
  id: string;
  epoch: number;
  newEpoch: number;
  targets: RestoreFreezeTargets;
  bookmark: string;
  timestamp: string;
  token: string;
  issuedAt: number;
  expiresAt: number;
}
export function restoreTimeTravelResult(input: unknown): RestoreTimeTravelResult {
  if (!input || typeof input !== "object" || Array.isArray(input))
    throw new Error("database_restore_invalid_result");
  const value = input as Record<string, unknown>;
  return {
    bookmark: restoreBookmark(value.bookmark),
    previousBookmark: restoreBookmark(value.previousBookmark),
  };
}
export function restoreTimeTravelGrant(input: RestoreTimeTravelGrant): RestoreTimeTravelGrant {
  const uuid = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
  if (
    !input ||
    input.validator !== "time-travel-dispatch-v1" ||
    typeof input.id !== "string" ||
    !uuid.test(input.id) ||
    typeof input.token !== "string" ||
    !uuid.test(input.token) ||
    !Number.isSafeInteger(input.epoch) ||
    input.epoch < 1 ||
    !Number.isSafeInteger(input.newEpoch) ||
    input.newEpoch <= input.epoch ||
    !Number.isSafeInteger(input.issuedAt) ||
    input.issuedAt < 1 ||
    !Number.isSafeInteger(input.expiresAt) ||
    input.expiresAt !== input.issuedAt + RESTORE_DISPATCH_MS
  )
    throw new Error("database_restore_invalid_grant");
  return {
    validator: input.validator,
    id: input.id,
    epoch: input.epoch,
    newEpoch: input.newEpoch,
    targets: restoreFreezeTargets(input.targets),
    bookmark: restoreBookmark(input.bookmark),
    timestamp: restoreBookmarkTimestamp(input.timestamp, input.issuedAt),
    token: input.token,
    issuedAt: input.issuedAt,
    expiresAt: input.expiresAt,
  };
}
