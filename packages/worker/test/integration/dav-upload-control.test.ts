import { applyD1Migrations, evictDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeAll, beforeEach, expect, it } from "vitest";
import { advanceMutations } from "../../src/db/mutationAdmission";
import { atomicBatch } from "../../src/db/primary";
import { CONTROL_NAME } from "../../src/do/ControlDO";
import { EPOCH_PREFIX } from "../../src/do/epochHistory";
import { recordStoredDavUpload, settleFailedDavUpload } from "../../src/services/davUpload";
import { davUploadHistory as history } from "../fixtures/davUploadHistory";
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
beforeEach(() =>
  env.DB.prepare("UPDATE mutation_admissions SET state='closed' WHERE state<>'closed'").run(),
);
async function fill(space: string) {
  const ids = Array.from({ length: 32 }, () => crypto.randomUUID());
  await atomicBatch(
    env.DB,
    ids.map((id, i) => ({
      sql: `INSERT INTO mutation_admissions(id,permit_id,space_id,epoch,system,maintenance,requested_at,wait_until)
    VALUES(?,?,?,?,1,1,strftime('%s','now')*1000,strftime('%s','now')*1000+5000)`,
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
it.each(["stored", "failed"] as const)(
  "native DAV %s facts wait in the shared pool with the owner's capacity held",
  async (kind) => {
    const f = await history({
        epoch,
        state: kind === "stored" ? "receiving" : "completing",
        present: true,
        expired: false,
        operationState: "failed",
      }),
      ids = await fill(f.ids.space);
    const pending = (
      kind === "stored"
        ? recordStoredDavUpload(env, f.row, { object: f.object!, sha256: "a".repeat(64) })
        : settleFailedDavUpload(env, f.row)
    ).then(
      () => null,
      (error) => error,
    );
    try {
      const prefix = "system:dav.put-" + kind + ":";
      await expect
        .poll(
          () =>
            env.DB.prepare(
              "SELECT COUNT(*) n FROM mutation_admissions WHERE space_id=? AND state='waiting' AND substr(permit_id,1,length(?))=?",
            )
              .bind(f.ids.space, prefix, prefix)
              .first("n"),
          { timeout: 4000, interval: 25 },
        )
        .toBe(1);
      expect(await f.counters()).toEqual({
        reserved_bytes: 3,
        physical_bytes: kind === "stored" ? 0 : 3,
      });
      await env.DB.prepare("UPDATE mutation_admissions SET state='closed' WHERE id=?")
        .bind(ids[0])
        .run();
      expect(await pending).toBeNull();
      expect(await f.counters()).toEqual({
        reserved_bytes: kind === "stored" ? 3 : 0,
        physical_bytes: 3,
      });
      expect(
        await env.DB.prepare(
          "SELECT state,committed_at,space_id,maintenance FROM mutation_admissions WHERE substr(permit_id,1,length(?))=? AND space_id=?",
        )
          .bind(prefix, prefix, f.ids.space)
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
it("replays exact failed DAV settlement after ControlDO eviction with all shared slots occupied", async () => {
  const f = await history({ epoch, state: "completing", present: true, expired: false }),
    fault = systemMutationFault("system:dav.put-failed:", "reads");
  await settleFailedDavUpload({ ...env, DB: fault.db }, f.row);
  expect(fault.fired()).toBe(true);
  await evictDurableObject(control());
  await fill(f.ids.space);
  await settleFailedDavUpload(env, f.row);
  expect(await f.counters()).toEqual({ reserved_bytes: 0, physical_bytes: 3 });
  expect(
    await env.DB.prepare(
      "SELECT COUNT(*) n FROM mutation_admissions WHERE space_id=? AND permit_id LIKE 'system:dav.put-failed:%'",
    )
      .bind(f.ids.space)
      .first("n"),
  ).toBe(1);
});
