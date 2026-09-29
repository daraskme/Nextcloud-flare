import { readdirSync, readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { URL } from "node:url";
import { afterEach, beforeEach, expect, it } from "vitest";

const dir = new URL("../../migrations/", import.meta.url),
  migration = readFileSync(new URL("0075_audio_cover_derivatives.sql", dir), "utf8");
let db: DatabaseSync;
beforeEach(() => {
  db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys=ON");
  for (const name of readdirSync(dir)
    .filter((n) => n.endsWith(".sql") && n < "0075")
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
it("changes only the derivative admission trigger and preserves all ordinary data", () => {
  const old = schema(),
    tables = db
      .prepare("PRAGMA table_list")
      .all()
      .filter((r) => r.type === "table" && !String(r.name).startsWith("sqlite_"));
  const rows = tables.map((t) => db.prepare(`SELECT * FROM "${t.name}"`).all());
  upgrade();
  expect(schema().filter((r) => r.name !== "image_derivative_start")).toEqual(
    old.filter((r) => r.name !== "image_derivative_start"),
  );
  expect(tables.map((t) => db.prepare(`SELECT * FROM "${t.name}"`).all())).toEqual(rows);
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
