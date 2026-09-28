import { readdirSync, readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { URL } from "node:url";
import { afterEach, beforeEach, expect, it } from "vitest";
import { RECOVERY_FINAL_QUERY } from "../../src/do/recoveryAudit";
import { foundationFixture } from "../fixtures/foundation";

const directory = new URL("../../migrations/", import.meta.url);
let db: DatabaseSync;
beforeEach(() => {
  db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys=ON");
  for (const name of readdirSync(directory)
    .filter((n) => n.endsWith(".sql") && n < "0056_")
    .sort())
    db.exec(readFileSync(new URL(name, directory), "utf8"));
  for (const name of ["source", "target"])
    for (const s of foundationFixture(name).statements)
      db.prepare(s.sql).run(...(s.values as (string | number | null)[]));
});
afterEach(() => db.close());
function freezeBackup() {
  db.exec(`INSERT INTO backup_runs(id,epoch,state,created_at,barrier_token,watermark)
 SELECT 'backup',1,'exporting',1,'00000000-0000-4000-8000-000000000001',backup_last_op FROM control;
 UPDATE control SET backup_token='00000000-0000-4000-8000-000000000001',backup_barrier_op=backup_last_op,backup_frozen=1;`);
}
const migrate = () =>
  db.exec(readFileSync(new URL("0056_copy_publication.sql", directory), "utf8"));
const op = "op_" + "a".repeat(64),
  job = "copy_" + "a".repeat(64);
function accepted() {
  db.exec(
    "INSERT INTO permits(permit_id,space_id,epoch,expires_at,state) VALUES('permit','source-s',1,10000,'released')",
  );
  db.prepare(`INSERT INTO operations(op_id,principal_kind,principal_id,credential_id,space_id,kind,state,request_digest,epoch,permit_id,permit_expires_at,claimed_expires_at,expected_steps,created_at,updated_at,destination_space_id)
    VALUES(?,'user','target-u','as:target-session','source-s','copy.enqueue','claimed','digest',1,'permit',10000,10000,4,1,1,'target-s')`).run(
    op,
  );
  db.prepare(`INSERT INTO bulk_jobs(id,owner_id,credential_id,op_id,kind,state,epoch,manifest_ref,grant_snapshot,node_count,created_at,updated_at)
    VALUES(?,'target-u','as:target-session',?,'node.copy','pending',1,?,'{}',1,1,1)`).run(
    job,
    op,
    "d1:copy/" + job,
  );
  db.prepare("INSERT INTO copy_job_manifests VALUES(?,?,1,1,10000)").run(job, "b".repeat(64));
  db.prepare("INSERT INTO copy_job_chunks VALUES(?,0,?)").run(job, Buffer.from("x"));
  for (const [i, kind] of ["copy_job", "copy_manifest", "copy_holds", "copy_outbox"].entries())
    db.prepare("INSERT INTO operation_steps VALUES(?,?,?,?)").run(op, i + 1, kind, job);
  db.prepare(
    "INSERT INTO outbox(outbox_id,op_id,kind,payload_ref,state,epoch,created_at,updated_at) VALUES(?,?,'copy.requested',?,'pending',1,1,1)",
  ).run(op + "_copy", op, job);
  db.prepare("UPDATE operations SET state='committed',result_json=? WHERE op_id=?").run(
    JSON.stringify({ status: 202, jobId: job }),
    op,
  );
}
it("preserves every legacy column and the accepted copy while adding nullable publication identity", () => {
  accepted();
  const tables = db
    .prepare("PRAGMA table_list")
    .all()
    .filter((t) => t.type === "table" && !String(t.name).startsWith("sqlite_"))
    .map((t) => String(t.name));
  const old = new Map(
    tables.map((t) => [
      t,
      {
        columns: db
          .prepare(`PRAGMA table_info(${t})`)
          .all()
          .map((c) => String(c.name))
          .join(","),
        rows: db.prepare(`SELECT * FROM ${t}`).all(),
      },
    ]),
  );
  migrate();
  for (const [t, data] of old)
    if (t !== "operation_kinds")
      expect(db.prepare(`SELECT ${data.columns} FROM ${t}`).all()).toEqual(data.rows);
  expect(db.prepare("SELECT publish_op_id,published_root_id FROM bulk_jobs").get()).toEqual({
    publish_op_id: null,
    published_root_id: null,
  });
  expect(db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
  // The current recovery fence is checked against the current schema, after preservation above.
  for (const name of readdirSync(directory)
    .filter((n) => n.endsWith(".sql") && n > "0056_copy_publication.sql")
    .sort())
    db.exec(readFileSync(new URL(name, directory), "utf8"));
  expect(db.prepare(RECOVERY_FINAL_QUERY).get(1)).toBeUndefined();
});
it.each(["open", "backup", "restore"])("refuses migration during %s", (phase) => {
  if (phase === "open") db.exec("UPDATE control SET maintenance=0");
  if (phase === "backup") freezeBackup();
  if (phase === "restore")
    db.exec("UPDATE control SET restore_freeze_token='00000000-0000-4000-8000-000000000000'");
  expect(migrate).toThrow();
  expect(
    db.prepare("SELECT name FROM operation_kinds WHERE name='copy.publish'").get(),
  ).toBeUndefined();
});
it.each([
  "UPDATE bulk_jobs SET state='completed'",
  "UPDATE bulk_jobs SET publish_op_id=op_id,published_root_id=id||'_n00001'",
  "UPDATE bulk_jobs SET published_root_id='unbound'",
])("rejects unproven completion: %s", (sql) => {
  accepted();
  migrate();
  expect(() => db.exec(sql)).toThrow();
  expect(db.prepare("SELECT state,publish_op_id FROM bulk_jobs").get()).toEqual({
    state: "pending",
    publish_op_id: null,
  });
});
it("retains backup and restore freeze coverage for the new columns", () => {
  accepted();
  migrate();
  freezeBackup();
  expect(() => db.exec("UPDATE bulk_jobs SET publish_op_id=publish_op_id")).toThrow(
    "backup_frozen",
  );
  db.exec(
    "UPDATE control SET backup_frozen=0; UPDATE control SET backup_token=NULL,backup_barrier_op=NULL,restore_freeze_token='00000000-0000-4000-8000-000000000000'",
  );
  expect(() => db.exec("UPDATE bulk_jobs SET published_root_id=published_root_id")).toThrow(
    "database_restore_frozen",
  );
});
