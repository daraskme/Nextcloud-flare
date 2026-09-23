import { assertExists, assertOneChange, atomicBatch } from "../db/primary";
import type { ControlStatus } from "./ControlDO";
import { epochNumber } from "./epochHistory";
import { RECOVERY_FINAL_QUERY } from "./recoveryAudit";

interface AdmissionRow extends Record<string, SqlStorageValue> {
  epoch: number;
  revision: number;
  phase: "closed" | "closing" | "opening" | "open" | "gc_changing";
  token: string | null;
  prior_token: string | null;
  gc_paused: number;
  audit_token: string | null;
}

const clock = "strftime('%s','now')*1000";
const closedWork = `NOT EXISTS(SELECT 1 FROM permits WHERE state='open')
  AND NOT EXISTS(SELECT 1 FROM operations WHERE state='claimed')`;

/** Local intent is durable before external I/O. D1 accepts only that transition identity. */
export class ControlAdmission {
  constructor(
    private readonly storage: DurableObjectStorage,
    private readonly db: D1Database,
    private readonly currentEpoch: () => number,
  ) {
    storage.sql.exec(`CREATE TABLE IF NOT EXISTS control_admission(
      singleton INTEGER PRIMARY KEY CHECK(singleton=1),epoch INTEGER NOT NULL,
      revision INTEGER NOT NULL CHECK(revision BETWEEN 0 AND 9007199254740991),
      phase TEXT NOT NULL CHECK(phase IN ('closed','closing','opening','open','gc_changing')),
      token TEXT,prior_token TEXT,gc_paused INTEGER NOT NULL CHECK(gc_paused IN (0,1)),
      audit_token TEXT
    )`);
    storage.sql.exec(`INSERT OR IGNORE INTO control_admission(singleton,epoch,revision,phase,gc_paused)
      SELECT 1,epoch,0,'closed',1 FROM control_state WHERE singleton=1`);
    // An interrupted repair cannot be treated as complete just because its isolate was evicted.
    storage.sql.exec(`CREATE TABLE IF NOT EXISTS control_maintenance_tasks(
      token TEXT PRIMARY KEY,epoch INTEGER NOT NULL
    )`);
  }

  #row(epoch = this.currentEpoch()): AdmissionRow {
    if (this.currentEpoch() !== epoch) throw new Error("admission_epoch_conflict");
    const row = this.storage.sql
      .exec<AdmissionRow>("SELECT * FROM control_admission WHERE singleton=1")
      .one();
    if (row.epoch !== epoch) throw new Error("admission_epoch_conflict");
    return row;
  }

  #current(intent: AdmissionRow, phase = intent.phase): void {
    const row = this.#row(intent.epoch);
    if (row.revision !== intent.revision || row.token !== intent.token || row.phase !== phase)
      throw new Error("admission_conflict");
  }

  assertClosed(epoch: number): void {
    if (this.#row(epoch).phase !== "closed") throw new Error("recovery_admission_not_closed");
  }

  /** Called in the same local transaction that publishes the new ready epoch. */
  resetEpoch(epoch: number, token: string): void {
    this.storage.sql.exec(
      `UPDATE control_admission SET epoch=?,revision=0,phase='closed',token=?,
      prior_token=NULL,gc_paused=1,audit_token=NULL WHERE singleton=1`,
      epoch,
      token,
    );
    this.storage.sql.exec("DELETE FROM recovery_audit_v7");
    this.storage.sql.exec("DELETE FROM control_maintenance_tasks WHERE epoch<>?", epoch);
  }

  beginTask(epoch: number): string {
    this.#row(epoch);
    const token = crypto.randomUUID();
    this.storage.sql.exec("INSERT INTO control_maintenance_tasks VALUES(?,?)", token, epoch);
    return token;
  }

  finishTask(token: string): void {
    this.storage.sql.exec("DELETE FROM control_maintenance_tasks WHERE token=?", token);
  }

  #audit(epoch: number, token?: string | null): string {
    const busy = this.storage.sql
      .exec("SELECT 1 FROM control_maintenance_tasks WHERE epoch=? LIMIT 1", epoch)
      .toArray();
    if (busy.length) throw new Error("recovery_maintenance_active");
    const audit = this.storage.sql
      .exec<{ token: string }>(
        "SELECT token FROM recovery_audit_v7 WHERE singleton=1 AND epoch=? AND stage='complete'",
        epoch,
      )
      .toArray()[0];
    if (!audit || (token !== undefined && audit.token !== token))
      throw new Error("recovery_audit_incomplete");
    return audit.token;
  }

  #transition(row: AdmissionRow, phase: AdmissionRow["phase"], gc: number, audit: string | null) {
    const revision = epochNumber(row.revision + 1);
    this.storage.transactionSync(() => {
      this.#current(row);
      this.storage.sql.exec(
        `UPDATE control_admission SET revision=?,phase=?,prior_token=token,token=?,
          gc_paused=?,audit_token=? WHERE singleton=1`,
        revision,
        phase,
        crypto.randomUUID(),
        gc,
        audit,
      );
      if (phase === "closing") this.storage.sql.exec("DELETE FROM recovery_audit_v7");
    });
    return this.#row(row.epoch);
  }

  async #receipt(row: AdmissionRow, maintenance: number): Promise<boolean> {
    const receipt = await this.db
      .prepare(`SELECT 1 FROM control WHERE singleton=1 AND epoch=?
        AND admission_revision=? AND admission_token IS ? AND maintenance=? AND gc_paused=?
        ${maintenance ? `AND ${closedWork}` : ""}`)
      .bind(row.epoch, row.revision, row.token, maintenance, row.gc_paused)
      .first<number>();
    return receipt !== null;
  }

  async status(): Promise<ControlStatus> {
    const row = this.#row();
    if (row.phase !== "open") return { epoch: row.epoch, maintenance: true, gcPaused: true };
    const matches = await this.#receipt(row, 0);
    this.#current(row);
    if (!matches) throw new Error("control_mirror_conflict");
    return { epoch: row.epoch, maintenance: false, gcPaused: row.gc_paused === 1 };
  }

  async close(epoch: number): Promise<ControlStatus & { activeJobLease: boolean }> {
    epochNumber(epoch);
    const row = this.#row(epoch);
    const intent = row.phase === "closing" ? row : this.#transition(row, "closing", 1, null);
    try {
      await atomicBatch(this.db, [
        {
          sql: `UPDATE control SET maintenance=1,gc_paused=1,admission_revision=?,admission_token=?,
            updated_at=MAX(updated_at,${clock}) WHERE singleton=1 AND epoch=?
            AND (admission_revision<? OR (admission_revision=? AND admission_token IS ?))`,
          values: [
            intent.revision,
            intent.token,
            epoch,
            intent.revision,
            intent.revision,
            intent.token,
          ],
        },
        assertOneChange,
        { sql: "UPDATE permits SET state='revoked' WHERE state='open'" },
        {
          sql: `UPDATE operations SET state='failed',error_code='maintenance',
            updated_at=MAX(updated_at,${clock}) WHERE state='claimed'`,
        },
        assertExists(`SELECT 1 FROM control WHERE singleton=1 AND ${closedWork}`),
      ]);
    } catch (error) {
      if (!(await this.#receipt(intent, 1))) throw error;
    }
    this.#finish(intent, "closed");
    const active = await this.db
      .prepare(`SELECT 1 FROM job_leases WHERE expires_at>${clock} LIMIT 1`)
      .first<number>();
    this.#current(intent, "closed");
    return { epoch, maintenance: true, gcPaused: true, activeJobLease: active !== null };
  }

  #finish(intent: AdmissionRow, phase: "closed" | "open"): void {
    const current = this.#row(intent.epoch);
    // Concurrent identical retries may both observe the same receipt.
    if (current.phase === phase) {
      this.#current(intent, phase);
      return;
    }
    this.#current(intent);
    this.storage.sql.exec(
      "UPDATE control_admission SET phase=?,prior_token=NULL WHERE singleton=1",
      phase,
    );
  }

  /** Only complete audit proof can open service. GC always stays paused at this boundary. */
  async resume(epoch: number): Promise<ControlStatus> {
    epochNumber(epoch);
    const row = this.#row(epoch);
    if (row.phase === "open") return this.status();
    if (row.phase !== "closed" && row.phase !== "opening") throw new Error("admission_conflict");
    const audit = this.#audit(epoch, row.phase === "opening" ? row.audit_token : undefined);
    const intent = row.phase === "opening" ? row : this.#transition(row, "opening", 1, audit);
    if (!(await this.#receipt(intent, 0))) {
      this.#current(intent);
      this.#audit(epoch, intent.audit_token);
      try {
        await atomicBatch(this.db, [
          assertExists(RECOVERY_FINAL_QUERY, [epoch]),
          {
            sql: `UPDATE control SET maintenance=0,gc_paused=1,admission_revision=?,admission_token=?,
              updated_at=MAX(updated_at,${clock}) WHERE singleton=1 AND epoch=?
              AND admission_revision=? AND admission_token IS ? AND maintenance=1 AND gc_paused=1`,
            values: [intent.revision, intent.token, epoch, intent.revision - 1, intent.prior_token],
          },
          assertOneChange,
        ]);
      } catch (error) {
        if (!(await this.#receipt(intent, 0))) throw error;
      }
    }
    this.#audit(epoch, intent.audit_token);
    this.#finish(intent, "open");
    return this.status();
  }

  /** Separate final GC gate, and an explicit pause for maintenance operations such as restore. */
  async setGcPaused(epoch: number, paused: boolean): Promise<ControlStatus> {
    epochNumber(epoch);
    const row = this.#row(epoch);
    const target = paused ? 1 : 0;
    if (row.phase === "open" && row.gc_paused === target) return this.status();
    if (row.phase !== "open" && !(row.phase === "gc_changing" && row.gc_paused === target))
      throw new Error("admission_not_open");
    const intent =
      row.phase === "gc_changing"
        ? row
        : this.#transition(row, "gc_changing", target, row.audit_token);
    if (!(await this.#receipt(intent, 0))) {
      this.#current(intent);
      try {
        await atomicBatch(this.db, [
          {
            sql: `UPDATE control SET gc_paused=?,admission_revision=?,admission_token=?,
              updated_at=MAX(updated_at,${clock}) WHERE singleton=1 AND epoch=? AND maintenance=0
              AND admission_revision=? AND admission_token IS ? AND gc_paused=?`,
            values: [
              target,
              intent.revision,
              intent.token,
              epoch,
              intent.revision - 1,
              intent.prior_token,
              1 - target,
            ],
          },
          assertOneChange,
        ]);
      } catch (error) {
        if (!(await this.#receipt(intent, 0))) throw error;
      }
    }
    this.#finish(intent, "open");
    return this.status();
  }
}
