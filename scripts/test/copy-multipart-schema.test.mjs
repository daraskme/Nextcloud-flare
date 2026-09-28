import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, expect, it } from "vitest";
import { copyMultipartPartsProof } from "../../packages/worker/src/db/r2Copy.ts";
import { initialize, migrations } from "../backup/snapshot.mjs";

const versions = await migrations();
const migration = versions.find((m) => m.name === "0055_copy_multipart.sql");
let db;
beforeEach(() => {
  db = initialize(
    ":memory:",
    versions.filter((m) => m.name < "0055_"),
  );
});
afterEach(() => db.close());
it("uses a unique receipt lookup for each part instead of rescanning the entire blob history", () => {
  db.exec(migration.sql);
  const statement = copyMultipartPartsProof("u/owner/b/blob");
  const plan = db.prepare("EXPLAIN QUERY PLAN " + statement.sql).all(...statement.values);
  expect(
    plan.some((row) =>
      row.detail.includes("SEARCH w USING INDEX r2_write_source (kind=? AND source_ref=?)"),
    ),
  ).toBe(true);
  expect(plan.some((row) => row.detail.includes("r2_write_key_history"))).toBe(false);
});
function attempt(
  kind,
  state,
  owner = "owner",
  source = JSON.stringify([randomUUID(), randomUUID(), randomUUID()]),
) {
  const id = randomUUID();
  db.prepare(
    `INSERT INTO r2_write_attempts VALUES(?,?,?,?,?,?,strftime('%s','now')*1000+3000,strftime('%s','now')*1000-1000,?,CASE WHEN ?='pending' THEN NULL ELSE strftime('%s','now')*1000 END,?)`,
  ).run(id, randomUUID(), 1, owner, kind, `u/${owner ?? "none"}/b/${id}`, state, state, source);
  return id;
}
it("preserves all fifteen prior write kinds and pending/terminal receipts exactly", () => {
  db.exec("UPDATE control SET maintenance=0");
  const kinds = [
    "empty.put",
    "manifest.put",
    "manifest.delete",
    "blob.delete",
    "orphan.delete",
    "upload.put",
    "multipart.create",
    "multipart.part",
    "multipart.complete",
    "multipart.abort",
    "bucket.abort",
    "probe.put",
    "backups.probe.put",
    "backup.delete",
    "copy.put",
  ];
  for (const kind of kinds)
    for (const state of ["pending", "succeeded", "not_started"]) {
      const owner = [
        "orphan.delete",
        "bucket.abort",
        "probe.put",
        "backups.probe.put",
        "backup.delete",
      ].includes(kind)
        ? null
        : "owner";
      attempt(
        kind,
        state,
        owner,
        kinds.indexOf(kind) < 5 ? null : JSON.stringify([randomUUID(), randomUUID(), randomUUID()]),
      );
    }
  db.exec("UPDATE control SET maintenance=1");
  const before = db.prepare("SELECT * FROM r2_write_attempts ORDER BY id").all();
  db.exec(migration.sql);
  expect(db.prepare("SELECT * FROM r2_write_attempts ORDER BY id").all()).toEqual(before);
  expect(db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
  expect(() => db.exec("DELETE FROM r2_write_attempts")).toThrow("r2_write_receipt_required");
  expect(() => db.exec("UPDATE control SET maintenance=0")).toThrow("r2_write_unsettled");
});
it.each(["copy.multipart.create", "copy.multipart.part", "copy.multipart.complete"])(
  "requires exact durable owner/source identity for %s",
  (kind) => {
    db.exec(migration.sql);
    db.exec("UPDATE control SET maintenance=0");
    expect(() => attempt(kind, "pending", null)).toThrow();
    expect(() => attempt(kind, "pending", "owner", null)).toThrow();
    const source = JSON.stringify(["copy-job", "source", randomUUID()]);
    const id = attempt(kind, "pending", "owner", source);
    expect(() => attempt(kind, "pending", "owner", source)).toThrow("UNIQUE");
    db.prepare(
      "UPDATE r2_write_attempts SET state='succeeded',finished_at=started_at+1 WHERE id=?",
    ).run(id);
    expect(() => attempt(kind, "pending", "owner", source)).toThrow("UNIQUE");
  },
);
it.each(["open", "backup", "restore"])("refuses migration during %s", (phase) => {
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
