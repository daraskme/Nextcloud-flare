import { EPOCH_PREFIX, type EpochRecord, epochNumber } from "./epochHistory";

export const EPOCH_HISTORY_TIMEOUT_MS = 10000;

interface Receipt extends Record<string, SqlStorageValue> {
  token: string;
  epoch: number;
  at: number;
  reason: string;
  state: "reserved" | "pending" | "ended";
}

/** One native PUT per durable epoch reservation. Readback cannot settle an unknown PUT. */
export class ControlEpochHistory {
  constructor(private readonly sql: SqlStorage) {
    sql.exec(`CREATE TABLE IF NOT EXISTS control_epoch_write(
      singleton INTEGER PRIMARY KEY CHECK(singleton=1),token TEXT NOT NULL,
      epoch INTEGER NOT NULL CHECK(epoch>0),at INTEGER NOT NULL CHECK(at>0),reason TEXT NOT NULL,
      state TEXT NOT NULL CHECK(state IN ('reserved','pending','ended')))`);
    sql.exec(`CREATE TRIGGER IF NOT EXISTS control_epoch_write_immutable
      BEFORE UPDATE ON control_epoch_write
      WHEN NEW.singleton<>OLD.singleton OR NEW.token<>OLD.token OR NEW.epoch<>OLD.epoch
        OR NEW.at<>OLD.at OR NEW.reason<>OLD.reason
        OR NOT ((OLD.state='reserved' AND NEW.state='pending') OR (OLD.state='pending' AND NEW.state='ended'))
      BEGIN SELECT RAISE(ABORT,'epoch_history_receipt_conflict'); END`);
    sql.exec(`CREATE TRIGGER IF NOT EXISTS control_epoch_write_delete
      BEFORE DELETE ON control_epoch_write WHEN OLD.state<>'ended'
      BEGIN SELECT RAISE(ABORT,'epoch_history_write_unsettled'); END`);
  }

  assertSettled(): void {
    if (this.sql.exec("SELECT 1 FROM control_epoch_write WHERE state<>'ended'").toArray().length)
      throw new Error("epoch_history_write_unsettled");
  }

  /** Called in the same synchronous transaction as control_state's pending intent. */
  reserve(record: EpochRecord, token: string): void {
    epochNumber(record.epoch);
    if (
      !Number.isSafeInteger(record.at) ||
      record.at <= 0 ||
      !["bootstrap", "storage_recovery", "restore", "credential_rotation", "operator"].includes(
        record.reason,
      ) ||
      !token
    )
      throw new Error("invalid_pending_epoch");
    this.assertSettled();
    this.sql.exec("DELETE FROM control_epoch_write WHERE state='ended'");
    this.sql.exec(
      "INSERT INTO control_epoch_write VALUES(1,?,?,?,?,'reserved')",
      token,
      record.epoch,
      record.at,
      record.reason,
    );
  }

  #receipt(record: EpochRecord, token: string): Receipt {
    const row = this.sql.exec<Receipt>("SELECT * FROM control_epoch_write").toArray()[0];
    // Legacy pending intents lack termination evidence; never synthesize a receipt from GET.
    if (!row) throw new Error("epoch_history_receipt_missing");
    if (
      row.token !== token ||
      row.epoch !== record.epoch ||
      row.at !== record.at ||
      row.reason !== record.reason
    )
      throw new Error("epoch_history_receipt_conflict");
    return row;
  }

  async persist(
    bucket: R2Bucket,
    record: EpochRecord,
    token: string,
    assertCurrent: () => void,
  ): Promise<void> {
    assertCurrent();
    if (this.#receipt(record, token).state === "pending")
      throw new Error("epoch_history_write_unsettled");
    const started = Date.now(),
      deadline = started + EPOCH_HISTORY_TIMEOUT_MS,
      key = `${EPOCH_PREFIX}${record.epoch}.json`;
    let active = true,
      timer: ReturnType<typeof setTimeout> | undefined,
      reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    const current = () => {
      if (!active) throw new Error("epoch_history_timeout");
      assertCurrent();
      this.#receipt(record, token);
      const now = Date.now();
      if (now < started || now >= deadline) throw new Error("epoch_history_timeout");
    };
    try {
      await Promise.race([
        (async () => {
          current();
          if (this.#receipt(record, token).state === "reserved") {
            this.sql.exec("UPDATE control_epoch_write SET state='pending' WHERE state='reserved'");
            // No await between the durable dispatch record and the one native invocation.
            await bucket.put(key, JSON.stringify(record), {
              onlyIf: { etagDoesNotMatch: "*" },
              httpMetadata: { contentType: "application/json" },
            });
            // Success or conditional no-op proves this invocation ended, even after timeout.
            // It grants no right to continue the expired/superseded publication.
            this.#receipt(record, token);
            this.sql.exec("UPDATE control_epoch_write SET state='ended' WHERE state='pending'");
            current();
          }
          const existing = await bucket.get(key);
          try {
            current();
            if (!existing || existing.size < 1 || existing.size > 1024)
              throw new Error("epoch_history_conflict");
            reader = existing.body.getReader();
            const bytes = new Uint8Array(existing.size);
            let count = 0;
            while (true) {
              const part = await reader.read();
              current();
              if (part.done) break;
              if (count + part.value.byteLength > bytes.length)
                throw new Error("epoch_history_conflict");
              bytes.set(part.value, count);
              count += part.value.byteLength;
            }
            if (count !== bytes.length) throw new Error("epoch_history_conflict");
            const found: unknown = JSON.parse(
              new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes),
            );
            if (
              !found ||
              typeof found !== "object" ||
              Array.isArray(found) ||
              Object.keys(found).length !== 3 ||
              !("epoch" in found && "at" in found && "reason" in found) ||
              found.epoch !== record.epoch ||
              found.at !== record.at ||
              found.reason !== record.reason
            )
              throw new Error("epoch_history_conflict");
          } finally {
            if (!reader) void existing?.body.cancel().catch(() => {});
          }
        })(),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            active = false;
            reject(new Error("epoch_history_timeout"));
          }, EPOCH_HISTORY_TIMEOUT_MS);
        }),
      ]);
      current();
    } finally {
      active = false;
      clearTimeout(timer);
      void reader?.cancel().catch(() => {});
    }
  }
}
