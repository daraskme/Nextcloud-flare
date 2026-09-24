import { assertExists, assertOneChange, atomicBatch, primary } from "../db/primary";
import { epochNumber } from "./epochHistory";

export interface BackupAdmissionSnapshot {
  epoch: number;
  revision: number;
  phase: "open" | "closed";
  token: string | null;
  gc_paused: number;
  operator_paused: number;
  audit_token: string | null;
}
interface BackupRow extends Record<string, SqlStorageValue> {
  id: string;
  epoch: number;
  phase: "preparing" | "frozen" | "releasing" | "released";
  token: string;
  release_token: string;
  cancelled: number;
  prior_json: string;
  created_at: number;
  watermark: string | null;
}
export interface BackupBarrierStatus {
  id: string;
  epoch: number;
  state: BackupRow["phase"];
  watermark: string | null;
}
const clock = "strftime('%s','now')*1000";
const drained = `NOT EXISTS(SELECT 1 FROM permits WHERE state='open')
  AND NOT EXISTS(SELECT 1 FROM operations WHERE state='claimed')
  AND NOT EXISTS(SELECT 1 FROM mutation_admissions WHERE state<>'closed')`;

export function initializeBackupState(sql: SqlStorage): void {
  sql.exec(`CREATE TABLE IF NOT EXISTS control_backup(
    singleton INTEGER PRIMARY KEY CHECK(singleton=1),id TEXT NOT NULL,epoch INTEGER NOT NULL,
    phase TEXT NOT NULL CHECK(phase IN ('preparing','frozen','releasing','released')),
    token TEXT NOT NULL,release_token TEXT NOT NULL,cancelled INTEGER NOT NULL CHECK(cancelled IN (0,1)),
    prior_json TEXT NOT NULL,created_at INTEGER NOT NULL,watermark TEXT
  )`);
}
export function backupActive(sql: SqlStorage): boolean {
  return sql.exec("SELECT 1 FROM control_backup WHERE phase<>'released'").toArray().length > 0;
}
export function assertNoBackup(sql: SqlStorage): void {
  if (backupActive(sql)) throw new Error("backup_active");
}

/** Internal RPC only. Exporters retain this barrier through every table until a durable snapshot exists. */
export class ControlBackup {
  constructor(
    private readonly storage: DurableObjectStorage,
    private readonly db: D1Database,
    private readonly currentEpoch: () => number,
    private readonly capture: () => BackupAdmissionSnapshot,
    private readonly restore: (snapshot: BackupAdmissionSnapshot, token: string) => void,
  ) {}

  #row(): BackupRow | undefined {
    return this.storage.sql
      .exec<BackupRow>("SELECT * FROM control_backup WHERE singleton=1")
      .toArray()[0];
  }
  #current(row: BackupRow): void {
    const current = this.#row();
    if (
      this.currentEpoch() !== row.epoch ||
      current?.token !== row.token ||
      current.phase !== row.phase
    )
      throw new Error("backup_conflict");
  }
  #status(row: BackupRow): BackupBarrierStatus {
    return { id: row.id, epoch: row.epoch, state: row.phase, watermark: row.watermark };
  }
  #identity(epoch: number, id: string): void {
    epochNumber(epoch);
    if (
      this.currentEpoch() !== epoch ||
      typeof id !== "string" ||
      !/^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(id)
    )
      throw new Error("invalid_backup_request");
  }
  async #prepared(row: BackupRow, frozen: boolean): Promise<{ watermark: string | null } | null> {
    const prior: BackupAdmissionSnapshot = JSON.parse(row.prior_json);
    return primary(this.db)
      .prepare(`SELECT b.watermark FROM control c JOIN backup_runs b ON b.barrier_token=c.backup_token
      WHERE c.singleton=1 AND c.epoch=? AND c.backup_token=? AND c.backup_frozen=?
      AND c.admission_revision=? AND c.admission_token=? AND c.maintenance=1 AND c.gc_paused=1
      AND c.gc_operator_paused=1 AND c.gc_hold_token IS NULL AND c.gc_hold_operation IS NULL AND c.gc_hold_expires_at IS NULL
      AND b.id=? AND b.epoch=c.epoch AND b.created_at=? AND b.released_at IS NULL AND b.state=?
      AND ${drained} ${frozen ? "AND b.watermark IS c.backup_barrier_op AND b.watermark IS c.backup_last_op" : ""}`)
      .bind(
        row.epoch,
        row.token,
        Number(frozen),
        prior.revision + 1,
        row.token,
        row.id,
        row.created_at,
        frozen ? "exporting" : "pending",
      )
      .first<{ watermark: string | null }>();
  }
  async begin(epoch: number, id: string): Promise<BackupBarrierStatus> {
    this.#identity(epoch, id);
    let row = this.#row();
    if (row?.id === id) {
      if (row.epoch !== epoch || row.phase === "releasing") throw new Error("backup_conflict");
      if (row.phase === "released") return this.#status(row);
    } else {
      if (row && row.phase !== "released") throw new Error("backup_active");
      const history = await primary(this.db)
        .prepare("SELECT epoch,watermark,released_at FROM backup_runs WHERE id=?")
        .bind(id)
        .first<{ epoch: number; watermark: string | null; released_at: number | null }>();
      if (this.#row()?.token !== row?.token || this.#row()?.phase !== row?.phase)
        throw new Error("backup_conflict");
      this.#identity(epoch, id);
      if (history) {
        if (history.epoch !== epoch || history.released_at === null)
          throw new Error("backup_history_conflict");
        return { id, epoch, state: "released", watermark: history.watermark };
      }
      const prior = this.capture();
      epochNumber(prior.revision + 2);
      this.storage.sql.exec(
        `INSERT INTO control_backup VALUES(1,?,?,'preparing',?,?,0,?,?,NULL)
        ON CONFLICT(singleton) DO UPDATE SET id=excluded.id,epoch=excluded.epoch,phase=excluded.phase,
        token=excluded.token,release_token=excluded.release_token,cancelled=0,prior_json=excluded.prior_json,
        created_at=excluded.created_at,watermark=NULL`,
        id,
        epoch,
        crypto.randomUUID(),
        crypto.randomUUID(),
        JSON.stringify(prior),
        Date.now(),
      );
      row = this.#row()!;
    }
    const frozen = await this.#prepared(row, true);
    this.#current(row);
    if (frozen) return this.#finishFreeze(row, frozen.watermark);
    if (row.phase !== "preparing") throw new Error("backup_mirror_conflict");
    const prior: BackupAdmissionSnapshot = JSON.parse(row.prior_json);
    if (!(await this.#prepared(row, false))) {
      this.#current(row);
      try {
        await atomicBatch(this.db, [
          assertExists(
            `SELECT 1 FROM control WHERE singleton=1 AND epoch=? AND backup_token IS NULL AND backup_frozen=0
            AND admission_revision=? AND admission_token IS ? AND maintenance=? AND gc_paused=? AND gc_operator_paused=?
            AND gc_hold_token IS NULL AND gc_hold_operation IS NULL AND gc_hold_expires_at IS NULL`,
            [
              epoch,
              prior.revision,
              prior.token,
              Number(prior.phase === "closed"),
              prior.gc_paused,
              prior.operator_paused,
            ],
          ),
          {
            sql: "INSERT INTO backup_runs(id,epoch,state,created_at,barrier_token) VALUES(?,?,'pending',?,?)",
            values: [id, epoch, row.created_at, row.token],
          },
          {
            sql: `UPDATE control SET backup_token=?,maintenance=1,gc_paused=1,gc_operator_paused=1,
            admission_revision=?,admission_token=?,updated_at=MAX(updated_at,${clock}) WHERE singleton=1`,
            values: [row.token, prior.revision + 1, row.token],
          },
          assertOneChange,
          { sql: "UPDATE permits SET state='revoked' WHERE state='open'" },
          {
            sql: `UPDATE operations SET state='failed',error_code='backup',updated_at=MAX(updated_at,${clock}) WHERE state='claimed'`,
          },
          assertExists(`SELECT 1 FROM control WHERE singleton=1 AND ${drained}`),
        ]);
      } catch (error) {
        if (!(await this.#prepared(row, false))) throw error;
      }
    }
    this.#current(row);
    try {
      await atomicBatch(this.db, [
        assertExists(
          `SELECT 1 FROM control WHERE singleton=1 AND epoch=? AND backup_token=? AND backup_frozen=0
          AND admission_revision=? AND admission_token=? AND maintenance=1 AND gc_paused=1 AND ${drained}
          AND NOT EXISTS(SELECT 1 FROM job_leases WHERE expires_at>${clock})`,
          [epoch, row.token, prior.revision + 1, row.token],
        ),
        {
          sql: `UPDATE backup_runs SET state='exporting',watermark=(SELECT backup_last_op FROM control WHERE singleton=1)
          WHERE id=? AND barrier_token=? AND state='pending' AND released_at IS NULL`,
          values: [id, row.token],
        },
        assertOneChange,
        {
          sql: "UPDATE control SET backup_barrier_op=(SELECT watermark FROM backup_runs WHERE id=?) WHERE singleton=1",
          values: [id],
        },
        { sql: "UPDATE control SET backup_frozen=1 WHERE singleton=1" },
        assertOneChange,
      ]);
    } catch (error) {
      if (!(await this.#prepared(row, true))) throw error;
    }
    const receipt = await this.#prepared(row, true);
    if (!receipt) throw new Error("backup_mirror_conflict");
    return this.#finishFreeze(row, receipt.watermark);
  }
  #finishFreeze(row: BackupRow, watermark: string | null): BackupBarrierStatus {
    this.#current(row);
    this.storage.sql.exec(
      "UPDATE control_backup SET phase='frozen',watermark=? WHERE singleton=1",
      watermark,
    );
    return this.#status(this.#row()!);
  }

  /** Release is explicit, never lease-driven. It does not claim that a backup manifest was published. */
  async release(epoch: number, id: string, cancelled = false): Promise<BackupBarrierStatus> {
    this.#identity(epoch, id);
    let row = this.#row();
    if (!row || row.id !== id || row.epoch !== epoch) throw new Error("backup_conflict");
    if (row.phase === "released") return this.#status(row);
    if (row.phase === "releasing") {
      if (row.cancelled !== Number(cancelled)) throw new Error("backup_conflict");
    } else {
      if (row.phase !== "frozen" && !cancelled) throw new Error("backup_not_frozen");
      this.storage.sql.exec(
        "UPDATE control_backup SET phase='releasing',cancelled=? WHERE singleton=1",
        Number(cancelled),
      );
      row = this.#row()!;
    }
    const prior: BackupAdmissionSnapshot = JSON.parse(row.prior_json);
    if (!(await this.#released(row, prior))) {
      this.#current(row);
      try {
        await atomicBatch(this.db, [
          // Frozen control permits only this single-column thaw. The rest is in the same atomic batch.
          {
            sql: "UPDATE control SET backup_frozen=0 WHERE singleton=1 AND epoch=? AND backup_token=? AND backup_frozen=1",
            values: [epoch, row.token],
          },
          {
            sql: `UPDATE control SET backup_token=NULL,maintenance=?,gc_paused=?,gc_operator_paused=?,
            admission_revision=?,admission_token=?,updated_at=MAX(updated_at,${clock}) WHERE singleton=1 AND epoch=? AND backup_frozen=0
            AND ((backup_token=? AND admission_revision=? AND admission_token=?)
              OR (?=1 AND backup_token IS NULL AND admission_revision=? AND admission_token IS ?))`,
            values: [
              Number(prior.phase === "closed"),
              prior.gc_paused,
              prior.operator_paused,
              prior.revision + 2,
              row.release_token,
              epoch,
              row.token,
              prior.revision + 1,
              row.token,
              row.cancelled,
              prior.revision,
              prior.token,
            ],
          },
          assertOneChange,
          ...(cancelled
            ? [
                {
                  sql: `INSERT INTO backup_runs(id,epoch,state,created_at,barrier_token)
            SELECT ?,?,'pending',?,? WHERE NOT EXISTS(SELECT 1 FROM backup_runs WHERE id=?)`,
                  values: [id, epoch, row.created_at, row.token, id],
                },
              ]
            : []),
          {
            sql: `UPDATE backup_runs SET released_at=MAX(created_at,${clock}),state=CASE WHEN ?=1 THEN 'failed' ELSE state END,
            completed_at=CASE WHEN ?=1 THEN MAX(created_at,${clock}) ELSE completed_at END
            WHERE id=? AND epoch=? AND barrier_token=? AND released_at IS NULL AND state IN ('pending','exporting')`,
            values: [row.cancelled, row.cancelled, id, epoch, row.token],
          },
          assertOneChange,
        ]);
      } catch (error) {
        if (!(await this.#released(row, prior))) throw error;
      }
    }
    this.#current(row);
    this.storage.transactionSync(() => {
      this.restore(prior, row.release_token);
      this.storage.sql.exec("UPDATE control_backup SET phase='released' WHERE singleton=1");
    });
    return this.#status(this.#row()!);
  }
  async #released(row: BackupRow, prior: BackupAdmissionSnapshot): Promise<boolean> {
    return (
      (await primary(this.db)
        .prepare(`SELECT 1 FROM control c JOIN backup_runs b ON b.id=?
      WHERE c.singleton=1 AND c.epoch=? AND c.backup_token IS NULL AND c.backup_frozen=0
      AND c.admission_revision=? AND c.admission_token=? AND c.maintenance=? AND c.gc_paused=? AND c.gc_operator_paused=?
      AND c.gc_hold_token IS NULL AND c.gc_hold_operation IS NULL AND c.gc_hold_expires_at IS NULL
      AND b.epoch=c.epoch AND b.barrier_token=? AND b.created_at=? AND b.released_at IS NOT NULL AND b.state=?`)
        .bind(
          row.id,
          row.epoch,
          prior.revision + 2,
          row.release_token,
          Number(prior.phase === "closed"),
          prior.gc_paused,
          prior.operator_paused,
          row.token,
          row.created_at,
          row.cancelled ? "failed" : "exporting",
        )
        .first()) !== null
    );
  }
}
