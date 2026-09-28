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
  for (const file of readdirSync(directory)
    .filter((n) => n.endsWith(".sql") && n < "0064_")
    .sort())
    db.exec(readFileSync(new URL(file, directory), "utf8"));
  for (const s of foundationFixture().statements)
    db.prepare(s.sql).run(...(s.values as (string | number | null)[]));
  db.exec(`UPDATE control SET bootstrap_done_at=1,bootstrap_iss='https://access.invalid',bootstrap_sub='f-u';
    INSERT INTO shares(id,owner_id,root_node_id,kind,version,created_at,disabled_at) VALUES('link','f-u','f-d','link',2,1,1);
    INSERT INTO share_sessions(id,share_id,share_version,secret_digest,epoch,issued_at,expires_at,revoked_at) VALUES('unlock','link',1,'secret',1,1,10000,1);
    INSERT INTO credentials(id,kind,share_session_id) VALUES('ss:unlock','share','unlock');
    INSERT INTO reservations(id,owner_id,bytes,state,expires_at,epoch) VALUES('res','f-u',3,'reserved',10000,1);
    UPDATE reservations SET state='released' WHERE id='res';
    INSERT INTO permits(permit_id,space_id,epoch,expires_at,state) VALUES('permit','f-s',1,10000,'released');
    INSERT INTO operations(op_id,principal_kind,principal_id,credential_id,credential_version,space_id,kind,state,request_digest,epoch,permit_id,permit_expires_at,claimed_expires_at,expected_steps,created_at,updated_at,operands_json)
      VALUES('op','link_share','link','ss:unlock',1,'f-s','upload.complete','failed','digest',1,'permit',10000,10000,0,1,1,'{"uploadId":"upload","parentId":"f-d"}');`);
});
afterEach(() => db.close());
const migrate = () => {
  // The current recovery proof must run against the fully migrated schema.
  for (const file of readdirSync(directory)
    .filter((n) => n.endsWith(".sql") && n >= "0064_")
    .sort())
    db.exec(readFileSync(new URL(file, directory), "utf8"));
};
function upload(change: Record<string, unknown> = {}) {
  const values = {
    id: "upload",
    owner_id: "f-u",
    space_id: "f-s",
    parent_id: "f-d",
    blob_id: "f-b",
    credential_id: "ss:unlock",
    reservation_id: "res",
    mode: "single",
    state: "aborted",
    declared_size: 3,
    capability_hash: "hash",
    epoch: 1,
    created_at: 1,
    expires_at: 10000,
    last_progress_at: 1,
    link_share_id: "link",
    link_share_version: 1,
    completion_op_id: "op",
    ...change,
  };
  db.prepare(
    `INSERT INTO uploads(${Object.keys(values).join(",")}) VALUES(${Object.keys(values)
      .map(() => "?")
      .join(",")})`,
  ).run(...(Object.values(values) as (string | number | null)[]));
}
const ready = () => db.prepare(RECOVERY_FINAL_QUERY).get(1);
it("preserves existing private uploads and credentials when migrating forward", () => {
  db.exec(`INSERT INTO uploads(id,owner_id,space_id,parent_id,blob_id,credential_id,reservation_id,
    mode,state,declared_size,capability_hash,epoch,created_at,expires_at,last_progress_at)
    VALUES('legacy','f-u','f-s','f-d','f-b','as:f-session','res','single','aborted',3,'old-capability',1,1,10000,1)`);
  const before = db.prepare("SELECT * FROM uploads WHERE id='legacy'").get();
  migrate();
  expect(db.prepare("SELECT * FROM uploads WHERE id='legacy'").get()).toEqual({
    ...before,
    link_share_id: null,
    link_share_version: null,
    upload_only: 0,
  });
  expect(ready()).toBeTruthy();
  expect(db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
});
it("accepts historical link uploads after revocation and protects their original scope", () => {
  migrate();
  upload();
  expect(ready()).toBeTruthy();
  expect(db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
  for (const sql of [
    "UPDATE uploads SET link_share_version=2",
    "UPDATE uploads SET link_share_id=NULL,link_share_version=NULL",
  ])
    expect(() => db.exec(sql)).toThrow("immutable_upload_link");
});
it.each([
  { link_share_id: null },
  { link_share_version: null },
  { link_share_id: null, link_share_version: null },
  { link_share_version: 2 },
  { credential_id: "as:f-session" },
  { source: "dav" },
  { completion_op_id: null, link_share_id: "other" },
])("rejects a forged upload binding %j", (change) => {
  migrate();
  expect(() => upload(change)).toThrow();
});
it.each([
  "UPDATE uploads SET link_share_id=NULL,link_share_version=NULL",
  "UPDATE uploads SET link_share_version=2",
  "UPDATE share_sessions SET share_version=2",
  "UPDATE shares SET kind='internal'",
  "UPDATE operations SET credential_version=2",
])("refuses corrupt restored link authority: %s", (sql) => {
  migrate();
  upload();
  expect(ready()).toBeTruthy();
  db.exec(
    "DROP TRIGGER uploads_link_identity; DROP TRIGGER operation_terminal_immutable; DROP TRIGGER operations_identity;",
  );
  db.exec(sql);
  expect(ready()).toBeUndefined();
});
it.each(["maintenance", "restore", "permit"])("requires a quiescent migration: %s", (condition) => {
  if (condition === "maintenance") db.exec("UPDATE control SET maintenance=0");
  if (condition === "restore")
    db.exec("UPDATE control SET restore_freeze_token='00000000-0000-4000-8000-000000000000'");
  if (condition === "permit")
    db.exec(
      "INSERT INTO permits(permit_id,space_id,epoch,expires_at,state) VALUES('open','f-s',1,10000,'open')",
    );
  expect(migrate).toThrow();
  expect(
    db
      .prepare("PRAGMA table_info(uploads)")
      .all()
      .some((row) => row.name === "link_share_id"),
  ).toBe(false);
});
