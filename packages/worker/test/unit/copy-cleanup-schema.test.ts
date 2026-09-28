import { readdirSync, readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { URL } from "node:url";
import { afterEach, beforeEach, expect, it } from "vitest";
import { foundationFixture } from "../fixtures/foundation";

const directory = new URL("../../migrations/", import.meta.url);
let db: DatabaseSync;
beforeEach(() => {
  db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys=ON");
  for (const name of readdirSync(directory)
    .filter((n) => n.endsWith(".sql") && n < "0057_")
    .sort())
    db.exec(readFileSync(new URL(name, directory), "utf8"));
  for (const s of foundationFixture("source").statements)
    db.prepare(s.sql).run(...(s.values as (string | number | null)[]));
});
afterEach(() => db.close());
const migrate = () => db.exec(readFileSync(new URL("0057_copy_cleanup.sql", directory), "utf8"));
it("preserves all old rows and columns and has a complete FK graph", () => {
  const tables = db
    .prepare("PRAGMA table_list")
    .all()
    .filter((r) => r.type === "table" && !String(r.name).startsWith("sqlite_"));
  const old = tables.map((t) => ({
    name: String(t.name),
    columns: db
      .prepare(`PRAGMA table_info(${t.name})`)
      .all()
      .map((c) => String(c.name))
      .join(","),
    rows: db.prepare(`SELECT * FROM ${t.name}`).all(),
  }));
  migrate();
  for (const t of old)
    expect(db.prepare(`SELECT ${t.columns} FROM ${t.name}`).all()).toEqual(t.rows);
  expect(db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
});
it.each(["admission", "restore", "backup"])("refuses migration during %s", (phase) => {
  if (phase === "admission") db.exec("UPDATE control SET maintenance=0");
  if (phase === "restore")
    db.exec("UPDATE control SET restore_freeze_token='00000000-0000-4000-8000-000000000000'");
  if (phase === "backup")
    db.exec(`INSERT INTO backup_runs(id,epoch,state,created_at,barrier_token,watermark)
    SELECT 'backup',1,'exporting',1,'00000000-0000-4000-8000-000000000001',backup_last_op FROM control;
    UPDATE control SET backup_token='00000000-0000-4000-8000-000000000001',backup_barrier_op=backup_last_op,backup_frozen=1;`);
  expect(migrate).toThrow();
  expect(
    db.prepare("SELECT name FROM sqlite_schema WHERE name='copy_cleanup_receipts'").get(),
  ).toBeUndefined();
});
it("requires a stopped job and durable proof before creating any cleanup receipt", () => {
  migrate();
  expect(() =>
    db.exec(
      "INSERT INTO copy_cleanup_receipts VALUES('job','source-b','dest','pin','reservation',3,'unwritten',1,1)",
    ),
  ).toThrow("copy_unwritten_unproven");
});
