import { applyD1Migrations } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterEach, beforeAll, beforeEach, expect, it } from "vitest";
import type { MutationRequest } from "../../src/db/mutationAdmission";
import { acquireMutation, acquireSystemMutation } from "../fixtures/mutationAdmission";
import { type JournalStage, journalFixture, journalStages } from "../fixtures/uploadJournal";
import { cleanupTransferObjects } from "../fixtures/uploadTransfer";

beforeAll(() => applyD1Migrations(env.DB, env.TEST_MIGRATIONS));
beforeEach(async () => {
  await env.DB.prepare("UPDATE control SET maintenance=1").run();
  await env.DB.prepare("UPDATE control SET epoch=1,maintenance=0").run();
});
afterEach(cleanupTransferObjects);
const match = (stage: JournalStage, sql: string) =>
  sql.includes(
    {
      init: "SET multipart_ledger_id=?",
      part: "INSERT INTO upload_parts",
      stop: "UPDATE uploads SET state=?,accept_parts=?",
      lost: "error_code='upload_ledger_lost'",
    }[stage],
  );
function faultDatabase(stage: JournalStage, mode: "ack" | "rollback" | "all_reads") {
  const queries = new WeakMap<object, string>();
  let reads = 0;
  const db = {
    prepare(sql: string) {
      const wrap = (statement: D1PreparedStatement): D1PreparedStatement => {
        const proxy = new Proxy(statement, {
          get(target, field) {
            if (field === "bind") return (...values: unknown[]) => wrap(target.bind(...values));
            if (field === "first")
              return async (...args: unknown[]) => {
                if (sql.includes("committed_at IS NOT NULL")) {
                  reads++;
                  if (mode === "all_reads") throw new Error("receipt_read_lost");
                }
                return Reflect.apply(target.first, target, args);
              };
            const value = Reflect.get(target, field);
            return typeof value === "function" ? value.bind(target) : value;
          },
        });
        queries.set(proxy, sql);
        return proxy;
      };
      return wrap(env.DB.prepare(sql));
    },
    async batch(statements: D1PreparedStatement[]) {
      const matches = statements.some((s) => match(stage, queries.get(s) ?? ""));
      const result = await env.DB.batch(
        matches && mode === "rollback"
          ? [...statements, env.DB.prepare("INSERT INTO _assert(v) VALUES(1)")]
          : statements,
      );
      if (matches && mode !== "rollback") throw new Error("journal_ack_lost");
      return result;
    },
  } as unknown as D1Database;
  return { db, reads: () => reads };
}
const system = (stage: JournalStage) => stage === "lost" || stage === "stop";
it.each(journalStages)(
  "commits %s through the shared pool and retains reservation",
  async (stage) => {
    const f = await journalFixture(stage),
      result = await f.run();
    expect("error" in result).toBe(stage === "lost");
    const receipts = await f.receipt();
    expect(receipts.length).toBeGreaterThan(0);
    for (const receipt of receipts)
      expect(receipt).toEqual({
        state: "closed",
        committed_at: expect.any(Number),
        system: system(stage) ? 1 : 0,
        maintenance: 0,
      });
    expect(await f.counters()).toMatchObject({ reserved_bytes: 3, physical_bytes: 0 });
    expect(f.parts()).toBe(stage === "part" ? 1 : 0);
    if (stage === "lost") expect(await f.row()).toMatchObject({ state: "failed", data_calls: 1 });
  },
);
it.each(journalStages)(
  "overload at %s leaves durable unknown state without external part dispatch",
  async (stage) => {
    const f = await journalFixture(stage),
      target = f.atGate();
    const reject = async (r: MutationRequest) => {
      if (target(r)) throw new Error("capacity_full");
    };
    const result = await f.run(
      f.configure({
        acquire: async (r) => {
          await reject(r);
          return acquireMutation(r);
        },
        systemAcquire: async (r) => {
          await reject(r);
          return acquireSystemMutation(r);
        },
      }),
    );
    expect(result).toHaveProperty("error");
    expect(f.parts()).toBe(0);
    expect(await f.counters()).toMatchObject({ reserved_bytes: 3, physical_bytes: 0 });
    expect((await f.receipt()).every((r) => r.state === "closed")).toBe(true);
    if (stage === "init") {
      expect(await f.row()).toMatchObject({ multipart_ledger_id: null });
      expect(await f.run()).not.toHaveProperty("error");
      expect(f.calls.create).toBe(1);
    }
    if (stage === "part") {
      expect((await f.journal()).dirty).toHaveLength(1);
      expect(await f.row()).toMatchObject({ data_calls: 0 });
      expect(await f.run()).toMatchObject({ value: { disposition: "in_flight" } });
      expect(f.parts()).toBe(0);
      expect(await f.row()).toMatchObject({ data_calls: 1 });
    }
    if (stage === "stop") {
      expect((await f.journal()).alarm).toEqual(expect.any(Number));
      expect(await f.run()).not.toHaveProperty("error");
    }
    if (stage === "lost") expect((await f.journal()).binding).toEqual([]);
  },
);
it.each(journalStages)(
  "lost ACK at %s never recovers permission to initialize or dispatch a part",
  async (stage) => {
    const f = await journalFixture(stage),
      fault = faultDatabase(stage, "ack");
    const result = await f.run(f.configure({ db: fault.db }));
    expect(result).toHaveProperty("error");
    expect(f.parts()).toBe(0);
    expect(fault.reads()).toBe(stage === "lost" ? 1 : 0);
    expect((await f.receipt()).at(-1)).toEqual({
      state: "closed",
      committed_at: expect.any(Number),
      system: system(stage) ? 1 : 0,
      maintenance: 0,
    });
    expect(await f.counters()).toMatchObject({ reserved_bytes: 3, physical_bytes: 0 });
    if (stage === "init") {
      expect((await f.journal()).binding).toEqual([]);
      expect(await f.run()).toMatchObject({
        error: { message: "upload_ledger_recovery_required" },
      });
      expect(f.calls.create).toBe(1);
      expect((await f.journal()).binding).toEqual([]);
    }
    if (stage === "part") {
      expect((await f.journal()).dirty).toHaveLength(1);
      expect(await f.run()).toMatchObject({ value: { disposition: "in_flight" } });
      expect(f.parts()).toBe(0);
      expect(await f.row()).toMatchObject({ data_calls: 1, data_bytes: 3 });
    }
    if (stage === "stop") expect(await f.run()).not.toHaveProperty("error");
    if (stage === "lost")
      expect(result).toMatchObject({ error: { message: "upload_ledger_recovery_required" } });
  },
);
it.each(journalStages)(
  "rollback at %s does not forge a receipt or clear pending journal work",
  async (stage) => {
    const f = await journalFixture(stage),
      fault = faultDatabase(stage, "rollback");
    expect(await f.run(f.configure({ db: fault.db }))).toHaveProperty("error");
    expect((await f.receipt()).at(-1)).toEqual({
      state: "active",
      committed_at: null,
      system: system(stage) ? 1 : 0,
      maintenance: 0,
    });
    expect(f.parts()).toBe(0);
    expect(await f.counters()).toMatchObject({ reserved_bytes: 3 });
    if (stage === "init") expect(await f.row()).toMatchObject({ multipart_ledger_id: null });
    if (stage === "part") expect((await f.journal()).dirty).toHaveLength(1);
    if (stage === "lost")
      expect(await f.row()).toMatchObject({ state: "uploading", data_calls: 1 });
  },
);
it.each(["init", "part"] as const)(
  "lost receipt reads cannot authorize %s after a lost direct ACK",
  async (stage) => {
    const f = await journalFixture(stage),
      fault = faultDatabase(stage, "all_reads");
    expect(await f.run(f.configure({ db: fault.db }))).toHaveProperty("error");
    expect(fault.reads()).toBe(0);
    expect(f.parts()).toBe(0);
    expect((await f.receipt()).at(-1)).toMatchObject({
      state: "closed",
      committed_at: expect.any(Number),
    });
  },
);
it.each(
  ["init", "part"].flatMap((stage) =>
    ["credential", "disabled", "maintenance", "epoch"].map((boundary) => ({
      stage: stage as "init" | "part",
      boundary,
    })),
  ),
)("rechecks $boundary after $stage acquires capacity", async ({ stage, boundary }) => {
  const f = await journalFixture(stage),
    target = f.atGate();
  const result = await f.run(
    f.configure({
      acquire: async (r) => {
        const grant = await acquireMutation(r);
        if (target(r)) {
          if (boundary === "credential")
            await env.DB.prepare("UPDATE sessions SET revoked_at=? WHERE id=?")
              .bind(Date.now(), f.f.ids.session)
              .run();
          if (boundary === "disabled")
            await env.DB.prepare("UPDATE users SET disabled_at=? WHERE id=?")
              .bind(Date.now(), f.f.ids.user)
              .run();
          if (boundary === "maintenance")
            await env.DB.prepare("UPDATE control SET maintenance=1").run();
          if (boundary === "epoch") await env.DB.prepare("UPDATE control SET epoch=2").run();
        }
        return grant;
      },
    }),
  );
  expect(result).toHaveProperty("error");
  expect(f.parts()).toBe(0);
  expect((await f.receipt()).at(-1)).toMatchObject({ committed_at: null });
  expect(await f.counters()).toMatchObject({ reserved_bytes: 3 });
});
it.each([1, 2])(
  "alarm records a restrictive journal after disable/revocation/maintenance at current epoch %s",
  async (epoch) => {
    const f = await journalFixture("stop");
    await env.DB.prepare("UPDATE users SET disabled_at=1 WHERE id=?").bind(f.f.ids.user).run();
    await env.DB.prepare("UPDATE sessions SET revoked_at=1 WHERE id=?").bind(f.f.ids.session).run();
    await env.DB.prepare("UPDATE control SET epoch=?,maintenance=1").bind(epoch).run();
    const result = await f.run();
    if ("error" in result) throw result.error;
    expect((await f.receipt()).at(-1)).toEqual({
      state: "closed",
      committed_at: expect.any(Number),
      system: 1,
      maintenance: 1,
    });
    expect(await f.row()).toMatchObject({ cleanup_pending: 1 });
    expect(await f.counters()).toMatchObject({ reserved_bytes: 3, physical_bytes: 0 });
    expect(f.parts()).toBe(0);
  },
);
it("lost stop-receipt read keeps the stopped upload and never rebuilds the journal", async () => {
  const f = await journalFixture("lost"),
    fault = faultDatabase("lost", "all_reads");
  expect(await f.run(f.configure({ db: fault.db }))).toHaveProperty("error");
  expect(fault.reads()).toBe(1);
  expect(await f.row()).toMatchObject({ state: "failed", data_calls: 1 });
  expect((await f.journal()).binding).toEqual([]);
  expect(await f.counters()).toMatchObject({ reserved_bytes: 3 });
});
