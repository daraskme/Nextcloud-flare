import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, expect, it } from "vitest";
import { initialize, migrations } from "../backup/snapshot.mjs";

const versions = await migrations();
const migration = versions.find((m) => m.name === "0045_backups_probe_r2_write_attempts.sql");
let db;
beforeEach(() => {
  db = initialize(":memory:", versions.slice(0, 44));
});
afterEach(() => db.close());
function attempt(kind, state = "pending", source = null) {
  const now = Math.floor(Date.now() / 1000) * 1000;
  const owner = ["orphan.delete", "bucket.abort", "probe.put", "backups.probe.put"].includes(kind)
    ? null
    : "owner";
  const values = [
    randomUUID(),
    randomUUID(),
    1,
    owner,
    kind,
    kind === "backups.probe.put"
      ? "sys/restore/binding-probe-v1"
      : kind === "probe.put"
        ? "system/r2-binding-probe-v1"
        : `u/${owner ?? "missing"}/b/${randomUUID()}`,
    now + 2000,
    now - 3000,
    state,
    state === "pending" ? null : now,
    source,
  ];
  db.prepare("INSERT INTO r2_write_attempts VALUES(?,?,?,?,?,?,?,?,?,?,?)").run(...values);
  return values;
}
it("preserves all twelve kinds and expired pending/terminal receipts without changing any field", async () => {
  db.exec("UPDATE control SET maintenance=0");
  for (const kind of [
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
  ])
    for (const state of ["pending", "succeeded", "not_started"])
      attempt(
        kind,
        state,
        ["empty.put", "manifest.put", "manifest.delete", "blob.delete", "orphan.delete"].includes(
          kind,
        )
          ? null
          : JSON.stringify([randomUUID(), randomUUID()]),
      );
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
it("permits one ownerless dispatch per probe challenge, including after a successful receipt", () => {
  db.exec(migration.sql);
  const source = JSON.stringify([1, randomUUID(), randomUUID(), "a".repeat(64)]);
  const original = attempt("backups.probe.put", "pending", source);
  expect(() => attempt("backups.probe.put", "pending", source)).toThrow("UNIQUE");
  expect(() => attempt("backups.probe.put", "not_started", source)).not.toThrow();
  db.prepare(
    "UPDATE r2_write_attempts SET state='succeeded',finished_at=started_at+1 WHERE id=?",
  ).run(original[0]);
  expect(() => attempt("backups.probe.put", "pending", source)).toThrow("UNIQUE");
  expect(() => attempt("backups.probe.put")).toThrow();
  expect(() =>
    db.prepare("UPDATE r2_write_attempts SET source_ref='other' WHERE id=?").run(original[0]),
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
