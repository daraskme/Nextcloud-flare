import { readdirSync, readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { URL } from "node:url";
import { afterEach, beforeEach, expect, it } from "vitest";
import { RECOVERY_FINAL_QUERY } from "../../src/do/recoveryAudit";
import { foundationFixture } from "../fixtures/foundation";

let db: DatabaseSync;
beforeEach(() => {
  db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys=ON");
  const directory = new URL("../../migrations/", import.meta.url);
  for (const file of readdirSync(directory)
    .filter((file) => file.endsWith(".sql"))
    .sort())
    db.exec(readFileSync(new URL(file, directory), "utf8"));
  for (const statement of foundationFixture().statements)
    db.prepare(statement.sql).run(...((statement.values as (string | number | null)[]) ?? []));
  db.exec(`UPDATE control SET bootstrap_done_at=1,bootstrap_iss='https://access.invalid',bootstrap_sub='f-u';
    INSERT INTO shares(id,owner_id,root_node_id,kind,created_at,version,disabled_at) VALUES('selected','f-u','f-d','internal',1,2,1);
    INSERT INTO permits(permit_id,space_id,epoch,expires_at,state) VALUES('permit','f-s',1,10000,'released');
    INSERT INTO operations(op_id,principal_kind,principal_id,credential_id,space_id,kind,state,request_digest,epoch,permit_id,permit_expires_at,claimed_expires_at,expected_steps,created_at,updated_at,selected_share_id,selected_share_version)
      VALUES('operation','user','f-u','as:f-session','f-s','upload.complete','failed','digest',1,'permit',10000,10000,0,1,1,'selected',1);
    INSERT INTO reservations(id,owner_id,bytes,state,expires_at,epoch) VALUES('res','f-u',3,'reserved',10000,1);
    UPDATE reservations SET state='released' WHERE id='res';
    INSERT INTO uploads(id,owner_id,space_id,parent_id,blob_id,credential_id,reservation_id,mode,state,declared_size,capability_hash,epoch,created_at,expires_at,last_progress_at,selected_share_id,selected_share_version,completion_op_id)
      VALUES('upload','f-u','f-s','f-d','f-b','as:f-session','res','single','aborted',3,'hash',1,1,10000,1,'selected',1,'operation');`);
});
afterEach(() => db.close());
const ready = () => db.prepare(RECOVERY_FINAL_QUERY).get(1);
it("accepts historical selected write records after the share was stopped and version advanced", () => {
  expect(ready()).toBeTruthy();
});
it.each([
  "UPDATE operations SET selected_share_version=NULL",
  "UPDATE uploads SET selected_share_id=NULL",
  "UPDATE uploads SET selected_share_version=2",
  "UPDATE operations SET selected_share_version=3",
  "UPDATE uploads SET selected_share_version=3",
])("blocks a corrupted restored scope: %s", (sql) => {
  expect(ready()).toBeTruthy();
  // Simulate a corrupt historical restore, bypassing current writer guards only in this DB.
  db.exec(
    "DROP TRIGGER operations_selected_share_identity; DROP TRIGGER operation_terminal_immutable; DROP TRIGGER uploads_selected_share_identity;",
  );
  db.exec(sql);
  expect(ready()).toBeUndefined();
});
