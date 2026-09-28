import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, expect, it } from "vitest";
import { copyBudgetExhaustedSql, copyRemainingBudgetSql } from "../../src/jobs/copyBudget";

let db: DatabaseSync;
beforeEach(() => {
  db = new DatabaseSync(":memory:");
  db.exec(`CREATE TABLE bulk_jobs(id TEXT PRIMARY KEY,invocation_count INTEGER,r2_calls INTEGER);
    CREATE TABLE job_leases(job_id TEXT PRIMARY KEY,expires_at INTEGER,attempt INTEGER);
    CREATE TABLE blobs(id TEXT PRIMARY KEY,size INTEGER);
    CREATE TABLE copy_job_blobs(job_id TEXT,source_blob_id TEXT,destination_blob_id TEXT,transfer_state TEXT,PRIMARY KEY(job_id,source_blob_id));
    CREATE TABLE copy_multipart_uploads(destination_blob_id TEXT PRIMARY KEY,state TEXT,part_count INTEGER);
    CREATE TABLE copy_multipart_parts(destination_blob_id TEXT,part_number INTEGER,PRIMARY KEY(destination_blob_id,part_number));
    INSERT INTO bulk_jobs VALUES('job',0,0);`);
});
afterEach(() => db.close());
function blob(id: string, size: number, state = "pending") {
  db.prepare("INSERT INTO blobs VALUES(?,?)").run(id, size);
  db.prepare("INSERT INTO copy_job_blobs VALUES('job',?,?,?)").run(id, id + "-dst", state);
}
const cost = () =>
  JSON.parse(
    db
      .prepare(`SELECT (SELECT json_object('calls',calls,'steps',steps)
      FROM (${copyRemainingBudgetSql("j")})) AS cost FROM bulk_jobs j`)
      .get()!.cost as string,
  );
const exhausted = () =>
  db.prepare(`SELECT ${copyBudgetExhaustedSql("j")} AS exhausted FROM bulk_jobs j`).get()!
    .exhausted;

it.each([
  [0, 2, 1],
  [8 * 1024 * 1024, 2, 1],
  [8 * 1024 * 1024 + 1, 4, 3],
  [90 * 1024 * 1024, 4, 3],
  [90 * 1024 * 1024 + 1, 6, 4],
  [500 * 1024 ** 3, 11380, 5691],
])("bounds untouched %s bytes by at least %s calls and %s steps", (size, calls, steps) => {
  blob("source", size);
  expect(cost()).toEqual({ calls, steps });
  expect(exhausted()).toBe(0);
});
it("accepts the exact native boundary and rejects even one insufficient call", () => {
  blob("source", 3);
  db.exec("UPDATE bulk_jobs SET r2_calls=19998");
  expect(exhausted()).toBe(0);
  db.exec("UPDATE bulk_jobs SET r2_calls=19999");
  expect(exhausted()).toBe(1);
});
it("checks the remaining invocation capacity independently from total native calls", () => {
  for (let i = 0; i < 57; i++) blob(String(i), 3);
  db.exec("UPDATE bulk_jobs SET invocation_count=198");
  expect(exhausted()).toBe(0);
  db.exec("UPDATE bulk_jobs SET invocation_count=199");
  expect(exhausted()).toBe(1);
});
it("checks invocation step capacity even when the native total fits", () => {
  db.exec("BEGIN");
  for (let i = 0; i < 5000; i++) blob(String(i), 9 * 1024 * 1024);
  db.exec("COMMIT");
  expect(cost()).toEqual({ calls: 20000, steps: 15000 });
  expect(exhausted()).toBe(1);
});
it("keeps the full 10000-small-blob boundary feasible without promising throughput", () => {
  db.exec("BEGIN");
  for (let i = 0; i < 10000; i++) blob(String(i), 3);
  db.exec("COMMIT");
  expect(cost()).toEqual({ calls: 20000, steps: 10000 });
  expect(exhausted()).toBe(0);
});
it("uses fixed multipart geometry and does not re-charge prepared native outcomes", () => {
  blob("source", 100 * 1024 * 1024, "claimed");
  db.exec("INSERT INTO copy_multipart_uploads VALUES('source-dst','creating',13)");
  expect(cost()).toEqual({ calls: 27, steps: 14 });
  db.exec(
    "UPDATE copy_multipart_uploads SET state='uploading'; INSERT INTO copy_multipart_parts VALUES('source-dst',1)",
  );
  expect(cost()).toEqual({ calls: 25, steps: 13 });
  db.exec("UPDATE copy_multipart_uploads SET state='completing'");
  expect(cost()).toEqual({ calls: 0, steps: 1 });
  db.exec("UPDATE copy_job_blobs SET transfer_state='stored'");
  expect(cost()).toEqual({ calls: 0, steps: 0 });
});
it("allows DB-only completion at the call limit but never extends invocation or retry limits", () => {
  blob("source", 3, "stored");
  db.exec("UPDATE bulk_jobs SET r2_calls=20000,invocation_count=199");
  expect(exhausted()).toBe(0);
  db.exec("UPDATE bulk_jobs SET invocation_count=200");
  expect(exhausted()).toBe(1);
  db.exec("UPDATE bulk_jobs SET invocation_count=199; INSERT INTO job_leases VALUES('job',0,10)");
  expect(exhausted()).toBe(1);
});
it("never stops a live execution based on a budget snapshot", () => {
  blob("source", 3);
  db.exec("UPDATE bulk_jobs SET r2_calls=20000,invocation_count=200");
  db.prepare("INSERT INTO job_leases VALUES('job',?,10)").run(Date.now() + 60000);
  expect(exhausted()).toBe(0);
  db.exec("UPDATE job_leases SET expires_at=0");
  expect(exhausted()).toBe(1);
});
