import { readdirSync, readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { URL } from "node:url";
import { afterEach, beforeEach, expect, it } from "vitest";
import { exportTables } from "../../src/db/schemaContract";
import { foundationFixture } from "../fixtures/foundation";

let db: DatabaseSync;
const dir = new URL("../../migrations/", import.meta.url),
  token = "a".repeat(36);
beforeEach(() => {
  db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys=ON");
  for (const file of readdirSync(dir)
    .filter((f) => f.endsWith(".sql") && f < "0037_")
    .sort())
    db.exec(readFileSync(new URL(file, dir), "utf8"));
  for (const s of foundationFixture().statements)
    db.prepare(s.sql).run(...((s.values ?? []) as (string | number | null)[]));
});
afterEach(() => db.close());
const migrate = () => db.exec(readFileSync(new URL("0037_backup_barrier.sql", dir), "utf8"));
function freeze() {
  db.prepare(
    "INSERT INTO backup_runs(id,epoch,state,created_at,barrier_token) VALUES('backup',1,'exporting',1,?)",
  ).run(token);
  db.prepare("UPDATE control SET backup_token=?,backup_frozen=1").run(token);
}
const snapshot = () =>
  Object.fromEntries(
    exportTables.map((t) => [t, db.prepare(`SELECT * FROM "${t}" ORDER BY 1`).all()]),
  );
it("preserves existing data and foreign keys through the forward backup migration", () => {
  const users = db.prepare("SELECT * FROM users").all(),
    blobs = db.prepare("SELECT * FROM blobs").all();
  migrate();
  expect(db.prepare("SELECT * FROM users").all()).toEqual(users);
  expect(db.prepare("SELECT * FROM blobs").all()).toEqual(blobs);
  expect(db.prepare("SELECT backup_token,backup_frozen FROM control").get()).toEqual({
    backup_token: null,
    backup_frozen: 0,
  });
  expect(db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
});
it("guards every normal table, requiring future tables to join the backup freeze", () => {
  migrate();
  const tables = db
    .prepare("PRAGMA table_list")
    .all()
    .filter((r) => r.type === "table" && !String(r.name).startsWith("sqlite_"))
    .map((r) => String(r.name))
    .sort();
  expect(tables).toEqual([...exportTables].sort());
  const triggers = db
    .prepare("SELECT name FROM sqlite_schema WHERE type='trigger'")
    .all()
    .map((r) => r.name);
  for (const t of tables)
    for (const action of t === "control" ? ["insert", "delete"] : ["insert", "update", "delete"])
      expect(triggers).toContain(`backup_freeze_${t}_${action}`);
  expect(triggers).toContain("backup_control_update");
});
it("rejects all control changes while frozen except a flag-only thaw in an atomic release", () => {
  migrate();
  freeze();
  const saved = snapshot();
  for (const sql of [
    "UPDATE users SET quota_bytes=quota_bytes+1",
    "DELETE FROM nodes",
    "DELETE FROM control",
    "INSERT OR REPLACE INTO control(singleton,epoch,updated_at) VALUES(1,3,0)",
    "UPDATE control SET backup_frozen=0,backup_token=NULL",
    "UPDATE control SET backup_frozen=0,maintenance=0",
    "UPDATE control SET backup_frozen=0,backup_barrier_op='wrong'",
    "UPDATE control SET backup_frozen=0,backup_last_op='wrong'",
  ])
    expect(() => db.exec(sql)).toThrow();
  expect(snapshot()).toEqual(saved);
  db.exec("BEGIN;UPDATE control SET backup_frozen=0;");
  expect(() => db.exec("UPDATE control SET epoch=2")).toThrow("backup_active");
  db.exec("ROLLBACK;");
  expect(snapshot()).toEqual(saved);
  db.prepare("UPDATE control SET backup_frozen=0 WHERE backup_token=?").run(token);
  db.prepare("UPDATE control SET backup_token=NULL WHERE backup_token=?").run(token);
  db.exec("UPDATE users SET quota_bytes=quota_bytes+1");
  expect(db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
});
it("requires an exact unreleased exporting run before freezing", () => {
  migrate();
  expect(() => db.exec("UPDATE control SET backup_frozen=1")).toThrow();
  db.prepare(
    "INSERT INTO backup_runs(id,epoch,state,created_at,barrier_token) VALUES('backup',1,'pending',1,?)",
  ).run(token);
  expect(() => db.prepare("UPDATE control SET backup_token=?,backup_frozen=1").run(token)).toThrow(
    "backup_not_drained",
  );
  db.exec("UPDATE backup_runs SET state='exporting',watermark='op_saved'");
  expect(() => db.prepare("UPDATE control SET backup_token=?,backup_frozen=1").run(token)).toThrow(
    "backup_not_drained",
  );
  db.prepare(
    "UPDATE control SET backup_last_op='op_saved',backup_barrier_op='op_saved',backup_token=?,backup_frozen=1",
  ).run(token);
  expect(() => db.exec("UPDATE backup_runs SET watermark='different'")).toThrow();
});

it("records actual commit order across timestamp ties and rolls the watermark back with a failed batch", () => {
  migrate();
  const committed = (id: string) => {
    db.prepare(
      "INSERT INTO permits(permit_id,space_id,epoch,expires_at,state) VALUES(?,'f-s',1,1,'released')",
    ).run(id);
    db.prepare(`INSERT INTO operations(op_id,principal_kind,principal_id,credential_id,space_id,kind,state,request_digest,epoch,
      permit_id,permit_expires_at,claimed_expires_at,expected_steps,created_at,updated_at)
      VALUES(?,'user','f-u','as:f-session','f-s','node.create','committed','digest',1,?,1,1,0,1,1)`).run(
      id,
      id,
    );
  };
  committed("z-first");
  db.exec("BEGIN");
  committed("a-second");
  db.exec("ROLLBACK");
  expect(db.prepare("SELECT backup_last_op FROM control").get()).toEqual({
    backup_last_op: "z-first",
  });
  committed("a-second");
  expect(db.prepare("SELECT backup_last_op FROM control").get()).toEqual({
    backup_last_op: "a-second",
  });
});
