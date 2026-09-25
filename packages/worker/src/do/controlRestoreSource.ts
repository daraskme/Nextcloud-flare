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
export interface RestoreSqlStatus {
  id: string;
  epoch: number;
  manifestSha256: string;
  state: "sql_verified";
  validator: "logical-sql-v1";
  verifiedAt: number;
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
    sql.exec(`CREATE TABLE IF NOT EXISTS control_database_restore_sql(
      id TEXT PRIMARY KEY REFERENCES control_database_restore(id),epoch INTEGER NOT NULL,
      hash TEXT NOT NULL,verified_at INTEGER NOT NULL,expires_at INTEGER NOT NULL,
      validator TEXT NOT NULL CHECK(validator='logical-sql-v1')
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

  #authority(epoch: number, id: string): RestoreSourceAuthority {
    if (this.restore.inspect(epoch, id).state !== "preparing")
      throw new Error("database_restore_not_preparing");
    const value = this.closedAuthority(epoch);
    if (value.epoch !== epoch) throw new Error("database_restore_epoch_conflict");
    return value;
  }

  /** Only a trusted SQL verifier may attest the pinned publication; never grants overwrite permission. */
  async attest(epoch: number, id: string, manifestSha256: string): Promise<RestoreSqlStatus> {
    if (this.#busy) throw new Error("database_restore_source_busy");
    this.#busy = true;
    try {
      const selected = this.restore.inspect(epoch, id);
      if (selected.source.kind !== "logical" || selected.source.manifestSha256 !== manifestSha256)
        throw new Error("database_restore_source_conflict");
      const before = this.#authority(epoch, id),
        row = this.sql
          .exec<SourceRow>("SELECT * FROM control_database_restore_source WHERE id=?", id)
          .toArray()[0];
      if (!row || row.cursor < 1 || row.cursor !== row.total)
        throw new Error("database_restore_source_unverified");
      // Refresh the receipt, manifest, exact closed mirror and age after the external SQL check.
      const page = await this.#verify(epoch, id),
        after = this.#authority(epoch, id),
        now = Date.now();
      if (after.revision !== before.revision || after.token !== before.token)
        throw new Error("database_restore_source_conflict");
      if (now < page.observedAt || now > page.expiresAt)
        throw new Error("database_restore_source_expired");
      const saved = this.sql.exec<{ id: string }>(
        `INSERT INTO control_database_restore_sql VALUES(?,?,?,?,?,'logical-sql-v1')
        ON CONFLICT(id) DO UPDATE SET verified_at=excluded.verified_at
        WHERE epoch=excluded.epoch AND hash=excluded.hash AND expires_at=excluded.expires_at
          AND verified_at<=excluded.verified_at RETURNING id`,
        id,
        epoch,
        manifestSha256,
        page.observedAt,
        page.expiresAt,
      );
      if (saved.toArray().length !== 1) throw new Error("database_restore_source_conflict");
      return {
        id,
        epoch,
        manifestSha256,
        state: "sql_verified",
        validator: "logical-sql-v1",
        verifiedAt: page.observedAt,
        expiresAt: page.expiresAt,
      };
    } finally {
      this.#busy = false;
    }
  }

  async #verify(epoch: number, id: string): Promise<RestoreSourceStatus> {
    const selected = this.restore.inspect(epoch, id);
    if (selected.state !== "preparing") throw new Error("database_restore_not_preparing");
    if (selected.source.kind !== "logical") throw new Error("database_restore_source_unavailable");
    const authority = () => this.#authority(epoch, id);
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
      AND cursor=? AND total=? AND generation_json IS ? AND observed_at IS ? AND expires_at IS ?`,
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
      row.observed_at,
      row.expires_at,
    );
    if (updated.rowsWritten !== 1) throw new Error("database_restore_source_conflict");
    return this.#status(this.#row(id));
  }
}
