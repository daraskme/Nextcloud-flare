import { applyD1Migrations, evictDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeAll, beforeEach, expect, it } from "vitest";
import { advanceMutations } from "../../src/db/mutationAdmission";
import { atomicBatch } from "../../src/db/primary";
import { CONTROL_NAME } from "../../src/do/ControlDO";
import { EPOCH_PREFIX } from "../../src/do/epochHistory";
import {
  completionModes,
  failedCompletionFixture as fixture,
  failedCompletionPrefix as prefix,
} from "../fixtures/failedCompletion";
import { systemMutationFault } from "../fixtures/systemMutationFault";

const control = () => env.CONTROL.get(env.CONTROL.idFromName(CONTROL_NAME));
let epoch = 2;
beforeAll(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
  await env.BACKUPS.put(
    EPOCH_PREFIX + "1.json",
    JSON.stringify({ epoch: 1, at: 1, reason: "operator" }),
  );
  epoch = (await control().recover()).epoch;
});
beforeEach(async () => {
  await env.DB.prepare("UPDATE mutation_admissions SET state='closed' WHERE state<>'closed'").run();
});
async function fill(space: string) {
  const ids = Array.from({ length: 32 }, () => crypto.randomUUID());
  await atomicBatch(
    env.DB,
    ids.map((id, i) => ({
      sql: "INSERT INTO mutation_admissions(id,permit_id,space_id,epoch,system,maintenance,requested_at,wait_until) VALUES(?,?,?,?,1,1,strftime('%s','now')*1000,strftime('%s','now')*1000+5000)",
      values: [
        id,
        (i % 2 ? "global:r2.probe-phase:" : "system:upload.observe:") + id,
        i % 2 ? null : space,
        epoch,
      ],
    })),
  );
  expect((await advanceMutations(env.DB)).filter((r) => r.state === "active")).toHaveLength(32);
  return ids;
}
it.each(completionModes)(
  "native %s settlement waits in the shared pool without an early refund",
  async (mode) => {
    const f = await fixture(mode, epoch),
      ids = await fill(f.ids.space);
    const pending = f.run(env).then(
      () => ({ ok: true }),
      (error) => ({ ok: false, error }),
    );
    try {
      await expect
        .poll(
          () =>
            env.DB.prepare(
              "SELECT COUNT(*) n FROM mutation_admissions WHERE state='waiting' AND space_id=? AND substr(permit_id,1,length(?))=?",
            )
              .bind(f.ids.space, prefix, prefix)
              .first("n"),
          { timeout: 4000, interval: 25 },
        )
        .toBe(1);
      expect(await f.snapshot()).toMatchObject({
        state: "completing",
        reserved_bytes: 3,
        physical_bytes: 3,
      });
      await env.DB.prepare("UPDATE mutation_admissions SET state='closed' WHERE id=?")
        .bind(ids[0])
        .run();
      const outcome = await pending;
      if ("error" in outcome) throw outcome.error;
      expect(await f.snapshot()).toMatchObject({
        state: "failed",
        reserved_bytes: 0,
        physical_bytes: 3,
      });
      expect(
        await env.DB.prepare(
          "SELECT state,committed_at,space_id,maintenance FROM mutation_admissions WHERE space_id=? AND substr(permit_id,1,length(?))=?",
        )
          .bind(f.ids.space, prefix, prefix)
          .first(),
      ).toEqual({
        state: "closed",
        committed_at: expect.any(Number),
        space_id: f.ids.space,
        maintenance: 1,
      });
    } finally {
      await env.DB.prepare(
        "UPDATE mutation_admissions SET state='closed' WHERE state<>'closed'",
      ).run();
      await pending;
    }
  },
);
it.each(completionModes)(
  "keeps recovered %s settlement read-only after eviction with all slots occupied",
  async (mode) => {
    const f = await fixture(mode, epoch),
      fault = systemMutationFault(prefix, "reads");
    await f.run({ ...env, DB: fault.db });
    expect(fault.fired()).toBe(true);
    const count = () =>
      env.DB.prepare(
        "SELECT COUNT(*) n FROM mutation_admissions WHERE space_id=? AND substr(permit_id,1,length(?))=?",
      )
        .bind(f.ids.space, prefix, prefix)
        .first("n");
    expect(await count()).toBe(1);
    await evictDurableObject(control());
    await fill(f.ids.space);
    await f.run(env);
    expect(await count()).toBe(1);
    expect(await f.snapshot()).toMatchObject({
      state: "failed",
      reserved_bytes: 0,
      physical_bytes: 3,
    });
  },
);
