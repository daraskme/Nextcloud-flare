import { applyD1Migrations } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeAll, beforeEach, expect, it } from "vitest";
import { atomicBatch } from "../../src/db/primary";
import type { Env } from "../../src/env";
import worker from "../../src/index";
import { runGarbageCollection } from "../../src/jobs/gc";
import { observePhysicalObject } from "../../src/services/physical";
import { foundationFixture } from "../fixtures/foundation";
import { acquireSystemMutation, mutationEnv } from "../fixtures/mutationAdmission";

beforeAll(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
});

beforeEach(async () => {
  await env.DB.prepare("UPDATE control SET epoch=1,maintenance=0,gc_paused=0").run();
});

async function candidate() {
  const f = foundationFixture(crypto.randomUUID(), Date.now() - 1_000);
  await atomicBatch(env.DB, f.statements);
  const key = `u/${f.ids.user}/b/${f.ids.blob}`;
  await env.BLOBS.put(key, new Uint8Array([1, 2, 3]));
  await observePhysicalObject(mutationEnv(), env.BLOBS, f.ids.blob, 1);
  await atomicBatch(env.DB, [
    { sql: "UPDATE nodes SET current_blob_id=NULL WHERE id=?", values: [f.ids.file] },
    { sql: "UPDATE blobs SET state='gc_candidate' WHERE id=?", values: [f.ids.blob] },
    {
      sql: "INSERT INTO gc_candidates(blob_id,state,not_before) VALUES(?,'candidate',0)",
      values: [f.ids.blob],
    },
  ]);
  return { ...f, key };
}

it("deletes an unreferenced object and finalizes physical accounting", async () => {
  const f = await candidate();
  expect(await runGarbageCollection(mutationEnv(), env.BLOBS, 1, { maxBlobs: 1 })).toEqual({
    claimed: 1,
    deleted: 1,
    retried: 0,
    r2Calls: 2,
  });
  expect(await env.BLOBS.head(f.key)).toBeNull();
  expect(
    await env.DB.prepare(`SELECT b.state AS blobState,g.state AS gcState,s.removed_at IS NOT NULL AS removed
      FROM blobs b JOIN gc_candidates g ON g.blob_id=b.id JOIN blob_storage s ON s.blob_id=b.id
      WHERE b.id=?`)
      .bind(f.ids.blob)
      .first(),
  ).toEqual({ blobState: "deleted", gcState: "deleted", removed: 1 });
  expect(
    await env.DB.prepare("SELECT physical_bytes FROM users WHERE id=?")
      .bind(f.ids.user)
      .first("physical_bytes"),
  ).toBe(0);
});

it("honors every pin, the materialized fence, and the GC pause", async () => {
  const f = await candidate();
  await atomicBatch(env.DB, [
    {
      sql: "INSERT INTO blob_pins(pin_id,blob_id,purpose,created_at) VALUES(?,?,'job',?)",
      values: [crypto.randomUUID(), f.ids.blob, Date.now()],
    },
    {
      sql: "INSERT INTO blob_pins(pin_id,blob_id,purpose,created_at) VALUES(?,?,'backup',?)",
      values: [crypto.randomUUID(), f.ids.blob, Date.now()],
    },
    {
      sql: "UPDATE gc_candidates SET pinned_by='materialized' WHERE blob_id=?",
      values: [f.ids.blob],
    },
  ]);
  expect(await runGarbageCollection(mutationEnv(), env.BLOBS, 1, { maxBlobs: 1 })).toMatchObject({
    claimed: 0,
  });
  await env.DB.prepare("DELETE FROM blob_pins WHERE blob_id=?").bind(f.ids.blob).run();
  expect(await runGarbageCollection(mutationEnv(), env.BLOBS, 1, { maxBlobs: 1 })).toMatchObject({
    claimed: 0,
  });
  await env.DB.prepare("UPDATE gc_candidates SET pinned_by=NULL WHERE blob_id=?")
    .bind(f.ids.blob)
    .run();
  await env.DB.prepare("UPDATE control SET gc_paused=1").run();
  expect(await runGarbageCollection(mutationEnv(), env.BLOBS, 1, { maxBlobs: 1 })).toMatchObject({
    claimed: 0,
  });
  await env.DB.prepare("UPDATE control SET gc_paused=0").run();
  expect(await runGarbageCollection(mutationEnv(), env.BLOBS, 1, { maxBlobs: 1 })).toMatchObject({
    deleted: 1,
  });
});

it("resolves a lost delete response through R2 head", async () => {
  const f = await candidate();
  const bucket = {
    delete: async (key: string) => {
      await env.BLOBS.delete(key);
      throw new Error("delete_ack_lost");
    },
    head: env.BLOBS.head.bind(env.BLOBS),
  } as unknown as R2Bucket;
  expect(await runGarbageCollection(mutationEnv(), bucket, 1, { maxBlobs: 1 })).toMatchObject({
    claimed: 1,
    deleted: 1,
    retried: 0,
  });
});

it("retakes an expired failed claim and preserves irreversible state", async () => {
  const f = await candidate();
  const unavailable = {
    delete: async () => {
      throw new Error("r2_unavailable");
    },
    head: env.BLOBS.head.bind(env.BLOBS),
  } as unknown as R2Bucket;
  expect(await runGarbageCollection(mutationEnv(), unavailable, 1, { maxBlobs: 1 })).toMatchObject({
    claimed: 1,
    deleted: 0,
    retried: 1,
  });
  expect(
    await env.DB.prepare("SELECT state,last_error,attempt FROM gc_candidates WHERE blob_id=?")
      .bind(f.ids.blob)
      .first(),
  ).toEqual({ state: "deleting", last_error: "r2_unconfirmed", attempt: 1 });
  await expect(
    env.DB.prepare("UPDATE gc_candidates SET state='candidate' WHERE blob_id=?")
      .bind(f.ids.blob)
      .run(),
  ).rejects.toThrow();
  await env.DB.prepare("UPDATE gc_candidates SET claim_expires_at=0 WHERE blob_id=?")
    .bind(f.ids.blob)
    .run();
  expect(await runGarbageCollection(mutationEnv(), env.BLOBS, 1, { maxBlobs: 1 })).toMatchObject({
    claimed: 1,
    deleted: 1,
    retried: 0,
  });
  expect(
    await env.DB.prepare("SELECT state,attempt FROM gc_candidates WHERE blob_id=?")
      .bind(f.ids.blob)
      .first(),
  ).toEqual({ state: "deleted", attempt: 2 });
});

it("runs from Cron only after ControlDO and D1 admit GC", async () => {
  const f = await candidate();
  const runtime = {
    ...env,
    CONTROL: {
      idFromName: () => "singleton",
      get: () => ({
        acquireSystemMutation,
        status: async () => ({ epoch: 1, maintenance: false, gcPaused: false }),
      }),
    },
  } as unknown as Env;
  await worker.scheduled({} as ScheduledController, runtime);
  expect(await env.BLOBS.head(f.key)).toBeNull();
  expect(
    await env.DB.prepare("SELECT state FROM gc_candidates WHERE blob_id=?")
      .bind(f.ids.blob)
      .first("state"),
  ).toBe("deleted");
});
