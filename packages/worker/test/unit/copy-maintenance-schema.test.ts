import { readdirSync, readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { URL } from "node:url";
import { afterEach, beforeEach, expect, it } from "vitest";
import { insertR2Write } from "../../src/db/r2Write";
import {
  COPY_MAINTENANCE_ELIGIBLE,
  COPY_MAINTENANCE_FROM,
} from "../../src/jobs/copyMaintenanceClaim";
import { foundationFixture } from "../fixtures/foundation";

const directory = new URL("../../migrations/", import.meta.url);
let db: DatabaseSync;
beforeEach(() => {
  db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys=ON");
  for (const name of readdirSync(directory)
    .filter((n) => n.endsWith(".sql") && n < "0059_")
    .sort())
    db.exec(readFileSync(new URL(name, directory), "utf8"));
  for (const s of foundationFixture("source").statements)
    db.prepare(s.sql).run(...(s.values as (string | number | null)[]));
  const native = insertR2Write(
    {
      id: crypto.randomUUID(),
      token: crypto.randomUUID(),
      epoch: 1,
      ownerId: "source-u",
      kind: "manifest.delete",
      key: "target-sets/migration-test",
      startedAt: 1000,
      deadline: 6000,
    },
    "succeeded",
  );
  db.prepare(native.sql).run(...(native.values as (string | number | null)[]));
});
afterEach(() => db.close());
const migrate = () =>
  db.exec(readFileSync(new URL("0059_copy_maintenance.sql", directory), "utf8"));
it("selects the next due job through the maintenance index without sorting terminal history", () => {
  migrate();
  const plan = db
    .prepare(`EXPLAIN QUERY PLAN SELECT j.id ${COPY_MAINTENANCE_FROM}
    WHERE c.epoch=? AND c.maintenance=0 AND ${COPY_MAINTENANCE_ELIGIBLE}
      AND (? IS NULL OR j.id=?) ORDER BY j.cleanup_next_at,j.id LIMIT 1`)
    .all(1, null, null)
    .map((r) => String(r.detail));
  expect(plan.some((p) => p.includes("USING INDEX bulk_copy_maintenance"))).toBe(true);
  expect(plan.some((p) => p.includes("TEMP B-TREE"))).toBe(false);
});
it("preserves existing rows and columns, including native receipts, and the FK graph", () => {
  const old = db
    .prepare("PRAGMA table_list")
    .all()
    .filter((r) => r.type === "table" && !String(r.name).startsWith("sqlite_"))
    .map((t) => ({
      name: String(t.name),
      columns: db
        .prepare(`PRAGMA table_info(${t.name})`)
        .all()
        .map((c) => String(c.name))
        .join(","),
      rows: db.prepare(`SELECT * FROM ${t.name}`).all(),
    }));
  migrate();
  for (const t of old)
    expect(db.prepare(`SELECT ${t.columns} FROM ${t.name}`).all()).toEqual(t.rows);
  expect(db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
  expect(
    db
      .prepare("PRAGMA table_info(bulk_jobs)")
      .all()
      .slice(-7)
      .map((row) => row.name),
  ).toEqual([
    "cleanup_token",
    "cleanup_epoch",
    "cleanup_expires_at",
    "cleanup_next_at",
    "cleanup_after",
    "cleanup_calls",
    "cleanup_total_calls",
  ]);
});
it.each(["admission", "restore", "backup"])("refuses migration during %s", (phase) => {
  if (phase === "admission") db.exec("UPDATE control SET maintenance=0");
  if (phase === "restore")
    db.exec("UPDATE control SET restore_freeze_token='00000000-0000-4000-8000-000000000000'");
  if (phase === "backup")
    db.exec(`INSERT INTO backup_runs(id,epoch,state,created_at,barrier_token,watermark)
    SELECT 'backup',1,'exporting',1,'00000000-0000-4000-8000-000000000001',backup_last_op FROM control;
    UPDATE control SET backup_token='00000000-0000-4000-8000-000000000001',backup_barrier_op=backup_last_op,backup_frozen=1;`);
  expect(migrate).toThrow();
  expect(
    db
      .prepare("PRAGMA table_info(bulk_jobs)")
      .all()
      .map((r) => r.name),
  ).not.toContain("cleanup_token");
});
