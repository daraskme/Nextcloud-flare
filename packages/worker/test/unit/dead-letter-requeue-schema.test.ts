import { readdirSync, readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { URL } from "node:url";
import { afterEach, beforeEach, expect, it } from "vitest";
import { OUTBOX_REQUEUE_ELIGIBLE } from "../../src/jobs/outboxRequeue";
import { foundationFixture } from "../fixtures/foundation";

const dir = new URL("../../migrations/", import.meta.url),
  id = "dlq_" + "a".repeat(64);
let db: DatabaseSync;
beforeEach(() => {
  db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys=ON");
  for (const file of readdirSync(dir)
    .filter((n) => n.endsWith(".sql") && n < "0063_")
    .sort())
    db.exec(readFileSync(new URL(file, dir), "utf8"));
  for (const s of foundationFixture("f", Date.now() - 1000).statements)
    db.prepare(s.sql).run(...(s.values as (string | number | null)[]));
  db.exec(`INSERT INTO permits(permit_id,space_id,epoch,expires_at,state) VALUES('permit','f-s',1,1,'released');
 INSERT INTO operations(op_id,principal_kind,principal_id,credential_id,space_id,kind,state,request_digest,epoch,permit_id,permit_expires_at,claimed_expires_at,expected_steps,created_at,updated_at)
 VALUES('op','user','f-u','as:f-session','f-s','node.create','committed','digest',1,'permit',1,1,0,1,1);
 INSERT INTO outbox(outbox_id,op_id,kind,payload_ref,state,epoch,created_at,updated_at) VALUES('event','op','node.created','f-d','pending',1,1,1);
 INSERT INTO queue_dead_letters VALUES('observation','event',1,2,1);`);
});
afterEach(() => db.close());
const migrate = () => db.exec(readFileSync(new URL("0063_dead_letter_requeue.sql", dir), "utf8"));
const audit = () =>
  db
    .prepare(
      "INSERT INTO activity(id,op_id,actor_id,kind,affected_id,created_at) VALUES(?,'op','f-u','admin.dlq','observation',3)",
    )
    .run(id);
const accept = () =>
  db
    .prepare(
      "UPDATE queue_dead_letters SET requeue_id=?,requeue_actor_id='f-u',requeue_credential_id='as:f-session',requeue_epoch=1,requeued_at=3 WHERE message_id='observation'",
    )
    .run(id);
it("preserves observation rows, keeps the FK graph valid and uses the shared eligibility SQL", () => {
  migrate();
  expect(db.prepare("SELECT * FROM queue_dead_letters").get()).toEqual({
    message_id: "observation",
    outbox_id: "event",
    sent_at: 1,
    received_at: 2,
    epoch: 1,
    requeue_id: null,
    requeue_actor_id: null,
    requeue_credential_id: null,
    requeue_epoch: null,
    requeued_at: null,
  });
  db.exec("UPDATE control SET maintenance=0");
  audit();
  accept();
  expect(db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
  expect(db.prepare(OUTBOX_REQUEUE_ELIGIBLE).get("event", 1)).toBeTruthy();
  const plan = db
    .prepare("EXPLAIN QUERY PLAN SELECT * FROM queue_dead_letters WHERE requeue_id=?")
    .all(id);
  expect(plan.some((r) => String(r.detail).includes("queue_dead_letters_requeue"))).toBe(true);
});
it.each(["admission", "backup", "restore"])("requires quiescence for migration: %s", (phase) => {
  if (phase === "admission") db.exec("UPDATE control SET maintenance=0");
  if (phase === "restore")
    db.exec("UPDATE control SET restore_freeze_token='00000000-0000-4000-8000-000000000000'");
  if (phase === "backup")
    db.exec(
      "INSERT INTO backup_runs(id,epoch,state,created_at,barrier_token,watermark) SELECT 'backup',1,'exporting',1,'00000000-0000-4000-8000-000000000001',backup_last_op FROM control; UPDATE control SET backup_token='00000000-0000-4000-8000-000000000001',backup_barrier_op=backup_last_op,backup_frozen=1",
    );
  expect(migrate).toThrow();
  expect(db.prepare("PRAGMA table_info(queue_dead_letters)").all()).toHaveLength(5);
});
it.each(["receipt", "role", "credential", "epoch", "state", "token", "timestamp"])(
  "refuses a forged requeue %s proof",
  (field) => {
    migrate();
    db.exec("UPDATE control SET maintenance=0");
    if (field !== "receipt") audit();
    if (field === "role") {
      for (const s of foundationFixture("other", Date.now() - 1000).statements)
        db.prepare(s.sql).run(...(s.values as (string | number | null)[]));
      db.exec("UPDATE users SET role='member' WHERE id='f-u'");
    }
    if (field === "credential") db.exec("UPDATE sessions SET revoked_at=1 WHERE id='f-session'");
    if (field === "epoch") db.exec("UPDATE control SET epoch=2");
    if (field === "state") db.exec("UPDATE outbox SET state='completed'");
    if (field === "token") db.exec("UPDATE outbox SET dispatch_token='active'");
    if (field === "timestamp") db.exec("UPDATE activity SET created_at=4");
    expect(accept).toThrow("invalid_dead_letter_requeue");
    expect(db.prepare("SELECT requeue_id FROM queue_dead_letters").get()).toEqual({
      requeue_id: null,
    });
  },
);
it("freezes both the original observation and its accepted audit tuple", () => {
  migrate();
  db.exec("UPDATE control SET maintenance=0");
  audit();
  accept();
  for (const sql of [
    "UPDATE queue_dead_letters SET sent_at=2",
    "UPDATE queue_dead_letters SET requeue_id=NULL",
    "UPDATE queue_dead_letters SET requeue_actor_id=NULL",
    "UPDATE queue_dead_letters SET requeued_at=4",
    "UPDATE activity SET actor_id=NULL",
    "DELETE FROM activity",
  ])
    expect(() => db.exec(sql)).toThrow();
  expect(() =>
    db
      .prepare(
        "INSERT INTO queue_dead_letters(message_id,sent_at,received_at,epoch,requeue_id) VALUES('forged',1,2,1,?)",
      )
      .run(id),
  ).toThrow("invalid_dead_letter_requeue");
});
