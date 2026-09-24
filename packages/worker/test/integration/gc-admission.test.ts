import { applyD1Migrations } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import type { MutationRequest, SystemMutationAdmission } from "../../src/db/mutationAdmission";
import type { RestorePause } from "../../src/db/restorePause";
import {
  drainRestoreBlobGarbageCollection,
  drainStoppedBlobGarbageCollection,
  runGarbageCollection,
} from "../../src/jobs/gc";
import type { SystemMutationSource } from "../../src/services/systemMutation";
import { gcFixture } from "../fixtures/gc";
import { acquireSystemMutation, mutationEnv } from "../fixtures/mutationAdmission";
import { injectBatch } from "../fixtures/uploadEnv";

beforeAll(() => applyD1Migrations(env.DB, env.TEST_MIGRATIONS));
beforeEach(async () => {
  await env.DB.prepare("UPDATE control SET maintenance=1").run();
  await env.DB.prepare(
    "UPDATE control SET epoch=1,maintenance=0,gc_paused=0,gc_hold_token=NULL,gc_hold_operation=NULL,gc_hold_expires_at=NULL",
  ).run();
  await env.DB.prepare(
    "UPDATE gc_candidates SET claim_expires_at=9999999999999 WHERE state='deleting'",
  ).run();
  await env.DB.prepare(
    "UPDATE gc_candidates SET not_before=9999999999999 WHERE state='candidate'",
  ).run();
});
afterEach(() => vi.restoreAllMocks());
const modes = ["normal", "stopped", "restore"] as const;
const stages = ["claim", "call", "finalize", "error"] as const;
type Mode = (typeof modes)[number];
type Stage = (typeof stages)[number];
type Gate = (request: MutationRequest) => Promise<SystemMutationAdmission>;
const cases = modes.flatMap((mode) => stages.map((stage) => ({ mode, stage })));
const prefix = (stage: Stage) => "system:gc." + stage + ":";

function faults(stage: Stage, mode: "ack" | "rollback" | "reads", nth = 1) {
  const parameters = new WeakMap<object, unknown[]>();
  let hits = 0,
    fired = false,
    reads = 0;
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
                  sql.includes("claim_token")
                )
                  throw new Error("gc_readback_unavailable");
                return Reflect.apply(target.first, target, args);
              };
            const value = Reflect.get(target, key);
            return typeof value === "function" ? value.bind(target) : value;
          },
        });
      return wrap(env.DB.prepare(sql));
    },
    async batch(statements: D1PreparedStatement[]) {
      const matches = statements.some((s) =>
        parameters.get(s)?.some((v) => typeof v === "string" && v.startsWith(prefix(stage))),
      );
      const hit = matches && ++hits === nth;
      if (hit) fired = true;
      const result = await env.DB.batch(
        hit && mode === "rollback"
          ? [...statements, env.DB.prepare("INSERT INTO _assert(v) VALUES(1)")]
          : statements,
      );
      if (hit) throw new Error("gc_ack_lost");
      return result;
    },
  } as unknown as D1Database;
  return { db, reads: () => reads, fired: () => fired };
}
async function fixture(mode: Mode, stage: Stage) {
  const f = await gcFixture(mode === "normal" ? "candidate" : "deleting");
  const epoch = mode === "stopped" ? 2 : 1;
  const pause: RestorePause = {
    epoch,
    token: crypto.randomUUID(),
    operationId: "op_" + crypto.randomUUID().replaceAll("-", "").repeat(2),
    expiresAt: Date.now() + 300000,
  };
  await env.DB.prepare(
    "UPDATE control SET epoch=?,maintenance=?,gc_paused=?,gc_hold_token=?,gc_hold_operation=?,gc_hold_expires_at=?",
  )
    .bind(
      epoch,
      mode === "stopped" ? 1 : 0,
      mode === "normal" ? 0 : 1,
      mode === "restore" ? pause.token : null,
      mode === "restore" ? pause.operationId : null,
      mode === "restore" ? pause.expiresAt : null,
    )
    .run();
  const calls = { delete: 0, head: 0 };
  const bucket = {
    delete: async (key: string) => {
      calls.delete++;
      if (stage === "error") throw new Error("r2_unavailable");
      await env.BLOBS.delete(key);
    },
    head: async (key: string) => {
      calls.head++;
      return env.BLOBS.head(key);
    },
  } as R2Bucket;
  const configure = (gate: Gate = acquireSystemMutation, db = env.DB): SystemMutationSource => ({
    DB: db,
    systemControl: {
      status: () => mutationEnv().CONTROL.get(env.CONTROL.idFromName("fixture")).status(),
      acquireSystemMutation: gate,
    },
  });
  const run = (source = configure(), maxWallMs = 25000, storage = bucket) =>
    mode === "normal"
      ? runGarbageCollection(source, storage, epoch, { maxBlobs: 1, maxWallMs })
      : mode === "stopped"
        ? drainStoppedBlobGarbageCollection(source, storage, epoch, { maxBlobs: 1, maxWallMs })
        : drainRestoreBlobGarbageCollection(source, storage, pause, { maxBlobs: 1, maxWallMs });
  const row = () =>
    env.DB.prepare(
      "SELECT state,claim_token,claim_expires_at,claim_epoch,r2_calls,last_error FROM gc_candidates WHERE blob_id=?",
    )
      .bind(f.ids.blob)
      .first();
  const physical = () =>
    env.DB.prepare("SELECT physical_bytes FROM users WHERE id=?")
      .bind(f.ids.user)
      .first("physical_bytes");
  const receipt = () =>
    env.DB.prepare(
      "SELECT state,committed_at,system,maintenance FROM mutation_admissions WHERE space_id=? AND permit_id LIKE ? ORDER BY seq",
    )
      .bind(f.ids.space, prefix(stage) + "%")
      .all()
      .then((r) => r.results);
  return { ...f, epoch, pause, calls, bucket, configure, run, row, physical, receipt };
}

it.each(cases)("commits $mode GC $stage with an exact shared receipt", async ({ mode, stage }) => {
  const f = await fixture(mode, stage);
  expect(await f.run()).toMatchObject(stage === "error" ? { retried: 1 } : { deleted: 1 });
  expect(await f.receipt()).not.toHaveLength(0);
  for (const r of await f.receipt())
    expect(r).toEqual({
      state: "closed",
      committed_at: expect.any(Number),
      system: 1,
      maintenance: mode === "stopped" ? 1 : 0,
    });
  expect(await f.physical()).toBe(stage === "error" ? 3 : 0);
});

it.each(cases)(
  "retains $mode physical bytes when $stage admission is unavailable",
  async ({ mode, stage }) => {
    const f = await fixture(mode, stage);
    let attempts = 0;
    await f.run(
      f.configure(async (r) => {
        if (r.permitId.startsWith(prefix(stage))) {
          attempts++;
          throw new Error("queue_full");
        }
        return acquireSystemMutation(r);
      }),
    );
    expect(attempts).toBe(1);
    expect(await f.receipt()).toEqual([]);
    expect(await f.physical()).toBe(3);
    if (stage === "claim" || stage === "call") expect(f.calls).toEqual({ delete: 0, head: 0 });
    if (stage !== "claim")
      expect(await f.row()).toMatchObject({ state: "deleting", claim_token: expect.any(String) });
  },
);

it.each(cases)(
  "recovers $mode $stage DB ACKs without replaying external dispatch",
  async ({ mode, stage }) => {
    const f = await fixture(mode, stage),
      fault = faults(stage, "ack");
    const result = await f.run(f.configure(undefined, fault.db));
    expect(fault.fired()).toBe(true);
    expect((await f.receipt())[0]).toMatchObject({
      state: "closed",
      committed_at: expect.any(Number),
    });
    if (stage === "call") {
      expect(result).toMatchObject({ deleted: 0, retried: 1, r2Calls: 0 });
      expect(f.calls).toEqual({ delete: 0, head: 0 });
      expect(fault.reads()).toBe(0);
      expect(await f.row()).toMatchObject({ r2_calls: 1 });
    } else expect(fault.reads()).toBeGreaterThan(0);
    expect(await f.physical()).toBe(stage === "call" || stage === "error" ? 3 : 0);
  },
);

it.each(cases)(
  "rolls back $mode $stage and retains the uncommitted slot",
  async ({ mode, stage }) => {
    const f = await fixture(mode, stage),
      fault = faults(stage, "rollback");
    await f.run(f.configure(undefined, fault.db));
    expect(fault.fired()).toBe(true);
    expect(await f.receipt()).toEqual([
      { state: "active", committed_at: null, system: 1, maintenance: mode === "stopped" ? 1 : 0 },
    ]);
    expect(await f.physical()).toBe(3);
    if (stage === "claim" || stage === "call") expect(f.calls).toEqual({ delete: 0, head: 0 });
    if (stage === "call") expect(await f.row()).toMatchObject({ r2_calls: 0 });
  },
);

it.each(modes)("never dispatches %s HEAD after a lost second budget ACK", async (mode) => {
  const f = await fixture(mode, "call"),
    fault = faults("call", "reads", 2);
  expect(await f.run(f.configure(undefined, fault.db))).toMatchObject({ retried: 1, r2Calls: 1 });
  expect(f.calls).toEqual({ delete: 1, head: 0 });
  expect(fault.reads()).toBe(0);
  expect(await f.row()).toMatchObject({ r2_calls: 2, state: "deleting" });
  expect(await f.physical()).toBe(3);
});

it.each(modes)(
  "holds %s deletion when claim receipt and token reads are unavailable",
  async (mode) => {
    const f = await fixture(mode, "claim"),
      fault = faults("claim", "reads");
    await expect(f.run(f.configure(undefined, fault.db))).rejects.toThrow(
      "gc_readback_unavailable",
    );
    expect(f.calls).toEqual({ delete: 0, head: 0 });
    expect(await f.row()).toMatchObject({ state: "deleting", claim_token: expect.any(String) });
    expect(await f.physical()).toBe(3);
  },
);

it.each(modes)("rechecks %s GC pause after admission returns", async (mode) => {
  const f = await fixture(mode, "call");
  await f.run(
    f.configure(async (r) => {
      const a = await acquireSystemMutation(r);
      if (r.permitId.startsWith(prefix("call")))
        await env.DB.prepare("UPDATE control SET gc_paused=?")
          .bind(mode === "normal" ? 1 : 0)
          .run();
      return a;
    }),
  );
  expect(f.calls).toEqual({ delete: 0, head: 0 });
  expect(await f.physical()).toBe(3);
  expect(await f.row()).toMatchObject({ r2_calls: 0 });
});

it.each(modes)("rechecks %s materialized pin after admission returns", async (mode) => {
  const f = await fixture(mode, "call");
  await f.run(
    f.configure(async (r) => {
      const a = await acquireSystemMutation(r);
      if (r.permitId.startsWith(prefix("call")))
        await env.DB.prepare("UPDATE gc_candidates SET pinned_by='backup' WHERE blob_id=?")
          .bind(f.ids.blob)
          .run();
      return a;
    }),
  );
  expect(f.calls).toEqual({ delete: 0, head: 0 });
  expect(await f.physical()).toBe(3);
});

it.each(modes)("can finish %s GC after owner/credential disable", async (mode) => {
  const f = await fixture(mode, "finalize");
  await env.DB.prepare("UPDATE users SET disabled_at=1 WHERE id=?").bind(f.ids.user).run();
  await env.DB.prepare("UPDATE sessions SET revoked_at=1 WHERE id=?").bind(f.ids.session).run();
  expect(await f.run()).toMatchObject({ deleted: 1 });
  expect(await f.physical()).toBe(0);
});

it.each(modes)("does not dispatch %s after admission exceeds the run deadline", async (mode) => {
  const f = await fixture(mode, "call"),
    now = Date.now();
  const clock = vi.spyOn(Date, "now").mockReturnValue(now);
  await f.run(
    f.configure(async (r) => {
      const a = await acquireSystemMutation(r);
      if (r.permitId.startsWith(prefix("call"))) clock.mockReturnValue(now + 1001);
      return a;
    }),
    1000,
  );
  expect(f.calls).toEqual({ delete: 0, head: 0 });
  expect(await f.row()).toMatchObject({ r2_calls: 0 });
  expect(await f.physical()).toBe(3);
});

it.each(modes)("does not dispatch %s after a slow successful budget ACK", async (mode) => {
  const f = await fixture(mode, "call"),
    now = Date.now();
  const clock = vi.spyOn(Date, "now").mockReturnValue(now);
  const db = injectBatch(
    (sql) => sql.includes("SET r2_calls=r2_calls+1"),
    async () => {
      clock.mockReturnValue(now + 1001);
    },
    true,
  );
  expect(await f.run(f.configure(undefined, db), 1000)).toMatchObject({ retried: 1, r2Calls: 0 });
  expect(f.calls).toEqual({ delete: 0, head: 0 });
  expect(await f.row()).toMatchObject({ r2_calls: 1 });
  expect(await f.physical()).toBe(3);
});

it("does not use a replaced restore capability after admission waits", async () => {
  const f = await fixture("restore", "call");
  await f.run(
    f.configure(async (r) => {
      const a = await acquireSystemMutation(r);
      if (r.permitId.startsWith(prefix("call")))
        await env.DB.prepare("UPDATE control SET gc_hold_token=?").bind(crypto.randomUUID()).run();
      return a;
    }),
  );
  expect(f.calls).toEqual({ delete: 0, head: 0 });
  expect(await f.physical()).toBe(3);
});

it("rechecks a postponed quarantine after claim admission", async () => {
  const f = await fixture("normal", "claim");
  await f.run(
    f.configure(async (r) => {
      const a = await acquireSystemMutation(r);
      await env.DB.prepare("UPDATE gc_candidates SET not_before=9999999999999 WHERE blob_id=?")
        .bind(f.ids.blob)
        .run();
      return a;
    }),
  );
  expect(f.calls).toEqual({ delete: 0, head: 0 });
  expect(await f.row()).toMatchObject({ state: "candidate" });
  expect(await f.physical()).toBe(3);
});

it("accepts another collector's terminal tuple without returning its own unknown slot", async () => {
  const f = await fixture("normal", "finalize");
  const bucket = {
    ...f.bucket,
    head: async (key: string) => {
      const object = await env.BLOBS.head(key);
      await env.DB.prepare("UPDATE gc_candidates SET claim_expires_at=0 WHERE blob_id=?")
        .bind(f.ids.blob)
        .run();
      expect(await f.run()).toMatchObject({ deleted: 1 });
      return object;
    },
  } as R2Bucket;
  expect(await f.run(undefined, 25000, bucket)).toMatchObject({ deleted: 1, retried: 0 });
  expect(await f.physical()).toBe(0);
  expect(await f.receipt()).toEqual([
    { state: "closed", committed_at: expect.any(Number), system: 1, maintenance: 0 },
    { state: "active", committed_at: null, system: 1, maintenance: 0 },
  ]);
});

it("starts the full claim lease from SQL time after waiting for admission", async () => {
  const f = await fixture("normal", "claim");
  let afterWait = 0;
  await f.run(
    f.configure(async (r) => {
      if (r.permitId.startsWith(prefix("call"))) throw new Error("hold_before_dispatch");
      const a = await acquireSystemMutation(r);
      if (r.permitId.startsWith(prefix("claim"))) {
        await new Promise((resolve) => setTimeout(resolve, 1200));
        afterWait = (await env.DB.prepare("SELECT strftime('%s','now')*1000 AS now").first<number>(
          "now",
        ))!;
      }
      return a;
    }),
  );
  expect(afterWait).toBeGreaterThan(0);
  expect((await f.row())?.claim_expires_at).toBeGreaterThanOrEqual(afterWait + 60000);
  expect(f.calls).toEqual({ delete: 0, head: 0 });
  expect(await f.physical()).toBe(3);
});
