import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKUP_MAX_AGE_MS } from "../../packages/shared/src/backupRetention.ts";
import { CHUNK_BYTES, generationId, MAX_PARTS } from "../backup/objectStore.mjs";
import { downloadGeneration } from "../backup/publication.mjs";

const integer = (value, minimum = 0) => Number.isSafeInteger(value) && value >= minimum;
const hash = (value) => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
export function restoreIdentity(epoch, id) {
  generationId(id);
  if (!integer(epoch, 1)) throw new Error("invalid_database_restore");
}
export function logicalSelection(id, epoch, manifestSha256) {
  restoreIdentity(epoch, id);
  if (!hash(manifestSha256)) throw new Error("invalid_database_restore");
  return { kind: "logical", id, epoch, manifestSha256 };
}
export function restoreStatus(value, epoch, id) {
  restoreIdentity(epoch, id);
  if (
    value?.id !== id ||
    value.epoch !== epoch ||
    !["preparing", "cancelled"].includes(value.state) ||
    !integer(value.createdAt)
  )
    throw new Error("database_restore_invalid_status");
  let source;
  if (value.source?.kind === "logical")
    source = logicalSelection(value.source.id, value.source.epoch, value.source.manifestSha256);
  else if (
    value.source?.kind === "time_travel" &&
    typeof value.source.bookmark === "string" &&
    /^[\x21-\x7e]{1,256}$/.test(value.source.bookmark)
  )
    source = { kind: "time_travel", bookmark: value.source.bookmark };
  else throw new Error("database_restore_invalid_status");
  return {
    id,
    epoch,
    state: value.state,
    createdAt: value.createdAt,
    source,
  };
}
function verifyPage(value, epoch, id, manifestSha256, previous) {
  if (
    value?.id !== id ||
    value.epoch !== epoch ||
    value.manifestSha256 !== manifestSha256 ||
    !integer(value.partsTotal, 1) ||
    value.partsTotal > MAX_PARTS ||
    !integer(value.partsVerified, 1) ||
    value.partsVerified > value.partsTotal ||
    value.state !== (value.partsVerified === value.partsTotal ? "parts_verified" : "verifying") ||
    !integer(value.observedAt) ||
    !integer(value.expiresAt) ||
    value.observedAt > value.expiresAt ||
    (previous &&
      (previous.partsTotal !== value.partsTotal ||
        previous.expiresAt !== value.expiresAt ||
        value.observedAt < previous.observedAt ||
        value.partsVerified !== previous.partsVerified + 1))
  )
    throw new Error("database_restore_invalid_progress");
  return value;
}

/** Verify selected bytes through a NEW isolated SQLite DB, then attest the same pinned source. */
export async function verifyRestoreSelection({
  epoch,
  id,
  control,
  store,
  progress = () => {},
  maxSteps = 100,
}) {
  restoreIdentity(epoch, id);
  if (!integer(maxSteps, 1) || maxSteps > 100) throw new Error("invalid_database_restore");
  const selected = restoreStatus(await control.inspect(epoch, id), epoch, id);
  if (selected.state !== "preparing") throw new Error("database_restore_not_preparing");
  const source = selected.source;
  if (source.kind !== "logical") throw new Error("database_restore_source_unavailable");
  let page;
  for (let step = 0; step < maxSteps; step++) {
    page = verifyPage(await control.verify(epoch, id), epoch, id, source.manifestSha256, page);
    progress({ stage: "source_part_verified", parts: page.partsVerified, total: page.partsTotal });
    if (page.state === "parts_verified") break;
  }
  if (page.state !== "parts_verified")
    return {
      id,
      epoch,
      state: "verifying",
      complete: false,
      partsVerified: page.partsVerified,
      partsTotal: page.partsTotal,
    };
  const directory = await mkdtemp(join(tmpdir(), "ncf-restore-sql-"));
  try {
    const verified = await downloadGeneration({
      directory,
      id: source.id,
      store,
      expectedSha256: source.manifestSha256,
      progress,
    });
    const manifest = verified.manifest;
    if (
      manifest.generation.epoch !== source.epoch ||
      Math.ceil(manifest.data.bytes / CHUNK_BYTES) !== page.partsTotal ||
      manifest.generation.createdAt + BACKUP_MAX_AGE_MS !== page.expiresAt ||
      manifest.capturedAt > page.observedAt
    )
      throw new Error("database_restore_source_conflict");
    progress({
      stage: "isolated_sql_verified",
      tables: manifest.tables.length,
      bytes: manifest.data.bytes,
    });
    const saved = await control.attest(epoch, id, source.manifestSha256);
    if (
      saved?.id !== id ||
      saved.epoch !== epoch ||
      saved.manifestSha256 !== source.manifestSha256 ||
      saved.state !== "sql_verified" ||
      saved.validator !== "logical-sql-v1" ||
      !integer(saved.verifiedAt) ||
      saved.verifiedAt < page.observedAt ||
      saved.expiresAt !== page.expiresAt ||
      saved.verifiedAt > saved.expiresAt
    )
      throw new Error("database_restore_invalid_attestation");
    return {
      id,
      epoch,
      state: "sql_verified",
      complete: true,
      source,
      validator: saved.validator,
      verifiedAt: saved.verifiedAt,
      expiresAt: saved.expiresAt,
      tables: manifest.tables.length,
      bytes: manifest.data.bytes,
      schemaSha256: manifest.schema.sha256,
      dataSha256: manifest.data.sha256,
    };
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
