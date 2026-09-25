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
  state: RestoreRow["phase"];
  createdAt: number;
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
    return {
      id: row.id,
      epoch: row.epoch,
      source: JSON.parse(row.source_json) as DatabaseRestoreSource,
      state: row.phase,
      createdAt: row.created_at,
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
    this.inspect(epoch, id);
    this.sql.exec(
      "UPDATE control_database_restore SET phase='cancelled' WHERE id=? AND epoch=? AND phase='preparing'",
      id,
      epoch,
    );
    return this.inspect(epoch, id);
  }
}
