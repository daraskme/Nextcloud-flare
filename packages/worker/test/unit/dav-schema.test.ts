import { readdirSync, readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { URL } from "node:url";
import { afterEach, beforeEach, expect, it } from "vitest";
import { foundationFixture } from "../fixtures/foundation";

const migrations = new URL("../../migrations/", import.meta.url);
let db: DatabaseSync;
const op = "op_" + "a".repeat(64),
  later = "op_" + "b".repeat(64),
  digest = "c".repeat(64);
beforeEach(() => {
  db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys=ON");
  for (const file of readdirSync(migrations)
    .filter((f) => f.endsWith(".sql") && f < "0036_")
    .sort())
    db.exec(readFileSync(new URL(file, migrations), "utf8"));
  for (const s of foundationFixture().statements)
    db.prepare(s.sql).run(...((s.values ?? []) as (string | number | null)[]));
  db.exec(`INSERT INTO app_passwords(id,user_id,root_node_id,name,secret_digest,salt,kdf,kdf_params,kid,created_at,expires_at)
    VALUES('dav','f-u','f-d','DAV','hash','salt','PBKDF2-SHA256','{"iterations":100000}','test',1,100000);
    INSERT INTO credentials(id,kind,app_password_id) VALUES('ap:dav','app_password','dav');
    INSERT INTO reservations(id,owner_id,bytes,state,expires_at,epoch) VALUES('private-res','f-u',3,'reserved',100000,1);
    INSERT INTO uploads(id,owner_id,space_id,parent_id,blob_id,credential_id,reservation_id,mode,state,declared_size,capability_hash,epoch,created_at,expires_at,last_progress_at)
      VALUES('private','f-u','f-s','f-d','f-b','as:f-session','private-res','single','receiving',3,'private-hash',1,1,100000,1);`);
  operation(op);
  staging(op, true);
  upload(op, true);
  db.prepare(
    "INSERT INTO blob_storage(blob_id,bytes,r2_etag,observed_at) VALUES(?,3,'saved',1)",
  ).run(op + "_blob");
});
afterEach(() => db.close());
function operation(id: string) {
  db.prepare(
    "INSERT INTO permits(permit_id,space_id,epoch,expires_at,state) VALUES(?,'f-s',1,1,'released')",
  ).run(id);
  db.prepare(`INSERT INTO operations(op_id,principal_kind,principal_id,credential_id,space_id,kind,state,request_digest,epoch,permit_id,permit_expires_at,claimed_expires_at,expected_steps,operands_json,created_at,updated_at)
    VALUES(?,'app_password','f-u','ap:dav','f-s','dav.put','claimed',?,1,?,1,1,10,'{"parentId":"f-d"}',1,1)`).run(
    id,
    digest,
    id,
  );
}
function staging(id: string, bound: boolean) {
  db.prepare(
    "INSERT INTO reservations(id,owner_id,bytes,state,expires_at,epoch,op_id) VALUES(?,'f-u',3,'reserved',100000,1,?)",
  ).run(id + "_reservation", bound ? id : null);
  db.prepare(
    "INSERT INTO blobs(id,owner_id,r2_key,size,content_etag,state,created_at) VALUES(?,'f-u',?,3,'content','staging',1)",
  ).run(id + "_blob", `u/f-u/b/${id}_blob`);
}
function upload(id: string, bound: boolean, credential = "ap:dav", requestDigest = digest) {
  db.prepare(`INSERT INTO uploads(id,source,owner_id,space_id,parent_id,blob_id,reservation_id,credential_id,mode,state,declared_size,capability_hash,epoch,created_at,expires_at,last_progress_at,upload_name,request_digest,write_attempt_id,write_lease_expires_at,completion_op_id)
    VALUES(?,'dav','f-u','f-s','f-d',?,?,?,'single','receiving',3,'internal:dav',1,1,100000,1,'file',?,'attempt',90000,?)`).run(
    "dav_" + id,
    id + "_blob",
    id + "_reservation",
    credential,
    requestDigest,
    bound ? id : null,
  );
}
function migrate() {
  db.exec(readFileSync(new URL("0036_dav_late_publication.sql", migrations), "utf8"));
}

it("preserves existing private and bound DAV rows, physical charges and holds through migration0036", () => {
  const snapshot = () =>
    Object.fromEntries(
      ["uploads", "reservations", "blobs", "blob_storage", "users", "operations", "permits"].map(
        (table) => [table, db.prepare(`SELECT * FROM ${table} ORDER BY 1`).all()],
      ),
    );
  const before = snapshot();
  migrate();
  expect(snapshot()).toEqual(before);
  expect(db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
});

it("requires a real app-password source and fixed digest before accepting an unbound DAV ledger", () => {
  migrate();
  staging(later, false);
  expect(() => upload(later, false, "as:f-session")).toThrow("invalid_dav_upload_source");
  expect(() => upload(later, false, "ap:dav", "not-a-digest")).toThrow("invalid_dav_upload_source");
  upload(later, false);
  expect(db.prepare("SELECT completion_op_id FROM uploads WHERE id=?").get("dav_" + later)).toEqual(
    { completion_op_id: null },
  );
  expect(db.prepare("SELECT op_id FROM operations WHERE op_id=?").get(later)).toBeUndefined();
});

it("binds late completion once to the derived operation and its reservation, retaining immutable identity", () => {
  migrate();
  staging(later, false);
  upload(later, false);
  expect(() =>
    db.prepare("UPDATE uploads SET completion_op_id=? WHERE id=?").run(op, "dav_" + later),
  ).toThrow("invalid_dav_upload_completion");
  operation(later);
  expect(() =>
    db.prepare("UPDATE uploads SET completion_op_id=? WHERE id=?").run(later, "dav_" + later),
  ).toThrow("invalid_dav_upload_completion");
  db.exec("BEGIN");
  db.prepare("UPDATE reservations SET op_id=? WHERE id=?").run(later, later + "_reservation");
  db.prepare("UPDATE uploads SET completion_op_id=? WHERE id=?").run(later, "dav_" + later);
  db.exec("COMMIT");
  expect(() =>
    db.prepare("UPDATE uploads SET completion_op_id=NULL WHERE id=?").run("dav_" + later),
  ).toThrow("immutable_upload_completion");
  expect(db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
});
