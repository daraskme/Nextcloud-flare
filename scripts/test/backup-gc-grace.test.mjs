import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { it } from "vitest";
import { foundationFixture } from "../../packages/worker/test/fixtures/foundation.ts";

const directory = new URL("../../packages/worker/migrations/", import.meta.url);
const migration = readFileSync(new URL("0039_backup_gc_grace.sql", directory), "utf8");
const grace = 35 * 86400000 + 1000,
  initial = 1800000000000;

function test(name, body) {
  it(name, () => {
    const db = new DatabaseSync(":memory:");
    let now = initial;
    db.function("strftime", { varargs: true }, (format, value) => {
      assert.equal(format, "%s");
      assert.equal(value, "now");
      return String(Math.floor(now / 1000));
    });
    try {
      db.exec("PRAGMA foreign_keys=ON");
      for (const name of readdirSync(directory)
        .filter((n) => n.endsWith(".sql") && n < "0039_")
        .sort())
        db.exec(readFileSync(new URL(name, directory), "utf8"));
      for (const s of foundationFixture().statements) db.prepare(s.sql).run(...(s.values ?? []));
      const candidate = () =>
        db.exec("INSERT INTO gc_candidates(blob_id,state,not_before) VALUES('f-b','candidate',0)");
      const deadline = () =>
        db.prepare("SELECT not_before FROM gc_candidates WHERE blob_id='f-b'").get()?.not_before;
      body({
        db,
        candidate,
        deadline,
        advance: (ms) => (now += ms),
        apply: () => db.exec(migration),
      });
      assert.deepEqual(db.prepare("PRAGMA foreign_key_check").all(), []);
    } finally {
      db.close();
    }
  });
}
test("forward migration protects old candidate and keeps later deadline", ({
  db,
  candidate,
  deadline,
  apply,
}) => {
  candidate();
  apply();
  assert.equal(deadline(), initial + grace);
  db.exec("UPDATE gc_candidates SET not_before=9999999999999");
  db.exec("UPDATE nodes SET current_blob_id=NULL WHERE id='f-f'");
  assert.equal(deadline(), 9999999999999);
});
test("node update starts from last reference, even while temporary pin remains", ({
  db,
  candidate,
  deadline,
  apply,
  advance,
}) => {
  candidate();
  apply();
  advance(70000);
  db.exec(
    "INSERT INTO blob_pins(pin_id,blob_id,purpose,created_at) VALUES('pin','f-b','reader',1)",
  );
  db.exec("UPDATE nodes SET current_blob_id=NULL WHERE id='f-f'");
  assert.equal(deadline(), initial + 70000 + grace);
  assert.equal(db.prepare("SELECT ref_count FROM blobs WHERE id='f-b'").get().ref_count, 1);
  assert.equal(db.prepare("SELECT used_bytes FROM users WHERE id='f-u'").get().used_bytes, 0);
  advance(60000);
  db.exec("DELETE FROM blob_pins");
  assert.equal(deadline(), initial + 70000 + grace);
});
test("last node DELETE extends grace", ({ db, candidate, deadline, apply, advance }) => {
  candidate();
  apply();
  advance(70000);
  db.exec("DELETE FROM nodes WHERE id='f-f'");
  assert.equal(deadline(), initial + 70000 + grace);
});
test("same reference update does not extend grace", ({
  db,
  candidate,
  deadline,
  apply,
  advance,
}) => {
  candidate();
  apply();
  advance(70000);
  db.exec("UPDATE nodes SET current_blob_id=current_blob_id WHERE id='f-f'");
  assert.equal(deadline(), initial + grace);
});
test("failed transaction rolls reference and deadline back together", ({
  db,
  candidate,
  deadline,
  apply,
  advance,
}) => {
  candidate();
  apply();
  advance(70000);
  db.exec("BEGIN; UPDATE nodes SET current_blob_id=NULL WHERE id='f-f'");
  assert.equal(deadline(), initial + 70000 + grace);
  db.exec("ROLLBACK");
  assert.equal(deadline(), initial + grace);
  assert.equal(db.prepare("SELECT ref_count FROM blobs WHERE id='f-b'").get().ref_count, 1);
});
test("reused candidate starts another full grace", ({
  db,
  candidate,
  deadline,
  apply,
  advance,
}) => {
  candidate();
  apply();
  db.exec("UPDATE nodes SET current_blob_id=NULL WHERE id='f-f'");
  advance(grace + 10000);
  db.exec("UPDATE nodes SET current_blob_id='f-b' WHERE id='f-f'");
  db.exec("UPDATE nodes SET current_blob_id=NULL WHERE id='f-f'");
  assert.equal(deadline(), initial + 2 * grace + 10000);
});
test("one second margin covers subsecond detachment", ({
  db,
  candidate,
  deadline,
  apply,
  advance,
}) => {
  candidate();
  apply();
  advance(10999);
  db.exec("UPDATE nodes SET current_blob_id=NULL WHERE id='f-f'");
  assert.equal(deadline(), initial + 10000 + grace);
  assert(deadline() > initial + 10999 + 35 * 86400000);
});
test("last old version deletion starts grace after current node moves away", ({
  db,
  candidate,
  deadline,
  apply,
  advance,
}) => {
  candidate();
  apply();
  db.exec(
    "INSERT INTO node_versions(id,node_id,blob_id,revision,created_at) VALUES('v1','f-f','f-b',1,1),('v2','f-f','f-b',2,2)",
  );
  advance(70000);
  db.exec("UPDATE nodes SET current_blob_id=NULL WHERE id='f-f'");
  assert.equal(deadline(), initial + grace);
  advance(10000);
  db.exec("DELETE FROM node_versions WHERE id='v1'");
  assert.equal(deadline(), initial + grace);
  advance(10000);
  db.exec("DELETE FROM node_versions WHERE id='v2'");
  assert.equal(deadline(), initial + 90000 + grace);
});
test("version removal cannot postpone while current node still references blob", ({
  db,
  candidate,
  deadline,
  apply,
  advance,
}) => {
  candidate();
  apply();
  db.exec(
    "INSERT INTO node_versions(id,node_id,blob_id,revision,created_at) VALUES('v1','f-f','f-b',1,1)",
  );
  advance(70000);
  db.exec("DELETE FROM node_versions WHERE id='v1'");
  assert.equal(deadline(), initial + grace);
});
test("last of multiple node references determines grace", ({
  db,
  candidate,
  deadline,
  apply,
  advance,
}) => {
  candidate();
  apply();
  db.exec(
    "INSERT INTO nodes(id,space_id,owner_id,parent_id,name,name_ci,kind,current_blob_id,created_at,updated_at) VALUES('other','f-s','f-u','f-d','Other','other','file','f-b',1,1)",
  );
  advance(70000);
  db.exec("DELETE FROM nodes WHERE id='f-f'");
  assert.equal(deadline(), initial + grace);
  advance(10000);
  db.exec("DELETE FROM nodes WHERE id='other'");
  assert.equal(deadline(), initial + 80000 + grace);
});
for (const terminal of ["deleting", "deleted"])
  test(
    "migration preserves " + terminal + " terminal pair",
    ({ db, candidate, deadline, apply }) => {
      candidate();
      db.exec("UPDATE nodes SET current_blob_id=NULL WHERE id='f-f'");
      db.prepare("UPDATE blobs SET state=?").run(terminal);
      db.prepare("UPDATE gc_candidates SET state=?,claim_token=?,claim_expires_at=?").run(
        terminal,
        terminal === "deleting" ? "claim" : null,
        terminal === "deleting" ? initial : null,
      );
      const before = db.prepare("SELECT * FROM gc_candidates").all();
      apply();
      assert.deepEqual(db.prepare("SELECT * FROM gc_candidates").all(), before);
      assert.equal(deadline(), 0);
      assert.throws(() => db.exec("UPDATE blobs SET state='committed'"), /blob_unrecoverable/);
    },
  );
test("no candidate is materialized by namespace removal alone", ({ db, deadline, apply }) => {
  apply();
  db.exec("UPDATE nodes SET current_blob_id=NULL WHERE id='f-f'");
  assert.equal(deadline(), undefined);
  assert.equal(db.prepare("SELECT ref_count FROM blobs WHERE id='f-b'").get().ref_count, 0);
});
