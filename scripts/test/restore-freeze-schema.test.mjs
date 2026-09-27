import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { afterEach, beforeEach, expect, it } from "vitest";
import { exportTables } from "../../packages/worker/src/db/schemaContract.ts";
import { initialize, migrations, specs } from "../backup/snapshot.mjs";

let db;
const versions = await migrations();
const migration = await readFile(
  new URL("../../packages/worker/migrations/0040_restore_freeze.sql", import.meta.url),
  "utf8",
);
beforeEach(() => {
  db = initialize(":memory:", versions);
});
afterEach(() => db.close());
const freeze = () => db.prepare("UPDATE control SET restore_freeze_token=?").run(randomUUID());

it("guards INSERT/UPDATE/DELETE on every normal table and preserves the export contract", () => {
  expect(
    specs(db)
      .map((t) => t.name)
      .sort(),
  ).toEqual([...exportTables].sort());
  const triggers = db
    .prepare(
      "SELECT name,sql FROM sqlite_schema WHERE type='trigger' AND name LIKE 'restore_freeze_%'",
    )
    .all();
  for (const table of exportTables)
    for (const operation of ["insert", "update", "delete"]) {
      const name =
        table === "control" && operation === "update"
          ? "restore_freeze_control_update"
          : `restore_freeze_${table}_${operation}`;
      expect(triggers.find((row) => row.name === name)?.sql).toContain("restore_freeze_token");
    }
  freeze();
  for (const table of exportTables)
    expect(() => db.exec(`INSERT INTO "${table}" DEFAULT VALUES`)).toThrow(
      "database_restore_frozen",
    );
  expect(() => db.exec("UPDATE operation_kinds SET name=name")).toThrow("database_restore_frozen");
  expect(() => db.exec("DELETE FROM operation_kinds")).toThrow("database_restore_frozen");
  expect(db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
});

it.each([
  "maintenance=0",
  "gc_paused=0",
  "epoch=epoch+1",
  "admission_revision=admission_revision+1",
  "restore_freeze_token='00000000-0000-0000-0000-000000000000'",
])("allows only an exact thaw, rejecting concurrent control mutation %s", (change) => {
  freeze();
  const before = db.prepare("SELECT * FROM control").get();
  expect(() => db.exec(`UPDATE control SET restore_freeze_token=NULL,${change}`)).toThrow(
    "database_restore_frozen",
  );
  expect(db.prepare("SELECT * FROM control").get()).toEqual(before);
  db.exec("UPDATE control SET restore_freeze_token=NULL");
  db.exec("UPDATE control SET admission_revision=admission_revision+1");
});

it("rolls back thaw together with a failed token rotation", () => {
  freeze();
  const token = db.prepare("SELECT restore_freeze_token FROM control").get().restore_freeze_token;
  db.exec("BEGIN");
  try {
    db.exec("UPDATE control SET restore_freeze_token=NULL");
    expect(() => db.exec("INSERT INTO _assert(v) VALUES(1)")).toThrow();
  } finally {
    db.exec("ROLLBACK");
  }
  expect(db.prepare("SELECT restore_freeze_token FROM control").get().restore_freeze_token).toBe(
    token,
  );
});

it.each(["maintenance", "backup"])("refuses migration from active %s state", (kind) => {
  db.close();
  db = initialize(":memory:", versions.slice(0, 39));
  if (kind === "maintenance") db.exec("UPDATE control SET maintenance=0");
  else {
    const token = randomUUID();
    db.prepare(
      "INSERT INTO backup_runs(id,epoch,state,created_at,barrier_token) VALUES(?,1,'exporting',1,?)",
    ).run(randomUUID(), token);
    db.prepare("UPDATE control SET backup_token=?").run(token);
  }
  expect(() => db.exec(migration)).toThrow();
  expect(
    db
      .prepare("PRAGMA table_info(control)")
      .all()
      .some((row) => row.name === "restore_freeze_token"),
  ).toBe(false);
});

it.each(["maintenance=0", "gc_paused=0"])("refuses freeze with %s", (change) => {
  db.exec(`UPDATE control SET ${change}`);
  expect(freeze).toThrow("restore_freeze_not_drained");
});
