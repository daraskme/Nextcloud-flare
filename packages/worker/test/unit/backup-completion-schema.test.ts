import { readdirSync, readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { URL } from "node:url";
import { afterEach, beforeEach, expect, it } from "vitest";

let db: DatabaseSync;
const dir = new URL("../../migrations/", import.meta.url);
const migration = readFileSync(new URL("0038_backup_completion.sql", dir), "utf8");
const id = "12345678-1234-1234-1234-123456789012",
  hash = "a".repeat(64),
  key = `sys/backups/v1/${id}/manifest.json`;
beforeEach(() => {
  db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys=ON");
  for (const file of readdirSync(dir)
    .filter((f) => f.endsWith(".sql") && f < "0038_")
    .sort())
    db.exec(readFileSync(new URL(file, dir), "utf8"));
  db.prepare(
    "INSERT INTO backup_runs(id,epoch,state,created_at,barrier_token) VALUES(?,1,'exporting',1,?)",
  ).run(id, id);
});
afterEach(() => db.close());
it("preserves existing generations and foreign keys during the forward migration", () => {
  const saved = db.prepare("SELECT * FROM backup_runs").all();
  db.exec(migration);
  expect(db.prepare("SELECT * FROM backup_runs").all()).toEqual(saved);
  expect(db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
});
it.each(["key", "hash", "release", "timestamp"])(
  "rejects completed records with invalid %s",
  (kind) => {
    db.exec(migration);
    expect(() =>
      db
        .prepare(
          "UPDATE backup_runs SET state='completed',manifest_key=?,manifest_sha256=?,released_at=?,completed_at=? WHERE id=?",
        )
        .run(
          kind === "key" ? "sys/epoch/1.json" : key,
          kind === "hash" ? "X".repeat(64) : hash,
          kind === "release" ? null : 2,
          kind === "timestamp" ? 0 : 2,
          id,
        ),
    ).toThrow("invalid_backup_completion");
    expect(db.prepare("SELECT state FROM backup_runs").get()).toEqual({ state: "exporting" });
  },
);
it("keeps the exact terminal publication receipt immutable", () => {
  db.exec(migration);
  db.prepare(
    "UPDATE backup_runs SET state='completed',manifest_key=?,manifest_sha256=?,released_at=2,completed_at=2 WHERE id=?",
  ).run(key, hash, id);
  for (const assignment of [
    "manifest_sha256='" + "b".repeat(64) + "'",
    "manifest_key='other'",
    "completed_at=3",
    "state='exporting'",
  ])
    expect(() => db.exec(`UPDATE backup_runs SET ${assignment}`)).toThrow();
  expect(db.prepare("SELECT manifest_sha256,completed_at FROM backup_runs").get()).toEqual({
    manifest_sha256: hash,
    completed_at: 2,
  });
});
