import { applyD1Migrations } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import type { MutationRequest, SystemMutationAdmission } from "../../src/db/mutationAdmission";
import { repairMultipartUploads } from "../../src/jobs/multipartCleanup";
import { repairSingleUploads } from "../../src/jobs/uploadCleanup";
import type { SystemMutationSource } from "../../src/services/systemMutation";
import { acquireSystemMutation, mutationEnv } from "../fixtures/mutationAdmission";
import { multipartCleanupFixture, singleCleanupFixture } from "../fixtures/uploadCleanup";
import { injectBatch } from "../fixtures/uploadEnv";

beforeAll(() => applyD1Migrations(env.DB, env.TEST_MIGRATIONS));
beforeEach(async () => {
  await env.DB.prepare("UPDATE control SET maintenance=1").run();
  await env.DB.prepare("UPDATE control SET epoch=1,maintenance=0,gc_paused=0").run();
  await env.DB.prepare("UPDATE uploads SET cleanup_next_at=9999999999999").run();
});
afterEach(() => vi.restoreAllMocks());
const singleStages = ["claim", "call", "observe", "settle", "error"] as const;
const multiStages = [...singleStages, "close"] as const;
type Stage = (typeof multiStages)[number];
type Mode = "single" | "multipart";
const cases = [
  ...singleStages.map((stage) => ({ mode: "single" as const, stage })),
  ...multiStages.map((stage) => ({ mode: "multipart" as const, stage })),
];
type Gate = (request: MutationRequest) => Promise<SystemMutationAdmission>;
const prefix = (stage: Stage) => "system:upload.cleanup-" + stage + ":";

function faults(stage: Stage, mode: "ack" | "rollback" | "reads") {
  const parameters = new WeakMap<object, unknown[]>();
  let fired = false;
  let reads = 0;
  const db = {
    prepare(sql: string) {
      const wrap = (statement: D1PreparedStatement): D1PreparedStatement =>
        new Proxy(statement, {
          get(target, key) {
            if (key === "bind")
              return (...values: unknown[]) => {
                const bound = wrap(target.bind(...values));
                parameters.set(bound, values);
                return bound;
              };
            if (key === "first")
              return (...args: unknown[]) => {
                if (sql.includes("committed_at IS NOT NULL")) {
                  reads++;
                  if (mode === "reads") throw new Error("receipt_unavailable");
                }
                if (
                  fired &&
                  mode === "reads" &&
                  sql.startsWith("SELECT") &&
                  sql.includes("cleanup_token")
                )
                  throw new Error("cleanup_receipt_unavailable");
                return Reflect.apply(target.first, target, args);
              };
            const value = Reflect.get(target, key);
            return typeof value === "function" ? value.bind(target) : value;
          },
        });
      return wrap(env.DB.prepare(sql));
    },
    async batch(statements: D1PreparedStatement[]) {
      const match =
        !fired &&
        statements.some((s) =>
          parameters.get(s)?.some((v) => typeof v === "string" && v.startsWith(prefix(stage))),
        );
      if (match) fired = true;
      const result = await env.DB.batch(
        match && mode === "rollback"
          ? [...statements, env.DB.prepare("INSERT INTO _assert(v) VALUES(1)")]
          : statements,
      );
      if (match) throw new Error("cleanup_ack_lost");
      return result;
    },
  } as unknown as D1Database;
  return { db, reads: () => reads, fired: () => fired };
}
async function fixture(mode: Mode, stage: Stage) {
  const f = mode === "single" ? await singleCleanupFixture() : await multipartCleanupFixture();
  if (stage === "observe")
    await env.BLOBS.put(f.key, "abc", {
      customMetadata: mode === "single" ? { ...f.metadata, attempt_id: "unexpected" } : f.metadata,
    });
  const calls = { head: 0, abort: 0 };
  const bucket = {
    head: async (key: string) => {
      calls.head++;
      if (stage === "error") throw new Error("head_unavailable");
      return env.BLOBS.head(key);
    },
    resumeMultipartUpload: (key: string, id: string) => ({
      abort: async () => {
        calls.abort++;
        return env.BLOBS.resumeMultipartUpload(key, id).abort();
      },
    }),
  } as R2Bucket;
  const configure = (gate: Gate = acquireSystemMutation, db = env.DB): SystemMutationSource => ({
    DB: db,
    systemControl: {
      status: () => mutationEnv().CONTROL.get(env.CONTROL.idFromName("fixture")).status(),
      acquireSystemMutation: gate,
    },
  });
  const run = (source = configure(), epoch = 1, maintenance = false, maxWallMs = 20000) =>
    (mode === "single" ? repairSingleUploads : repairMultipartUploads)(source, bucket, epoch, {
      maintenance,
      maxWallMs,
    });
  const row = () =>
    env.DB.prepare(
      "SELECT state,cleanup_token,cleanup_pending,cleanup_calls,cleanup_error,multipart_cleanup_closed FROM uploads WHERE id=?",
    )
      .bind(f.id)
      .first();
  const counters = () =>
    env.DB.prepare("SELECT reserved_bytes,physical_bytes FROM users WHERE id=?")
      .bind(f.ids.user)
      .first();
  const receipt = () =>
    env.DB.prepare(
      "SELECT state,committed_at,system,maintenance FROM mutation_admissions WHERE space_id=? AND permit_id LIKE ? ORDER BY seq",
    )
      .bind(f.ids.space, prefix(stage) + "%")
      .all()
      .then((r) => r.results);
  return { ...f, calls, configure, run, row, counters, receipt };
}

it.each(cases)(
  "commits $mode $stage with an exact receipt in shared capacity",
  async ({ mode, stage }) => {
    const f = await fixture(mode, stage);
    await f.run();
    expect(await f.receipt()).not.toHaveLength(0);
    for (const r of await f.receipt())
      expect(r).toEqual({
        state: "closed",
        committed_at: expect.any(Number),
        system: 1,
        maintenance: 0,
      });
    expect(await f.counters()).toMatchObject({
      reserved_bytes: stage === "error" || (mode === "single" && stage === "observe") ? 3 : 0,
    });
  },
);

it.each(cases)(
  "retains holds when $mode $stage admission is unavailable",
  async ({ mode, stage }) => {
    const f = await fixture(mode, stage);
    await f.run(
      f.configure(async (r) => {
        if (r.permitId.startsWith(prefix(stage))) throw new Error("queue_full");
        return acquireSystemMutation(r);
      }),
    );
    expect(await f.receipt()).toEqual([]);
    expect(await f.counters()).toMatchObject({ reserved_bytes: 3 });
    if (stage === "claim" || stage === "call") expect(f.calls).toEqual({ head: 0, abort: 0 });
    if (stage !== "claim")
      expect(await f.row()).toMatchObject({
        cleanup_pending: 1,
        cleanup_token: expect.any(String),
      });
  },
);

it.each(cases)(
  "recovers $mode $stage DB-only ACK but never an external call ACK",
  async ({ mode, stage }) => {
    const f = await fixture(mode, stage),
      fault = faults(stage, "ack");
    const result = await f.run(f.configure(undefined, fault.db));
    expect(fault.fired()).toBe(true);
    expect((await f.receipt())[0]).toEqual({
      state: "closed",
      committed_at: expect.any(Number),
      system: 1,
      maintenance: 0,
    });
    if (stage === "call") {
      expect(result).toMatchObject({ retried: 1, r2Calls: 0 });
      expect(f.calls).toEqual({ head: 0, abort: 0 });
      expect(fault.reads()).toBe(0);
      expect(await f.row()).toMatchObject({ cleanup_calls: 1 });
      expect(await f.counters()).toMatchObject({ reserved_bytes: 3 });
    } else {
      expect(fault.reads()).toBeGreaterThan(0);
      expect(await f.counters()).toMatchObject({
        reserved_bytes: stage === "error" || (mode === "single" && stage === "observe") ? 3 : 0,
      });
    }
  },
);

it.each(cases)("rolls back $mode $stage together with its receipt", async ({ mode, stage }) => {
  const f = await fixture(mode, stage),
    fault = faults(stage, "rollback");
  await f.run(f.configure(undefined, fault.db));
  expect(fault.fired()).toBe(true);
  expect((await f.receipt())[0]).toMatchObject({ state: "active", committed_at: null });
  expect(await f.counters()).toMatchObject({ reserved_bytes: 3 });
  if (stage === "claim" || stage === "call") expect(f.calls).toEqual({ head: 0, abort: 0 });
  if (stage === "call") expect(await f.row()).toMatchObject({ cleanup_calls: 0 });
  if (stage === "close") expect(await f.row()).toMatchObject({ multipart_cleanup_closed: null });
});

it.each(["single", "multipart"] as const)(
  "does not dispatch %s after a lost call ACK and unreadable receipt",
  async (mode) => {
    const f = await fixture(mode, "call"),
      fault = faults("call", "reads");
    expect(await f.run(f.configure(undefined, fault.db))).toMatchObject({ retried: 1, r2Calls: 0 });
    expect(fault.reads()).toBe(0);
    expect(f.calls).toEqual({ head: 0, abort: 0 });
    expect(await f.counters()).toMatchObject({ reserved_bytes: 3 });
  },
);

it.each(["single", "multipart"] as const)(
  "keeps %s stopped when all claim readbacks are lost",
  async (mode) => {
    const f = await fixture(mode, "claim"),
      fault = faults("claim", "reads");
    await expect(f.run(f.configure(undefined, fault.db))).rejects.toThrow(
      "cleanup_receipt_unavailable",
    );
    expect(f.calls).toEqual({ head: 0, abort: 0 });
    expect(await f.row()).toMatchObject({ cleanup_pending: 1, cleanup_token: expect.any(String) });
    expect(await f.counters()).toMatchObject({ reserved_bytes: 3 });
  },
);

it.each(["single", "multipart"] as const)(
  "rechecks %s SQL epoch/mode after waiting",
  async (mode) => {
    const f = await fixture(mode, "call");
    await f.run(
      f.configure(async (r) => {
        const a = await acquireSystemMutation(r);
        if (r.permitId.startsWith(prefix("call")))
          await env.DB.prepare("UPDATE control SET epoch=2,maintenance=1,gc_paused=1").run();
        return a;
      }),
    );
    expect(f.calls).toEqual({ head: 0, abort: 0 });
    expect(await f.counters()).toMatchObject({ reserved_bytes: 3 });
    expect(await f.row()).toMatchObject({ cleanup_calls: 0, cleanup_token: expect.any(String) });
  },
);

it.each(["single", "multipart"] as const)(
  "repairs disabled/revoked old-epoch %s under maintenance",
  async (mode) => {
    const f = await fixture(mode, "settle");
    await env.DB.prepare("UPDATE users SET disabled_at=1 WHERE id=?").bind(f.ids.user).run();
    await env.DB.prepare("UPDATE sessions SET revoked_at=1 WHERE id=?").bind(f.ids.session).run();
    await env.DB.prepare("UPDATE control SET epoch=2,maintenance=1,gc_paused=1").run();
    expect(await f.run(undefined, 2, true)).toMatchObject({ absent: 1 });
    expect(await f.counters()).toMatchObject({ reserved_bytes: 0 });
    expect(await f.receipt()).toEqual([
      { state: "closed", committed_at: expect.any(Number), system: 1, maintenance: 1 },
    ]);
  },
);

it.each(["single", "multipart"] as const)(
  "does not dispatch %s when admission consumes the run budget",
  async (mode) => {
    const f = await fixture(mode, "call");
    const now = Date.now();
    const clock = vi.spyOn(Date, "now").mockReturnValue(now);
    await f.run(
      f.configure(async (r) => {
        const a = await acquireSystemMutation(r);
        if (r.permitId.startsWith(prefix("call"))) clock.mockReturnValue(now + 1001);
        return a;
      }),
      1,
      false,
      1000,
    );
    expect(f.calls).toEqual({ head: 0, abort: 0 });
    expect(await f.row()).toMatchObject({ cleanup_calls: 0, cleanup_token: expect.any(String) });
    expect(await f.counters()).toMatchObject({ reserved_bytes: 3 });
  },
);

it.each(["single", "multipart"] as const)(
  "does not dispatch %s after a slow successful budget ACK",
  async (mode) => {
    const f = await fixture(mode, "call");
    const now = Date.now();
    const clock = vi.spyOn(Date, "now").mockReturnValue(now);
    const db = injectBatch(
      (sql) => sql.includes("cleanup_calls=cleanup_calls+1"),
      async () => {
        clock.mockReturnValue(now + 1001);
      },
      true,
    );
    expect(await f.run(f.configure(undefined, db), 1, false, 1000)).toMatchObject({
      retried: 1,
      r2Calls: 0,
    });
    expect(f.calls).toEqual({ head: 0, abort: 0 });
    expect(await f.row()).toMatchObject({ cleanup_calls: 1, cleanup_token: expect.any(String) });
    expect(await f.counters()).toMatchObject({ reserved_bytes: 3 });
    expect(await f.receipt()).toEqual([
      { state: "closed", committed_at: expect.any(Number), system: 1, maintenance: 0 },
    ]);
  },
);
