import { type RestoreSourceAuthority, verifyRestoreSourcePage } from "../backup/restoreSource";
import type { ControlDatabaseRestore } from "./controlDatabaseRestore";

interface SourceRow extends Record<string, SqlStorageValue> {
  id: string;
  epoch: number;
  hash: string;
  cursor: number;
  total: number;
  generation_json: string | null;
  observed_at: number | null;
  expires_at: number | null;
}
export interface RestoreSourceStatus {
  id: string;
  epoch: number;
  manifestSha256: string;
  state: "verifying" | "parts_verified";
  partsVerified: number;
  partsTotal: number;
  observedAt: number;
  expiresAt: number;
}

/** Resumable transport verification. SQL/schema validation and final restore sealing are separate. */
export class ControlRestoreSource {
  #busy = false;
  constructor(
    private readonly sql: SqlStorage,
    private readonly db: D1Database,
    private readonly bucket: R2Bucket,
    private readonly restore: ControlDatabaseRestore,
    private readonly closedAuthority: (epoch: number) => RestoreSourceAuthority,
  ) {
    sql.exec(`CREATE TABLE IF NOT EXISTS control_database_restore_source(
      id TEXT PRIMARY KEY REFERENCES control_database_restore(id),epoch INTEGER NOT NULL,
      hash TEXT NOT NULL,cursor INTEGER NOT NULL CHECK(cursor>=0),total INTEGER NOT NULL CHECK(total>=0),
      generation_json TEXT,observed_at INTEGER,expires_at INTEGER,
      CHECK(cursor<=total),CHECK((cursor=0)=(generation_json IS NULL))
    )`);
  }

  #row(id: string): SourceRow {
    return this.sql
      .exec<SourceRow>("SELECT * FROM control_database_restore_source WHERE id=?", id)
      .one();
  }
  #status(row: SourceRow): RestoreSourceStatus {
    if (row.observed_at === null || row.expires_at === null || row.cursor < 1)
      throw new Error("database_restore_source_unverified");
    return {
      id: row.id,
      epoch: row.epoch,
      manifestSha256: row.hash,
      state: row.cursor === row.total ? "parts_verified" : "verifying",
      partsVerified: row.cursor,
      partsTotal: row.total,
      observedAt: row.observed_at,
      expiresAt: row.expires_at,
    };
  }

  async verify(epoch: number, id: string): Promise<RestoreSourceStatus> {
    if (this.#busy) throw new Error("database_restore_source_busy");
    this.#busy = true;
    try {
      return await this.#verify(epoch, id);
    } finally {
      this.#busy = false;
    }
  }
  async #verify(epoch: number, id: string): Promise<RestoreSourceStatus> {
    const selected = this.restore.inspect(epoch, id);
    if (selected.state !== "preparing") throw new Error("database_restore_not_preparing");
    if (selected.source.kind !== "logical") throw new Error("database_restore_source_unavailable");
    const authority = () => {
      if (this.restore.inspect(epoch, id).state !== "preparing")
        throw new Error("database_restore_not_preparing");
      const value = this.closedAuthority(epoch);
      if (value.epoch !== epoch) throw new Error("database_restore_epoch_conflict");
      return value;
    };
    const before = authority();
    this.sql.exec(
      `INSERT OR IGNORE INTO control_database_restore_source
      VALUES(?,?,?,0,0,NULL,NULL,NULL)`,
      id,
      epoch,
      selected.source.manifestSha256,
    );
    const row = this.#row(id);
    if (row.epoch !== epoch || row.hash !== selected.source.manifestSha256)
      throw new Error("database_restore_source_conflict");
    const page = await verifyRestoreSourcePage({
      db: this.db,
      bucket: this.bucket,
      source: selected.source,
      cursor: row.cursor,
      authority,
    });
    const after = authority();
    if (
      before.epoch !== after.epoch ||
      before.revision !== after.revision ||
      before.token !== after.token
    )
      throw new Error("database_restore_source_conflict");
    const now = Date.now();
    if (row.observed_at !== null && page.observedAt < row.observed_at)
      throw new Error("database_restore_source_clock_conflict");
    if (now < page.observedAt || now > page.expiresAt)
      throw new Error("database_restore_source_expired");
    const generation = JSON.stringify(page.generation);
    if (
      (row.total !== 0 && row.total !== page.parts) ||
      (row.generation_json !== null && row.generation_json !== generation)
    )
      throw new Error("database_restore_source_conflict");
    const updated = this.sql.exec(
      `UPDATE control_database_restore_source SET cursor=?,total=?,
      generation_json=?,observed_at=?,expires_at=? WHERE id=? AND epoch=? AND hash=?
      AND cursor=? AND total=? AND generation_json IS ?`,
      page.next,
      page.parts,
      generation,
      page.observedAt,
      page.expiresAt,
      id,
      epoch,
      row.hash,
      row.cursor,
      row.total,
      row.generation_json,
    );
    if (updated.rowsWritten !== 1) throw new Error("database_restore_source_conflict");
    return this.#status(this.#row(id));
  }
}
