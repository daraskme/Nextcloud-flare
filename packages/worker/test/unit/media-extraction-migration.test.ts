import { readdirSync, readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { URL } from "node:url";
import { afterEach, beforeEach, expect, it } from "vitest";

const dir = new URL("../../migrations/", import.meta.url),
  migration = readFileSync(new URL("0076_media_extraction_requests.sql", dir), "utf8");
let db: DatabaseSync;
beforeEach(() => {
  db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys=ON");
  for (const name of readdirSync(dir)
    .filter((n) => n.endsWith(".sql") && n < "0076")
    .sort())
    db.exec(readFileSync(new URL(name, dir), "utf8"));
});
afterEach(() => db.close());
function upgrade() {
  db.exec("BEGIN");
  try {
    db.exec(migration);
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}
const schema = () =>
  db.prepare("SELECT name,sql FROM sqlite_schema WHERE sql IS NOT NULL ORDER BY name").all();
it("adds only a bounded terminal receipt and operation/index without new tables", () => {
  const tables = () =>
    db.prepare("SELECT name FROM sqlite_schema WHERE type='table' ORDER BY name").all();
  const old = tables();
  upgrade();
  expect(tables()).toEqual(old);
  expect(
    db.prepare("SELECT name FROM operation_kinds WHERE name='media.extract'").all(),
  ).toHaveLength(1);
  expect(db.prepare("PRAGMA table_info('outbox')").all().at(-1)).toMatchObject({
    name: "result_json",
    type: "TEXT",
  });
  expect(db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
});
it.each([
  "maintenance=0",
  "backup_token='00000000-0000-0000-0000-000000000001',backup_frozen=1",
  "restore_freeze_token='00000000-0000-0000-0000-000000000001'",
])("rejects unsafe control state %s atomically", (update) => {
  db.exec(
    "INSERT INTO backup_runs(id,epoch,state,created_at,barrier_token) VALUES('backup',1,'exporting',0,'00000000-0000-0000-0000-000000000001')",
  );
  db.exec(`UPDATE control SET ${update}`);
  const old = schema();
  expect(upgrade).toThrow();
  expect(schema()).toEqual(old);
});
