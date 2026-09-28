import { readdirSync, readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { URL } from "node:url";
import { afterEach, beforeEach, expect, it } from "vitest";
import { RECOVERY_FINAL_QUERY } from "../../src/do/recoveryAudit";
import { foundationFixture } from "../fixtures/foundation";

const directory = new URL("../../migrations/", import.meta.url);
let db: DatabaseSync;
const op = "op_" + "a".repeat(64);
beforeEach(() => {
  db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys=ON");
  for (const file of readdirSync(directory)
    .filter((f) => f.endsWith(".sql") && f < "0050_")
    .sort())
    db.exec(readFileSync(new URL(file, directory), "utf8"));
  for (const prefix of ["owner", "recipient"])
    for (const s of foundationFixture(prefix).statements)
      db.prepare(s.sql).run(...(s.values as (string | number | null)[]));
  db.exec(`UPDATE control SET bootstrap_done_at=1,bootstrap_iss='https://access.invalid',bootstrap_sub='owner-u';
    INSERT INTO shares(id,owner_id,root_node_id,kind,created_at,version,disabled_at) VALUES('selected','owner-u','owner-d','internal',1,2,1);
    INSERT INTO app_passwords(id,user_id,name,secret_digest,salt,kdf,kdf_params,kid,created_at,expires_at)
      VALUES('dav','recipient-u','DAV','hash','salt','PBKDF2-SHA256','{"iterations":100000}','test',1,100000);
    INSERT INTO credentials(id,kind,app_password_id) VALUES('ap:dav','app_password','dav');
    INSERT INTO permits(permit_id,space_id,epoch,expires_at,state) VALUES('permit','owner-s',1,10000,'released');`);
});
afterEach(() => db.close());
const migrate = () =>
  db.exec(readFileSync(new URL("0050_dav_selected_shares.sql", directory), "utf8"));
function insertOperation(selected = true) {
  db.prepare(`INSERT INTO operations(op_id,principal_kind,principal_id,credential_id,space_id,kind,state,request_digest,epoch,permit_id,permit_expires_at,claimed_expires_at,expected_steps,created_at,updated_at,selected_share_id,selected_share_version,operands_json)
    VALUES(?,'app_password','recipient-u','ap:dav','owner-s','dav.put','failed',?,1,'permit',10000,10000,0,1,1,?,?, '{"parentId":"owner-d"}')`).run(
    op,
    "b".repeat(64),
    selected ? "selected" : null,
    selected ? 1 : null,
  );
}
function insertUpload(selected = true, bound = false) {
  db.prepare(
    "INSERT INTO reservations(id,owner_id,bytes,state,expires_at,epoch,op_id) VALUES(?,'owner-u',3,'reserved',10000,1,?)",
  ).run(op + "_reservation", bound ? op : null);
  db.prepare("UPDATE reservations SET state='released' WHERE id=?").run(op + "_reservation");
  db.prepare(
    "INSERT INTO blobs(id,owner_id,r2_key,size,content_etag,state,created_at) VALUES(?,'owner-u',?,3,'etag','deleted',1)",
  ).run(op + "_blob", `u/owner-u/b/${op}_blob`);
  db.prepare(`INSERT INTO uploads(id,owner_id,space_id,parent_id,blob_id,credential_id,reservation_id,mode,state,declared_size,capability_hash,epoch,created_at,expires_at,last_progress_at,selected_share_id,selected_share_version,completion_op_id,source,upload_name,request_digest,write_attempt_id,write_lease_expires_at)
    VALUES(?,'owner-u','owner-s','owner-d',?,'ap:dav',?,'single','aborted',3,'internal:dav',1,1,10000,1,?,?,?,'dav','file',?,'attempt',1000)`).run(
    "dav_" + op,
    op + "_blob",
    op + "_reservation",
    selected ? "selected" : null,
    selected ? 1 : null,
    bound ? op : null,
    "b".repeat(64),
  );
}

it("preserves all existing table data and does not invent mount names in migration0050", () => {
  const tables = db
    .prepare("PRAGMA table_list")
    .all()
    .filter((t) => t.type === "table" && !String(t.name).startsWith("sqlite_"))
    .map((t) => String(t.name));
  const snapshot = () =>
    Object.fromEntries(tables.map((t) => [t, db.prepare(`SELECT * FROM ${t} ORDER BY 1`).all()]));
  const before = snapshot();
  migrate();
  expect(snapshot()).toEqual(before);
  expect(db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
});
it.each([false, true])("accepts historical selected DAV scope in recovery, bound=%s", (bound) => {
  migrate();
  if (bound) insertOperation();
  insertUpload(true, bound);
  for (const file of readdirSync(directory)
    .filter((f) => f.endsWith(".sql") && f > "0050_zz")
    .sort())
    db.exec(readFileSync(new URL(file, directory), "utf8"));
  expect(db.prepare(RECOVERY_FINAL_QUERY).get(1)).toBeTruthy();
  expect(() => db.exec("UPDATE uploads SET selected_share_version=2")).toThrow(
    "immutable_upload_share",
  );
  if (bound) expect(() => db.exec("UPDATE operations SET selected_share_version=2")).toThrow();
});
it("keeps an unselected recipient from inserting another owner's prepublication DAV upload", () => {
  migrate();
  expect(() => insertUpload(false)).toThrow("invalid_dav_upload_source");
});
it("rejects a DAV completion whose selected share differs from its staged upload", () => {
  migrate();
  insertUpload();
  insertOperation(false);
  db.prepare("UPDATE reservations SET op_id=? WHERE id=?").run(op, op + "_reservation");
  expect(() => db.prepare("UPDATE uploads SET completion_op_id=?").run(op)).toThrow(
    "upload_operation_share_mismatch",
  );
});
