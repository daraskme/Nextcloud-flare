export const NATIVE_HISTORY_DAYS = 36;
export const NATIVE_HISTORY_LIMIT = 50_000_000;
export type NativeOutcome = "finished" | "succeeded" | "not_started";

/** Domain-separated identity only: no password, salt, crypto output or replayable grant. */
export async function nativeIdentity(kind: "kdf" | "r2", values: unknown[]): Promise<ArrayBuffer> {
  return crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(JSON.stringify(["native-history-v1", kind, ...values])),
  );
}

/** Independent of D1 rollback. Missing/expired evidence always means unknown. */
export class NativeHistory {
  constructor(private readonly sql: SqlStorage) {
    sql.exec(`CREATE TABLE IF NOT EXISTS control_native_history(
      identity BLOB PRIMARY KEY CHECK(length(identity)=32),
      outcome TEXT NOT NULL CHECK(outcome IN ('finished','succeeded','not_started')),
      deadline INTEGER NOT NULL CHECK(deadline>0),
      archived_at INTEGER NOT NULL CHECK(archived_at>=0)
    ) WITHOUT ROWID`);
    sql.exec(
      "CREATE INDEX IF NOT EXISTS control_native_history_age ON control_native_history(archived_at)",
    );
    sql.exec(`CREATE TABLE IF NOT EXISTS control_native_history_usage(
      singleton INTEGER PRIMARY KEY CHECK(singleton=1),
      entries INTEGER NOT NULL CHECK(entries>=0 AND entries<=${NATIVE_HISTORY_LIMIT})
    )`);
    sql.exec("INSERT OR IGNORE INTO control_native_history_usage VALUES(1,0)");
    sql.exec(`CREATE TRIGGER IF NOT EXISTS control_native_history_insert AFTER INSERT ON control_native_history
      BEGIN UPDATE control_native_history_usage SET entries=entries+1 WHERE singleton=1; END`);
    sql.exec(`CREATE TRIGGER IF NOT EXISTS control_native_history_delete AFTER DELETE ON control_native_history
      BEGIN UPDATE control_native_history_usage SET entries=entries-1 WHERE singleton=1; END`);
    sql.exec(`CREATE TRIGGER IF NOT EXISTS control_native_history_immutable BEFORE UPDATE ON control_native_history
      BEGIN SELECT RAISE(ABORT,'immutable_native_history'); END`);
    sql.exec(`CREATE TRIGGER IF NOT EXISTS control_native_history_retention BEFORE DELETE ON control_native_history
      WHEN OLD.archived_at>=strftime('%s','now')*1000-${NATIVE_HISTORY_DAYS * 86400000}
      BEGIN SELECT RAISE(ABORT,'native_history_retained'); END`);
  }

  find(identity: ArrayBuffer): { outcome: NativeOutcome; deadline: number } | undefined {
    return this.sql
      .exec<{ outcome: NativeOutcome; deadline: number }>(
        "SELECT outcome,deadline FROM control_native_history WHERE identity=?",
        identity,
      )
      .toArray()[0];
  }

  remember(identity: ArrayBuffer, outcome: NativeOutcome, deadline: number): void {
    const saved = this.find(identity);
    if (saved) {
      if (saved.outcome !== outcome || saved.deadline !== deadline)
        throw new Error("recovery_native_history_conflict");
      return;
    }
    // At most 32 removals per new receipt. Retain evidence while any restore owns the hold.
    const restoreTable = this.sql
      .exec("SELECT 1 FROM sqlite_master WHERE type='table' AND name='control_database_restore'")
      .toArray().length;
    const restoring =
      restoreTable &&
      this.sql
        .exec(
          "SELECT 1 FROM control_database_restore WHERE phase='preparing' AND released_at IS NULL LIMIT 1",
        )
        .toArray().length;
    if (!restoring)
      this.sql.exec(`DELETE FROM control_native_history WHERE identity IN (
      SELECT identity FROM control_native_history
      WHERE archived_at<strftime('%s','now')*1000-${NATIVE_HISTORY_DAYS * 86400000}
      ORDER BY archived_at LIMIT 32)`);
    // Capacity failure leaves the original terminal receipt in the live, bounded ledger.
    const inserted = this.sql.exec(
      "INSERT INTO control_native_history VALUES(?,?,?,MAX(?,strftime('%s','now')*1000)) RETURNING identity",
      identity,
      outcome,
      deadline,
      Date.now(),
    );
    if (inserted.toArray().length !== 1) throw new Error("recovery_native_history_unconfirmed");
  }
}
