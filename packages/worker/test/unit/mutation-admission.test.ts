import { readdirSync, readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { URL } from "node:url";
import { afterEach, beforeEach, expect, it } from "vitest";
import {
  advanceMutations,
  commitMutationAdmission,
  type MutationAdmission,
} from "../../src/db/mutationAdmission";
import { foundationFixture } from "../fixtures/foundation";

const directory = new URL("../../migrations/", import.meta.url);
const migrationNames = readdirSync(directory)
  .sort()
  .filter((name) => name.endsWith(".sql"));
const migrations = migrationNames.map((name) => readFileSync(new URL(name, directory), "utf8"));
const creationIndex = migrationNames.indexOf("0030_mutation_admission.sql");
let db: DatabaseSync, now: number;
beforeEach(() => {
  db = new DatabaseSync(":memory:");
  now = 1_000_000;
  db.function("strftime", { varargs: true }, () => String(Math.floor(now / 1000)));
  for (const sql of migrations) db.exec(sql);
  for (const statement of foundationFixture().statements)
    db.prepare(statement.sql).run(...((statement.values as (string | number | null)[]) ?? []));
  db.exec("UPDATE control SET maintenance=0");
});
afterEach(() => db.close());
function ticket(permit = crypto.randomUUID()) {
  const id = crypto.randomUUID();
  db.prepare(
    "INSERT INTO mutation_admissions(id,permit_id,space_id,epoch,requested_at,wait_until) VALUES(?,?,'f-s',1,?,?)",
  ).run(id, permit, now, now + 5000);
  db.prepare(
    "UPDATE mutation_admissions SET state='active',granted_at=?,expires_at=? WHERE id=?",
  ).run(now, now + 30000, id);
  return { id, permit };
}
function close(id: string) {
  db.prepare("UPDATE mutation_admissions SET state='closed' WHERE id=?").run(id);
}
function insertPermit(permit: string) {
  db.prepare("INSERT INTO permits VALUES(?,'f-s',1,?,'open')").run(permit, now + 30000);
}

// Execute the production cleanup transaction against SQLite's controllable clock.
function clockDatabase(): D1Database {
  return {
    prepare(sql: string) {
      return { bind: (...values: (string | number | null)[]) => ({ sql, values }) };
    },
    async batch(statements: { sql: string; values: (string | number | null)[] }[]) {
      db.exec("BEGIN");
      try {
        const result = statements.map(({ sql, values }) => ({
          results: db.prepare(sql).all(...values),
        }));
        db.exec("COMMIT");
        return result;
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    },
  } as unknown as D1Database;
}

it("does not reuse expired slots until their old grants are irreversibly closed", () => {
  const tickets = Array.from({ length: 32 }, () => ticket());
  now += 31000;
  expect(() => ticket()).toThrow("mutation_unavailable");
  close(tickets[0]!.id);
  const replacement = ticket();
  now -= 31000;
  expect(() => ticket()).toThrow("mutation_unavailable");
  expect(() =>
    db.prepare("UPDATE mutation_admissions SET state='active' WHERE id=?").run(tickets[0]!.id),
  ).toThrow(/immutable_mutation_admission|mutation_unavailable/);
  expect(
    db.prepare("SELECT COUNT(*) AS n FROM mutation_admissions WHERE state='active'").get()!.n,
  ).toBe(32);
  expect(
    db.prepare("SELECT state FROM mutation_admissions WHERE id=?").get(replacement.id)!.state,
  ).toBe("active");
});

it("closing capacity revokes the permit and fails only claimed operations, preserving terminal results and physical accounting", async () => {
  const a = ticket();
  insertPermit(a.permit);
  for (const state of ["claimed", "committed", "failed"])
    db.prepare(`INSERT INTO operations(op_id,principal_kind,principal_id,credential_id,space_id,kind,state,request_digest,epoch,
    permit_id,permit_expires_at,claimed_expires_at,expected_steps,created_at,updated_at)
    VALUES(?,'user','f-u','as:f-session','f-s','node.create',?,'digest',1,?,?,?,0,?,?)`).run(
      state,
      state,
      a.permit,
      now + 30000,
      now + 30000,
      now,
      now,
    );
  const counters = db.prepare("SELECT used_bytes,reserved_bytes,physical_bytes FROM users").get();
  now += 31000;
  expect(await advanceMutations(clockDatabase())).toEqual([]);
  expect(db.prepare("SELECT state FROM permits").get()!.state).toBe("revoked");
  expect(db.prepare("SELECT op_id,state FROM operations ORDER BY op_id").all()).toEqual([
    { op_id: "claimed", state: "failed" },
    { op_id: "committed", state: "committed" },
    { op_id: "failed", state: "failed" },
  ]);
  expect(db.prepare("SELECT used_bytes,reserved_bytes,physical_bytes FROM users").get()).toEqual(
    counters,
  );
  now -= 31000;
  expect(() => insertPermit(a.permit)).toThrow();
  expect(() => db.exec("UPDATE permits SET state='open'")).toThrow();
});

it("retains closed receipts until the original wait deadline and rejects extended or overdue grants", () => {
  const a = ticket();
  insertPermit(a.permit);
  close(a.id);
  expect(() => db.prepare("DELETE FROM mutation_admissions WHERE id=?").run(a.id)).toThrow(
    "mutation_receipt_required",
  );
  expect(() =>
    db.prepare("INSERT INTO permits VALUES(?,'f-s',1,?,'open')").run("b", now + 60000),
  ).toThrow("mutation_admission_required");
  const id = crypto.randomUUID();
  db.prepare(
    "INSERT INTO mutation_admissions(id,permit_id,space_id,epoch,requested_at,wait_until) VALUES(?,'new','f-s',1,?,?)",
  ).run(id, now, now + 5000);
  now += 5000;
  db.prepare("DELETE FROM mutation_admissions WHERE id=?").run(a.id);
  expect(db.prepare("SELECT state FROM permits WHERE permit_id=?").get(a.permit)!.state).toBe(
    "revoked",
  );
  expect(() => insertPermit(a.permit)).toThrow();
  expect(() =>
    db
      .prepare("UPDATE mutation_admissions SET state='active',granted_at=?,expires_at=? WHERE id=?")
      .run(now, now + 30000, id),
  ).toThrow("mutation_unavailable");
});

it("requires closed and drained admission when upgrading an existing database", () => {
  const legacy = new DatabaseSync(":memory:");
  try {
    for (const sql of migrations.slice(0, creationIndex)) legacy.exec(sql);
    legacy.exec("UPDATE control SET maintenance=0");
    expect(() => legacy.exec(migrations[creationIndex]!)).toThrow();
    expect(
      legacy.prepare("SELECT name FROM sqlite_master WHERE name='mutation_admissions'").get(),
    ).toBeUndefined();
    legacy.exec("UPDATE control SET maintenance=1");
    legacy.exec(migrations[creationIndex]!);
    expect(
      legacy.prepare("SELECT name FROM sqlite_master WHERE name='mutation_admissions'").get(),
    ).toBeDefined();
  } finally {
    legacy.close();
  }
});

function commitTicket(a: ReturnType<typeof ticket>) {
  const admission: MutationAdmission = {
    id: a.id,
    permit_id: a.permit,
    space_id: "f-s",
    epoch: 1,
    expires_at: now + 30000,
  };
  for (const s of commitMutationAdmission(admission))
    db.prepare(s.sql).run(...((s.values as (string | number | null)[]) ?? []));
}

it("upgrades drained existing tickets without turning a stop into a commit receipt", () => {
  const legacy = new DatabaseSync(":memory:");
  const receiptIndex = migrationNames.indexOf("0031_mutation_commit_receipts.sql");
  try {
    legacy.function("strftime", { varargs: true }, () => String(Math.floor(now / 1000)));
    for (const sql of migrations.slice(0, receiptIndex)) legacy.exec(sql);
    for (const s of foundationFixture().statements)
      legacy.prepare(s.sql).run(...((s.values as (string | number | null)[]) ?? []));
    legacy.exec("UPDATE control SET maintenance=0");
    legacy
      .prepare(
        "INSERT INTO mutation_admissions(id,permit_id,space_id,epoch,requested_at,wait_until) VALUES(?,'old','f-s',1,?,?)",
      )
      .run(crypto.randomUUID(), now, now + 5000);
    legacy
      .prepare("UPDATE mutation_admissions SET state='active',granted_at=?,expires_at=?")
      .run(now, now + 30000);
    expect(() => legacy.exec(migrations[receiptIndex]!)).toThrow();
    expect(
      legacy
        .prepare("PRAGMA table_info(mutation_admissions)")
        .all()
        .some((row) => row.name === "committed_at"),
    ).toBe(false);
    legacy.exec("UPDATE control SET maintenance=1");
    legacy.exec(migrations[receiptIndex]!);
    expect(legacy.prepare("SELECT state,committed_at FROM mutation_admissions").get()).toEqual({
      state: "closed",
      committed_at: null,
    });
  } finally {
    legacy.close();
  }
});

it("retains committed receipts for 60 seconds through cleanup and clock rollback", async () => {
  const a = ticket();
  commitTicket(a);
  now += 59000;
  await advanceMutations(clockDatabase());
  expect(
    db.prepare("SELECT committed_at FROM mutation_admissions WHERE id=?").get(a.id)!.committed_at,
  ).toBe(1000000);
  expect(() => db.prepare("DELETE FROM mutation_admissions WHERE id=?").run(a.id)).toThrow(
    "mutation_receipt_required",
  );
  now -= 60000;
  await advanceMutations(clockDatabase());
  expect(db.prepare("SELECT id FROM mutation_admissions WHERE id=?").get(a.id)).toBeDefined();
  now = 1060000;
  await advanceMutations(clockDatabase());
  expect(db.prepare("SELECT id FROM mutation_admissions WHERE id=?").get(a.id)).toBeUndefined();
});

it("cannot forge commit proof from a stopped or expired ticket, mutate proof, or close a namespace permit as a commit", () => {
  const stopped = ticket();
  close(stopped.id);
  expect(() =>
    db.prepare("UPDATE mutation_admissions SET committed_at=? WHERE id=?").run(now, stopped.id),
  ).toThrow();
  const expired = ticket();
  now += 30000;
  expect(() =>
    db
      .prepare("UPDATE mutation_admissions SET state='closed',committed_at=? WHERE id=?")
      .run(now, expired.id),
  ).toThrow();
  const bound = ticket();
  insertPermit(bound.permit);
  expect(() => commitTicket(bound)).toThrow();
  const committed = ticket();
  commitTicket(committed);
  expect(() =>
    db.prepare("UPDATE mutation_admissions SET committed_at=NULL WHERE id=?").run(committed.id),
  ).toThrow();
  expect(() =>
    db
      .prepare("UPDATE mutation_admissions SET committed_at=committed_at+1 WHERE id=?")
      .run(committed.id),
  ).toThrow();
});

it("uses the retention expression index to bound cleanup without scanning recent commit history", () => {
  const plan = db
    .prepare(
      "EXPLAIN QUERY PLAN SELECT seq FROM mutation_admissions WHERE state='closed' AND MAX(wait_until,COALESCE(committed_at+60000,0))<=? ORDER BY MAX(wait_until,COALESCE(committed_at+60000,0)),seq LIMIT 256",
    )
    .all(now);
  expect(JSON.stringify(plan)).toContain("mutation_admissions_cleanup");
  expect(JSON.stringify(plan)).not.toContain("TEMP B-TREE");
});
