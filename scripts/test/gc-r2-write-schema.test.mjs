import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, expect, it } from "vitest";
import { initialize, migrations } from "../backup/snapshot.mjs";

const versions = await migrations();
const migration = versions.find((m) => m.name === "0042_gc_r2_write_attempts.sql");
let db;
beforeEach(() => {
  db = initialize(":memory:", versions.slice(0, 41));
});
afterEach(() => db.close());
function attempt(kind, state = "pending", owner = "owner") {
  const started = Math.floor(Date.now() / 1000) * 1000;
  const values = [
    randomUUID(),
    randomUUID(),
    1,
    owner,
    kind,
    `u/${owner ?? "missing"}/b/${randomUUID()}`,
    started + 2000,
    started - 3000,
    state,
    state === "pending" ? null : started,
  ];
  db.prepare("INSERT INTO r2_write_attempts VALUES(?,?,?,?,?,?,?,?,?,?)").run(...values);
  return values;
}
it("preserves expired pending and terminal attempts through the forward migration", async () => {
  db.exec("UPDATE control SET maintenance=0");
  for (const state of ["pending", "succeeded", "not_started"]) attempt("empty.put", state);
  db.exec("UPDATE control SET maintenance=1");
  const before = db.prepare("SELECT * FROM r2_write_attempts ORDER BY id").all();
  await new Promise((resolve) => setTimeout(resolve, 2100));
  db.exec(migration.sql);
  expect(db.prepare("SELECT * FROM r2_write_attempts ORDER BY id").all()).toEqual(before);
  expect(db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
  expect(() => db.exec("UPDATE control SET maintenance=0")).toThrow("r2_write_unsettled");
  expect(() => db.prepare("UPDATE control SET restore_freeze_token=?").run(randomUUID())).toThrow(
    "restore_freeze_not_drained",
  );
  expect(() => db.exec("DELETE FROM r2_write_attempts")).toThrow("r2_write_receipt_required");
});
it.each(["blob.delete", "orphan.delete"])(
  "records %s while stopped and retains the hold",
  (kind) => {
    db.exec(migration.sql);
    const values = attempt(kind, "pending", kind === "orphan.delete" ? null : "owner");
    expect(db.prepare("SELECT state FROM r2_write_attempts WHERE id=?").get(values[0]).state).toBe(
      "pending",
    );
    expect(() => db.exec("UPDATE control SET maintenance=0")).toThrow("r2_write_unsettled");
    expect(() =>
      attempt(kind, "pending", kind === "orphan.delete" ? "fake-owner" : null),
    ).toThrow();
  },
);
it.each(["open", "backup", "restore"])("refuses forward migration during %s", (phase) => {
  if (phase === "open") db.exec("UPDATE control SET maintenance=0");
  if (phase === "backup") {
    const token = randomUUID();
    db.prepare(
      "INSERT INTO backup_runs(id,epoch,state,created_at,barrier_token) VALUES(?,1,'pending',1,?)",
    ).run(randomUUID(), token);
    db.prepare("UPDATE control SET backup_token=?").run(token);
  }
  if (phase === "restore")
    db.prepare("UPDATE control SET restore_freeze_token=?").run(randomUUID());
  expect(() => db.exec(migration.sql)).toThrow();
  expect(
    db.prepare("SELECT name FROM sqlite_schema WHERE name='_r2_write_attempts_next'").get(),
  ).toBeUndefined();
});
