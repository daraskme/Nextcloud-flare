import {
  BACKUP_MANIFEST_BYTES,
  type BackupGeneration,
  backupManifestKey,
  backupPartKey,
  parseBackupPublication,
} from "../../../shared/src/backupPublication";
import { BACKUP_MAX_AGE_MS } from "../../../shared/src/backupRetention";
import { primary } from "../db/primary";
import type { DatabaseRestoreSource } from "../do/controlDatabaseRestore";
import { readBackupObject, sha256 } from "./publication";

export interface RestoreSourceAuthority {
  epoch: number;
  revision: number;
  token: string;
}
interface Receipt extends BackupGeneration {
  state: string;
  completedAt: number;
  releasedAt: number;
  manifestKey: string;
  manifestSha256: string;
}
export interface RestoreSourcePage {
  generation: BackupGeneration;
  manifestSha256: string;
  parts: number;
  next: number;
  observedAt: number;
  expiresAt: number;
}
const timestamp = (v: number) => Number.isSafeInteger(v) && v >= 0;

/** One immutable R2 part plus a fresh completed receipt; does not attest SQL or authorize restore. */
export async function verifyRestoreSourcePage({
  db,
  bucket,
  source,
  cursor,
  authority,
}: {
  db: D1Database;
  bucket: R2Bucket;
  source: Extract<DatabaseRestoreSource, { kind: "logical" }>;
  cursor: number;
  /** Throws unless the same restore request is preparing and local admission is closed. */
  authority: () => RestoreSourceAuthority;
}): Promise<RestoreSourcePage> {
  const key = backupManifestKey(source.id),
    before = authority(),
    started = Date.now();
  if (
    source.kind !== "logical" ||
    !Number.isSafeInteger(source.epoch) ||
    source.epoch < 1 ||
    !/^[a-f0-9]{64}$/.test(source.manifestSha256) ||
    !Number.isSafeInteger(cursor) ||
    cursor < 0 ||
    !Number.isSafeInteger(before.epoch) ||
    before.epoch < source.epoch ||
    !timestamp(before.revision) ||
    typeof before.token !== "string" ||
    before.token.length < 1
  )
    throw new Error("restore_invalid_source");

  function current() {
    const found = authority(),
      now = Date.now();
    if (now < started || now - started >= 25000) throw new Error("restore_source_deadline");
    if (
      found.epoch !== before.epoch ||
      found.revision !== before.revision ||
      found.token !== before.token
    )
      throw new Error("restore_source_changed");
    return now;
  }
  async function request<T>(run: () => Promise<T>): Promise<T> {
    current();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const value = await Promise.race([
        run(),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error("restore_source_timeout")), 10000);
        }),
      ]);
      current();
      return value;
    } finally {
      clearTimeout(timer);
    }
  }
  let receipt: Receipt | undefined;
  async function eligible() {
    const rows = await request(() =>
      primary(db).batch([
        primary(db).prepare(`SELECT epoch,maintenance,gc_paused,admission_revision,admission_token,
        backup_token,backup_frozen FROM control WHERE singleton=1`),
        primary(db)
          .prepare(`SELECT id,epoch,state,created_at AS createdAt,barrier_token AS token,watermark,
        completed_at AS completedAt,released_at AS releasedAt,manifest_key AS manifestKey,
        manifest_sha256 AS manifestSha256 FROM backup_runs WHERE id=?`)
          .bind(source.id),
      ]),
    );
    const mirror = rows[0]?.results[0] as Record<string, unknown> | undefined;
    if (
      !mirror ||
      mirror.epoch !== before.epoch ||
      mirror.maintenance !== 1 ||
      mirror.gc_paused !== 1 ||
      mirror.admission_revision !== before.revision ||
      mirror.admission_token !== before.token ||
      mirror.backup_token !== null ||
      mirror.backup_frozen !== 0
    )
      throw new Error("restore_source_mirror_conflict");
    const row = rows[1]?.results[0] as unknown as Receipt | undefined,
      now = current();
    if (
      !row ||
      row.id !== source.id ||
      row.epoch !== source.epoch ||
      row.state !== "completed" ||
      !timestamp(row.createdAt) ||
      !timestamp(row.completedAt) ||
      !timestamp(row.releasedAt) ||
      row.completedAt < row.createdAt ||
      row.releasedAt < row.createdAt ||
      row.completedAt > now ||
      row.releasedAt > now ||
      row.manifestKey !== key ||
      row.manifestSha256 !== source.manifestSha256 ||
      typeof row.token !== "string" ||
      !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(row.token) ||
      !(
        row.watermark === null ||
        (typeof row.watermark === "string" &&
          row.watermark.length > 0 &&
          row.watermark.length <= 128)
      )
    )
      throw new Error("restore_source_receipt_invalid");
    if (now - row.createdAt > BACKUP_MAX_AGE_MS) throw new Error("restore_source_expired");
    if (receipt && JSON.stringify(row) !== JSON.stringify(receipt))
      throw new Error("restore_source_changed");
    receipt = row;
  }

  await eligible();
  const manifest = await request(() => readBackupObject(bucket, key, BACKUP_MANIFEST_BYTES));
  if (manifest === null || (await sha256(manifest)) !== source.manifestSha256)
    throw new Error("restore_source_manifest_mismatch");
  current();
  const publication = parseBackupPublication(manifest, source.id),
    generation = publication.manifest.generation;
  for (const field of ["id", "epoch", "token", "createdAt", "watermark"] as const)
    if (generation[field] !== receipt![field])
      throw new Error("restore_source_generation_mismatch");
  if (cursor > publication.parts.length) throw new Error("restore_invalid_source_cursor");
  let next = cursor;
  if (cursor < publication.parts.length) {
    const part = publication.parts[cursor]!;
    const bytes = await request(() =>
      readBackupObject(bucket, backupPartKey(source.id, cursor, part.sha256), part.bytes),
    );
    if (bytes === null || bytes.byteLength !== part.bytes || (await sha256(bytes)) !== part.sha256)
      throw new Error("restore_source_part_mismatch");
    current();
    next++;
  }
  await eligible();
  const observedAt = current(),
    expiresAt = generation.createdAt + BACKUP_MAX_AGE_MS;
  if (observedAt > expiresAt) throw new Error("restore_source_expired");
  return {
    generation,
    manifestSha256: source.manifestSha256,
    parts: publication.parts.length,
    next,
    observedAt,
    expiresAt,
  };
}
