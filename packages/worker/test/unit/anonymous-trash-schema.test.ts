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
    .filter((n) => n.endsWith(".sql") && n < "0065_")
    .sort())
    db.exec(readFileSync(new URL(name, directory), "utf8"));
  for (const s of foundationFixture().statements)
    db.prepare(s.sql).run(...(s.values as (string | number | null)[]));
  db.exec(`UPDATE control SET bootstrap_done_at=1,bootstrap_iss='https://access.invalid',bootstrap_sub='f-u';
    INSERT INTO shares(id,owner_id,root_node_id,kind,version,created_at,disabled_at) VALUES('link','f-u','f-d','link',2,1,1);
    INSERT INTO share_sessions(id,share_id,share_version,secret_digest,epoch,issued_at,expires_at,revoked_at) VALUES('unlock','link',1,'secret',1,1,10000,1);
    INSERT INTO credentials(id,kind,share_session_id) VALUES('ss:unlock','share','unlock');
    INSERT INTO permits(permit_id,space_id,epoch,expires_at,state) VALUES('permit','f-s',1,10000,'released');
    INSERT INTO operations(op_id,principal_kind,principal_id,credential_id,credential_version,space_id,kind,state,request_digest,epoch,permit_id,permit_expires_at,claimed_expires_at,expected_steps,created_at,updated_at,operands_json)
      VALUES('op','link_share','link','ss:unlock',1,'f-s','node.trash','committed','digest',1,'permit',10000,10000,13,1,1,'{"nodeId":"f-f","parentId":"f-d"}');`);
});
afterEach(() => db.close());
const migrate = () =>
  db.exec(readFileSync(new URL("0065_anonymous_trash_actor.sql", directory), "utf8"));
const ready = () => db.prepare(RECOVERY_FINAL_QUERY).get(1);
const trash = (actor: string | null = null) =>
  db
    .prepare(
      "INSERT INTO trash_ops(op_id,actor_id,space_id,root_node_id,state,reason,created_at,epoch) VALUES('op',?,'f-s','f-f','trashed','node.trash',1,1)",
    )
    .run(actor);
const activity = () =>
  db.exec(
    "INSERT INTO activity(id,op_id,actor_id,kind,affected_id,created_at) VALUES('activity','op',NULL,'node.trash','f-f',1)",
  );
it("preserves populated legacy trash, inbound node/member references, indexes and freeze guards", () => {
  db.exec(`INSERT INTO trash_ops(op_id,actor_id,space_id,root_node_id,state,created_at,epoch) VALUES('legacy','f-u','f-s','f-f','trashed',1,1);
    UPDATE nodes SET deleted_at=1,deleted_op_id='legacy',orig_parent_id=parent_id WHERE id='f-f';
    INSERT INTO trash_members VALUES('legacy','f-f');`);
  const before = db.prepare("SELECT * FROM trash_ops").all();
  migrate();
  expect(db.prepare("SELECT * FROM trash_ops").all()).toEqual(before);
  expect(db.prepare("SELECT deleted_op_id FROM nodes WHERE id='f-f'").get()).toEqual({
    deleted_op_id: "legacy",
  });
  expect(db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
  expect(
    db
      .prepare(
        "SELECT COUNT(*) AS n FROM sqlite_schema WHERE type='index' AND tbl_name='trash_ops' AND sql IS NOT NULL",
      )
      .get(),
  ).toEqual({ n: 3 });
  expect(
    db
      .prepare(
        "SELECT COUNT(*) AS n FROM sqlite_schema WHERE type='trigger' AND tbl_name='trash_ops' AND name LIKE '%freeze%'",
      )
      .get(),
  ).toEqual({ n: 6 });
});
it("retains anonymous attribution after revocation and permits owner restore/purge states", () => {
  migrate();
  trash();
  activity();
  expect(ready()).toBeTruthy();
  db.exec("UPDATE trash_ops SET state='restored' WHERE op_id='op'");
  expect(ready()).toBeTruthy();
  db.exec("UPDATE trash_ops SET state='purged' WHERE op_id='op'");
  expect(ready()).toBeTruthy();
  expect(() => db.exec("UPDATE trash_ops SET actor_id='f-u' WHERE op_id='op'")).toThrow(
    "immutable_trash_actor",
  );
});
it("rejects anonymous records without provenance and does not impersonate the owner", () => {
  migrate();
  expect(() => trash("f-u")).toThrow("invalid_anonymous_trash_actor");
  db.exec("DELETE FROM operations WHERE op_id='op'");
  expect(() => trash()).toThrow("invalid_anonymous_trash_actor");
});
it.each([
  "UPDATE trash_ops SET actor_id='f-u'",
  "UPDATE trash_ops SET root_node_id='f-d'",
  "UPDATE operations SET credential_version=2",
  "UPDATE share_sessions SET epoch=2",
  "UPDATE shares SET kind='internal'",
  "UPDATE activity SET actor_id='f-u'",
])("refuses corrupted restored anonymous attribution: %s", (change) => {
  migrate();
  trash();
  activity();
  expect(ready()).toBeTruthy();
  db.exec(
    "DROP TRIGGER trash_actor_identity; DROP TRIGGER operation_terminal_immutable; DROP TRIGGER operations_identity;",
  );
  db.exec(change);
  expect(ready()).toBeUndefined();
});
it.each(["maintenance", "restore", "permit"])(
  "requires quiescence before changing actor schema: %s",
  (condition) => {
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
        .prepare("SELECT \"notnull\" FROM pragma_table_info('trash_ops') WHERE name='actor_id'")
        .get(),
    ).toEqual({ notnull: 1 });
  },
);
