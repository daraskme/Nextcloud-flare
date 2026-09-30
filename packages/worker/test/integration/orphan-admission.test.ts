import { applyD1Migrations } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import type { GlobalMutationAdmission, MutationRequest } from "../../src/db/mutationAdmission";
import {
  collectOrphanObjects,
  drainStoppedOrphanGarbageCollection,
  scanOrphanObjects,
} from "../../src/jobs/orphanInventory";
import type { GlobalMutationSource } from "../../src/services/globalMutation";
import { acquireGlobalMutation, mutationEnv } from "../fixtures/mutationAdmission";
import { orphanBucket, orphanFixture, trackOrphan } from "../fixtures/orphanInventory";
import { systemMutationFault } from "../fixtures/systemMutationFault";
import { injectBatch } from "../fixtures/uploadEnv";

beforeAll(() => applyD1Migrations(env.DB, env.TEST_MIGRATIONS));
beforeEach(async () => {
  await env.DB.prepare("UPDATE control SET maintenance=1").run();
  await env.DB.prepare("UPDATE control SET epoch=1,maintenance=0,gc_paused=0").run();
  await env.DB.prepare(
    "UPDATE r2_inventory_scan SET epoch=1,cursor='',lease_token=NULL,lease_expires_at=NULL,next_scan_at=0,last_token=NULL,pages=0",
  ).run();
  await env.DB.prepare("UPDATE orphan_objects SET next_check_at=9999999999999").run();
});
afterEach(() => vi.restoreAllMocks());
const stages = [
  "scan-claim",
  "scan-list",
  "scan-head",
  "scan-observe",
  "scan-page",
  "scan-release",
  "gc-claim",
  "gc-head",
  "gc-delete",
  "gc-confirm",
  "gc-observe",
  "gc-finalize",
  "gc-error",
] as const;
type Stage = (typeof stages)[number];
type Gate = (r: Omit<MutationRequest, "spaceId">) => Promise<GlobalMutationAdmission>;
const kind = (stage: Stage) =>
  stage === "scan-list" || stage === "scan-head"
    ? "scan-call"
    : stage === "gc-head" || stage === "gc-delete" || stage === "gc-confirm"
      ? "gc-call"
      : stage;
const prefix = (stage: Stage) => "global:orphan." + kind(stage) + ":";
const nth = (stage: Stage) =>
  stage === "scan-head" || stage === "gc-delete" ? 2 : stage === "gc-confirm" ? 3 : 1;
const external = (stage: Stage) => kind(stage).endsWith("-call");
const noDispatch = (stage: Stage) =>
  stage === "scan-claim" || stage === "scan-list" || stage === "gc-claim" || stage === "gc-head";

async function fixture(stage: Stage, stopped = false) {
  const f = await orphanFixture();
  const scan = stage.startsWith("scan-");
  if (!scan) await trackOrphan(f);
  if (stage === "gc-observe") await env.BLOBS.put(f.key, "newer");
  if (stopped) {
    await env.DB.prepare("UPDATE control SET maintenance=1,gc_paused=1").run();
    if (!scan)
      await env.DB.prepare("UPDATE orphan_objects SET state='deleting' WHERE r2_key=?")
        .bind(f.key)
        .run();
  }
  const calls = { list: 0, head: 0, delete: 0 };
  const bucket = orphanBucket({
    list: async (options) => {
      calls.list++;
      return f.bucket.list(options);
    },
    head: async (key) => {
      calls.head++;
      if (stage === "scan-release" || stage === "gc-error") throw new Error("head_failed");
      return env.BLOBS.head(key);
    },
    delete: async (key) => {
      calls.delete++;
      await env.BLOBS.delete(key);
    },
  });
  let permit = "";
  const configure = (gate: Gate = acquireGlobalMutation, db = env.DB): GlobalMutationSource => {
    let hits = 0;
    return {
      DB: db,
      systemControl: {
        status: () => mutationEnv().CONTROL.get(env.CONTROL.idFromName("fixture")).status(),
        acquireGlobalMutation: (r) => {
          if (r.permitId.startsWith(prefix(stage)) && ++hits === nth(stage)) permit = r.permitId;
          return gate(r);
        },
      },
    };
  };
  const run = (source = configure(), maxWallMs = 25000, storage = bucket) =>
    scan
      ? scanOrphanObjects(source, storage, 1, { limit: 1, maxWallMs, maintenance: stopped })
      : stopped
        ? drainStoppedOrphanGarbageCollection(source, storage, 1, { limit: 1, maxWallMs })
        : collectOrphanObjects(source, storage, 1, { limit: 1, maxWallMs });
  const outcome = (...args: Parameters<typeof run>) =>
    run(...args).catch((error) => error as Error);
  const row = () =>
    env.DB.prepare("SELECT * FROM orphan_objects WHERE r2_key=?")
      .bind(f.key)
      .first<Record<string, unknown>>();
  const scanRow = () =>
    env.DB.prepare("SELECT * FROM r2_inventory_scan").first<Record<string, unknown>>();
  const physical = () =>
    env.DB.prepare("SELECT physical_bytes FROM users WHERE id=?")
      .bind(f.ids.user)
      .first<number>("physical_bytes");
  const receipt = () =>
    env.DB.prepare(
      "SELECT state,committed_at,space_id,system,maintenance FROM mutation_admissions WHERE permit_id=?",
    )
      .bind(permit)
      .first();
  return {
    ...f,
    scan,
    stage,
    calls,
    bucket,
    configure,
    run,
    outcome,
    row,
    scanRow,
    physical,
    receipt,
  };
}

it.each(stages)("cannot bypass unavailable %s admission", async (stage) => {
  const f = await fixture(stage);
  let hits = 0;
  const result = await f.outcome(
    f.configure(async (r) => {
      if (r.permitId.startsWith(prefix(stage)) && ++hits === nth(stage))
        throw new Error("queue_full");
      return acquireGlobalMutation(r);
    }),
  );
  expect(hits).toBe(nth(stage));
  expect(await f.receipt()).toBeNull();
  if (noDispatch(stage)) expect(f.calls).toEqual({ list: 0, head: 0, delete: 0 });
  if (stage === "scan-head") expect(f.calls).toEqual({ list: 1, head: 0, delete: 0 });
  if (stage === "gc-delete") expect(f.calls.delete).toBe(0);
  if (stage === "gc-confirm") expect(f.calls).toEqual({ list: 0, head: 1, delete: 1 });
  if (!f.scan) expect(await f.physical()).toBe(3);
  if (stage === "scan-observe") expect(await f.row()).toBeNull();
  if (stage === "scan-page") expect(await f.scanRow()).toMatchObject({ pages: 0, cursor: "" });
  if (stage === "scan-release") {
    expect(result).toBeInstanceOf(Error);
    expect((result as Error).message).toBe("head_failed");
    expect(await f.scanRow()).toMatchObject({ lease_token: expect.any(String) });
  }
});

it.each(stages)("recovers only DB facts after a lost %s ACK", async (stage) => {
  const f = await fixture(stage),
    fault = systemMutationFault(prefix(stage), "ack", nth(stage));
  const result = await f.outcome(f.configure(undefined, fault.db));
  expect(fault.fired()).toBe(true);
  expect(await f.receipt()).toEqual({
    state: "closed",
    committed_at: expect.any(Number),
    space_id: null,
    system: 1,
    maintenance: 0,
  });
  if (external(stage)) {
    expect(fault.reads()).toBe(0);
    if (stage === "scan-list" || stage === "gc-head")
      expect(f.calls).toEqual({ list: 0, head: 0, delete: 0 });
    if (stage === "scan-head") expect(f.calls).toEqual({ list: 1, head: 0, delete: 0 });
    if (stage === "gc-delete") expect(f.calls).toEqual({ list: 0, head: 1, delete: 0 });
    if (stage === "gc-confirm") expect(f.calls).toEqual({ list: 0, head: 1, delete: 1 });
    if (!f.scan) expect(await f.physical()).toBe(3);
  } else if (stage === "scan-observe") {
    expect(result).toBeInstanceOf(Error);
    expect(fault.reads()).toBe(0);
    expect(await f.physical()).toBe(3);
    expect(await f.scanRow()).toMatchObject({ pages: 0 });
  } else {
    expect(fault.reads()).toBe(1);
    if (stage === "scan-claim" || stage === "scan-page")
      expect(result).toMatchObject({ completed: true });
    if (stage === "scan-release") expect(await f.scanRow()).toMatchObject({ lease_token: null });
    if (stage === "gc-claim" || stage === "gc-finalize")
      expect(result).toMatchObject({ deleted: 1 });
    if (stage === "gc-observe") expect(result).toMatchObject({ changed: 1 });
    if (stage === "gc-error") expect(result).toMatchObject({ retried: 1 });
  }
});

it.each(stages)("rolls back %s and retains the unresolved common slot", async (stage) => {
  const f = await fixture(stage),
    fault = systemMutationFault(prefix(stage), "rollback", nth(stage));
  await f.outcome(f.configure(undefined, fault.db));
  expect(fault.fired()).toBe(true);
  expect(await f.receipt()).toEqual({
    state: "active",
    committed_at: null,
    space_id: null,
    system: 1,
    maintenance: 0,
  });
  if (noDispatch(stage)) expect(f.calls).toEqual({ list: 0, head: 0, delete: 0 });
  if (!f.scan) expect(await f.physical()).toBe(3);
  if (stage === "scan-observe") expect(await f.row()).toBeNull();
  if (stage === "scan-page") expect(await f.scanRow()).toMatchObject({ pages: 0, cursor: "" });
  if (stage === "scan-release")
    expect(await f.scanRow()).toMatchObject({ lease_token: expect.any(String) });
});

it.each(stages)(
  "does not infer external permission from an unreadable %s receipt",
  async (stage) => {
    const f = await fixture(stage),
      fault = systemMutationFault(prefix(stage), "reads", nth(stage));
    const result = await f.outcome(f.configure(undefined, fault.db));
    expect(fault.fired()).toBe(true);
    expect(await f.receipt()).toMatchObject({ state: "closed", committed_at: expect.any(Number) });
    if (external(stage)) {
      expect(fault.reads()).toBe(0);
      if (stage === "gc-delete") expect(f.calls.delete).toBe(0);
      if (stage === "gc-confirm") expect(f.calls.head).toBe(1);
      if (stage === "scan-list" || stage === "gc-head")
        expect(f.calls).toEqual({ list: 0, head: 0, delete: 0 });
      if (stage === "scan-head") expect(f.calls.head).toBe(0);
    }
    // Existing exact domain token/terminal tuple readback remains valid for DB-only progress.
    if (stage === "scan-claim" || stage === "scan-page")
      expect(result).toMatchObject({ completed: true });
    if (stage === "gc-claim" || stage === "gc-finalize")
      expect(result).toMatchObject({ deleted: 1 });
    if (stage === "gc-observe") {
      expect(result).toMatchObject({ changed: 0, retried: 1 });
      expect(await f.physical()).toBe(5);
      expect(await f.row()).toMatchObject({ claim_token: null, bytes: 5 });
    }
  },
);

const calls = ["scan-list", "scan-head", "gc-head", "gc-delete", "gc-confirm"] as const;
it.each(calls)("does not start %s after admission passes the fixed deadline", async (stage) => {
  const f = await fixture(stage),
    now = Date.now(),
    clock = vi.spyOn(Date, "now").mockReturnValue(now);
  let hits = 0;
  await f.outcome(
    f.configure(async (r) => {
      const grant = await acquireGlobalMutation(r);
      if (r.permitId.startsWith(prefix(stage)) && ++hits === nth(stage))
        clock.mockReturnValue(now + 1001);
      return grant;
    }),
    1000,
  );
  expect(hits).toBe(nth(stage));
  expect(await f.receipt()).toMatchObject({ state: "active", committed_at: null });
  expect(f.calls).toEqual(
    stage === "scan-head"
      ? { list: 1, head: 0, delete: 0 }
      : stage === "gc-delete"
        ? { list: 0, head: 1, delete: 0 }
        : stage === "gc-confirm"
          ? { list: 0, head: 1, delete: 1 }
          : { list: 0, head: 0, delete: 0 },
  );
});

it.each(calls)("does not start %s after a late successful budget ACK", async (stage) => {
  const f = await fixture(stage),
    now = Date.now(),
    clock = vi.spyOn(Date, "now").mockReturnValue(now);
  let hits = 0;
  const db = injectBatch(
    (sql) => {
      const match = stage.startsWith("scan-")
        ? sql.includes("AND lease_token=? AND lease_expires_at>")
        : sql.includes("SET r2_calls=r2_calls+1");
      return match && ++hits === nth(stage);
    },
    async () => {
      clock.mockReturnValue(now + 1001);
    },
    true,
  );
  await f.outcome(f.configure(undefined, db), 1000);
  expect(hits).toBeGreaterThanOrEqual(nth(stage));
  expect(await f.receipt()).toMatchObject({ state: "closed", committed_at: expect.any(Number) });
  expect(f.calls).toEqual(
    stage === "scan-head"
      ? { list: 1, head: 0, delete: 0 }
      : stage === "gc-delete"
        ? { list: 0, head: 1, delete: 0 }
        : stage === "gc-confirm"
          ? { list: 0, head: 1, delete: 1 }
          : { list: 0, head: 0, delete: 0 },
  );
});

const scanProofs = (["scan-head", "scan-observe", "scan-page"] as const).flatMap((stage) =>
  (["epoch", "mode", "lease", "token"] as const).map((change) => ({ stage, change })),
);
it.each(scanProofs)("rechecks scan $change after $stage admission", async ({ stage, change }) => {
  const f = await fixture(stage);
  let hits = 0;
  await f.outcome(
    f.configure(async (r) => {
      const a = await acquireGlobalMutation(r);
      if (r.permitId.startsWith(prefix(stage)) && ++hits === nth(stage)) {
        if (change === "epoch") await env.DB.prepare("UPDATE control SET epoch=2").run();
        if (change === "mode") await env.DB.prepare("UPDATE control SET maintenance=1").run();
        if (change === "lease")
          await env.DB.prepare("UPDATE r2_inventory_scan SET lease_expires_at=1").run();
        if (change === "token")
          await env.DB.prepare("UPDATE r2_inventory_scan SET lease_token='replacement'").run();
      }
      return a;
    }),
  );
  expect(hits).toBe(nth(stage));
  expect(await f.scanRow()).toMatchObject({ pages: 0, cursor: "" });
  if (stage === "scan-head") expect(f.calls).toEqual({ list: 1, head: 0, delete: 0 });
  if (stage !== "scan-page") expect(await f.row()).toBeNull();
  if (change === "token") expect(await f.scanRow()).toMatchObject({ lease_token: "replacement" });
});

const gcProofs = (["gc-delete", "gc-observe", "gc-finalize"] as const).flatMap((stage) =>
  (["epoch", "mode", "gc_pause", "lease", "token"] as const).map((change) => ({ stage, change })),
);
it.each(gcProofs)("rechecks GC $change after $stage admission", async ({ stage, change }) => {
  const f = await fixture(stage);
  let hits = 0;
  await f.outcome(
    f.configure(async (r) => {
      const a = await acquireGlobalMutation(r);
      if (r.permitId.startsWith(prefix(stage)) && ++hits === nth(stage)) {
        if (change === "epoch") await env.DB.prepare("UPDATE control SET epoch=2").run();
        if (change === "mode") await env.DB.prepare("UPDATE control SET maintenance=1").run();
        if (change === "gc_pause") await env.DB.prepare("UPDATE control SET gc_paused=1").run();
        if (change === "lease")
          await env.DB.prepare("UPDATE orphan_objects SET claim_expires_at=1 WHERE r2_key=?")
            .bind(f.key)
            .run();
        if (change === "token")
          await env.DB.prepare("UPDATE orphan_objects SET claim_token='replacement' WHERE r2_key=?")
            .bind(f.key)
            .run();
      }
      return a;
    }),
  );
  expect(hits).toBe(nth(stage));
  expect(await f.physical()).toBe(3);
  expect(await f.row()).toMatchObject({ state: "deleting", bytes: 3 });
  if (stage === "gc-delete") expect(f.calls.delete).toBe(0);
  if (change === "token")
    expect(await f.row()).toMatchObject({ claim_token: "replacement", last_error: null });
});

it.each(["scan-claim", "gc-claim"] as const)(
  "starts the %s SQL lease after the actual admission wait",
  async (stage) => {
    const f = await fixture(stage);
    let afterWait = 0;
    await f.outcome(
      f.configure(async (r) => {
        if (r.permitId.includes("-call:")) throw new Error("hold_before_dispatch");
        if (r.permitId.includes("scan-release:")) throw new Error("hold_lease");
        const a = await acquireGlobalMutation(r);
        if (r.permitId.startsWith(prefix(stage))) {
          await new Promise((resolve) => setTimeout(resolve, 1200));
          afterWait = (await env.DB.prepare(
            "SELECT strftime('%s','now')*1000 AS now",
          ).first<number>("now"))!;
        }
        return a;
      }),
    );
    expect(afterWait).toBeGreaterThan(0);
    const lease =
      stage === "scan-claim"
        ? (await f.scanRow())?.lease_expires_at
        : (await f.row())?.claim_expires_at;
    expect(lease).toBeGreaterThanOrEqual(afterWait + 60000);
    expect(f.calls).toEqual({ list: 0, head: 0, delete: 0 });
  },
);

it("keeps its unknown finalize slot when another collector proves the same terminal tuple", async () => {
  const f = await fixture("gc-finalize");
  const receipts: string[] = [];
  const source = f.configure(async (r) => {
    if (r.permitId.startsWith(prefix("gc-finalize"))) receipts.push(r.permitId);
    return acquireGlobalMutation(r);
  });
  const bucket = orphanBucket({
    head: async (key) => {
      const object = await env.BLOBS.head(key);
      if (!object) {
        await env.DB.prepare(
          "UPDATE orphan_objects SET claim_expires_at=1,next_check_at=0 WHERE r2_key=?",
        )
          .bind(key)
          .run();
        expect(await f.run(source)).toMatchObject({ deleted: 1 });
      }
      return object;
    },
  });
  expect(await f.run(source, 25000, bucket)).toMatchObject({ deleted: 1 });
  expect(receipts).toHaveLength(2);
  expect(await f.physical()).toBe(0);
  expect(
    await env.DB.prepare("SELECT state,committed_at FROM mutation_admissions WHERE permit_id=?")
      .bind(receipts[0]!)
      .first(),
  ).toEqual({ state: "closed", committed_at: expect.any(Number) });
  expect(
    await env.DB.prepare("SELECT state,committed_at FROM mutation_admissions WHERE permit_id=?")
      .bind(receipts[1]!)
      .first(),
  ).toEqual({ state: "active", committed_at: null });
});

it("uses explicit null scope before an unknown owner is restored", async () => {
  const owner = crypto.randomUUID(),
    key = `u/${owner}/b/absent-owner`;
  await env.BLOBS.put(key, "abc");
  const bucket = orphanBucket({
    list: (options) => env.BLOBS.list({ ...options, prefix: `u/${owner}/` }),
  });
  const permits: string[] = [];
  const source: GlobalMutationSource = {
    DB: env.DB,
    systemControl: {
      status: () => mutationEnv().CONTROL.get(env.CONTROL.idFromName("fixture")).status(),
      acquireGlobalMutation: async (r) => {
        permits.push(r.permitId);
        return acquireGlobalMutation(r);
      },
    },
  };
  expect(await scanOrphanObjects(source, bucket, 1)).toMatchObject({
    observed: 1,
    completed: true,
  });
  expect(
    await env.DB.prepare("SELECT owner_key,owner_id,bytes FROM orphan_objects WHERE r2_key=?")
      .bind(key)
      .first(),
  ).toEqual({ owner_key: owner, owner_id: null, bytes: 3 });
  expect(await env.DB.prepare("SELECT id FROM users WHERE id=?").bind(owner).first()).toBeNull();
  expect(permits).toHaveLength(6);
  for (const permit of permits)
    expect(
      await env.DB.prepare(
        "SELECT space_id,system,maintenance,committed_at FROM mutation_admissions WHERE permit_id=?",
      )
        .bind(permit)
        .first(),
    ).toEqual({ space_id: null, system: 1, maintenance: 0, committed_at: expect.any(Number) });
});
