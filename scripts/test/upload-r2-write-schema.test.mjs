import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, expect, it } from "vitest";
import { initialize, migrations } from "../backup/snapshot.mjs";

const versions = await migrations();
const migration = versions.find((m) => m.name === "0043_upload_r2_write_attempts.sql");
let db;
beforeEach(() => {
  db = initialize(":memory:", versions.slice(0, 42));
});
afterEach(() => db.close());
function attempt(kind, state = "pending", source = null, owner = "owner") {
  const now = Math.floor(Date.now() / 1000) * 1000;
  const values = [
    randomUUID(),
    randomUUID(),
    1,
    owner,
    kind,
    `u/${owner ?? "missing"}/b/${randomUUID()}`,
    now + 2000,
    now - 3000,
    state,
    state === "pending" ? null : now,
  ];
  if (source !== null) values.push(source);
  db.prepare(`INSERT INTO r2_write_attempts VALUES(${values.map(() => "?").join(",")})`).run(
    ...values,
  );
  return values;
}
it("preserves every old receipt, including expired unknown native writes", async () => {
  db.exec("UPDATE control SET maintenance=0");
  for (const kind of ["empty.put", "manifest.put", "blob.delete", "orphan.delete"])
    for (const state of ["pending", "succeeded", "not_started"])
      attempt(kind, state, null, kind === "orphan.delete" ? null : "owner");
  db.exec("UPDATE control SET maintenance=1");
  const before = db.prepare("SELECT * FROM r2_write_attempts ORDER BY id").all();
  await new Promise((resolve) => setTimeout(resolve, 2100));
  db.exec(migration.sql);
  expect(db.prepare("SELECT * FROM r2_write_attempts ORDER BY id").all()).toEqual(
    before.map((row) => ({ ...row, source_ref: null })),
  );
  expect(db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
  expect(() => db.exec("UPDATE control SET maintenance=0")).toThrow("r2_write_unsettled");
  expect(() => db.prepare("UPDATE control SET restore_freeze_token=?").run(randomUUID())).toThrow(
    "restore_freeze_not_drained",
  );
  expect(() => db.exec("DELETE FROM r2_write_attempts")).toThrow("r2_write_receipt_required");
});
it.each([
  "upload.put",
  "multipart.create",
  "multipart.part",
  "multipart.complete",
  "multipart.abort",
  "bucket.abort",
])("requires one native dispatch per original %s attempt", (kind) => {
  db.exec(migration.sql);
  db.exec("UPDATE control SET maintenance=0");
  const owner = kind === "bucket.abort" ? null : "owner";
  const source = JSON.stringify([randomUUID(), randomUUID()]);
  const values = attempt(kind, "pending", source, owner);
  expect(() => attempt(kind, "pending", source, owner)).toThrow("UNIQUE");
  // Rejected begin calls can still leave a conclusive never-dispatched receipt.
  expect(() => attempt(kind, "not_started", source, owner)).not.toThrow();
  db.prepare(
    "UPDATE r2_write_attempts SET state='succeeded',finished_at=started_at+1 WHERE id=?",
  ).run(values[0]);
  expect(() => attempt(kind, "pending", source, owner)).toThrow("UNIQUE");
  expect(() =>
    db.prepare("UPDATE r2_write_attempts SET source_ref=? WHERE id=?").run("other", values[0]),
  ).toThrow("immutable_r2_write");
});
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
