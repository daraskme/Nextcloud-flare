import { KdfUnavailableError } from "../auth/kdf";
import { assertOneChange, atomicBatch, primary } from "../db/primary";

const CLOCK = "strftime('%s','now')*1000";
export interface KdfDispatch {
  id: string;
  token: string;
  epoch: number;
  deadline: number;
}
type Terminal = "finished" | "not_started";
interface Receipt extends KdfDispatch, Record<string, SqlStorageValue> {
  state: "reserved" | Terminal;
  dispatch_started: number;
}
export interface KdfRepairResult {
  checked: number;
  reconciled: number;
  pending: number;
  unknown: number;
}
interface Saved {
  state: string;
  epoch: number;
  expires_at: number;
}

/** Bounded completion evidence, never password material or a replayable crypto request. */
export class KdfSettlements {
  constructor(
    private readonly sql: SqlStorage,
    private readonly db: D1Database,
    private readonly sync: () => Promise<void>,
  ) {
    sql.exec(`CREATE TABLE IF NOT EXISTS control_kdf_receipts(
      token TEXT PRIMARY KEY CHECK(length(token)=36),id TEXT NOT NULL CHECK(length(id)=36),
      epoch INTEGER NOT NULL CHECK(epoch>0),deadline INTEGER NOT NULL CHECK(deadline>0),
      state TEXT NOT NULL CHECK(state IN ('reserved','finished','not_started'))
    )`);
    sql.exec(`CREATE TRIGGER IF NOT EXISTS control_kdf_receipt_limit BEFORE INSERT ON control_kdf_receipts
      WHEN (SELECT COUNT(*) FROM control_kdf_receipts)>=20
      BEGIN SELECT RAISE(ABORT,'kdf_receipt_capacity'); END`);
    sql.exec(`CREATE TRIGGER IF NOT EXISTS control_kdf_receipt_delete BEFORE DELETE ON control_kdf_receipts
      WHEN OLD.state='reserved' BEGIN SELECT RAISE(ABORT,'kdf_completion_required'); END`);
    // Older reservations may already have dispatched native crypto. Never infer otherwise.
    if (
      !sql
        .exec("PRAGMA table_info(control_kdf_receipts)")
        .toArray()
        .some((column) => column.name === "dispatch_started")
    )
      sql.exec(
        "ALTER TABLE control_kdf_receipts ADD COLUMN dispatch_started INTEGER NOT NULL DEFAULT 1 CHECK(dispatch_started IN (0,1))",
      );
    sql.exec("DROP TRIGGER IF EXISTS control_kdf_receipt_immutable");
    sql.exec(`CREATE TRIGGER IF NOT EXISTS control_kdf_receipt_immutable_v2 BEFORE UPDATE ON control_kdf_receipts
      WHEN OLD.state<>'reserved' OR NEW.token<>OLD.token OR NEW.id<>OLD.id
        OR NEW.epoch<>OLD.epoch OR NEW.deadline<>OLD.deadline
        OR NOT ((NEW.state='reserved' AND OLD.dispatch_started=0 AND NEW.dispatch_started=1)
          OR (NEW.state IN ('finished','not_started') AND NEW.dispatch_started=OLD.dispatch_started))
      BEGIN SELECT RAISE(ABORT,'immutable_kdf_receipt'); END`);
  }

  reserve(r: KdfDispatch): void {
    this.sql.exec(
      "INSERT INTO control_kdf_receipts(token,id,epoch,deadline,state,dispatch_started) VALUES(?,?,?,?,'reserved',0)",
      r.token,
      r.id,
      r.epoch,
      r.deadline,
    );
  }

  /** Durable intent precedes native work; repair can cancel only a reservation without it. */
  async beginDispatch(r: KdfDispatch): Promise<void> {
    const changed = this.sql.exec(
      `UPDATE control_kdf_receipts SET dispatch_started=1
       WHERE token=? AND id=? AND epoch=? AND deadline=? AND state='reserved' AND dispatch_started=0`,
      r.token,
      r.id,
      r.epoch,
      r.deadline,
    );
    if (changed.rowsWritten !== 1) throw new KdfUnavailableError();
    await this.sync();
    const saved = this.#rows().find((row) => row.token === r.token);
    if (!saved || saved.state !== "reserved" || saved.dispatch_started !== 1)
      throw new KdfUnavailableError();
  }

  assertEmpty(): void {
    if (this.#rows().length) throw new Error("recovery_kdf_unsettled");
  }

  #rows(): Receipt[] {
    return this.sql
      .exec<Receipt>("SELECT * FROM control_kdf_receipts ORDER BY token LIMIT 20")
      .toArray();
  }

  async settle(r: KdfDispatch, state: Terminal): Promise<void> {
    try {
      this.sql.exec(
        "UPDATE control_kdf_receipts SET state=? WHERE token=? AND id=? AND epoch=? AND deadline=? AND state='reserved'",
        state,
        r.token,
        r.id,
        r.epoch,
        r.deadline,
      );
    } catch {
      // A replaced instance can finish native work but lose local storage access. Preserve
      // that exact completion in D1 if reachable; repair still needs a confirmed receipt.
      try {
        await this.#recordD1(r, state);
      } catch {
        /* Both stores unavailable: retain the unknown hold. */
      }
      throw new KdfUnavailableError();
    }
    const saved = this.#rows().find((row) => row.token === r.token);
    if (
      !saved ||
      saved.id !== r.id ||
      saved.epoch !== r.epoch ||
      saved.deadline !== r.deadline ||
      saved.state !== state
    )
      throw new KdfUnavailableError();
    if (!(await this.#confirm(saved))) throw new KdfUnavailableError();
  }

  async repair(limit = 20): Promise<KdfRepairResult> {
    if (!Number.isInteger(limit) || limit < 1 || limit > 20)
      throw new Error("invalid_kdf_repair_limit");
    const rows = this.#rows().slice(0, limit);
    for (const row of rows) {
      try {
        if (row.state === "reserved") {
          if (row.dispatch_started === 0) {
            // The synchronous transition fences a suspended handler before it can dispatch.
            // Earlier rows can await D1, so this row may have started after our snapshot.
            const changed = this.sql.exec(
              `UPDATE control_kdf_receipts SET state='not_started'
               WHERE token=? AND id=? AND epoch=? AND deadline=? AND state='reserved' AND dispatch_started=0`,
              row.token,
              row.id,
              row.epoch,
              row.deadline,
            );
            if (changed.rowsWritten === 1) await this.#confirm({ ...row, state: "not_started" });
          } else {
            // Exact immutable D1 terminal evidence can survive loss of the local receipt write.
            const saved = await primary(this.db)
              .prepare(
                "SELECT state,epoch,expires_at FROM kdf_attempts WHERE id=? AND dispatch_token=?",
              )
              .bind(row.id, row.token)
              .first<Saved>();
            if (
              saved &&
              (saved.state === "finished" || saved.state === "not_started") &&
              saved.epoch === row.epoch &&
              saved.expires_at <= row.deadline
            )
              await this.settle(row, saved.state);
          }
        } else await this.#confirm(row);
      } catch {
        // Keep the exact proof. No inference from elapsed time or a failed DB request.
      }
    }
    const remaining = this.#rows();
    return {
      checked: rows.length,
      reconciled: rows.filter((row) => !remaining.some((other) => other.token === row.token))
        .length,
      pending: remaining.length,
      unknown: remaining.filter((row) => row.state === "reserved").length,
    };
  }

  #forget(r: Receipt): void {
    this.sql.exec(
      "DELETE FROM control_kdf_receipts WHERE token=? AND id=? AND epoch=? AND deadline=? AND state=?",
      r.token,
      r.id,
      r.epoch,
      r.deadline,
      r.state,
    );
  }

  #matches(saved: Saved, r: Receipt): boolean {
    return saved.state === r.state && saved.epoch === r.epoch && saved.expires_at <= r.deadline;
  }

  async #recordD1(r: KdfDispatch, state: Terminal): Promise<void> {
    await primary(this.db)
      .prepare(`UPDATE kdf_attempts SET state=?,finished_at=MAX(issued_at,${CLOCK})
        WHERE id=? AND dispatch_token=? AND epoch=? AND expires_at<=? AND state='claimed'`)
      .bind(state, r.id, r.token, r.epoch, r.deadline)
      .run();
  }

  async #confirm(r: Receipt): Promise<boolean> {
    if (r.state === "reserved") throw new KdfUnavailableError();
    try {
      await this.#recordD1(r, r.state);
    } catch {
      // A committed update may have lost its acknowledgement.
    }
    const saved = await primary(this.db)
      .prepare("SELECT state,epoch,expires_at FROM kdf_attempts WHERE id=? AND dispatch_token=?")
      .bind(r.id, r.token)
      .first<Saved>();
    if (saved) {
      if (!this.#matches(saved, r)) throw new KdfUnavailableError();
      this.#forget(r);
      return true;
    }
    // Acquire a write transaction before observing absence. A delayed claim serialized after
    // this barrier must reevaluate its SQL-clock/dispatch-deadline checks and cannot start late.
    const results = await atomicBatch(this.db, [
      { sql: "UPDATE control SET kdf_not_before=kdf_not_before WHERE singleton=1" },
      assertOneChange,
      {
        sql: `SELECT k.state,k.epoch,k.expires_at,${CLOCK} AS now FROM control c
          LEFT JOIN kdf_attempts k ON k.id=? AND k.dispatch_token=? WHERE c.singleton=1`,
        values: [r.id, r.token],
      },
    ]);
    const observed = results[2]?.results[0] as (Saved & { now: number }) | undefined;
    if (!observed) throw new KdfUnavailableError();
    if (observed.state !== null && this.#matches(observed, r)) {
      this.#forget(r);
      return true;
    }
    if (observed.state === null && observed.now >= r.deadline) this.#forget(r);
    // Even a proven absent receipt never turns an uncertain derivation into a successful one.
    return false;
  }
}
