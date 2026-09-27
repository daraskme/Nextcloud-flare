import {
  type BackupGeneration,
  backupManifestKey,
  backupPartKey,
} from "../../../shared/src/backupPublication";
import { BACKUP_MAX_AGE_MS } from "../../../shared/src/backupRetention";
import { assertExists, type SqlStatement } from "./primary";
import type { R2WriteGrant, R2WriteRequest } from "./r2Write";

export interface BackupDeleteAuthority {
  epoch: number;
  token: string | null;
  phase: string | null;
  admission: { maintenance: 0 | 1; revision: number; token: string | null };
}
export interface R2BackupDeleteProof {
  attemptId: string;
  generation: BackupGeneration & {
    completedAt: number;
    releasedAt: number;
    manifestSha256: string;
  };
  phase: "parts" | "manifest";
  keys: string[];
  authority: BackupDeleteAuthority;
}
const uuid = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
const timestamp = (n: unknown): n is number => Number.isSafeInteger(n) && (n as number) >= 0;
export function validateBackupDelete(request: R2WriteRequest): void {
  const p = request.prune,
    g = p?.generation,
    a = p?.authority,
    s = a?.admission;
  if (
    !p ||
    !g ||
    !a ||
    !s ||
    request.ownerId !== null ||
    request.gc !== undefined ||
    request.upload !== undefined ||
    request.abort !== undefined ||
    request.probe !== undefined ||
    request.backups !== undefined ||
    !uuid.test(p.attemptId) ||
    !uuid.test(g.id) ||
    !uuid.test(g.token) ||
    !Number.isSafeInteger(g.epoch) ||
    g.epoch < 1 ||
    g.epoch > request.epoch ||
    !timestamp(g.createdAt) ||
    !timestamp(g.completedAt) ||
    !timestamp(g.releasedAt) ||
    g.completedAt < g.createdAt ||
    g.releasedAt < g.createdAt ||
    !(
      g.watermark === null ||
      (typeof g.watermark === "string" && g.watermark.length > 0 && g.watermark.length <= 128)
    ) ||
    typeof g.manifestSha256 !== "string" ||
    !/^[a-f0-9]{64}$/.test(g.manifestSha256) ||
    request.key !== backupManifestKey(g.id) ||
    a.epoch !== request.epoch ||
    !(
      (a.phase === null && a.token === null) ||
      (a.phase === "released" && typeof a.token === "string" && uuid.test(a.token))
    ) ||
    ![0, 1].includes(s.maintenance) ||
    !timestamp(s.revision) ||
    !(s.token === null || uuid.test(s.token)) ||
    !Array.isArray(p.keys) ||
    p.keys.length < 1 ||
    p.keys.length > 20 ||
    new Set(p.keys).size !== p.keys.length
  )
    throw new Error("invalid_r2_write");
  if (p.phase === "manifest") {
    if (p.keys.length !== 1 || p.keys[0] !== request.key) throw new Error("invalid_r2_write");
  } else if (p.phase === "parts") {
    const prefix = `sys/backups/v1/${g.id}/`;
    for (const key of p.keys) {
      const match =
        typeof key === "string" && key.startsWith(prefix)
          ? /^parts\/(\d{6})-([a-f0-9]{64})\.bin$/.exec(key.slice(prefix.length))
          : null;
      if (!match || backupPartKey(g.id, Number(match[1]), match[2]!) !== key)
        throw new Error("invalid_r2_write");
    }
  } else throw new Error("invalid_r2_write");
}

/** The completed generation and original stop are rechecked atomically with dispatch. */
export function backupDeleteProof(request: R2WriteGrant): SqlStatement[] {
  const p = request.prune!,
    g = p.generation,
    a = p.authority.admission;
  return [
    assertExists(
      `SELECT 1 FROM control WHERE singleton=1 AND epoch=? AND maintenance=?
      AND admission_revision=? AND admission_token IS ? AND backup_token IS NULL AND backup_frozen=0 AND restore_freeze_token IS NULL`,
      [request.epoch, a.maintenance, a.revision, a.token],
    ),
    assertExists(
      `SELECT 1 FROM backup_runs WHERE id=? AND epoch=? AND state='completed' AND created_at=?
      AND completed_at=? AND released_at=? AND barrier_token=? AND watermark IS ? AND manifest_key=? AND manifest_sha256=?
      AND created_at<? AND completed_at<=? AND released_at<=?`,
      [
        g.id,
        g.epoch,
        g.createdAt,
        g.completedAt,
        g.releasedAt,
        g.token,
        g.watermark,
        request.key,
        g.manifestSha256,
        request.startedAt - BACKUP_MAX_AGE_MS,
        request.startedAt,
        request.startedAt,
      ],
    ),
    assertExists(
      "SELECT 1 WHERE NOT EXISTS(SELECT 1 FROM r2_write_attempts WHERE kind='backup.delete' AND r2_key=? AND state='pending')",
      [request.key],
    ),
  ];
}
