import type { RestoreTimeTravelResult } from "../../../shared/src/restoreTimeTravel";
import { epochNumber } from "./epochHistory";

/** A pinned operator selection, not proof that the archive/bookmark has been verified. */
export type DatabaseRestoreSource =
  | { kind: "logical"; id: string; epoch: number; manifestSha256: string }
  | { kind: "time_travel"; bookmark: string };

interface RestoreRow extends Record<string, SqlStorageValue> {
  id: string;
  epoch: number;
  source_json: string;
  phase: "preparing" | "cancelled";
  created_at: number;
}

export interface DatabaseRestoreStatus {
  id: string;
  epoch: number;
  source: DatabaseRestoreSource;
  state:
    | RestoreRow["phase"]
    | "freezing"
    | "frozen"
    | "cancelling"
    | "epoch_reserving"
    | "epoch_reserved"
    | "restore_pending"
    | "restore_written"
    | "snapshot_checking"
    | "snapshot_verified"
    | "adoption_pending"
    | "adoption_written"
    | "epoch_adopted";
  createdAt: number;
  newEpoch?: number;
  restoreResult?: RestoreTimeTravelResult;
  snapshotVerifiedAt?: number;
}

// Match the existing logical-backup generation identity contract, including imported UUIDs.
const uuid = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;
function restoreId(id: string): void {
  if (typeof id !== "string" || !uuid.test(id)) throw new Error("invalid_database_restore");
}
function sourceJson(source: DatabaseRestoreSource): string {
  if (!source || typeof source !== "object") throw new Error("invalid_database_restore");
  if (source.kind === "logical") {
    restoreId(source.id);
    epochNumber(source.epoch);
    if (typeof source.manifestSha256 !== "string" || !/^[a-f0-9]{64}$/.test(source.manifestSha256))
      throw new Error("invalid_database_restore");
    return JSON.stringify({
      kind: source.kind,
      id: source.id,
      epoch: source.epoch,
      manifestSha256: source.manifestSha256,
    });
  }
  if (
    source.kind === "time_travel" &&
    typeof source.bookmark === "string" &&
    /^[\x21-\x7e]{1,256}$/.test(source.bookmark)
  )
    // Syntax is deliberately opaque here. The platform bookmark must be verified separately.
    return JSON.stringify({ kind: source.kind, bookmark: source.bookmark });
  throw new Error("invalid_database_restore");
}

/** D1 rollback cannot erase this hold. No method here authorizes a database overwrite. */
export class ControlDatabaseRestore {
  constructor(private readonly sql: SqlStorage) {
    sql.exec(`CREATE TABLE IF NOT EXISTS control_database_restore(
      id TEXT PRIMARY KEY,epoch INTEGER NOT NULL CHECK(epoch>0),source_json TEXT NOT NULL,
      phase TEXT NOT NULL CHECK(phase IN ('preparing','cancelled')),created_at INTEGER NOT NULL
    )`);
    sql.exec(`CREATE UNIQUE INDEX IF NOT EXISTS control_database_restore_active
      ON control_database_restore((1)) WHERE phase='preparing'`);
    sql.exec(`CREATE TABLE IF NOT EXISTS control_database_restore_freeze(
      id TEXT PRIMARY KEY REFERENCES control_database_restore(id),epoch INTEGER NOT NULL,
      token TEXT NOT NULL UNIQUE,phase TEXT NOT NULL CHECK(phase IN ('freezing','frozen','cancelling','cancelled')),
      challenge_json TEXT NOT NULL,proof_json TEXT NOT NULL,expires_at INTEGER NOT NULL,
      started_at INTEGER NOT NULL,frozen_at INTEGER,cancel_token TEXT,cancel_revision INTEGER
    )`);
    sql.exec(`CREATE TABLE IF NOT EXISTS control_database_restore_epoch(
      id TEXT PRIMARY KEY REFERENCES control_database_restore(id),epoch INTEGER NOT NULL,
      source_json TEXT NOT NULL,targets_json TEXT NOT NULL,freeze_token TEXT NOT NULL,
      history_token TEXT NOT NULL UNIQUE,proof_json TEXT NOT NULL,created_at INTEGER NOT NULL,
      phase TEXT NOT NULL CHECK(phase IN ('allocating','writing','reserved')),
      new_epoch INTEGER,history_at INTEGER,
      CHECK((phase='allocating')=(new_epoch IS NULL)),
      CHECK((new_epoch IS NULL)=(history_at IS NULL)),CHECK(new_epoch>epoch)
    )`);
    sql.exec(`CREATE TABLE IF NOT EXISTS control_database_restore_execution(
      id TEXT PRIMARY KEY REFERENCES control_database_restore(id),grant_json TEXT NOT NULL,
      state TEXT NOT NULL CHECK(state IN ('pending','ended')),result_json TEXT,
      CHECK((state='ended')=(result_json IS NOT NULL))
    )`);
    sql.exec(`CREATE TRIGGER IF NOT EXISTS control_database_restore_execution_immutable
      BEFORE UPDATE ON control_database_restore_execution
      WHEN NEW.id<>OLD.id OR NEW.grant_json<>OLD.grant_json
        OR NOT (OLD.state='pending' AND NEW.state='ended')
      BEGIN SELECT RAISE(ABORT,'database_restore_execution_conflict'); END`);
    sql.exec(`CREATE TRIGGER IF NOT EXISTS control_database_restore_execution_delete
      BEFORE DELETE ON control_database_restore_execution
      BEGIN SELECT RAISE(ABORT,'database_restore_execution_conflict'); END`);
    sql.exec(`CREATE TABLE IF NOT EXISTS control_database_restore_snapshot(
      id TEXT PRIMARY KEY REFERENCES control_database_restore(id),challenge_id TEXT NOT NULL,
      issued_at INTEGER NOT NULL,expires_at INTEGER NOT NULL,challenge_json TEXT,
      proof_json TEXT,verified_at INTEGER,
      CHECK((proof_json IS NULL)=(verified_at IS NULL))
    )`);
    sql.exec(`CREATE TABLE IF NOT EXISTS control_database_restore_adoption(
      id TEXT PRIMARY KEY REFERENCES control_database_restore(id),challenge_json TEXT NOT NULL,
      state TEXT NOT NULL CHECK(state IN ('pending','written','adopted'))
    )`);
    sql.exec(`CREATE TRIGGER IF NOT EXISTS control_database_restore_adoption_immutable
      BEFORE UPDATE ON control_database_restore_adoption
      WHEN NEW.id<>OLD.id OR NEW.challenge_json<>OLD.challenge_json OR NOT (
        OLD.state='pending' AND NEW.state='written' OR OLD.state='written' AND NEW.state='adopted')
      BEGIN SELECT RAISE(ABORT,'database_restore_adoption_conflict'); END`);
    sql.exec(`CREATE TRIGGER IF NOT EXISTS control_database_restore_adoption_delete
      BEFORE DELETE ON control_database_restore_adoption
      BEGIN SELECT RAISE(ABORT,'database_restore_adoption_conflict'); END`);
  }

  active(): boolean {
    return (
      this.sql.exec("SELECT 1 FROM control_database_restore WHERE phase='preparing'").toArray()
        .length > 0
    );
  }

  assertInactive(): void {
    if (this.active()) throw new Error("database_restore_active");
  }

  assertCancellable(id: string): void {
    if (
      this.sql.exec("SELECT 1 FROM control_database_restore_epoch WHERE id=?", id).toArray().length
    )
      throw new Error("database_restore_epoch_reserved");
  }

  /** A durable freeze intent also closes the maintenance-only mutation path. */
  assertCanRepair(): void {
    if (
      this.sql
        .exec(`SELECT 1 FROM control_database_restore_freeze f WHERE phase<>'cancelled'
          AND NOT EXISTS(SELECT 1 FROM control_database_restore_adoption a WHERE a.id=f.id AND a.state='adopted') LIMIT 1`)
        .toArray().length
    )
      throw new Error("database_restore_frozen");
  }

  #row(epoch: number, id: string): RestoreRow | undefined {
    epochNumber(epoch);
    restoreId(id);
    const row = this.sql
      .exec<RestoreRow>("SELECT * FROM control_database_restore WHERE id=?", id)
      .toArray()[0];
    if (row && row.epoch !== epoch) throw new Error("database_restore_conflict");
    return row;
  }

  #status(row: RestoreRow): DatabaseRestoreStatus {
    const adoption = this.sql
      .exec("SELECT state FROM control_database_restore_adoption WHERE id=?", row.id)
      .toArray()[0];
    const snapshot = this.sql
      .exec<{ verified_at: number | null }>(
        "SELECT verified_at FROM control_database_restore_snapshot WHERE id=?",
        row.id,
      )
      .toArray()[0];
    const execution = this.sql
      .exec<{ state: string; result_json: string | null }>(
        "SELECT state,result_json FROM control_database_restore_execution WHERE id=?",
        row.id,
      )
      .toArray()[0];
    const reservation = this.sql
      .exec<{ phase: string; new_epoch: number | null }>(
        "SELECT phase,new_epoch FROM control_database_restore_epoch WHERE id=?",
        row.id,
      )
      .toArray()[0];
    const freeze = this.sql
      .exec<{ phase: "freezing" | "frozen" | "cancelling" | "cancelled" }>(
        "SELECT phase FROM control_database_restore_freeze WHERE id=? AND epoch=?",
        row.id,
        row.epoch,
      )
      .toArray()[0];
    return {
      id: row.id,
      epoch: row.epoch,
      source: JSON.parse(row.source_json) as DatabaseRestoreSource,
      state: adoption
        ? adoption.state === "adopted"
          ? "epoch_adopted"
          : adoption.state === "written"
            ? "adoption_written"
            : "adoption_pending"
        : snapshot
          ? snapshot.verified_at === null
            ? "snapshot_checking"
            : "snapshot_verified"
          : execution
            ? execution.state === "ended"
              ? "restore_written"
              : "restore_pending"
            : reservation
              ? reservation.phase === "reserved"
                ? "epoch_reserved"
                : "epoch_reserving"
              : row.phase === "cancelled" || !freeze || freeze.phase === "cancelled"
                ? row.phase
                : freeze.phase,
      createdAt: row.created_at,
      ...(reservation?.new_epoch ? { newEpoch: reservation.new_epoch } : {}),
      ...(execution?.result_json
        ? { restoreResult: JSON.parse(execution.result_json) as RestoreTimeTravelResult }
        : {}),
      ...(snapshot?.verified_at === null || snapshot?.verified_at === undefined
        ? {}
        : { snapshotVerifiedAt: snapshot.verified_at }),
    };
  }

  existing(epoch: number, id: string, source: DatabaseRestoreSource): DatabaseRestoreStatus | null {
    const selected = sourceJson(source),
      row = this.#row(epoch, id);
    if (!row) return null;
    if (row.source_json !== selected) throw new Error("database_restore_conflict");
    return this.#status(row);
  }

  inspect(epoch: number, id: string): DatabaseRestoreStatus {
    const row = this.#row(epoch, id);
    if (!row) throw new Error("database_restore_missing");
    return this.#status(row);
  }

  /** Caller has rechecked the ready epoch and backup exclusion immediately before this write. */
  begin(epoch: number, id: string, source: DatabaseRestoreSource): DatabaseRestoreStatus {
    const existing = this.existing(epoch, id, source);
    if (existing) return existing;
    this.assertInactive();
    this.sql.exec(
      "INSERT INTO control_database_restore VALUES(?,?,?,'preparing',?)",
      id,
      epoch,
      sourceJson(source),
      Date.now(),
    );
    return this.inspect(epoch, id);
  }

  /** Only preparation can be cancelled, after the caller has freshly closed D1 admission. */
  cancel(epoch: number, id: string): DatabaseRestoreStatus {
    this.assertCancellable(id);
    const previous = this.inspect(epoch, id);
    this.assertCanRepair();
    if (previous.state === "cancelled") return previous;
    const saved = this.sql.exec(
      "UPDATE control_database_restore SET phase='cancelled' WHERE id=? AND epoch=? AND phase='preparing' RETURNING id",
      id,
      epoch,
    );
    if (saved.toArray().length !== 1) throw new Error("database_restore_conflict");
    return this.inspect(epoch, id);
  }
}
