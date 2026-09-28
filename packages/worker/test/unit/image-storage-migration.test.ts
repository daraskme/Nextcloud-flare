import { readdirSync, readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { URL } from "node:url";
import { afterEach, beforeEach, expect, it } from "vitest";
import { foundationFixture } from "../fixtures/foundation";

const dir = new URL("../../migrations/", import.meta.url);
const migration = readFileSync(new URL("0070_image_derivative_storage.sql", dir), "utf8");
let db: DatabaseSync;
beforeEach(() => {
  db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys=ON");
  for (const name of readdirSync(dir)
    .filter((n) => n.endsWith(".sql") && n < "0070")
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
function receipt(state: "succeeded" | "not_started" | "pending") {
  const now = Date.now();
  db.prepare(`INSERT INTO r2_write_attempts(id,token,epoch,owner_id,kind,r2_key,
    dispatch_before,started_at,state,finished_at,source_ref)
    VALUES(?,?,1,'owner','manifest.put',?,?,?,?,?,NULL)`).run(
    crypto.randomUUID(),
    crypto.randomUUID(),
    `target-sets/${crypto.randomUUID()}`,
    now + 5000,
    now,
    state,
    state === "pending" ? null : now,
  );
}
it("preserves native receipts and all existing guards while adding derivative storage", () => {
  receipt("succeeded");
  receipt("not_started");
  const rows = db.prepare("SELECT * FROM r2_write_attempts ORDER BY id").all();
  const triggers = db
    .prepare("SELECT name,sql FROM sqlite_schema WHERE type='trigger' ORDER BY name")
    .all();
  upgrade();
  expect(db.prepare("SELECT * FROM r2_write_attempts ORDER BY id").all()).toEqual(rows);
  for (const trigger of triggers) {
    if (["reservations_charge", "reservations_uncharge"].includes(trigger.name as string)) continue;
    expect(
      db
        .prepare("SELECT sql FROM sqlite_schema WHERE type='trigger' AND name=?")
        .get(trigger.name as string),
    ).toEqual({ sql: trigger.sql });
  }
  expect(db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
});
it("preserves ordinary reservation accounting and requires proof for physical-only capacity", () => {
  const f = foundationFixture("migration", Date.now() - 1000);
  for (const statement of f.statements)
    db.prepare(statement.sql).run(...((statement.values ?? []) as (string | number | null)[]));
  db.prepare(
    "INSERT INTO reservations(id,owner_id,bytes,state,expires_at,epoch) VALUES('held',?,11,'reserved',10000,1)",
  ).run(f.ids.user);
  const before = db.prepare("SELECT * FROM users WHERE id=?").get(f.ids.user);
  upgrade();
  expect(db.prepare("SELECT * FROM users WHERE id=?").get(f.ids.user)).toEqual({
    ...before,
    image_reserved_bytes: 0,
  });
  expect(db.prepare("SELECT physical_only FROM reservations WHERE id='held'").get()).toEqual({
    physical_only: 0,
  });
  db.exec("UPDATE reservations SET state='released' WHERE id='held'");
  expect(
    db.prepare("SELECT reserved_bytes,image_reserved_bytes FROM users WHERE id=?").get(f.ids.user),
  ).toEqual({ reserved_bytes: 0, image_reserved_bytes: 0 });
  expect(() =>
    db
      .prepare(
        "INSERT INTO reservations(id,owner_id,bytes,state,expires_at,epoch,physical_only) VALUES('forged',?,11,'reserved',10000,1,1)",
      )
      .run(f.ids.user),
  ).toThrow("invalid_image_reservation");
});
it.each(["running", "pending"])(
  "rejects migration with %s work and preserves the old schema",
  (mode) => {
    db.exec("UPDATE control SET maintenance=0");
    if (mode === "pending") {
      receipt("pending");
      db.exec("UPDATE control SET maintenance=1");
    }
    const before = db.prepare("SELECT * FROM r2_write_attempts").all();
    expect(upgrade).toThrow();
    expect(db.prepare("SELECT * FROM r2_write_attempts").all()).toEqual(before);
    expect(
      db
        .prepare("SELECT name FROM pragma_table_info('users') WHERE name='image_reserved_bytes'")
        .get(),
    ).toBeUndefined();
  },
);
