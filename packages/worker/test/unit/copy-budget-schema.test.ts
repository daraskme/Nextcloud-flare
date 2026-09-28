import { readdirSync, readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { URL } from "node:url";
import { afterEach, beforeEach, expect, it } from "vitest";
import { copyBudgetExhaustedSql } from "../../src/jobs/copyBudget";
import { foundationFixture } from "../fixtures/foundation";

const directory = new URL("../../migrations/", import.meta.url);
let db: DatabaseSync;
beforeEach(() => {
  db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys=ON");
  for (const name of readdirSync(directory)
    .filter((n) => n.endsWith(".sql") && n < "0060_")
    .sort())
    db.exec(readFileSync(new URL(name, directory), "utf8"));
  for (const s of foundationFixture("source").statements)
    db.prepare(s.sql).run(...(s.values as (string | number | null)[]));
});
afterEach(() => db.close());
const migrate = () => db.exec(readFileSync(new URL("0060_copy_budget.sql", directory), "utf8"));
it("preserves rows and the FK graph and uses the runtime budget proof in the stop trigger", () => {
  const old = db
    .prepare("PRAGMA table_list")
    .all()
    .filter((r) => r.type === "table" && !String(r.name).startsWith("sqlite_"))
    .map((t) => ({ name: String(t.name), rows: db.prepare(`SELECT * FROM ${t.name}`).all() }));
  migrate();
  for (const t of old) expect(db.prepare(`SELECT * FROM ${t.name}`).all()).toEqual(t.rows);
  expect(db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
  const sql = db.prepare("SELECT sql FROM sqlite_schema WHERE name='copy_stop_proof'").get()!
    .sql as string;
  expect(sql.replace(/\s+/g, " ")).toContain(copyBudgetExhaustedSql("NEW").replace(/\s+/g, " "));
});
it.each(["admission", "restore", "backup"])("refuses migration during %s", (phase) => {
  const old = db.prepare("SELECT sql FROM sqlite_schema WHERE name='copy_stop_proof'").get();
  if (phase === "admission") db.exec("UPDATE control SET maintenance=0");
  if (phase === "restore")
    db.exec("UPDATE control SET restore_freeze_token='00000000-0000-4000-8000-000000000000'");
  if (phase === "backup")
    db.exec(`INSERT INTO backup_runs(id,epoch,state,created_at,barrier_token,watermark)
      SELECT 'backup',1,'exporting',1,'00000000-0000-4000-8000-000000000001',backup_last_op FROM control;
      UPDATE control SET backup_token='00000000-0000-4000-8000-000000000001',backup_barrier_op=backup_last_op,backup_frozen=1;`);
  expect(migrate).toThrow();
  expect(db.prepare("SELECT sql FROM sqlite_schema WHERE name='copy_stop_proof'").get()).toEqual(
    old,
  );
});
