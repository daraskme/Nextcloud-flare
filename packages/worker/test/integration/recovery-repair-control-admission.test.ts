import { applyD1Migrations, evictDurableObject, runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeAll, beforeEach, expect, it } from "vitest";
import { advanceMutations } from "../../src/db/mutationAdmission";
import { atomicBatch } from "../../src/db/primary";
import { CONTROL_NAME, ControlDO } from "../../src/do/ControlDO";
import { EPOCH_PREFIX } from "../../src/do/epochHistory";
import { foundationFixture } from "../fixtures/foundation";
import {
  recoveryRepairFixture,
  repairKinds,
  resetRecoveryRepairs,
} from "../fixtures/recoveryRepair";
import { systemMutationFault } from "../fixtures/systemMutationFault";

const control = () => env.CONTROL.get(env.CONTROL.idFromName(CONTROL_NAME));
const admin = foundationFixture(crypto.randomUUID(), Date.now() - 1000);
let epoch = 2;
beforeAll(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
  await env.BACKUPS.put(
    EPOCH_PREFIX + "1.json",
    JSON.stringify({ epoch: 1, at: 1, reason: "operator" }),
  );
  epoch = (await control().recover()).epoch;
  await atomicBatch(env.DB, admin.statements);
});
beforeEach(async () => {
  await control().quiesce(epoch);
  await resetRecoveryRepairs(admin, epoch);
});
async function fill() {
  const ids = Array.from({ length: 32 }, () => crypto.randomUUID());
  await atomicBatch(
    env.DB,
    ids.map((id, i) => ({
      sql: "INSERT INTO mutation_admissions(id,permit_id,space_id,epoch,system,maintenance,requested_at,wait_until) VALUES(?,?,?,?,1,1,strftime('%s','now')*1000,strftime('%s','now')*1000+5000)",
      values: [
        id,
        (i % 2 ? "global:r2.probe-phase:" : "system:upload.observe:") + id,
        i % 2 ? null : admin.ids.space,
        epoch,
      ],
    })),
  );
  expect((await advanceMutations(env.DB)).filter((r) => r.state === "active")).toHaveLength(32);
  return ids;
}
const cases = repairKinds.flatMap((kind) =>
  ([true, false] as const).map((drainAll) => ({ kind, drainAll })),
);
it.each(cases)(
  "native $kind waits for capacity and requires other work drained=$drainAll",
  async ({ kind, drainAll }) => {
    const f = await recoveryRepairFixture(kind, admin, epoch);
    let ids: string[] = [],
      permit = "";
    const pending = runInDurableObject(control(), async (_, state) => {
      const instance = new ControlDO(state, env);
      const system = instance.acquireSystemMutation.bind(instance),
        global = instance.acquireGlobalMutation.bind(instance);
      const before = async (id: string) => {
        if (!permit && id.startsWith(f.prefix)) {
          permit = id;
          ids = await fill();
        }
      };
      instance.acquireSystemMutation = async (r) => {
        await before(r.permitId);
        return system(r);
      };
      instance.acquireGlobalMutation = async (r) => {
        await before(r.permitId);
        return global(r);
      };
      try {
        const result = await (kind === "fts-rebuild"
          ? instance.rebuildRecoveryFts(epoch)
          : kind === "outbox-fail"
            ? instance.failStaleOutbox(epoch)
            : instance.releaseStaleReservations(epoch));
        return { ok: true, result };
      } catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : "unknown" };
      } finally {
        instance.acquireSystemMutation = system;
        instance.acquireGlobalMutation = global;
      }
    }).then((result) => result);
    try {
      await expect
        .poll(
          () =>
            env.DB.prepare(
              "SELECT COUNT(*) n FROM mutation_admissions WHERE state='waiting' AND substr(permit_id,1,length(?))=?",
            )
              .bind(f.prefix, f.prefix)
              .first("n"),
          { timeout: 4000, interval: 25 },
        )
        .toBe(1);
      expect(await f.read()).toBe(f.initial);
      const close = drainAll ? ids : ids.slice(0, 1);
      await env.DB.prepare(
        "UPDATE mutation_admissions SET state='closed' WHERE id IN (" +
          close.map(() => "?").join(",") +
          ")",
      )
        .bind(...close)
        .run();
      const result = await pending;
      expect(result.ok).toBe(drainAll);
      expect(await f.read()).toBe(drainAll ? f.terminal : f.initial);
      expect(
        await env.DB.prepare(
          "SELECT state,committed_at,space_id,system,maintenance FROM mutation_admissions WHERE permit_id=?",
        )
          .bind(permit)
          .first(),
      ).toEqual({
        state: "closed",
        committed_at: drainAll ? expect.any(Number) : null,
        space_id: kind === "fts-rebuild" ? null : f.ids.space,
        system: 1,
        maintenance: 1,
      });
      if (drainAll)
        expect(result).toMatchObject(
          kind === "fts-rebuild"
            ? { result: { stage: "users", pages: 0 } }
            : kind === "outbox-fail"
              ? { result: { failed: 1, audit: { stage: "users", pages: 0 } } }
              : { result: { released: 1, audit: { stage: "users", pages: 0 } } },
        );
      expect(await control().status()).toMatchObject({ epoch, maintenance: true, gcPaused: true });
    } finally {
      await env.DB.prepare(
        "UPDATE mutation_admissions SET state='closed' WHERE state<>'closed'",
      ).run();
      await pending;
    }
  },
);
it.each(["reservation-release", "outbox-fail"] as const)(
  "keeps recovered %s terminal results read-only across eviction",
  async (kind) => {
    const f = await recoveryRepairFixture(kind, admin, epoch),
      fault = systemMutationFault(f.prefix, "reads");
    expect(await f.run({ ...env, DB: fault.db })).toBe(1);
    expect(fault.fired()).toBe(true);
    expect(await f.read()).toBe(f.terminal);
    const count = () =>
      env.DB.prepare(
        "SELECT COUNT(*) n FROM mutation_admissions WHERE substr(permit_id,1,length(?))=?",
      )
        .bind(f.prefix, f.prefix)
        .first("n");
    const before = await count();
    await evictDurableObject(control());
    expect(await f.run(env)).toBe(0);
    expect(await count()).toBe(before);
  },
);
