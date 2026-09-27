import { atomicBatch, type BindValue } from "../../src/db/primary";

/** Isolated test database only. Simulates provider rollback, restoring the original SQL guard atomically. */
export async function rollbackNativeReceipt(
  db: D1Database,
  table: "kdf_attempts" | "r2_write_attempts",
  id: string,
  changes: Record<string, BindValue> = {},
) {
  const trigger = table === "kdf_attempts" ? "kdf_attempt_update" : "r2_write_immutable";
  const sql = await db
    .prepare("SELECT sql FROM sqlite_master WHERE type='trigger' AND name=?")
    .bind(trigger)
    .first<string>("sql");
  if (!sql) throw new Error("fixture_trigger_missing");
  await atomicBatch(db, [
    { sql: `DROP TRIGGER ${trigger}` },
    {
      sql: `UPDATE ${table} SET state=?,finished_at=NULL${Object.keys(changes)
        .map((key) => `,${key}=?`)
        .join("")} WHERE id=?`,
      values: [table === "kdf_attempts" ? "claimed" : "pending", ...Object.values(changes), id],
    },
    { sql },
  ]);
}
