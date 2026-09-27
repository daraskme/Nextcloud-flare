import { type RestoreFreezeTargets, restoreFreezeTargets } from "./restoreFreeze.ts";
import { type RestoreTimeTravelResult, restoreTimeTravelResult } from "./restoreTimeTravel.ts";

export const RESTORE_SNAPSHOT_WINDOW_MS = 60 * 60 * 1000;
export interface RestoreSnapshotMirror {
  snapshotEpoch: number;
  controlSha256: string;
  schemaSha256: string;
  catalogueSha256: string;
  tables: string[];
}
export interface RestoreSnapshotChallenge {
  id: string;
  epoch: number;
  newEpoch: number;
  targets: RestoreFreezeTargets;
  restoreResult: RestoreTimeTravelResult;
  challengeId: string;
  issuedAt: number;
  expiresAt: number;
  mirror: RestoreSnapshotMirror;
}
export interface RestoreSnapshotProof {
  validator: "restored-snapshot-v1";
  schemaSha256: string;
  migrations: { name: string; sha256: string }[];
  data: { bytes: number; sha256: string };
  tables: { name: string; rows: number; sha256: string }[];
}
const hash = (value: unknown): value is string =>
  typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
const integer = (value: unknown): value is number =>
  Number.isSafeInteger(value) && (value as number) >= 0;
export function restoreSnapshotChallenge(
  input: RestoreSnapshotChallenge,
): RestoreSnapshotChallenge {
  const uuid = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
  if (
    !input ||
    !uuid.test(input.id) ||
    !uuid.test(input.challengeId) ||
    !integer(input.epoch) ||
    input.epoch < 1 ||
    !integer(input.newEpoch) ||
    input.newEpoch <= input.epoch ||
    !integer(input.issuedAt) ||
    !integer(input.expiresAt) ||
    input.expiresAt !== input.issuedAt + RESTORE_SNAPSHOT_WINDOW_MS ||
    !integer(input.mirror?.snapshotEpoch) ||
    input.mirror.snapshotEpoch < 1 ||
    input.mirror.snapshotEpoch > input.epoch ||
    !hash(input.mirror.controlSha256) ||
    !hash(input.mirror.schemaSha256) ||
    !hash(input.mirror.catalogueSha256) ||
    !Array.isArray(input.mirror.tables) ||
    input.mirror.tables.length < 1 ||
    input.mirror.tables.length > 100 ||
    input.mirror.tables.some(
      (name) => typeof name !== "string" || !/^[a-z_][a-z_0-9]*$/.test(name),
    ) ||
    JSON.stringify(input.mirror.tables) !== JSON.stringify([...new Set(input.mirror.tables)].sort())
  )
    throw new Error("database_restore_invalid_snapshot_challenge");
  return {
    id: input.id,
    epoch: input.epoch,
    newEpoch: input.newEpoch,
    targets: restoreFreezeTargets(input.targets),
    restoreResult: restoreTimeTravelResult(input.restoreResult),
    challengeId: input.challengeId,
    issuedAt: input.issuedAt,
    expiresAt: input.expiresAt,
    mirror: {
      snapshotEpoch: input.mirror.snapshotEpoch,
      controlSha256: input.mirror.controlSha256,
      schemaSha256: input.mirror.schemaSha256,
      catalogueSha256: input.mirror.catalogueSha256,
      tables: [...input.mirror.tables],
    },
  };
}
export function restoreSnapshotProof(
  input: RestoreSnapshotProof,
  challenge: RestoreSnapshotChallenge,
): RestoreSnapshotProof {
  if (
    !input ||
    input.validator !== "restored-snapshot-v1" ||
    !hash(input.schemaSha256) ||
    !integer(input.data?.bytes) ||
    input.data.bytes < 1 ||
    !hash(input.data.sha256) ||
    !Array.isArray(input.migrations) ||
    input.migrations.length < 37 ||
    input.migrations.length > 1000 ||
    input.migrations.some(
      (m) =>
        !m ||
        typeof m.name !== "string" ||
        !/^\d{4}_[a-z0-9_]+\.sql$/.test(m.name) ||
        !hash(m.sha256),
    ) ||
    new Set(input.migrations.map((m) => m.name)).size !== input.migrations.length ||
    !Array.isArray(input.tables) ||
    input.tables.length !== challenge.mirror.tables.length ||
    input.tables.some(
      (t) => !t || typeof t.name !== "string" || !integer(t.rows) || !hash(t.sha256),
    ) ||
    JSON.stringify(input.tables.map((t) => t.name).sort()) !==
      JSON.stringify(challenge.mirror.tables)
  )
    throw new Error("database_restore_invalid_snapshot_proof");
  return {
    validator: input.validator,
    schemaSha256: input.schemaSha256,
    migrations: input.migrations.map((m) => ({ name: m.name, sha256: m.sha256 })),
    data: { bytes: input.data.bytes, sha256: input.data.sha256 },
    tables: input.tables.map((t) => ({ name: t.name, rows: t.rows, sha256: t.sha256 })),
  };
}
