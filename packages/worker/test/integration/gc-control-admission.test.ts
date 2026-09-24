import { applyD1Migrations, evictDurableObject, runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";
import { advanceMutations, type MutationRequest } from "../../src/db/mutationAdmission";
import { grantPermit } from "../../src/db/permits";
import { atomicBatch } from "../../src/db/primary";
import { CONTROL_NAME, ControlDO } from "../../src/do/ControlDO";
import { EPOCH_PREFIX } from "../../src/do/epochHistory";
import { runGarbageCollection } from "../../src/jobs/gc";
import { foundationFixture } from "../fixtures/foundation";
import { gcFixture } from "../fixtures/gc";
import { injectBatch } from "../fixtures/uploadEnv";

const control = () => env.CONTROL.get(env.CONTROL.idFromName(CONTROL_NAME));
const op = () => "op_" + crypto.randomUUID().replaceAll("-", "").repeat(2);
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
  const object = (await env.BLOBS.put("u/" + owner.ids.user + "/b/" + owner.ids.blob, "abc"))!;
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
});
beforeEach(async () => {
  await control().beginRecoveryAudit(epoch);
  let completed = false;
  for (let i = 0; i < 30; i++)
    if ((await control().nextRecoveryAuditPage(epoch, 20)).completed) {
      completed = true;
      break;
    }
  expect(completed).toBe(true);
  await control().resumeAdmission(epoch);
  await control().resumeGarbageCollection(epoch);
});
afterAll(() => control().quiesce(epoch));
async function fill(space: string, seeds: string[], maintenance: 0 | 1) {
  await atomicBatch(
    env.DB,
    seeds.map((id) => ({
      sql: "INSERT INTO mutation_admissions(id,permit_id,space_id,epoch,system,maintenance,requested_at,wait_until) VALUES(?,?,?,?,?,?,strftime('%s','now')*1000,strftime('%s','now')*1000+5000)",
      values: [
        id,
        maintenance ? "system:gc.call:" + id : id,
        space,
        epoch,
        maintenance,
        maintenance,
      ],
    })),
  );
  expect((await advanceMutations(env.DB)).filter((r) => r.state === "active")).toHaveLength(32);
}
async function waiting(space: string, prefix: string) {
  await expect
    .poll(
      () =>
        env.DB.prepare(
          "SELECT COUNT(*) AS n FROM mutation_admissions WHERE space_id=? AND state='waiting' AND permit_id LIKE ?",
        )
          .bind(space, prefix + "%")
          .first("n"),
      { timeout: 4000, interval: 25 },
    )
    .toBe(1);
}
async function release(id: string) {
  await env.DB.prepare(
    "UPDATE mutation_admissions SET state='closed' WHERE id=? AND state<>'closed'",
  )
    .bind(id)
    .run();
}
async function cleanup(space: string) {
  await env.DB.prepare(
    "UPDATE mutation_admissions SET state='closed' WHERE space_id=? AND state<>'closed'",
  )
    .bind(space)
    .run();
  await env.DB.prepare("UPDATE permits SET state='revoked' WHERE space_id=? AND state='open'")
    .bind(space)
    .run();
}

it.each(["claim", "call", "finalize", "error"] as const)(
  "queues normal GC %s in the real global pool and returns the slot",
  async (stage) => {
    const f = await gcFixture("candidate"),
      prefix = "system:gc." + stage + ":";
    const seeds = Array.from({ length: 32 }, () => crypto.randomUUID());
    let filled = false,
      calls = 0;
    const source = {
      DB: env.DB,
      systemControl: {
        status: () => control().status(),
        acquireSystemMutation: async (r: MutationRequest) => {
          if (!filled && r.permitId.startsWith(prefix)) {
            filled = true;
            await fill(f.ids.space, seeds, 0);
          }
          return control().acquireSystemMutation(r);
        },
      },
    };
    const bucket = {
      delete: async (key: string) => {
        calls++;
        if (stage === "error") throw new Error("delete_unconfirmed");
        await env.BLOBS.delete(key);
      },
      head: (key: string) => {
        calls++;
        return env.BLOBS.head(key);
      },
    } as R2Bucket;
    const outcome = runGarbageCollection(source, bucket, epoch, { maxBlobs: 1 });
    try {
      await waiting(f.ids.space, prefix);
      expect(calls).toBe(stage === "claim" || stage === "call" ? 0 : 2);
      expect(
        await env.DB.prepare("SELECT physical_bytes FROM users WHERE id=?")
          .bind(f.ids.user)
          .first("physical_bytes"),
      ).toBe(3);
      await release(seeds[0]!);
      expect(await outcome).toMatchObject(stage === "error" ? { retried: 1 } : { deleted: 1 });
      const receipts = await env.DB.prepare(
        "SELECT state,committed_at FROM mutation_admissions WHERE space_id=? AND permit_id LIKE ?",
      )
        .bind(f.ids.space, prefix + "%")
        .all();
      for (const r of receipts.results)
        expect(r).toEqual({ state: "closed", committed_at: expect.any(Number) });
      expect(
        await env.DB.prepare(
          "SELECT COUNT(*) AS n FROM mutation_admissions WHERE state='active'",
        ).first("n"),
      ).toBe(31);
      const grant = await control().acquireMutation({
        permitId: crypto.randomUUID(),
        spaceId: f.ids.space,
        epoch,
        deadline: Date.now() + 5000,
      });
      expect(await grantPermit(env.DB, grant.permit_id, f.ids.space, epoch, grant)).toMatchObject({
        permit_id: grant.permit_id,
      });
    } finally {
      await cleanup(f.ids.space);
      await outcome;
      await env.DB.prepare(
        "UPDATE gc_candidates SET claim_expires_at=0 WHERE blob_id=? AND state='deleting'",
      )
        .bind(f.ids.blob)
        .run();
      await runGarbageCollection(env, env.BLOBS, epoch, { maxBlobs: 1 });
    }
  },
);

it.each(["stopped", "restore"] as const)(
  "internal %s GC uses the same instance queue without an RPC to itself",
  async (mode) => {
    const f = await gcFixture(),
      seeds = Array.from({ length: 32 }, () => crypto.randomUUID());
    const prefix = "system:gc.call:";
    const outcome = runInDurableObject(control(), async (instance) => {
      const native = instance.acquireSystemMutation.bind(instance);
      let filled = false;
      instance.acquireSystemMutation = async (r) => {
        if (!filled && r.permitId.startsWith(prefix)) {
          filled = true;
          await fill(f.ids.space, seeds, mode === "stopped" ? 1 : 0);
        }
        return native(r);
      };
      try {
        return {
          value:
            mode === "stopped"
              ? await instance.drainBlobGarbageCollection(epoch, 1)
              : await instance.acquireRestorePause(epoch, op()),
        };
      } catch (error) {
        return { error: String(error) };
      } finally {
        instance.acquireSystemMutation = native;
      }
    });
    try {
      await waiting(f.ids.space, prefix);
      expect(
        await env.DB.prepare("SELECT r2_calls FROM gc_candidates WHERE blob_id=?")
          .bind(f.ids.blob)
          .first("r2_calls"),
      ).toBe(0);
      expect(await env.BLOBS.head(f.key)).not.toBeNull();
      await release(seeds[0]!);
      const result = await outcome;
      if ("error" in result) throw new Error(result.error);
      expect(result.value).toMatchObject(
        mode === "stopped"
          ? { cleanup: { deleted: 1 }, audit: { stage: "users" } }
          : { ready: true },
      );
      expect(await env.BLOBS.head(f.key)).toBeNull();
      expect(
        await env.DB.prepare("SELECT physical_bytes FROM users WHERE id=?")
          .bind(f.ids.user)
          .first("physical_bytes"),
      ).toBe(0);
      const rows = await env.DB.prepare(
        "SELECT state,committed_at,maintenance FROM mutation_admissions WHERE space_id=? AND permit_id LIKE ? AND committed_at IS NOT NULL",
      )
        .bind(f.ids.space, prefix + "%")
        .all();
      expect(rows.results).toHaveLength(2);
      for (const r of rows.results)
        expect(r).toEqual({
          state: "closed",
          committed_at: expect.any(Number),
          maintenance: mode === "stopped" ? 1 : 0,
        });
    } finally {
      await cleanup(f.ids.space);
      await outcome;
      await control().quiesce(epoch);
      await env.DB.prepare(
        "UPDATE gc_candidates SET claim_expires_at=0 WHERE blob_id=? AND state='deleting'",
      )
        .bind(f.ids.blob)
        .run();
      await control().drainBlobGarbageCollection(epoch, 1);
    }
  },
);

it("keeps a lost internal dispatch ACK across eviction and later settles a newly charged retry", async () => {
  const f = await gcFixture();
  const result = await runInDurableObject(control(), async (_, state) => {
    const db = injectBatch(
      (sql) => sql.includes("SET r2_calls=r2_calls+1"),
      async () => {
        throw new Error("ack_lost");
      },
      true,
    );
    const instance = new ControlDO(state, { ...env, DB: db });
    try {
      return { value: await instance.drainBlobGarbageCollection(epoch, 1) };
    } catch (error) {
      return { error: String(error) };
    }
  });
  if ("error" in result) throw new Error(result.error);
  expect(result.value.cleanup).toMatchObject({ deleted: 0, retried: 1, r2Calls: 0 });
  expect(await env.BLOBS.head(f.key)).not.toBeNull();
  expect(
    await env.DB.prepare("SELECT r2_calls FROM gc_candidates WHERE blob_id=?")
      .bind(f.ids.blob)
      .first("r2_calls"),
  ).toBe(1);
  await evictDurableObject(control());
  expect(await control().status()).toMatchObject({ epoch, maintenance: true });
  await env.DB.prepare("UPDATE gc_candidates SET claim_expires_at=0 WHERE blob_id=?")
    .bind(f.ids.blob)
    .run();
  expect(await control().drainBlobGarbageCollection(epoch, 1)).toMatchObject({
    cleanup: { deleted: 1 },
  });
  expect(
    await env.DB.prepare("SELECT r2_calls FROM gc_candidates WHERE blob_id=?")
      .bind(f.ids.blob)
      .first("r2_calls"),
  ).toBe(3);
  expect(
    await env.DB.prepare("SELECT physical_bytes FROM users WHERE id=?")
      .bind(f.ids.user)
      .first("physical_bytes"),
  ).toBe(0);
});
