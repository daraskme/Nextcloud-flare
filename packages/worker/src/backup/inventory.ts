import { backupManifestKey } from "../../../shared/src/backupPublication";
import {
  BACKUP_INVENTORY_PAGE_SIZE,
  type BackupInventoryCursor,
  type BackupInventoryPage,
  type BackupInventoryRow,
  type BackupPhase,
} from "../../../shared/src/backupRetention";
import { primary } from "../db/primary";

interface Authority {
  epoch: number;
  token: string | null;
  phase: BackupPhase | null;
  active: BackupInventoryPage["active"];
}

/** Read-only, primary-key pagination. A changed backup authority invalidates the whole scan. */
export async function inspectBackupInventory(
  db: D1Database,
  epoch: number,
  authority: () => Authority,
  cursor?: BackupInventoryCursor,
): Promise<BackupInventoryPage> {
  if (!Number.isSafeInteger(epoch) || epoch < 1) throw new Error("invalid_backup_request");
  const before = authority();
  if (before.epoch !== epoch) throw new Error("invalid_backup_request");
  if (before.active && before.active.epoch !== epoch) throw new Error("backup_mirror_conflict");
  const at = cursor === undefined ? Date.now() : cursor?.at;
  if (cursor !== undefined) {
    if (
      !cursor ||
      typeof cursor !== "object" ||
      Object.keys(cursor).sort().join(",") !== "after,at,phase,token" ||
      !Number.isSafeInteger(at) ||
      at < 0 ||
      at > Date.now() ||
      cursor.token !== before.token ||
      cursor.phase !== before.phase
    )
      throw new Error("backup_inventory_changed");
    if (cursor.after !== null) backupManifestKey(cursor.after);
  }
  const results = await primary(db).batch([
    primary(db).prepare("SELECT epoch,backup_frozen,backup_token FROM control WHERE singleton=1"),
    primary(db)
      .prepare(`SELECT id,epoch,state,created_at AS createdAt,completed_at AS completedAt,
        released_at AS releasedAt,manifest_key AS manifestKey,manifest_sha256 AS manifestSha256
        FROM backup_runs WHERE id>? ORDER BY id LIMIT ?`)
      .bind(cursor?.after ?? "", BACKUP_INVENTORY_PAGE_SIZE + 1),
  ]);
  const after = authority();
  if (after.epoch !== epoch || after.token !== before.token || after.phase !== before.phase)
    throw new Error("backup_inventory_changed");
  const mirror = results[0]?.results[0] as
    | { epoch: number; backup_frozen: number; backup_token: string | null }
    | undefined;
  if (mirror?.epoch !== epoch) throw new Error("backup_mirror_conflict");
  const open = mirror.backup_frozen === 0 && mirror.backup_token === null;
  const frozen =
    before.active !== null && mirror.backup_frozen === 1 && mirror.backup_token === before.token;
  if ((!before.active && !open) || (before.phase === "frozen" ? !frozen : !open && !frozen))
    throw new Error("backup_mirror_conflict");
  const observedAt = Date.now();
  if (observedAt < at) throw new Error("backup_clock_conflict");
  const snapshot = { at, token: before.token, phase: before.phase };
  const found = results[1]?.results as unknown as BackupInventoryRow[];
  if (!Array.isArray(found)) throw new Error("backup_inventory_unavailable");
  const rows = found.slice(0, BACKUP_INVENTORY_PAGE_SIZE);
  return {
    epoch,
    observedAt,
    snapshot,
    active: before.active,
    rows,
    next: found.length > rows.length ? { ...snapshot, after: rows.at(-1)!.id } : null,
  };
}
