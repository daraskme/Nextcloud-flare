import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, expect, it } from "vitest";
import { initialize, migrations } from "../backup/snapshot.mjs";

const versions = await migrations();
let db;
beforeEach(() => {
  db = initialize(":memory:", versions);
  db.exec("UPDATE control SET maintenance=0");
});
afterEach(() => db.close());
const clock = () => Math.floor(Date.now() / 1000) * 1000;
function insert(state = "pending", key = `target-sets/${randomUUID()}`, overrides = {}) {
  const g = {
    id: randomUUID(),
    token: randomUUID(),
    epoch: 1,
    owner: "owner",
    kind: "manifest.put",
    key,
    deadline: clock() + 5000,
    started: clock(),
    state,
    finished: state === "pending" ? null : clock(),
    ...overrides,
  };
  db.prepare("INSERT INTO r2_write_attempts VALUES(?,?,?,?,?,?,?,?,?,?)").run(
    g.id,
    g.token,
    g.epoch,
    g.owner,
    g.kind,
    g.key,
    g.deadline,
    g.started,
    g.state,
    g.finished,
  );
  return g;
}
it("keeps unknown writes through elapsed time and refuses repair bypasses", async () => {
  const row = insert("pending", undefined, { started: clock() - 3000, deadline: clock() + 2000 });
  await new Promise((resolve) => setTimeout(resolve, 2100));
  expect(clock()).toBeGreaterThanOrEqual(row.deadline);
  db.exec("UPDATE control SET maintenance=1");
  expect(() => db.exec("UPDATE control SET maintenance=0")).toThrow("r2_write_unsettled");
  expect(() => db.prepare("UPDATE control SET restore_freeze_token=?").run(randomUUID())).toThrow(
    "restore_freeze_not_drained",
  );
  expect(() => db.exec("DELETE FROM r2_write_attempts")).toThrow("r2_write_receipt_required");
  expect(() =>
    db
      .prepare("UPDATE r2_write_attempts SET dispatch_before=dispatch_before-1 WHERE id=?")
      .run(row.id),
  ).toThrow("immutable_r2_write");
});
it("fences delayed dispatch with a terminal tombstone", () => {
  const g = insert("not_started");
  expect(() => insert("pending", g.key, { id: g.id, token: g.token })).toThrow();
  expect(db.prepare("SELECT state FROM r2_write_attempts").get().state).toBe("not_started");
});
it("refuses another manifest PUT for a key with retained history", () => {
  const g = insert("succeeded");
  expect(() => insert("pending", g.key)).toThrow("r2_write_unavailable");
});
it("bounds every pending invocation, including concurrent writes to the same immutable key", () => {
  const first = insert("pending", `u/owner/b/op_${"a".repeat(64)}_blob`, { kind: "empty.put" });
  insert("pending", first.key, { kind: "empty.put" });
  for (let i = 2; i < 32; i++) insert();
  expect(() => insert()).toThrow("r2_write_unavailable");
  db.prepare("UPDATE r2_write_attempts SET state='succeeded',finished_at=? WHERE id=?").run(
    clock(),
    first.id,
  );
  insert("pending", first.key, { kind: "empty.put" });
  expect(
    db.prepare("SELECT COUNT(*) AS n FROM r2_write_attempts WHERE state='pending'").get().n,
  ).toBe(32);
});
it.each(["succeeded", "not_started"])(
  "retains exact terminal %s receipts for at least 24 hours",
  (state) => {
    const now = clock();
    const old = insert(state, undefined, {
      started: now - 86401000,
      deadline: now - 86400000,
      finished: now - 86401000,
    });
    db.prepare("DELETE FROM r2_write_attempts WHERE id=?").run(old.id);
    const current = insert(state);
    expect(() => db.prepare("DELETE FROM r2_write_attempts WHERE id=?").run(current.id)).toThrow();
    expect(() =>
      db
        .prepare("UPDATE r2_write_attempts SET state='pending',finished_at=NULL WHERE id=?")
        .run(current.id),
    ).toThrow("immutable_r2_write");
  },
);
it.each(["stopped", "expired", "epoch"])("rejects new dispatch while %s", (mode) => {
  if (mode === "stopped") db.exec("UPDATE control SET maintenance=1");
  expect(() =>
    insert(
      "pending",
      undefined,
      mode === "expired"
        ? { started: clock() - 5000, deadline: clock() }
        : mode === "epoch"
          ? { epoch: 2 }
          : {},
    ),
  ).toThrow("r2_write_unavailable");
});
it.each(["insert", "update", "delete"])("joins backup and restore guards for %s", (action) => {
  const triggers = db
    .prepare("SELECT name FROM sqlite_schema WHERE type='trigger'")
    .all()
    .map((r) => r.name);
  expect(triggers).toContain(`backup_freeze_r2_write_attempts_${action}`);
  expect(triggers).toContain(`restore_freeze_r2_write_attempts_${action}`);
  const g = insert("succeeded");
  db.exec("UPDATE control SET maintenance=1");
  db.prepare("UPDATE control SET restore_freeze_token=?").run(randomUUID());
  expect(() =>
    action === "insert"
      ? insert("not_started")
      : db
          .prepare(
            action === "update"
              ? "UPDATE r2_write_attempts SET state='not_started' WHERE id=?"
              : "DELETE FROM r2_write_attempts WHERE id=?",
          )
          .run(g.id),
  ).toThrow("database_restore_frozen");
});
