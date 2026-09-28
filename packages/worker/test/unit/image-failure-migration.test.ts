import { readdirSync, readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { URL } from "node:url";
import { afterEach, beforeEach, expect, it } from "vitest";
import { type ImageTransformGrant, insertImageTransform } from "../../src/db/imageTransform";

const dir = new URL("../../migrations/", import.meta.url);
const migration = readFileSync(new URL("0069_image_transform_failures.sql", dir), "utf8");
let db: DatabaseSync;
beforeEach(() => {
  db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys=ON");
  for (const name of readdirSync(dir)
    .filter((n) => n.endsWith(".sql") && n < "0069")
    .sort())
    db.exec(readFileSync(new URL(name, dir), "utf8"));
});
afterEach(() => db.close());
function saved(state: "succeeded" | "not_started" | "pending") {
  const startedAt = Date.now();
  const grant: ImageTransformGrant = {
    id: crypto.randomUUID(),
    token: crypto.randomUUID(),
    epoch: 1,
    ownerId: "owner",
    blobId: crypto.randomUUID(),
    outboxId: "event",
    claimToken: crypto.randomUUID(),
    variant: "sm",
    generator: "image-webp-v1",
    startedAt,
    deadline: startedAt + 5000,
    expiresAt: startedAt + 25000,
    source: {
      nodeId: "node",
      parentId: "parent",
      key: "unused",
      etag: "etag",
      size: 99,
      width: 16,
      height: 12,
    },
  };
  grant.source.key = `u/owner/b/${grant.blobId}`;
  const output =
    state === "succeeded"
      ? JSON.stringify({ bytes: 68, width: 16, height: 12, sha256: "a".repeat(64) })
      : null;
  const statement = insertImageTransform(grant, state, output);
  // The pre-upgrade schema has no failure column; seed actual old rows with every old value.
  db.prepare(statement.sql.replace(",failure_json)", ")").replace(/,\?\)$/, ")")).run(
    ...(statement.values!.slice(0, -1) as (string | number | null)[]),
  );
  return grant;
}
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
it("preserves all old receipt fields and reinstalls immutability and cost guards", () => {
  saved("succeeded");
  saved("not_started");
  const old = db.prepare("SELECT * FROM image_transform_attempts ORDER BY id").all();
  upgrade();
  expect(db.prepare("SELECT * FROM image_transform_attempts ORDER BY id").all()).toEqual(
    old.map((r) => ({ ...r, failure_json: null })),
  );
  expect(db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
  expect(() => db.exec("DELETE FROM image_transform_attempts")).toThrow("receipt_required");
  expect(() =>
    db.exec("UPDATE image_transform_attempts SET state='failed',failure_json='{}'"),
  ).toThrow("immutable");
  const oldNames = [
    "image_attempt_dispatch",
    "image_attempt_immutable",
    "image_attempt_keep",
    "image_attempt_restore_hold",
    "image_attempt_backup_hold",
    "image_attempt_resume_hold",
    "image_attempt_blob_hold",
  ];
  for (const name of oldNames)
    expect(
      db.prepare("SELECT 1 FROM sqlite_master WHERE type='trigger' AND name=?").get(name),
    ).toBeDefined();
});
it("does not migrate over a still-pending image transformation", () => {
  db.exec("DROP TRIGGER image_attempt_dispatch");
  saved("pending");
  const old = db.prepare("SELECT * FROM image_transform_attempts").all();
  expect(upgrade).toThrow();
  expect(db.prepare("SELECT * FROM image_transform_attempts").all()).toEqual(old);
  expect(
    db
      .prepare(
        "SELECT name FROM pragma_table_info('image_transform_attempts') WHERE name='failure_json'",
      )
      .get(),
  ).toBeUndefined();
});
it("requires stopped admission and retains the old schema after rejection", () => {
  db.exec("UPDATE control SET maintenance=0");
  expect(upgrade).toThrow();
  expect(
    db
      .prepare(
        "SELECT name FROM pragma_table_info('image_transform_attempts') WHERE name='failure_json'",
      )
      .get(),
  ).toBeUndefined();
});
