import { applyD1Migrations, evictDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeAll, expect, it } from "vitest";
import { advanceMutations } from "../../src/db/mutationAdmission";
import { atomicBatch } from "../../src/db/primary";
import { CONTROL_NAME } from "../../src/do/ControlDO";
import { EPOCH_PREFIX } from "../../src/do/epochHistory";
import { putFile } from "../../src/services/putFile";
import { davBucket, davPutFixture } from "../fixtures/davPut";
import { foundationFixture } from "../fixtures/foundation";

const control = () => env.CONTROL.get(env.CONTROL.idFromName(CONTROL_NAME));
let epoch = 2;
beforeAll(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
  await env.BACKUPS.put(
    EPOCH_PREFIX + "1.json",
    JSON.stringify({ epoch: 1, at: 1, reason: "operator" }),
  );
  epoch = (await control().recover()).epoch;
  const owner = foundationFixture(crypto.randomUUID(), Date.now() - 1000);
  await atomicBatch(env.DB, owner.statements);
  const object = (await env.BLOBS.put(`u/${owner.ids.user}/b/${owner.ids.blob}`, "abc"))!;
  await atomicBatch(env.DB, [
    {
      sql: "UPDATE control SET bootstrap_done_at=1,bootstrap_iss='https://access.invalid',bootstrap_sub=?",
      values: [owner.ids.user],
    },
    {
      sql: "INSERT INTO blob_storage(blob_id,bytes,r2_etag,observed_at) VALUES(?,3,?,1)",
      values: [owner.ids.blob, object.etag],
    },
  ]);
  await control().beginRecoveryAudit(epoch);
  let complete = false;
  for (let i = 0; i < 20; i++)
    if ((await control().nextRecoveryAuditPage(epoch, 20)).completed) {
      complete = true;
      break;
    }
  expect(complete).toBe(true);
  await control().resumeAdmission(epoch);
});

it.each(["evict", "stop"] as const)(
  "queues DAV start in the real mixed shared pool, then handles %s during native storage",
  async (action) => {
    const f = await davPutFixture(),
      ids = Array.from({ length: 32 }, () => crypto.randomUUID());
    await atomicBatch(
      env.DB,
      ids.map((id, i) => ({
        sql: "INSERT INTO mutation_admissions(id,permit_id,space_id,epoch,system,maintenance,requested_at,wait_until) VALUES(?,?,?,?,?,0,strftime('%s','now')*1000,strftime('%s','now')*1000+5000)",
        values: [
          id,
          i % 2 ? "global:r2.probe-phase:" + id : id,
          i % 2 ? null : f.ids.space,
          epoch,
          i % 2,
        ],
      })),
    );
    expect((await advanceMutations(env.DB)).filter((row) => row.state === "active")).toHaveLength(
      32,
    );
    let puts = 0;
    const pending = putFile(
      {
        ...env,
        BLOBS: davBucket({
          put: async (k, b, o) => {
            puts++;
            expect(await f.op()).toBeNull();
            expect(
              await env.DB.prepare(
                "SELECT state,committed_at FROM mutation_admissions WHERE space_id=? AND permit_id LIKE 'dav.put-start:%'",
              )
                .bind(f.ids.space)
                .first(),
            ).toEqual({ state: "closed", committed_at: expect.any(Number) });
            const object = await env.BLOBS.put(k, b, o);
            if (action === "evict") await evictDurableObject(control());
            else await control().quiesce(epoch);
            return object;
          },
        }),
      },
      { ...f.input, principal: { ...f.input.principal, epoch }, body: new Blob(["abc"]).stream() },
    ).then(
      (value) => ({ value }),
      (error) => ({ error }),
    );
    try {
      await expect
        .poll(
          () =>
            env.DB.prepare(
              "SELECT COUNT(*) n FROM mutation_admissions WHERE space_id=? AND permit_id LIKE 'dav.put-start:%' AND state='waiting'",
            )
              .bind(f.ids.space)
              .first("n"),
          { timeout: 4000, interval: 25 },
        )
        .toBe(1);
      expect(puts).toBe(0);
      expect(await f.row()).toBeNull();
      expect(await f.counters()).toEqual({ reserved_bytes: 0, physical_bytes: 0 });
      await env.DB.prepare("UPDATE mutation_admissions SET state='closed' WHERE id=?")
        .bind(ids[0])
        .run();
      const result = await pending;
      if (action === "evict")
        expect(result).toMatchObject({
          value: { kind: "terminal", operation: { state: "committed" } },
        });
      else {
        expect(result).toHaveProperty("error");
        expect(await f.row()).toMatchObject({ state: "completing", completion_op_id: null });
        expect(await f.op()).toBeNull();
      }
      expect(puts).toBe(1);
      expect(await f.counters()).toEqual({
        reserved_bytes: action === "stop" ? 3 : 0,
        physical_bytes: 3,
      });
    } finally {
      await env.DB.prepare(
        "UPDATE mutation_admissions SET state='closed' WHERE state<>'closed'",
      ).run();
      await pending;
    }
  },
);
