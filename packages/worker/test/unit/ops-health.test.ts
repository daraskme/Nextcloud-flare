import { readdirSync, readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { URL } from "node:url";
import { afterEach, beforeEach, expect, it } from "vitest";
import { CONTROL_NAME } from "../../src/do/controlName";
import type { Env } from "../../src/env";
import {
  inspectOperationsHealth,
  OPERATIONS_HEALTH_RESPONSES,
  OPERATIONS_HEALTH_VERSION,
} from "../../src/ops/health";
import { foundationFixture } from "../fixtures/foundation";

const directory = new URL("../../migrations/", import.meta.url);
const migrations = readdirSync(directory)
  .sort()
  .filter((name) => name.endsWith(".sql"))
  .map((name) => readFileSync(new URL(name, directory), "utf8"));

let db: DatabaseSync, now: number;
let control = { epoch: 1, maintenance: false, gcPaused: false };

beforeEach(() => {
  db = new DatabaseSync(":memory:");
  now = 1_000_000;
  db.function("strftime", { varargs: true }, () => String(Math.floor(now / 1000)));
  for (const sql of migrations) db.exec(sql);
  const f = foundationFixture("oh", now - 1000);
  for (const statement of f.statements)
    db.prepare(statement.sql).run(...((statement.values as (string | number | null)[]) ?? []));
  db.exec("UPDATE control SET epoch=1,maintenance=0,gc_paused=0");
  control = { epoch: 1, maintenance: false, gcPaused: false };
});

afterEach(() => db.close());

function d1(onControlRead?: () => void): D1Database {
  return {
    prepare(sql: string) {
      return {
        bind: (...values: (string | number | null)[]) => ({
          async first(column?: string) {
            if (sql.includes("FROM control WHERE singleton=1")) onControlRead?.();
            const row = db.prepare(sql).get(...values) as Record<string, unknown> | undefined;
            return column && row ? row[column] : (row ?? null);
          },
        }),
        async first(column?: string) {
          if (sql.includes("FROM control WHERE singleton=1")) onControlRead?.();
          const row = db.prepare(sql).get() as Record<string, unknown> | undefined;
          return column && row ? row[column] : (row ?? null);
        },
      };
    },
  } as unknown as D1Database;
}

function env(status = () => control, database = d1()): Env {
  return {
    DB: database,
    CONTROL: {
      idFromName: (name: string) => {
        expect(name).toBe(CONTROL_NAME);
        return "singleton";
      },
      get: () => ({ status: async () => status() }),
    },
    ENVIRONMENT: "development",
  } as unknown as Env;
}

function insertOp(id: string, state: "claimed" | "committed" | "failed", expiresAt = now + 30_000) {
  const permit = `${id}-permit`;
  db.prepare(
    "INSERT INTO permits(permit_id,space_id,epoch,expires_at,state) VALUES(?,'oh-s',1,?,?)",
  ).run(permit, expiresAt, state === "claimed" ? "open" : "released");
  db.prepare(
    `INSERT INTO operations(op_id,principal_kind,principal_id,credential_id,space_id,kind,state,
      request_digest,epoch,permit_id,permit_expires_at,claimed_expires_at,expected_steps,
      operands_json,created_at,updated_at)
     VALUES(?,'user','oh-u','as:oh-session','oh-s','node.create',?,'digest',1,?,?,?,0,'{}',?,?)`,
  ).run(id, state, permit, expiresAt, expiresAt, now - 100, now - 100);
  return id;
}

function insertReservation(id: string, expiresAt: number, state = "reserved") {
  db.prepare(
    "INSERT INTO reservations(id,owner_id,bytes,state,expires_at,epoch) VALUES(?,'oh-u',1,?, ?,1)",
  ).run(id, state, expiresAt);
  return id;
}

function insertBlob(id: string) {
  db.prepare(
    "INSERT INTO blobs(id,owner_id,r2_key,size,content_etag,state,created_at) VALUES(?,'oh-u',?,1,?,'staging',?)",
  ).run(id, `u/oh-u/b/${id}`, `"${id}"`, now - 100);
  return id;
}

function insertUpload(
  id: string,
  values: Partial<{
    mode: "single" | "multipart";
    state: string;
    expiresAt: number;
    cleanupPending: number;
    cleanupNextAt: number;
    writeAttemptId: string | null;
    writeLeaseExpiresAt: number | null;
    multipartCompleteAttempt: string | null;
    multipartCompleteLease: number | null;
  }> = {},
) {
  const mode = values.mode ?? "single";
  const reservation = insertReservation(`${id}-reservation`, values.expiresAt ?? now + 30_000);
  const blob = insertBlob(`${id}-blob`);
  db.prepare(
    `INSERT INTO uploads(id,owner_id,space_id,parent_id,blob_id,credential_id,reservation_id,mode,
      state,declared_size,capability_hash,epoch,created_at,expires_at,last_progress_at,
      cleanup_pending,cleanup_next_at,write_attempt_id,write_lease_expires_at,
      multipart_complete_attempt,multipart_complete_lease,upload_name,r2_upload_id)
     VALUES(?,'oh-u','oh-s','oh-d',?,'as:oh-session',?,?,?,1,'cap',1,?,?,?,?,?,?,?,?,?,?,?)`,
  ).run(
    id,
    blob,
    reservation,
    mode,
    values.state ?? "created",
    now - 100,
    values.expiresAt ?? now + 30_000,
    now - 100,
    values.cleanupPending ?? 0,
    values.cleanupNextAt ?? 0,
    values.writeAttemptId ?? null,
    values.writeLeaseExpiresAt ?? null,
    values.multipartCompleteAttempt ?? null,
    values.multipartCompleteLease ?? null,
    mode === "multipart" ? "upload-name" : null,
    mode === "multipart" ? `${id}-r2-upload` : null,
  );
  return { blob, reservation };
}

it("returns a complete redacted healthy snapshot for a clean fixture", async () => {
  const result = await inspectOperationsHealth(env(), { expectedEpoch: 1 });
  expect(result.version).toBe(OPERATIONS_HEALTH_VERSION);
  expect(result.healthy).toBe(true);
  expect(result.complete).toBe(true);
  expect(result.alerts).toEqual([]);
  const text = JSON.stringify(result);
  expect(text).not.toContain("oh-u");
  expect(text).not.toContain("oh-f");
  expect(text).not.toContain("fixture@example.invalid");
  expect(text).not.toContain("SELECT");
});

it("reports stable sorted allowlisted alerts without leaking row payloads", async () => {
  db.prepare(
    "INSERT INTO mutation_admissions(id,permit_id,space_id,epoch,requested_at,wait_until) VALUES(?,'expired-admission','oh-s',1,?,?)",
  ).run(crypto.randomUUID(), now, now + 5_000);
  now += 5_001;
  insertOp("expired-operation", "claimed", now - 1);
  insertOp("committed-operation", "committed");
  db.prepare(
    "INSERT INTO outbox(outbox_id,op_id,kind,payload_ref,state,epoch,created_at,updated_at) VALUES('failed-outbox','committed-operation','node.created','never disclose payload','failed',1,?,?)",
  ).run(now - 100, now - 100);
  db.prepare(
    `INSERT INTO outbox(outbox_id,op_id,kind,payload_ref,state,epoch,created_at,updated_at,
      claim_token,claim_expires_at)
     VALUES('leased-outbox','committed-operation','node.created','never disclose lease','sent',1,?,?,?,?)`,
  ).run(now - 100, now - 90, "never-disclose-claim", now - 1);
  db.prepare(
    "INSERT INTO outbox_dead_letters(outbox_id,queue_message_id,observed_attempts,first_observed_at,last_observed_at,status,epoch) VALUES('failed-outbox','queue-message-secret',10,?,?,'failed',1)",
  ).run(now - 90, now - 80);
  db.prepare(
    "INSERT INTO bulk_jobs(id,owner_id,credential_id,op_id,kind,state,epoch,grant_snapshot,created_at,updated_at) VALUES('failed-job','oh-u','as:oh-session','expired-operation','node.create','failed',1,'{}',?,?)",
  ).run(now - 100, now - 90);
  db.prepare(
    "INSERT INTO bulk_jobs(id,owner_id,credential_id,op_id,kind,state,epoch,grant_snapshot,created_at,updated_at) VALUES('leased-job','oh-u','as:oh-session','committed-operation','node.create','pending',1,'{}',?,?)",
  ).run(now - 100, now - 90);
  db.prepare(
    "INSERT INTO job_leases(job_id,claim_token,epoch,expires_at,attempt) VALUES('leased-job','never-disclose-job-claim',1,?,1)",
  ).run(now - 1);
  insertReservation("expired-reservation", now - 1);
  insertUpload("cleanup-upload", {
    state: "expired",
    expiresAt: now - 1,
    cleanupPending: 1,
    cleanupNextAt: 0,
  });
  insertUpload("lease-upload", {
    state: "receiving",
    writeAttemptId: "never-disclose-attempt",
    writeLeaseExpiresAt: now - 1,
  });
  insertUpload("multipart-upload", {
    mode: "multipart",
    state: "completing",
    multipartCompleteAttempt: "never-disclose-complete",
    multipartCompleteLease: now - 1,
  });
  db.prepare(
    "INSERT INTO multipart_closure_runs(id,source,epoch,phase,not_before,created_at,updated_at) VALUES('closure','{}',1,'waiting',?,?,?)",
  ).run(now - 1, now - 100, now - 100);
  db.exec("DROP TRIGGER multipart_upload_settlement_insert");
  db.prepare(
    "INSERT INTO multipart_upload_settlements(upload_id,closure_id,owner_id,reservation_id,token,lease_expires_at,state,claimed_at) VALUES('multipart-upload','closure','oh-u','multipart-upload-reservation',?,?, 'claimed',?)",
  ).run(crypto.randomUUID(), now - 1, now - 100);
  const handle = crypto.randomUUID();
  db.prepare(
    "INSERT INTO multipart_bucket_handles(id,source,r2_key,r2_upload_id,initiated_at,state,first_seen_at,last_seen_at,epoch,last_round_id) VALUES(?, '{}', ?, 'upload-secret', ?, 'quarantined', ?, ?, 1, ?)",
  ).run(handle, "u/orphan/b/secret", now - 100, now - 100, now - 100, crypto.randomUUID());
  db.exec("DROP TRIGGER multipart_bucket_abort_insert");
  db.prepare(
    `INSERT INTO multipart_bucket_abort_attempts(
      id,handle_id,ordinal,epoch,proof_generation,scan_round_id,part_round_id,held_bytes,
      started_at,outcome,finished_at,error)
     VALUES(?,?,1,1,1,?,?,0,?,'unconfirmed',?,'abort_unconfirmed')`,
  ).run(crypto.randomUUID(), handle, crypto.randomUUID(), crypto.randomUUID(), now - 90, now - 80);
  db.prepare(
    "INSERT INTO orphan_objects(r2_key,bytes,r2_etag,r2_version,uploaded_at,first_seen_at,last_seen_at,epoch,state,next_check_at) VALUES(?,1,'etag','version',?,?,?,1,'quarantined',0)",
  ).run("u/orphan/b/object", now - 100, now - 100, now - 100);
  db.prepare(
    "UPDATE orphan_objects SET state='deleting',claim_token='never-disclose-orphan-claim',claim_expires_at=? WHERE r2_key='u/orphan/b/object'",
  ).run(now - 1);
  insertBlob("gc-blob");
  db.prepare(
    "INSERT INTO gc_candidates(blob_id,state,not_before) VALUES('gc-blob','candidate',0)",
  ).run();
  insertBlob("gc-claimed-blob");
  db.prepare(
    "INSERT INTO gc_candidates(blob_id,state,not_before,claim_token,claim_expires_at) VALUES('gc-claimed-blob','deleting',0,'never-disclose-gc-claim',?)",
  ).run(now - 1);
  const result = await inspectOperationsHealth(env(), { expectedEpoch: 1 });
  expect(result.healthy).toBe(false);
  expect(result.complete).toBe(true);
  expect(result.alerts.map((a) => a.code)).toEqual([...result.alerts.map((a) => a.code)].sort());
  for (const alert of result.alerts)
    expect(alert.response).toBe(OPERATIONS_HEALTH_RESPONSES[alert.code]);
  expect(result.alerts.map((a) => a.code)).toEqual(
    expect.arrayContaining([
      "mutation_admission_expired",
      "permit_expired",
      "operation_claim_expired",
      "outbox_delivery_failed",
      "outbox_lease_expired",
      "outbox_dead_letter_failed",
      "tree_job_failed",
      "tree_job_lease_expired",
      "reservation_expired",
      "upload_cleanup_due",
      "upload_lease_expired",
      "multipart_closure_due",
      "multipart_settlement_expired",
      "multipart_handle_quarantined",
      "multipart_bucket_abort_unconfirmed",
      "orphan_object_due",
      "orphan_object_expired_claim",
      "gc_candidate_due",
      "gc_claim_expired",
    ]),
  );
  const text = JSON.stringify(result);
  for (const secret of [
    "oh-u",
    "queue-message-secret",
    "never disclose payload",
    "never disclose lease",
    "never-disclose-claim",
    "never-disclose-job-claim",
    "never-disclose-attempt",
    "never-disclose-complete",
    "u/orphan/b/object",
    "u/orphan/b/secret",
    "never-disclose-orphan-claim",
    "never-disclose-gc-claim",
  ])
    expect(text).not.toContain(secret);
});

it("treats authority transitions as incomplete instead of healthy", async () => {
  let calls = 0;
  const result = await inspectOperationsHealth(
    env(() => (++calls === 1 ? control : { ...control, epoch: 2 })),
    { expectedEpoch: 1 },
  );
  expect(result.complete).toBe(false);
  expect(result.healthy).toBe(false);
  expect(result.alerts.map((a) => a.code)).toContain("control_epoch_mismatch");
});

it("detects D1 maintenance and GC-pause changes during inspection", async () => {
  let reads = 0;
  const database = d1(() => {
    if (++reads === 2) db.exec("UPDATE control SET maintenance=1,gc_paused=1");
  });
  const result = await inspectOperationsHealth(
    env(() => control, database),
    { expectedEpoch: 1 },
  );
  expect(result.complete).toBe(false);
  expect(result.healthy).toBe(false);
  expect(result.alerts.map((a) => a.code)).toEqual(
    expect.arrayContaining([
      "control_gc_pause_mismatch",
      "control_maintenance_mismatch",
      "control_mirror_mismatch",
    ]),
  );
});

it("treats lease expiry as due exactly at the boundary", async () => {
  const admission = crypto.randomUUID();
  const permit = crypto.randomUUID();
  db.prepare(
    "INSERT INTO mutation_admissions(id,permit_id,space_id,epoch,requested_at,wait_until) VALUES(?,?,'oh-s',1,?,?)",
  ).run(admission, permit, now, now + 5_000);
  db.prepare(
    "UPDATE mutation_admissions SET state='active',granted_at=?,expires_at=? WHERE id=?",
  ).run(now, now + 30_000, admission);
  db.prepare(
    "INSERT INTO permits(permit_id,space_id,epoch,expires_at,state) VALUES(?,'oh-s',1,?,'open')",
  ).run(permit, now + 30_000);
  expect((await inspectOperationsHealth(env(), { expectedEpoch: 1 })).healthy).toBe(true);
  now += 30_000;
  const result = await inspectOperationsHealth(env(), { expectedEpoch: 1 });
  expect(result.healthy).toBe(false);
  expect(result.alerts.map((a) => a.code)).toContain("permit_expired");
});

it("marks a bounded domain incomplete without exposing rows", async () => {
  insertOp("bounded-operation", "committed");
  const statement = db.prepare(
    "INSERT INTO bulk_jobs(id,owner_id,credential_id,op_id,kind,state,epoch,grant_snapshot,created_at,updated_at) VALUES(?,'oh-u','as:oh-session','bounded-operation','node.create','failed',1,'{}',?,?)",
  );
  for (let index = 0; index <= 256; index++)
    statement.run(`bounded-job-${index}`, now - 300, now - index);
  const result = await inspectOperationsHealth(env(), { expectedEpoch: 1 });
  expect(result.complete).toBe(false);
  expect(result.healthy).toBe(false);
  expect(result.domains.operations.failedTreeJobs).toEqual({
    count: 256,
    oldestAt: now - 256,
    truncated: true,
  });
  expect(result.alerts.map((alert) => alert.code)).toContain("health_scan_bounded");
  expect(JSON.stringify(result)).not.toContain("bounded-job-");
});

it("uses the health indexes for bounded predicates", () => {
  for (const [sql, index] of [
    [
      "EXPLAIN QUERY PLAN SELECT MAX(wait_until,COALESCE(committed_at+60000,0)) FROM mutation_admissions INDEXED BY mutation_admissions_health_waiting WHERE state='waiting' AND MAX(wait_until,COALESCE(committed_at+60000,0))<=? ORDER BY MAX(wait_until,COALESCE(committed_at+60000,0)) LIMIT 257",
      "mutation_admissions_health_waiting",
    ],
    [
      "EXPLAIN QUERY PLAN SELECT claimed_expires_at FROM operations INDEXED BY operations_health_claimed WHERE state='claimed' AND claimed_expires_at<=? ORDER BY claimed_expires_at LIMIT 257",
      "operations_health_claimed",
    ],
    [
      "EXPLAIN QUERY PLAN SELECT expires_at FROM reservations INDEXED BY reservations_health_expiry WHERE state='reserved' AND expires_at<=? ORDER BY expires_at LIMIT 257",
      "reservations_health_expiry",
    ],
    [
      "EXPLAIN QUERY PLAN SELECT last_observed_at FROM outbox_dead_letters INDEXED BY outbox_dead_letters_health WHERE status='failed' ORDER BY last_observed_at LIMIT 257",
      "outbox_dead_letters_health",
    ],
    [
      "EXPLAIN QUERY PLAN SELECT expires_at FROM job_leases INDEXED BY job_leases_health_expiry WHERE expires_at<=? ORDER BY expires_at LIMIT 257",
      "job_leases_health_expiry",
    ],
  ] as const) {
    expect(
      JSON.stringify(sql.includes("?") ? db.prepare(sql).all(now) : db.prepare(sql).all()),
    ).toContain(index);
  }
});
