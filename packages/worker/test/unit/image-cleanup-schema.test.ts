import { readdirSync, readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { URL } from "node:url";
import { afterEach, beforeEach, expect, it } from "vitest";
import { type ImageTransformGrant, imageTransformValues } from "../../src/db/imageTransform";
import { IMAGE_CLEANUP_QUERY } from "../../src/jobs/imageDerivativeCleanup";
import { foundationFixture } from "../fixtures/foundation";

const dir = new URL("../../migrations/", import.meta.url),
  migration = readFileSync(new URL("0071_image_derivative_cleanup.sql", dir), "utf8");
let db: DatabaseSync;
beforeEach(() => {
  db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys=ON");
  for (const name of readdirSync(dir)
    .filter((n) => n.endsWith(".sql") && n < "0071")
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
function seed(published: boolean) {
  const now = Date.now(),
    f = foundationFixture(crypto.randomUUID(), now - 1000);
  db.exec("UPDATE control SET maintenance=0");
  for (const s of f.statements)
    db.prepare(s.sql).run(...((s.values ?? []) as (string | number | null)[]));
  const g: ImageTransformGrant = {
    id: crypto.randomUUID(),
    token: crypto.randomUUID(),
    epoch: 1,
    ownerId: f.ids.user,
    blobId: f.ids.blob,
    outboxId: "event",
    claimToken: crypto.randomUUID(),
    variant: "sm",
    generator: "image-webp-v1",
    startedAt: now,
    deadline: now + 5000,
    expiresAt: now + 25000,
    source: {
      nodeId: f.ids.file,
      parentId: f.ids.folder,
      key: `u/${f.ids.user}/b/${f.ids.blob}`,
      etag: "source",
      size: 3,
      width: 16,
      height: 12,
    },
  };
  const id = "image_" + g.id,
    key = `u/${g.ownerId}/d/${g.blobId}/${g.generator}/${g.variant}/${g.id}`,
    attempt = crypto.randomUUID();
  db.prepare(
    "INSERT INTO image_transform_attempts(id,token,epoch,owner_id,blob_id,outbox_id,variant,generator_version,claim_token,source_json,started_at,dispatch_before,expires_at,state,finished_at,output_json,failure_json) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,'succeeded',?,?,NULL)",
  ).run(
    ...imageTransformValues(g),
    now,
    JSON.stringify({ bytes: 68, width: 16, height: 12, sha256: "a".repeat(64) }),
  );
  db.prepare(
    "INSERT INTO reservations(id,owner_id,bytes,state,expires_at,epoch,physical_only) VALUES(?,?,68,'reserved',?,1,1)",
  ).run(id, g.ownerId, g.expiresAt);
  db.prepare(
    "INSERT INTO blobs(id,owner_id,r2_key,size,content_etag,mime_sniffed,state,created_at) VALUES(?,?,?,68,'output','image/webp','staging',?)",
  ).run(id, g.ownerId, key, now);
  db.prepare(
    "INSERT INTO blob_pins(pin_id,blob_id,purpose,expires_at,created_at) VALUES(?,?,'job',NULL,?)",
  ).run(id, id, now);
  db.prepare(
    "INSERT INTO derivative_results(id,blob_id,kind,variant,generator_version,state,claim_token,claim_expires_at,epoch,attempts,r2_key,size) VALUES(?,?,'thumbnail','sm','image-webp-v1','running',?,?,1,1,?,68)",
  ).run(id, g.blobId, g.claimToken, g.expiresAt, key);
  db.prepare("INSERT INTO image_derivative_objects VALUES(?,?,?,?,?,?,?,?,'prepared',?)").run(
    g.id,
    g.ownerId,
    g.blobId,
    id,
    id,
    id,
    id,
    attempt,
    now,
  );
  if (published) {
    db.prepare(
      "INSERT INTO r2_write_attempts(id,token,epoch,owner_id,kind,r2_key,dispatch_before,started_at,state,finished_at,source_ref) VALUES(?,?,1,?,'image.put',?,?,?,'succeeded',?,?)",
    ).run(
      crypto.randomUUID(),
      crypto.randomUUID(),
      g.ownerId,
      key,
      now + 5000,
      now,
      now,
      JSON.stringify([g.id, attempt]),
    );
    db.prepare(
      "INSERT INTO blob_storage(blob_id,bytes,r2_etag,observed_at) VALUES(?,68,'stored',?)",
    ).run(id, now);
    db.prepare(
      "UPDATE blobs SET sha256_verified=?,r2_etag='stored',state='committed' WHERE id=?",
    ).run("a".repeat(64), id);
    db.prepare("UPDATE image_derivative_objects SET state='stored' WHERE id=?").run(g.id);
    db.prepare("UPDATE derivative_results SET state='ready' WHERE id=?").run(id);
    db.prepare("UPDATE image_derivative_objects SET state='published' WHERE id=?").run(g.id);
    db.prepare("UPDATE reservations SET state='released' WHERE id=?").run(id);
  }
  db.exec("UPDATE control SET maintenance=1");
  return g.id;
}
it("preserves every old row and backfills held and published generations without waking healthy outputs", () => {
  const prepared = seed(false),
    published = seed(true);
  const old = db
    .prepare("PRAGMA table_list")
    .all()
    .filter((t) => t.type === "table" && !String(t.name).startsWith("sqlite_"))
    .map((t) => ({ name: String(t.name), rows: db.prepare(`SELECT * FROM "${t.name}"`).all() }));
  const now = Date.now();
  upgrade();
  for (const t of old) expect(db.prepare(`SELECT * FROM "${t.name}"`).all()).toEqual(t.rows);
  expect(
    db.prepare("SELECT next_at FROM image_derivative_cleanup WHERE image_id=?").get(prepared)!
      .next_at,
  ).toBeGreaterThanOrEqual(now);
  expect(
    db
      .prepare(
        "SELECT next_at,retired_at,seal_token,head_calls FROM image_derivative_cleanup WHERE image_id=?",
      )
      .get(published),
  ).toEqual({
    next_at: Number.MAX_SAFE_INTEGER,
    retired_at: null,
    seal_token: null,
    head_calls: 0,
  });
  expect(db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
});
it("selects due work through its partial scheduling index without sorting old history", () => {
  upgrade();
  const plan = db
    .prepare("EXPLAIN QUERY PLAN " + IMAGE_CLEANUP_QUERY)
    .all(1, null, null)
    .map((r) => String(r.detail));
  expect(plan.some((p) => p.includes("image_cleanup_due"))).toBe(true);
  expect(plan.some((p) => p.includes("TEMP B-TREE"))).toBe(false);
});
it("does not accept invented seal or settlement facts outside the required admissions", () => {
  const id = seed(false);
  upgrade();
  expect(() =>
    db
      .prepare("UPDATE image_derivative_cleanup SET seal_token=? WHERE image_id=?")
      .run(crypto.randomUUID(), id),
  ).toThrow("image_seal_unproven");
  expect(() =>
    db
      .prepare(
        "UPDATE image_derivative_cleanup SET disposition='absent',settled_at=1 WHERE image_id=?",
      )
      .run(id),
  ).toThrow("image_cleanup_unproven");
});
it("refuses a running database without leaving a partial migration", () => {
  db.exec("UPDATE control SET maintenance=0");
  expect(upgrade).toThrow();
  expect(
    db.prepare("SELECT 1 FROM sqlite_schema WHERE name='image_derivative_cleanup'").get(),
  ).toBeUndefined();
});
