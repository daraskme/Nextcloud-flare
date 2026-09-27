import { assertExists, atomicBatch, type BindValue, primary } from "../db/primary";
import { R2_WRITE_IDENTITY } from "../db/r2Write";
import { NativeHistory, nativeIdentity } from "./nativeHistory";

export interface NativeRepairStatus {
  stage: "kdf" | "r2" | "complete";
  afterId: string;
  checked: number;
  reconciled: number;
  unknown: number;
  completed: boolean;
}
interface Progress extends NativeRepairStatus {
  token: string;
}
const STOP = `SELECT 1 FROM control WHERE singleton=1 AND epoch=? AND maintenance=1 AND gc_paused=1
  AND admission_revision=? AND admission_token=? AND restore_freeze_token IS NULL
  AND backup_token IS NULL AND backup_frozen=0`;
interface Pending {
  id: string;
  epoch: number;
  dispatch_token: string;
  issued_at: number;
  expires_at: number;
  token: string;
  owner_id: string | null;
  kind: string;
  r2_key: string;
  dispatch_before: number;
  started_at: number;
  source_ref: string | null;
}

/** Only metadata settlement from actual native receipts; never dispatches crypto or R2. */
export class RestoreNativeRepair {
  readonly #history: NativeHistory;
  constructor(
    private readonly sql: SqlStorage,
    private readonly db: D1Database,
  ) {
    this.#history = new NativeHistory(sql);
    sql.exec(`CREATE TABLE IF NOT EXISTS control_database_restore_native_repair(
      id TEXT PRIMARY KEY REFERENCES control_database_restore(id),progress_json TEXT NOT NULL
    )`);
  }
  #saved(id: string): string | undefined {
    return this.sql
      .exec<{ progress_json: string }>(
        "SELECT progress_json FROM control_database_restore_native_repair WHERE id=?",
        id,
      )
      .toArray()[0]?.progress_json;
  }
  async page(
    id: string,
    epoch: number,
    limit: number,
    current: () => void,
  ): Promise<NativeRepairStatus> {
    if (!Number.isInteger(limit) || limit < 1 || limit > 20)
      throw new Error("invalid_recovery_limit");
    current();
    let saved = this.#saved(id);
    if (!saved || (JSON.parse(saved) as Progress).completed) {
      saved = JSON.stringify({
        stage: "kdf",
        afterId: "",
        checked: 0,
        reconciled: 0,
        unknown: 0,
        completed: false,
        token: crypto.randomUUID(),
      } satisfies Progress);
      this.sql.exec(
        `INSERT INTO control_database_restore_native_repair VALUES(?,?)
        ON CONFLICT(id) DO UPDATE SET progress_json=excluded.progress_json`,
        id,
        saved,
      );
    }
    const progress = JSON.parse(saved) as Progress;
    const active = () => {
      current();
      if (this.#saved(id) !== saved) throw new Error("database_restore_recovery_conflict");
    };
    const control = await primary(this.db)
      .prepare(
        "SELECT admission_revision,admission_token FROM control WHERE singleton=1 AND epoch=? AND maintenance=1 AND gc_paused=1",
      )
      .bind(epoch)
      .first<{ admission_revision: number; admission_token: string }>();
    active();
    if (!control) throw new Error("database_restore_recovery_conflict");
    const fence = [epoch, control.admission_revision, control.admission_token];
    const kdf = progress.stage === "kdf",
      table = kdf ? "kdf_attempts" : "r2_write_attempts",
      pending = kdf ? "claimed" : "pending";
    const rows = await primary(this.db)
      .prepare(`SELECT * FROM ${table} WHERE state=? AND id>? ORDER BY id LIMIT ?`)
      .bind(pending, progress.afterId, limit)
      .all<Pending>();
    active();
    for (const row of rows.results) {
      const values: BindValue[] = kdf
        ? [row.id, row.dispatch_token, row.epoch, row.issued_at, row.expires_at]
        : [
            row.id,
            row.token,
            row.epoch,
            row.owner_id,
            row.kind,
            row.r2_key,
            row.dispatch_before,
            row.started_at,
            row.source_ref,
          ];
      const identity = await nativeIdentity(kdf ? "kdf" : "r2", kdf ? values.slice(0, 3) : values);
      active();
      const proof = this.#history.find(identity);
      if (
        !proof ||
        row.epoch >= epoch ||
        (kdf
          ? proof.outcome === "succeeded" || row.expires_at > proof.deadline
          : proof.outcome === "finished" || row.dispatch_before !== proof.deadline)
      ) {
        progress.unknown++;
      } else {
        const match = kdf
          ? "id=? AND dispatch_token=? AND epoch=? AND issued_at=? AND expires_at=?"
          : R2_WRITE_IDENTITY;
        const confirmed = `SELECT 1 FROM ${table} WHERE ${match} AND state=? AND EXISTS (${STOP})`,
          confirmation = [...values, proof.outcome, ...fence];
        try {
          await atomicBatch(this.db, [
            assertExists(STOP, fence),
            {
              sql: `UPDATE ${table} SET state=?,finished_at=MAX(${kdf ? "issued_at" : "started_at"},strftime('%s','now')*1000)
                WHERE ${match} AND state=?`,
              values: [proof.outcome, ...values, pending],
            },
            assertExists(confirmed, confirmation),
          ]);
        } catch {
          // An unknown ACK is resolved only by the exact terminal tuple and the same stop.
        }
        active();
        const ended = await primary(this.db)
          .prepare(confirmed)
          .bind(...confirmation)
          .first();
        active();
        if (!ended) throw new Error("database_restore_native_repair_unconfirmed");
        progress.reconciled++;
      }
      progress.checked++;
      progress.afterId = row.id;
    }
    if (rows.results.length < limit) {
      progress.stage = kdf ? "r2" : "complete";
      progress.afterId = "";
      progress.completed = !kdf;
    }
    active();
    this.sql.exec(
      "UPDATE control_database_restore_native_repair SET progress_json=? WHERE id=?",
      JSON.stringify(progress),
      id,
    );
    const { token: _token, ...status } = progress;
    return status;
  }
}
