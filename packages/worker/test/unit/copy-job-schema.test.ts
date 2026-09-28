import { readdirSync, readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { URL } from "node:url";
import { afterEach, beforeEach, expect, it } from "vitest";
import { RECOVERY_FINAL_QUERY } from "../../src/do/recoveryAudit";
import { foundationFixture } from "../fixtures/foundation";

let db: DatabaseSync;
const directory = new URL("../../migrations/", import.meta.url);
const job = "copy_" + "a".repeat(64),
  op = "op_" + "a".repeat(64);
beforeEach(() => {
  db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys=ON");
  for (const name of readdirSync(directory)
    .filter((n) => n.endsWith(".sql") && n < "0052_")
    .sort())
    db.exec(readFileSync(new URL(name, directory), "utf8"));
  for (const name of ["source", "target"])
    for (const s of foundationFixture(name).statements)
      db.prepare(s.sql).run(...(s.values as (number | string | null)[]));
  db.exec(`UPDATE control SET bootstrap_done_at=1,bootstrap_iss='https://access.invalid',bootstrap_sub='source-u';
    INSERT INTO shares(id,owner_id,root_node_id,kind,version,created_at) VALUES('grant','source-u','source-d','internal',1,1);
    INSERT INTO permits(permit_id,space_id,epoch,expires_at,state) VALUES('permit','source-s',1,10000,'released');`);
});
afterEach(() => db.close());
const migrate = () => db.exec(readFileSync(new URL("0052_copy_jobs.sql", directory), "utf8"));
function operation(kind = "copy.enqueue", destination = "target-s", id = op) {
  db.prepare(`INSERT INTO operations(op_id,principal_kind,principal_id,credential_id,space_id,kind,state,request_digest,epoch,permit_id,permit_expires_at,claimed_expires_at,expected_steps,created_at,updated_at,selected_share_id,selected_share_version,destination_space_id)
 VALUES(?,'user','target-u','as:target-session','source-s',?,'claimed','digest',1,'permit',10000,10000,4,1,1,'grant',1,?)`).run(
    id,
    kind,
    destination,
  );
}
function pending() {
  operation();
  db.prepare(`INSERT INTO bulk_jobs(id,owner_id,credential_id,op_id,kind,state,epoch,manifest_ref,grant_snapshot,node_count,created_at,updated_at)
 VALUES(?,'target-u','as:target-session',?,'node.copy','pending',1,?,'{}',1,1,1)`).run(
    job,
    op,
    "d1:copy/" + job,
  );
  db.prepare("INSERT INTO copy_job_manifests VALUES(?,?,1,1,10000)").run(job, "b".repeat(64));
  db.prepare("INSERT INTO copy_job_chunks VALUES(?,0,?)").run(job, Buffer.from("x"));
}
it("preserves all previous tables and data while adding three guarded manifest tables", () => {
  const tables = db
    .prepare("PRAGMA table_list")
    .all()
    .filter((r) => r.type === "table" && !String(r.name).startsWith("sqlite_"))
    .map((r) => String(r.name));
  const columns = new Map(
    tables.map((t) => [
      t,
      db
        .prepare(`PRAGMA table_info(${t})`)
        .all()
        .map((c) => String(c.name))
        .join(","),
    ]),
  );
  const data = new Map(
    tables.map((t) => [t, db.prepare(`SELECT ${columns.get(t)} FROM ${t}`).all()]),
  );
  migrate();
  for (const t of tables) {
    if (t === "operation_kinds") continue;
    expect(db.prepare(`SELECT ${columns.get(t)} FROM ${t}`).all()).toEqual(data.get(t));
  }
  expect(db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
});
it("refuses unknown legacy copy jobs before applying the new catalogue", () => {
  db.exec(`INSERT INTO operations(op_id,principal_kind,principal_id,credential_id,space_id,kind,state,request_digest,epoch,permit_id,permit_expires_at,claimed_expires_at,expected_steps,created_at,updated_at)
 VALUES('legacy','user','source-u','as:source-session','source-s','node.copy','committed','digest',1,'permit',10000,10000,0,1,1);
 INSERT INTO bulk_jobs(id,owner_id,op_id,kind,state,epoch,grant_snapshot,created_at,updated_at) VALUES('legacy-job','source-u','legacy','node.copy','pending',1,'{}',1,1);`);
  expect(migrate).toThrow();
  expect(
    db.prepare("SELECT name FROM operation_kinds WHERE name='copy.enqueue'").get(),
  ).toBeUndefined();
});
it("allows cross-owner destinations only for explicit async user acceptance", () => {
  migrate();
  for (const kind of ["node.copy", "dav.copy", "node.move", "dav.move"])
    expect(() => operation(kind)).toThrow("invalid_transfer_destination");
  operation();
  expect(db.prepare("SELECT destination_space_id FROM operations WHERE op_id=?").get(op)).toEqual({
    destination_space_id: "target-s",
  });
});
it.each([
  "UPDATE bulk_jobs SET credential_id='as:source-session'",
  "UPDATE bulk_jobs SET grant_snapshot='[]'",
  "UPDATE bulk_jobs SET owner_id='source-u'",
  "UPDATE bulk_jobs SET epoch=2",
  "UPDATE copy_job_manifests SET sha256=printf('%064d',0)",
  "UPDATE copy_job_chunks SET data=x'79'",
  "DELETE FROM copy_job_manifests",
  "DELETE FROM copy_job_chunks",
])("refuses mutation of accepted job identity or retained manifest: %s", (sql) => {
  migrate();
  pending();
  expect(() => db.exec(sql)).toThrow();
});
it("blocks recovery for a pending folder-only copy even without reservations or leases", () => {
  migrate();
  expect(db.prepare(RECOVERY_FINAL_QUERY).get(1)).toBeTruthy();
  pending();
  for (const [i, kind] of ["copy_job", "copy_manifest", "copy_holds", "copy_outbox"].entries())
    db.prepare("INSERT INTO operation_steps VALUES(?,?,?,?)").run(op, i + 1, kind, job);
  db.prepare(
    "INSERT INTO outbox(outbox_id,op_id,kind,payload_ref,state,epoch,created_at,updated_at) VALUES(?,?,'copy.requested',?,'pending',1,1,1)",
  ).run(op + "_copy", op, job);
  db.prepare("UPDATE operations SET state='committed',result_json=? WHERE op_id=?").run(
    JSON.stringify({ status: 202, jobId: job }),
    op,
  );
  expect(db.prepare(RECOVERY_FINAL_QUERY).get(1)).toBeUndefined();
});
it("refuses a committed acceptance receipt without its mandatory durable records", () => {
  migrate();
  pending();
  expect(() =>
    db
      .prepare("UPDATE operations SET state='committed',result_json=? WHERE op_id=?")
      .run(JSON.stringify({ status: 202, jobId: job }), op),
  ).toThrow("incomplete_copy_acceptance");
  expect(db.prepare("SELECT state FROM operations WHERE op_id=?").get(op)).toEqual({
    state: "claimed",
  });
});
