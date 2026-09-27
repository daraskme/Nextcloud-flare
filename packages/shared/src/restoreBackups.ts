import { type RestoreBlobsTarget, restoreBlobsTarget } from "./restoreBlobs.ts";
import type { RestoreD1Challenge, RestoreD1Target } from "./restoreTarget.ts";

export const RESTORE_BACKUPS_PROBE_KEY = "sys/restore/binding-probe-v1";
export const RESTORE_BACKUPS_PROBE_KIND = "restore_backups_probe_v1";
export const RESTORE_BACKUPS_PROBE_BYTES = 64;
export const RESTORE_BACKUPS_WINDOW_MS = 60000;
export type RestoreBackupsTarget = RestoreBlobsTarget;

export function restoreBackupsTarget(input: unknown): RestoreBackupsTarget {
  try {
    return restoreBlobsTarget(input);
  } catch {
    throw new Error("database_restore_invalid_backups_target");
  }
}

/** No expected nonce is returned: it must be read independently through the pinned S3 target. */
export interface RestoreBackupsChallenge {
  id: string;
  epoch: number;
  target: RestoreD1Target;
  source: RestoreBackupsTarget;
  state: "backups_challenge";
  challengeId: string;
  revision: number;
  attemptId: string;
  issuedAt: number;
  expiresAt: number;
}

export function restoreBackupsChallenge(
  input: unknown,
  d1: RestoreD1Challenge,
  source: RestoreBackupsTarget,
): RestoreBackupsChallenge {
  const value = input as RestoreBackupsChallenge | null;
  if (
    !value ||
    value.id !== d1.id ||
    value.epoch !== d1.epoch ||
    value.state !== "backups_challenge" ||
    JSON.stringify(value.target) !== JSON.stringify(d1.target) ||
    JSON.stringify(restoreBackupsTarget(value.source)) !== JSON.stringify(source) ||
    value.challengeId !== d1.challengeId ||
    value.revision !== d1.revision ||
    typeof value.attemptId !== "string" ||
    !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(value.attemptId) ||
    !Number.isSafeInteger(value.issuedAt) ||
    value.issuedAt < d1.issuedAt ||
    value.issuedAt >= d1.expiresAt ||
    value.expiresAt !== Math.min(d1.expiresAt, value.issuedAt + RESTORE_BACKUPS_WINDOW_MS)
  )
    throw new Error("database_restore_invalid_backups_challenge");
  return {
    id: value.id,
    epoch: value.epoch,
    target: d1.target,
    source,
    state: value.state,
    challengeId: value.challengeId,
    revision: value.revision,
    attemptId: value.attemptId,
    issuedAt: value.issuedAt,
    expiresAt: value.expiresAt,
  };
}
