import { readdirSync, readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { URL } from "node:url";
import { expect, it } from "vitest";
import { foundationFixture } from "../fixtures/foundation";

it("adds invocation accounting without changing existing job lease identity or attempts", () => {
  const db = new DatabaseSync(":memory:");
  const directory = new URL("../../migrations/", import.meta.url);
  try {
    for (const name of readdirSync(directory)
      .filter((n) => n.endsWith(".sql") && n < "0053_")
      .sort())
      db.exec(readFileSync(new URL(name, directory), "utf8"));
    for (const s of foundationFixture("legacy").statements)
      db.prepare(s.sql).run(...(s.values as (number | string | null)[]));
    db.exec(`INSERT INTO permits(permit_id,space_id,epoch,expires_at,state) VALUES('permit','legacy-s',1,10000,'released');
      INSERT INTO operations(op_id,principal_kind,principal_id,credential_id,space_id,kind,state,request_digest,epoch,permit_id,permit_expires_at,claimed_expires_at,expected_steps,created_at,updated_at)
        VALUES('operation','user','legacy-u','as:legacy-session','legacy-s','node.create','claimed','digest',1,'permit',10000,10000,1,1,1);
      INSERT INTO bulk_jobs(id,owner_id,credential_id,op_id,kind,state,epoch,grant_snapshot,created_at,updated_at)
        VALUES('job','legacy-u','as:legacy-session','operation','node.create','running',1,'{}',1,1);
      INSERT INTO job_leases VALUES('job','token',1,10000,3);`);
    const before = db.prepare("SELECT * FROM job_leases").get();
    db.exec(readFileSync(new URL("0053_copy_execution.sql", directory), "utf8"));
    expect(db.prepare("SELECT * FROM job_leases").get()).toEqual({ ...before, r2_calls: 0 });
    db.exec("UPDATE job_leases SET r2_calls=2000");
    for (const invalid of [-1, 2001])
      expect(() => db.prepare("UPDATE job_leases SET r2_calls=?").run(invalid)).toThrow();
    expect(db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
  } finally {
    db.close();
  }
});
