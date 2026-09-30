import { assertExists, assertOneChange, atomicBatch } from "../db/primary";
import { type RestorePause } from "../db/restorePause";
import type { ControlStatus } from "./ControlDO";
import {
  assertNoBackup,
  type BackupAdmissionSnapshot,
  initializeBackupState,
} from "./controlBackup";
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
  operator_paused: number;
  hold_token: string | null;
  hold_operation: string | null;
  hold_expires_at: number | null;
  prior_gc_paused: number;
}

export interface AdmissionTransition {
  epoch: number;
  revision: number;
  token: string | null;
}

const clock = "strftime('%s','now')*1000";
const closedWork = `NOT EXISTS(SELECT 1 FROM permits WHERE state='open')
  AND NOT EXISTS(SELECT 1 FROM mutation_admissions WHERE state<>'closed')
  AND NOT EXISTS(SELECT 1 FROM operations WHERE state='claimed')`;

/** Local intent is durable before external I/O. D1 accepts only that transition identity. */
export class ControlAdmission {
  constructor(
    private readonly storage: DurableObjectStorage,
    private readonly db: D1Database,
    private readonly currentEpoch: () => number,
    private readonly assertKdfQuiescent: () => void,
  ) {
    initializeBackupState(storage.sql);
    storage.sql.exec(`CREATE TABLE IF NOT EXISTS control_admission(
      singleton INTEGER PRIMARY KEY CHECK(singleton=1),epoch INTEGER NOT NULL,
      revision INTEGER NOT NULL CHECK(revision BETWEEN 0 AND 9007199254740991),
      phase TEXT NOT NULL CHECK(phase IN ('closed','closing','opening','open','gc_changing')),
      token TEXT,prior_token TEXT,gc_paused INTEGER NOT NULL CHECK(gc_paused IN (0,1)),
      audit_token TEXT
    )`);
    storage.sql.exec(`INSERT OR IGNORE INTO control_admission(singleton,epoch,revision,phase,gc_paused)
      SELECT 1,epoch,0,'closed',1 FROM control_state WHERE singleton=1`);
    storage.sql.exec(`CREATE TABLE IF NOT EXISTS control_gc_policy(
      singleton INTEGER PRIMARY KEY CHECK(singleton=1),epoch INTEGER NOT NULL,
      operator_paused INTEGER NOT NULL CHECK(operator_paused IN (0,1)),
      hold_token TEXT,hold_operation TEXT,hold_expires_at INTEGER,prior_gc_paused INTEGER NOT NULL
    )`);
    storage.sql.exec(`INSERT OR IGNORE INTO control_gc_policy
      SELECT singleton,epoch,gc_paused,NULL,NULL,NULL,gc_paused FROM control_admission`);
    storage.sql.exec(`CREATE TABLE IF NOT EXISTS control_alarm_failures(
      singleton INTEGER PRIMARY KEY CHECK(singleton=1),epoch INTEGER NOT NULL,
      revision INTEGER NOT NULL,token TEXT,failures INTEGER NOT NULL CHECK(failures BETWEEN 1 AND 6)
    )`);
    // An interrupted repair cannot be treated as complete just because its isolate was evicted.
    storage.sql.exec(`CREATE TABLE IF NOT EXISTS control_maintenance_tasks(
      token TEXT PRIMARY KEY,epoch INTEGER NOT NULL
    )`);
  }

  #row(epoch = this.currentEpoch(), allowBackup = false): AdmissionRow {
    if (!allowBackup) assertNoBackup(this.storage.sql);
    if (this.currentEpoch() !== epoch) throw new Error("admission_epoch_conflict");
    const row = this.storage.sql
      .exec<AdmissionRow>(
        "SELECT a.*,p.operator_paused,p.hold_token,p.hold_operation,p.hold_expires_at,p.prior_gc_paused FROM control_admission a JOIN control_gc_policy p ON p.singleton=a.singleton AND p.epoch=a.epoch WHERE a.singleton=1",
      )
      .one();
    if (row.epoch !== epoch) throw new Error("admission_epoch_conflict");
    return row;
  }

  captureBackup(): BackupAdmissionSnapshot {
    const row = this.#row();
    if ((row.phase !== "open" && row.phase !== "closed") || row.hold_token !== null)
      throw new Error("backup_admission_busy");
    if (this.storage.sql.exec("SELECT 1 FROM control_maintenance_tasks LIMIT 1").toArray().length)
      throw new Error("backup_maintenance_active");
    return {
      epoch: row.epoch,
      revision: row.revision,
      phase: row.phase,
      token: row.token,
      gc_paused: row.gc_paused,
      operator_paused: row.operator_paused,
      audit_token: row.audit_token,
    };
  }

  /** Called only after the backup's exact D1 release receipt, in the caller's local transaction. */
  restoreBackup(snapshot: BackupAdmissionSnapshot, token: string): void {
    const row = this.#row(snapshot.epoch, true);
    if (
      row.revision !== snapshot.revision ||
      row.token !== snapshot.token ||
      row.phase !== snapshot.phase
    )
      throw new Error("backup_admission_conflict");
    this.storage.sql.exec(
      `UPDATE control_admission SET revision=?,token=?,prior_token=NULL WHERE singleton=1`,
      snapshot.revision + 2,
      token,
    );
    this.storage.sql.exec("DELETE FROM control_alarm_failures");
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
    this.storage.sql.exec(
      "UPDATE control_gc_policy SET epoch=?,operator_paused=1,hold_token=NULL,hold_operation=NULL,hold_expires_at=NULL,prior_gc_paused=1 WHERE singleton=1",
      epoch,
    );
    this.storage.sql.exec("DELETE FROM recovery_audit_v7");
    this.storage.sql.exec("DELETE FROM control_alarm_failures");
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
    this.assertKdfQuiescent();
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

  #transition(
    row: AdmissionRow,
    phase: AdmissionRow["phase"],
    gc: number,
    audit: string | null,
    policy: Pick<
      AdmissionRow,
      "operator_paused" | "hold_token" | "hold_operation" | "hold_expires_at"
    > = { operator_paused: 1, hold_token: null, hold_operation: null, hold_expires_at: null },
  ) {
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
      this.storage.sql.exec(
        "UPDATE control_gc_policy SET operator_paused=?,hold_token=?,hold_operation=?,hold_expires_at=?,prior_gc_paused=? WHERE singleton=1 AND epoch=?",
        policy.operator_paused,
        policy.hold_token,
        policy.hold_operation,
        policy.hold_expires_at,
        row.gc_paused,
        row.epoch,
      );
      if (phase === "closing") this.storage.sql.exec("DELETE FROM recovery_audit_v7");
    });
    return this.#row(row.epoch);
  }

  async #receipt(row: AdmissionRow, maintenance: number, quiescent = true): Promise<boolean> {
    const receipt = await this.db
      .prepare(`SELECT 1 FROM control WHERE singleton=1 AND epoch=?
        AND admission_revision=? AND admission_token IS ? AND maintenance=? AND gc_paused=?
        AND gc_operator_paused=? AND gc_hold_token IS ? AND gc_hold_operation IS ? AND gc_hold_expires_at IS ?
        ${maintenance && quiescent ? `AND ${closedWork}` : ""}`)
      .bind(
        row.epoch,
        row.revision,
        row.token,
        maintenance,
        row.gc_paused,
        row.operator_paused,
        row.hold_token,
        row.hold_operation,
        row.hold_expires_at,
      )
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

  /** Synchronous local fence immediately before native crypto dispatch. */
  assertKdfOpen(epoch: number): void {
    if (this.#row(epoch).phase !== "open") throw new Error("kdf_unavailable");
  }

  assertMutationOpen(epoch: number): void {
    if (this.#row(epoch).phase !== "open") throw new Error("mutation_unavailable");
  }

  /** Capture locally before entering the bounded queue; all D1 work stays inside that queue. */
  captureSystemMutationMode(epoch: number): 0 | 1 {
    const phase = this.#row(epoch).phase;
    if (phase !== "open" && phase !== "closed") throw new Error("mutation_unavailable");
    return phase === "closed" ? 1 : 0;
  }

  /** Internal facts may queue in a stable closed mode; transitional or mismatched mirrors cannot. */
  async systemMutationMode(epoch: number): Promise<0 | 1> {
    const row = this.#row(epoch);
    if (row.phase !== "open" && row.phase !== "closed") throw new Error("mutation_unavailable");
    const maintenance = row.phase === "closed" ? 1 : 0;
    if (!(await this.#receipt(row, maintenance, false))) throw new Error("control_mirror_conflict");
    this.#current(row);
    return maintenance;
  }

  assertSystemMutationMode(epoch: number, maintenance: 0 | 1): void {
    if (this.#row(epoch).phase !== (maintenance ? "closed" : "open"))
      throw new Error("mutation_unavailable");
  }

  async close(epoch: number): Promise<ControlStatus & { activeJobLease: boolean }> {
    epochNumber(epoch);
    const row = this.#row(epoch);
    const intent = row.phase === "closing" ? row : this.#transition(row, "closing", 1, null);
    try {
      await atomicBatch(this.db, [
        {
          sql: `UPDATE control SET maintenance=1,gc_paused=1,gc_operator_paused=1,gc_hold_token=NULL,gc_hold_operation=NULL,gc_hold_expires_at=NULL,admission_revision=?,admission_token=?,
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
            sql: `UPDATE control SET maintenance=0,gc_paused=1,gc_operator_paused=1,gc_hold_token=NULL,gc_hold_operation=NULL,gc_hold_expires_at=NULL,admission_revision=?,admission_token=?,
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

  /** Operator pause remains authoritative after a temporary restore window ends. */
  async setGcPaused(epoch: number, paused: boolean): Promise<ControlStatus> {
    epochNumber(epoch);
    const row = this.#row(epoch);
    if (row.hold_token && !paused) throw new Error("gc_restore_busy");
    if (row.phase === "open" && row.operator_paused === Number(paused)) return this.status();
    if (
      row.phase !== "open" &&
      !(row.phase === "gc_changing" && row.operator_paused === Number(paused))
    )
      throw new Error("admission_not_open");
    const intent =
      row.phase === "gc_changing"
        ? row
        : this.#transition(row, "gc_changing", row.hold_token || paused ? 1 : 0, row.audit_token, {
            ...row,
            operator_paused: Number(paused),
          });
    return this.#applyGc(intent);
  }

  async #applyGc(intent: AdmissionRow): Promise<ControlStatus> {
    if (!(await this.#receipt(intent, 0))) {
      this.#current(intent);
      try {
        await atomicBatch(this.db, [
          {
            sql: `UPDATE control SET gc_paused=?,gc_operator_paused=?,gc_hold_token=?,gc_hold_operation=?,gc_hold_expires_at=?,
            admission_revision=?,admission_token=?,updated_at=MAX(updated_at,${clock})
            WHERE singleton=1 AND epoch=? AND maintenance=0 AND admission_revision=? AND admission_token IS ? AND gc_paused=?`,
            values: [
              intent.gc_paused,
              intent.operator_paused,
              intent.hold_token,
              intent.hold_operation,
              intent.hold_expires_at,
              intent.revision,
              intent.token,
              intent.epoch,
              intent.revision - 1,
              intent.prior_token,
              intent.prior_gc_paused,
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

  async acquireRestorePause(epoch: number, operationId: string): Promise<RestorePause> {
    epochNumber(epoch);
    if (!/^op_[a-f0-9]{64}$/.test(operationId)) throw new Error("invalid_restore_pause");
    let row = this.#row(epoch);
    if (row.hold_token && row.hold_expires_at! <= Date.now()) {
      await this.releaseRestorePause(epoch, row.hold_token);
      row = this.#row(epoch);
    }
    if (row.hold_token && row.hold_operation !== operationId) throw new Error("gc_restore_busy");
    if (
      row.phase !== "open" &&
      !(row.phase === "gc_changing" && row.hold_operation === operationId)
    )
      throw new Error("admission_not_open");
    const intent = row.hold_token
      ? row
      : this.#transition(row, "gc_changing", 1, row.audit_token, {
          operator_paused: row.operator_paused,
          hold_token: crypto.randomUUID(),
          hold_operation: operationId,
          hold_expires_at: Date.now() + 300_000,
        });
    // Persist retry scheduling before any external dispatch. A lost reply cannot orphan the hold.
    await this.storage.setAlarm(Date.now() + 5_000);
    if (intent.phase === "gc_changing") await this.#applyGc(intent);
    else {
      await this.status();
      this.#current(intent);
    }
    return { epoch, token: intent.hold_token!, operationId, expiresAt: intent.hold_expires_at! };
  }

  async releaseRestorePause(epoch: number, token: string): Promise<void> {
    let row = this.#row(epoch);
    if (row.phase === "gc_changing") {
      await this.#applyGc(row);
      row = this.#row(epoch);
    }
    if (row.hold_token !== token || row.phase !== "open") return;
    const intent = this.#transition(row, "gc_changing", row.operator_paused, row.audit_token, {
      operator_paused: row.operator_paused,
      hold_token: null,
      hold_operation: null,
      hold_expires_at: null,
    });
    await this.storage.setAlarm(Date.now() + 5_000);
    await this.#applyGc(intent);
  }

  /** Restart interrupted transitions; expiration revokes the SQL capability before GC resumes. */
  async reconcileRestorePause(): Promise<RestorePause | null> {
    let row = this.#row();
    if (row.phase === "gc_changing") {
      await this.#applyGc(row);
      row = this.#row();
    }
    if (row.phase !== "open" || !row.hold_token) return null;
    if (
      row.hold_expires_at! <= Date.now() ||
      (await this.db
        .prepare(
          "SELECT 1 FROM operations WHERE op_id=? AND epoch=? AND state IN ('committed','failed')",
        )
        .bind(row.hold_operation, row.epoch)
        .first<number>()) !== null
    ) {
      await this.releaseRestorePause(row.epoch, row.hold_token);
      return null;
    }
    return {
      epoch: row.epoch,
      token: row.hold_token,
      operationId: row.hold_operation!,
      expiresAt: row.hold_expires_at!,
    };
  }

  alarmTransition(): AdmissionTransition {
    const { epoch, revision, token } = this.#row();
    return { epoch, revision, token };
  }

  restoreAlarmSucceeded(transition: AdmissionTransition): void {
    this.storage.sql.exec(
      "DELETE FROM control_alarm_failures WHERE epoch=? AND revision=? AND token IS ?",
      transition.epoch,
      transition.revision,
      transition.token,
    );
  }

  /** Six consecutive failures of this exact transition require explicit operator repair. */
  async restoreAlarmFailed(transition: AdmissionTransition): Promise<boolean> {
    const current = this.#row();
    if (
      current.epoch !== transition.epoch ||
      current.revision !== transition.revision ||
      current.token !== transition.token
    )
      // An old failure cannot close a newer transition. Preserve cleanup scheduling when an
      // operator pause changed the revision while this alarm was waiting on D1.
      return (
        current.phase === "gc_changing" || (current.phase === "open" && current.hold_token !== null)
      );
    if (current.phase !== "open" && current.phase !== "gc_changing") return false;
    const attempts = this.storage.sql
      .exec<{ failures: number }>(
        `INSERT INTO control_alarm_failures VALUES(1,?,?,?,1) ON CONFLICT(singleton) DO UPDATE SET
        failures=CASE WHEN epoch=excluded.epoch AND revision=excluded.revision AND token IS excluded.token
          THEN MIN(failures+1,6) ELSE 1 END,
        epoch=excluded.epoch,revision=excluded.revision,token=excluded.token RETURNING failures`,
        transition.epoch,
        transition.revision,
        transition.token,
      )
      .one().failures;
    if (attempts < 6) return true;
    try {
      // close() persists the closing intent before D1 I/O. Readback failure stays closed locally.
      await this.close(current.epoch);
    } catch {
      // quiesce() can reconcile this exact pending close after the operator repairs D1.
    }
    return false;
  }
}
