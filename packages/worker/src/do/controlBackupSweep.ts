import { backupManifestKey } from "../../../shared/src/backupPublication";
import { BACKUP_MAX_AGE_MS } from "../../../shared/src/backupRetention";
import { pruneBackupGeneration } from "../backup/prune";
import { primary } from "../db/primary";

interface Authority {
  epoch: number;
  token: string | null;
  phase: string | null;
}
interface SweepRow extends Record<string, SqlStorageValue> {
  epoch: number;
  round: string;
  phase: "running" | "completed";
  started_at: number;
  after_id: string;
  through_id: string;
  scanned: number;
  absent: number;
  errors: number;
  last_error_id: string | null;
  last_error: string | null;
}
export interface BackupSweepStatus {
  epoch: number;
  round: string;
  state: "running" | "completed";
  startedAt: number;
  after: string | null;
  through: string | null;
  scanned: number;
  absent: number;
  errors: number;
  lastError: { id: string; code: string } | null;
}
const corrupt = new Set([
  "backup_publication_hash_mismatch",
  "backup_generation_conflict",
  "backup_invalid_publication",
  "backup_manifest_size",
  "backup_invalid_part",
  "backup_export_size",
  "backup_unexpected_object",
  "backup_manifest_missing_with_objects",
  "backup_invalid_receipt",
]);

export function initializeBackupSweep(sql: SqlStorage): void {
  sql.exec(`CREATE TABLE IF NOT EXISTS control_backup_sweep(
    singleton INTEGER PRIMARY KEY CHECK(singleton=1),epoch INTEGER NOT NULL,round TEXT NOT NULL,
    phase TEXT NOT NULL CHECK(phase IN ('running','completed')),started_at INTEGER NOT NULL,
    after_id TEXT NOT NULL,through_id TEXT NOT NULL,scanned INTEGER NOT NULL,
    absent INTEGER NOT NULL,errors INTEGER NOT NULL,last_error_id TEXT,last_error TEXT
  )`);
}

/** One durable scan, with a fixed key ceiling and age cutoff. The caller serializes this with manual prune. */
export class ControlBackupSweep {
  constructor(
    private readonly sql: SqlStorage,
    private readonly db: D1Database,
    private readonly bucket: R2Bucket,
    private readonly authority: () => Authority,
  ) {}
  #row() {
    return this.sql
      .exec<SweepRow>("SELECT * FROM control_backup_sweep WHERE singleton=1")
      .toArray()[0];
  }
  #status(row: SweepRow): BackupSweepStatus {
    return {
      epoch: row.epoch,
      round: row.round,
      state: row.phase,
      startedAt: row.started_at,
      after: row.after_id || null,
      through: row.through_id || null,
      scanned: row.scanned,
      absent: row.absent,
      errors: row.errors,
      lastError: row.last_error_id ? { id: row.last_error_id, code: row.last_error! } : null,
    };
  }
  #guard(epoch: number) {
    const started = Date.now(),
      before = this.authority(),
      row = this.#row();
    if (!Number.isSafeInteger(epoch) || epoch < 1 || before.epoch !== epoch)
      throw new Error("invalid_backup_request");
    const check = () => {
      const found = this.authority(),
        current = this.#row();
      if (Date.now() < started || Date.now() - started >= 25000)
        throw new Error("backup_prune_deadline");
      if (
        found.epoch !== epoch ||
        found.token !== before.token ||
        found.phase !== before.phase ||
        current?.round !== row?.round ||
        current?.after_id !== row?.after_id ||
        current?.phase !== row?.phase
      )
        throw new Error("backup_sweep_changed");
      if (found.phase !== null && found.phase !== "released") throw new Error("backup_active");
      if (row?.epoch === epoch && Date.now() < row.started_at)
        throw new Error("backup_clock_conflict");
    };
    check();
    return { check, started, row };
  }
  async #query(epoch: number, statement: D1PreparedStatement, check: () => void) {
    check();
    const result = await primary(this.db).batch([
      primary(this.db).prepare(
        "SELECT epoch,backup_frozen,backup_token FROM control WHERE singleton=1",
      ),
      statement,
    ]);
    check();
    const mirror = result[0]?.results[0] as
      | { epoch: number; backup_frozen: number; backup_token: string | null }
      | undefined;
    if (mirror?.epoch !== epoch || mirror.backup_frozen !== 0 || mirror.backup_token !== null)
      throw new Error("backup_mirror_conflict");
    if (!Array.isArray(result[1]?.results)) throw new Error("backup_inventory_unavailable");
    return result[1].results;
  }
  async plan(epoch: number): Promise<BackupSweepStatus> {
    const { check, started, row } = this.#guard(epoch);
    const rows = await this.#query(
      epoch,
      primary(this.db).prepare("SELECT MAX(id) AS last FROM backup_runs"),
      check,
    );
    if (row?.epoch === epoch && row.phase === "running") return this.#status(row);
    const through = (rows[0] as { last: string | null }).last ?? "";
    if (through) backupManifestKey(through);
    this.sql.exec(
      `INSERT INTO control_backup_sweep VALUES(1,?,?,'running',?,'',?,0,0,0,NULL,NULL)
      ON CONFLICT(singleton) DO UPDATE SET epoch=excluded.epoch,round=excluded.round,phase='running',
      started_at=excluded.started_at,after_id='',through_id=excluded.through_id,scanned=0,absent=0,errors=0,last_error_id=NULL,last_error=NULL`,
      epoch,
      crypto.randomUUID(),
      started,
      through,
    );
    return this.#status(this.#row()!);
  }
  async step(epoch: number, round: string): Promise<BackupSweepStatus> {
    backupManifestKey(round);
    const { check, started, row } = this.#guard(epoch);
    if (row?.epoch !== epoch || row.round !== round) throw new Error("backup_sweep_changed");
    const rows = (await this.#query(
      epoch,
      primary(this.db)
        .prepare(
          "SELECT id,state,created_at AS createdAt FROM backup_runs WHERE id>? AND id<=? ORDER BY id LIMIT 100",
        )
        .bind(row.after_id, row.through_id),
      check,
    )) as unknown as { id: string; state: string; createdAt: number }[];
    if (row.phase === "completed") return this.#status(row);
    let after = row.after_id,
      scanned = 0,
      absent = 0,
      error: { id: string; code: string } | null = null;
    let pending = false;
    for (const item of rows) {
      backupManifestKey(item.id);
      if (item.id <= after || !Number.isSafeInteger(item.createdAt) || item.createdAt < 0)
        throw new Error("backup_invalid_inventory");
      if (item.state === "completed" && row.started_at - item.createdAt > BACKUP_MAX_AGE_MS) {
        try {
          const result = await pruneBackupGeneration({
            db: this.db,
            bucket: this.bucket,
            epoch,
            id: item.id,
            authority: this.authority,
            startedAt: started,
          });
          if (result.state === "pending") pending = true;
          else absent = 1;
        } catch (failure) {
          const code = failure instanceof Error ? failure.message : "";
          if (!corrupt.has(code)) throw failure; // Unknown external outcomes retain the same candidate.
          error = { id: item.id, code };
        }
        check();
        // Recheck D1 even when a corrupt manifest was rejected before prune's final fence.
        await this.#query(epoch, primary(this.db).prepare("SELECT 1"), check);
        if (!pending) {
          after = item.id;
          scanned++;
        }
        break; // At most one generation / twenty parts per RPC.
      }
      after = item.id;
      scanned++;
    }
    check();
    const done =
      !pending && (after === row.through_id || (rows.length < 100 && scanned === rows.length));
    this.sql.exec(
      `UPDATE control_backup_sweep SET after_id=?,phase=?,scanned=scanned+?,absent=absent+?,
      errors=errors+?,last_error_id=COALESCE(?,last_error_id),last_error=COALESCE(?,last_error)
      WHERE singleton=1 AND epoch=? AND round=? AND after_id=? AND phase='running'`,
      after,
      done ? "completed" : "running",
      scanned,
      absent,
      Number(error !== null),
      error?.id ?? null,
      error?.code ?? null,
      epoch,
      round,
      row.after_id,
    );
    return this.#status(this.#row()!);
  }
}
