import { readdirSync, readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { URL } from "node:url";
import { afterEach, beforeEach, expect, it } from "vitest";
import { foundationFixture } from "../fixtures/foundation";

const dir = new URL("../../migrations/", import.meta.url);
const migration = readFileSync(new URL("0077_archive_derivative_storage.sql", dir), "utf8");
let db: DatabaseSync;
beforeEach(() => {
  db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys=ON");
  for (const name of readdirSync(dir)
    .filter((n) => n.endsWith(".sql") && n < "0077")
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
  db.prepare(`INSERT INTO r2_write_attempts(id,token,epoch,owner_id,kind,r2_key,dispatch_before,started_at,state,finished_at)
    VALUES(?,?,1,'owner','manifest.put',?,?,?,?,?)`).run(
    crypto.randomUUID(),
    crypto.randomUUID(),
    "target-sets/" + crypto.randomUUID(),
    now + 5000,
    now,
    state,
    state === "pending" ? null : now,
  );
}
it("preserves old indices, native receipts, and every unchanged guard", () => {
  receipt("succeeded");
  receipt("not_started");
  const f = foundationFixture("old-archive", Date.now() - 1000);
  for (const s of f.statements)
    db.prepare(s.sql).run(...((s.values ?? []) as (string | number | null)[]));
  db.prepare("INSERT INTO archive_index VALUES('old',?,?,'old-generator',?,'hash',1,10)").run(
    f.ids.file,
    f.ids.blob,
    `u/${f.ids.user}/d/${f.ids.blob}/old/index`,
  );
  const rows = db.prepare("SELECT * FROM r2_write_attempts ORDER BY id").all();
  const indices = db.prepare("SELECT * FROM archive_index").all();
  const triggers = db.prepare("SELECT name,sql FROM sqlite_schema WHERE type='trigger'").all();
  upgrade();
  expect(db.prepare("SELECT * FROM r2_write_attempts ORDER BY id").all()).toEqual(rows);
  expect(db.prepare("SELECT * FROM archive_index").all()).toEqual(indices);
  for (const trigger of triggers) {
    if (trigger.name === "image_reservation_kind") continue;
    expect(
      db
        .prepare("SELECT sql FROM sqlite_schema WHERE type='trigger' AND name=?")
        .get(trigger.name as string),
    ).toEqual({ sql: trigger.sql });
  }
  expect(db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
  expect(() => db.exec("UPDATE archive_index SET sha256='changed'")).toThrow(
    "immutable_archive_index",
  );
});
it.each(["running", "pending", "backup", "restore"])(
  "rejects %s state without partial migration",
  (mode) => {
    if (mode === "running") db.exec("UPDATE control SET maintenance=0");
    if (mode === "pending") {
      db.exec("UPDATE control SET maintenance=0");
      receipt("pending");
      db.exec("UPDATE control SET maintenance=1");
    }
    if (mode === "backup") {
      db.exec(
        "INSERT INTO backup_runs(id,epoch,state,created_at,barrier_token) VALUES('backup',1,'exporting',0,'00000000-0000-0000-0000-000000000001')",
      );
      db.exec(
        "UPDATE control SET backup_token='00000000-0000-0000-0000-000000000001',backup_frozen=1",
      );
    }
    if (mode === "restore")
      db.prepare("UPDATE control SET restore_freeze_token=?").run(crypto.randomUUID());
    const before = db.prepare("SELECT * FROM r2_write_attempts").all();
    expect(upgrade).toThrow();
    expect(db.prepare("SELECT * FROM r2_write_attempts").all()).toEqual(before);
    expect(
      db.prepare("SELECT 1 FROM sqlite_schema WHERE name='archive_derivative_objects'").get(),
    ).toBeUndefined();
  },
);
