export const BACKUP_MAX_AGE_MS = 35 * 86400000;
export const BACKUP_FRESHNESS_MS = 86400000;
export const BACKUP_MIN_GENERATIONS = 5;
export const BACKUP_INVENTORY_PAGE_SIZE = 100;

export type BackupPhase = "preparing" | "frozen" | "releasing" | "released";
export interface BackupInventorySnapshot {
  at: number;
  token: string | null;
  phase: BackupPhase | null;
}
export interface BackupInventoryCursor extends BackupInventorySnapshot {
  after: string | null;
}
export interface BackupInventoryRow {
  id: string;
  epoch: number;
  state: "pending" | "exporting" | "completed" | "failed";
  createdAt: number;
  completedAt: number | null;
  releasedAt: number | null;
  manifestKey: string | null;
  manifestSha256: string | null;
}
export interface BackupInventoryPage {
  epoch: number;
  observedAt: number;
  snapshot: BackupInventorySnapshot;
  active: { id: string; epoch: number; phase: BackupPhase; createdAt: number } | null;
  rows: BackupInventoryRow[];
  next: BackupInventoryCursor | null;
}
