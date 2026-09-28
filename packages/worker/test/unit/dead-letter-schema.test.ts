import { readdirSync, readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { URL } from "node:url";
import { afterEach, beforeEach, expect, it } from "vitest";
import { foundationFixture } from "../fixtures/foundation";

const dir = new URL("../../migrations/", import.meta.url);
let db: DatabaseSync;
beforeEach(() => {
  db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys=ON");
  for (const name of readdirSync(dir)
    .filter((n) => n.endsWith(".sql") && n < "0062_")
    .sort())
    db.exec(readFileSync(new URL(name, dir), "utf8"));
  for (const s of foundationFixture().statements)
    db.prepare(s.sql).run(...(s.values as (string | number | null)[]));
});
afterEach(() => db.close());
const migrate = () => db.exec(readFileSync(new URL("0062_queue_dead_letters.sql", dir), "utf8"));
it("preserves existing tables, exports unknown references, and indexes stable pagination", () => {
  const rows = db.prepare("SELECT * FROM users").all();
  migrate();
  expect(db.prepare("SELECT * FROM users").all()).toEqual(rows);
  db.exec("INSERT INTO queue_dead_letters VALUES('receipt','missing',1,2,1)");
  expect(db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
  const plan = db
    .prepare(
      "EXPLAIN QUERY PLAN SELECT * FROM queue_dead_letters WHERE (received_at,message_id)<(?,?) ORDER BY received_at DESC,message_id DESC LIMIT 51",
    )
    .all(3, "z");
  expect(plan.some((r) => String(r.detail).includes("queue_dead_letters_page"))).toBe(true);
  expect(plan.some((r) => String(r.detail).includes("TEMP B-TREE"))).toBe(false);
  expect(() => db.exec("UPDATE queue_dead_letters SET outbox_id='other'")).toThrow(
    "immutable_dead_letter",
  );
});
it.each(["admission", "backup", "restore"])("requires quiescence before migration: %s", (phase) => {
  if (phase === "admission") db.exec("UPDATE control SET maintenance=0");
  if (phase === "restore")
    db.exec("UPDATE control SET restore_freeze_token='00000000-0000-4000-8000-000000000000'");
  if (phase === "backup")
    db.exec(
      "INSERT INTO backup_runs(id,epoch,state,created_at,barrier_token,watermark) SELECT 'backup',1,'exporting',1,'00000000-0000-4000-8000-000000000001',backup_last_op FROM control; UPDATE control SET backup_token='00000000-0000-4000-8000-000000000001',backup_barrier_op=backup_last_op,backup_frozen=1",
    );
  expect(migrate).toThrow();
  expect(
    db.prepare("SELECT 1 FROM sqlite_schema WHERE name='queue_dead_letters'").get(),
  ).toBeUndefined();
});
it.each(["backup", "restore"])("freezes delivery facts during %s", (phase) => {
  migrate();
  db.exec("INSERT INTO queue_dead_letters VALUES('receipt',NULL,1,2,1)");
  if (phase === "restore")
    db.exec("UPDATE control SET restore_freeze_token='00000000-0000-4000-8000-000000000000'");
  else
    db.exec(
      "INSERT INTO backup_runs(id,epoch,state,created_at,barrier_token,watermark) SELECT 'backup',1,'exporting',1,'00000000-0000-4000-8000-000000000001',backup_last_op FROM control; UPDATE control SET backup_token='00000000-0000-4000-8000-000000000001',backup_barrier_op=backup_last_op,backup_frozen=1",
    );
  for (const sql of [
    "INSERT INTO queue_dead_letters VALUES('next',NULL,1,2,1)",
    "UPDATE queue_dead_letters SET outbox_id='changed'",
    "DELETE FROM queue_dead_letters",
  ])
    expect(() => db.exec(sql)).toThrow();
  expect(db.prepare("SELECT * FROM queue_dead_letters").get()).toEqual({
    message_id: "receipt",
    outbox_id: null,
    sent_at: 1,
    received_at: 2,
    epoch: 1,
  });
});
