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
  ) {
    sql.exec(`CREATE TABLE IF NOT EXISTS control_kdf_receipts(
      token TEXT PRIMARY KEY CHECK(length(token)=36),id TEXT NOT NULL CHECK(length(id)=36),
      epoch INTEGER NOT NULL CHECK(epoch>0),deadline INTEGER NOT NULL CHECK(deadline>0),
      state TEXT NOT NULL CHECK(state IN ('reserved','finished','not_started'))
    )`);
    sql.exec(`CREATE TRIGGER IF NOT EXISTS control_kdf_receipt_limit BEFORE INSERT ON control_kdf_receipts
      WHEN (SELECT COUNT(*) FROM control_kdf_receipts)>=20
      BEGIN SELECT RAISE(ABORT,'kdf_receipt_capacity'); END`);
    sql.exec(`CREATE TRIGGER IF NOT EXISTS control_kdf_receipt_immutable BEFORE UPDATE ON control_kdf_receipts
      WHEN OLD.state<>'reserved' OR NEW.state='reserved' OR NEW.token<>OLD.token OR NEW.id<>OLD.id
        OR NEW.epoch<>OLD.epoch OR NEW.deadline<>OLD.deadline
      BEGIN SELECT RAISE(ABORT,'immutable_kdf_receipt'); END`);
    sql.exec(`CREATE TRIGGER IF NOT EXISTS control_kdf_receipt_delete BEFORE DELETE ON control_kdf_receipts
      WHEN OLD.state='reserved' BEGIN SELECT RAISE(ABORT,'kdf_completion_required'); END`);
  }

  reserve(r: KdfDispatch): void {
    this.sql.exec(
      "INSERT INTO control_kdf_receipts(token,id,epoch,deadline,state) VALUES(?,?,?,?,'reserved')",
      r.token,
      r.id,
      r.epoch,
      r.deadline,
    );
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
    this.sql.exec(
      "UPDATE control_kdf_receipts SET state=? WHERE token=? AND id=? AND epoch=? AND deadline=? AND state='reserved'",
      state,
      r.token,
      r.id,
      r.epoch,
      r.deadline,
    );
    const saved = this.#rows().find((row) => row.token === r.token);
    if (
      !saved ||
      saved.id !== r.id ||
      saved.epoch !== r.epoch ||
      saved.deadline !== r.deadline ||
      saved.state !== state
    )
      throw new KdfUnavailableError();
    if (!(await this.#confirm({ ...r, state }))) throw new KdfUnavailableError();
  }

  async repair(limit = 20): Promise<KdfRepairResult> {
    if (!Number.isInteger(limit) || limit < 1 || limit > 20)
      throw new Error("invalid_kdf_repair_limit");
    const rows = this.#rows()
      .filter((row) => row.state !== "reserved")
      .slice(0, limit);
    for (const row of rows) {
      try {
        await this.#confirm(row);
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

  async #confirm(r: Receipt): Promise<boolean> {
    if (r.state === "reserved") throw new KdfUnavailableError();
    try {
      await primary(this.db)
        .prepare(`UPDATE kdf_attempts SET state=?,finished_at=MAX(issued_at,${CLOCK})
          WHERE id=? AND dispatch_token=? AND epoch=? AND expires_at<=? AND state='claimed'`)
        .bind(r.state, r.id, r.token, r.epoch, r.deadline)
        .run();
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
