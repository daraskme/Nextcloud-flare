import {
  RESTORE_BACKUPS_PROBE_KEY,
  type RestoreBackupsTarget,
  restoreBackupsTarget,
} from "../../../shared/src/restoreBackups";
import { type RestoreD1Challenge, restoreD1Challenge } from "../../../shared/src/restoreTarget";
import { assertExists, type SqlStatement } from "./primary";
import type { R2WriteRequest } from "./r2Write";

export interface R2BackupsProbeProof {
  id: string;
  attemptId: string;
  challenge: RestoreD1Challenge;
  source: RestoreBackupsTarget;
  nonce: string;
  expectedEtag: string | null;
  expiresAt: number;
}
const uuid = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
export function validateBackupsProbeWrite(request: R2WriteRequest): void {
  const p = request.backups;
  if (
    !p ||
    request.ownerId !== null ||
    request.key !== RESTORE_BACKUPS_PROBE_KEY ||
    request.gc !== undefined ||
    request.upload !== undefined ||
    request.abort !== undefined ||
    request.probe !== undefined ||
    !uuid.test(p.id) ||
    !uuid.test(p.attemptId) ||
    typeof p.nonce !== "string" ||
    !/^[a-f0-9]{64}$/.test(p.nonce) ||
    !(
      p.expectedEtag === null ||
      (typeof p.expectedEtag === "string" &&
        p.expectedEtag.length > 0 &&
        p.expectedEtag.length <= 256)
    ) ||
    !Number.isSafeInteger(p.expiresAt) ||
    p.expiresAt < request.deadline
  )
    throw new Error("invalid_r2_write");
  const c = restoreD1Challenge(p.challenge, request.epoch, p.id, p.challenge?.target);
  const source = restoreBackupsTarget(p.source);
  if (
    c.target.mode !== "remote" ||
    c.target.accountId !== source.accountId ||
    p.expiresAt > c.expiresAt
  )
    throw new Error("invalid_r2_write");
}

/** The original DO challenge is checked around this atomic D1 stop/dispatch fence. */
export function backupsProbeWriteProof(request: R2WriteRequest): SqlStatement[] {
  const c = request.backups!.challenge;
  return [
    assertExists(
      `SELECT 1 FROM control WHERE singleton=1 AND epoch=? AND maintenance=1 AND gc_paused=1
      AND admission_revision=? AND admission_token=? AND backup_token IS NULL
      AND backup_frozen=0 AND restore_freeze_token IS NULL`,
      [request.epoch, c.revision, c.token],
    ),
  ];
}
