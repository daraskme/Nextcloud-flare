import {
  BACKUP_MANIFEST_BYTES,
  type BackupGeneration,
  backupManifestKey,
  backupPartKey,
  parseBackupPublication,
} from "../../../shared/src/backupPublication";
import { BACKUP_MAX_AGE_MS } from "../../../shared/src/backupRetention";
import { primary } from "../db/primary";
import { readBackupObject, sha256 } from "./publication";

export const BACKUP_PRUNE_BATCH = 20;
export interface BackupPruneResult {
  id: string;
  epoch: number;
  generationEpoch: number;
  createdAt: number;
  manifestSha256: string;
  state: "pending" | "absent";
  deletedObjects: number;
}
interface Receipt extends BackupGeneration {
  state: string;
  completedAt: number;
  releasedAt: number;
  manifestKey: string;
  manifestSha256: string;
}
interface Authority {
  epoch: number;
  token: string | null;
  phase: string | null;
}
const timestamp = (n: number) => Number.isSafeInteger(n) && n >= 0;

/** Delete only an expired, immutable completed identity. Remaining R2 keys are the retry cursor. */
export async function pruneBackupGeneration({
  db,
  bucket,
  epoch,
  id,
  authority,
}: {
  db: D1Database;
  bucket: R2Bucket;
  epoch: number;
  id: string;
  authority: () => Authority;
}): Promise<BackupPruneResult> {
  const key = backupManifestKey(id),
    prefix = key.slice(0, -"manifest.json".length),
    started = Date.now(),
    snapshot = authority();
  if (!Number.isSafeInteger(epoch) || epoch < 1 || snapshot.epoch !== epoch)
    throw new Error("invalid_backup_request");
  function current() {
    const now = Date.now(),
      found = authority();
    if (now < started || now - started >= 25000) throw new Error("backup_prune_deadline");
    if (found.epoch !== epoch || found.token !== snapshot.token || found.phase !== snapshot.phase)
      throw new Error("backup_conflict");
    if (found.phase !== null && found.phase !== "released") throw new Error("backup_active");
  }
  let receipt: Receipt | undefined;
  async function eligible() {
    current();
    const result = await primary(db).batch([
      primary(db).prepare("SELECT epoch,backup_frozen,backup_token FROM control WHERE singleton=1"),
      primary(db)
        .prepare(`SELECT id,epoch,state,created_at AS createdAt,barrier_token AS token,watermark,
          completed_at AS completedAt,released_at AS releasedAt,manifest_key AS manifestKey,
          manifest_sha256 AS manifestSha256 FROM backup_runs WHERE id=?`)
        .bind(id),
    ]);
    current();
    const mirror = result[0]?.results[0] as
      | { epoch: number; backup_frozen: number; backup_token: string | null }
      | undefined;
    if (mirror?.epoch !== epoch || mirror.backup_frozen !== 0 || mirror.backup_token !== null)
      throw new Error("backup_mirror_conflict");
    const row = result[1]?.results[0] as unknown as Receipt | undefined;
    const now = Date.now();
    if (
      !row ||
      row.state !== "completed" ||
      row.id !== id ||
      !Number.isSafeInteger(row.epoch) ||
      row.epoch < 1 ||
      row.epoch > epoch ||
      !timestamp(row.createdAt) ||
      !timestamp(row.completedAt) ||
      !timestamp(row.releasedAt) ||
      row.completedAt < row.createdAt ||
      row.releasedAt < row.createdAt ||
      row.completedAt > now ||
      row.releasedAt > now ||
      row.manifestKey !== key ||
      typeof row.manifestSha256 !== "string" ||
      !/^[a-f0-9]{64}$/.test(row.manifestSha256) ||
      typeof row.token !== "string" ||
      !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(row.token)
    )
      throw new Error("backup_invalid_receipt");
    if (now - row.createdAt <= BACKUP_MAX_AGE_MS) throw new Error("backup_not_expired");
    if (receipt && JSON.stringify(row) !== JSON.stringify(receipt))
      throw new Error("backup_generation_conflict");
    receipt = row;
  }
  // Deadline races never schedule follow-up I/O in the losing continuation.
  async function request<T>(run: () => Promise<T>): Promise<T> {
    current();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const value = await Promise.race([
        run(),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error("backup_prune_timeout")), 10000);
        }),
      ]);
      current();
      return value;
    } finally {
      clearTimeout(timer);
    }
  }
  async function list(limit: number) {
    const result = await request(() => bucket.list({ prefix, limit }));
    if (
      result.delimitedPrefixes.length !== 0 ||
      result.objects.length > limit ||
      (result.truncated && result.objects.length === 0) ||
      new Set(result.objects.map((o) => o.key)).size !== result.objects.length ||
      result.objects.some((o) => !o.key.startsWith(prefix))
    )
      throw new Error("backup_invalid_listing");
    return result;
  }
  function status(state: BackupPruneResult["state"], deletedObjects: number): BackupPruneResult {
    return {
      id,
      epoch,
      generationEpoch: receipt!.epoch,
      createdAt: receipt!.createdAt,
      manifestSha256: receipt!.manifestSha256,
      state,
      deletedObjects,
    };
  }
  await eligible();
  const bytes = await request(() => readBackupObject(bucket, key, BACKUP_MANIFEST_BYTES));
  if (bytes === null) {
    // This also reconciles a lost final DELETE response, without any DO-local tombstone.
    const remaining = await list(1);
    await eligible();
    if (remaining.truncated || remaining.objects.length !== 0)
      throw new Error("backup_manifest_missing_with_objects");
    return status("absent", 0);
  }
  if ((await sha256(bytes)) !== receipt!.manifestSha256)
    throw new Error("backup_publication_hash_mismatch");
  const publication = parseBackupPublication(bytes, id),
    generation = publication.manifest.generation;
  for (const field of ["id", "epoch", "createdAt", "token", "watermark"] as const)
    if (generation[field] !== receipt![field]) throw new Error("backup_generation_conflict");
  const page = await list(BACKUP_PRUNE_BATCH + 1);
  const parts = page.objects.filter((o) => o.key !== key);
  for (const object of parts) {
    const match = /^parts\/(\d{6})-([a-f0-9]{64})\.bin$/.exec(object.key.slice(prefix.length));
    const index = match ? Number(match[1]) : -1,
      part = publication.parts[index];
    if (!part || object.key !== backupPartKey(id, index, part.sha256))
      throw new Error("backup_unexpected_object");
  }
  const keys = parts.slice(0, BACKUP_PRUNE_BATCH).map((o) => o.key);
  let deleted = 0;
  if (keys.length > 0) {
    await eligible();
    await request(() => bucket.delete(keys));
    deleted = keys.length;
  }
  const remaining = await list(2);
  await eligible();
  if (remaining.truncated || remaining.objects.some((o) => o.key !== key))
    return status("pending", deleted);
  // Preserve the manifest until the entire generation contains no other object.
  await request(() => bucket.delete(key));
  const final = await list(1);
  await eligible();
  if (final.truncated || final.objects.length !== 0) throw new Error("backup_prune_not_empty");
  return status("absent", deleted + 1);
}
