import { applyD1Migrations } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeAll, beforeEach, expect, it } from "vitest";
import { atomicBatch } from "../../src/db/primary";
import type { Env } from "../../src/env";
import worker from "../../src/index";
import { runGarbageCollection } from "../../src/jobs/gc";
import { R2S3Inventory } from "../../src/r2/s3Inventory";
import { observePhysicalObject } from "../../src/services/physical";
import { foundationFixture } from "../fixtures/foundation";
import { multipartInventoryFixture } from "../fixtures/multipartInventory";
import { acquireSystemMutation, mutationEnv } from "../fixtures/mutationAdmission";
import { inventoryEnv } from "../fixtures/s3Inventory";

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

it("confirms derivative removal before terminal original deletion", async () => {
  const f = await candidate();
  const derivativeKey = `u/${f.ids.user}/d/${f.ids.blob}/image-sm256-v1/sm256/${crypto.randomUUID()}.webp`;
  const derivative = await env.BLOBS.put(derivativeKey, "sm");
  if (!derivative) throw new Error("fixture_derivative_missing");
  await env.DB.prepare(
    `INSERT INTO derivative_results
      (id,blob_id,kind,variant,generator_version,state,epoch,attempts,r2_key,size,r2_etag)
      VALUES(?,?,'thumbnail','sm256','image-sm256-v1','ready',1,1,?,?,?)`,
  )
    .bind(crypto.randomUUID(), f.ids.blob, derivativeKey, derivative.size, derivative.etag)
    .run();
  expect(await runGarbageCollection(mutationEnv(), env.BLOBS, 1, { maxBlobs: 1 })).toEqual({
    claimed: 1,
    deleted: 1,
    retried: 0,
    r2Calls: 4,
  });
  expect(await env.BLOBS.head(derivativeKey)).toBeNull();
  expect(await env.BLOBS.head(f.key)).toBeNull();
  expect(
    await env.DB.prepare("SELECT COUNT(*) AS count FROM derivative_results WHERE blob_id=?")
      .bind(f.ids.blob)
      .first("count"),
  ).toBe(0);
});

it("removes unpublished derivative rows before terminal original deletion", async () => {
  const f = await candidate();
  await env.DB.prepare(
    `INSERT INTO derivative_results
      (id,blob_id,kind,variant,generator_version,state,epoch,attempts,error_code)
      VALUES(?,?,'thumbnail','sm256','image-sm256-v1','failed',1,3,'attempts_exhausted')`,
  )
    .bind(crypto.randomUUID(), f.ids.blob)
    .run();
  expect(await runGarbageCollection(mutationEnv(), env.BLOBS, 1, { maxBlobs: 1 })).toEqual({
    claimed: 1,
    deleted: 1,
    retried: 0,
    r2Calls: 2,
  });
  expect(await env.BLOBS.head(f.key)).toBeNull();
  expect(
    await env.DB.prepare("SELECT COUNT(*) AS count FROM derivative_results WHERE blob_id=?")
      .bind(f.ids.blob)
      .first("count"),
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

it("reclaims a gc_candidate whose multipart upload was closure-settled", async () => {
  const f = await multipartInventoryFixture({ known: true });
  await f.handle.abort();
  const now = Date.now();
  const source = JSON.stringify(new R2S3Inventory(inventoryEnv).source);
  const run = crypto.randomUUID();
  await atomicBatch(env.DB, [
    {
      sql: `UPDATE uploads SET state='failed',accept_parts=0,in_flight=0,cleanup_pending=1,
        multipart_cleanup_started_at=? WHERE id=?`,
      values: [now, f.id],
    },
    { sql: "UPDATE blobs SET state='orphan' WHERE id=?", values: [f.blob] },
    {
      sql: `INSERT INTO multipart_inventory_scans(
        upload_id,r2_key,source,epoch,round_id,pages,completed_at,next_scan_at
      ) VALUES(?,?,?,?,?,1,?,0)`,
      values: [f.id, f.key, source, 1, crypto.randomUUID(), now],
    },
    {
      sql: `INSERT INTO multipart_closure_runs(id,source,epoch,phase,not_before,scan_round_id,proven_at,created_at,updated_at)
        VALUES(?,?,1,'proven',0,'scan',?,?,?)`,
      values: [run, source, now - 10, now - 10, now - 10],
    },
    {
      sql: `INSERT INTO multipart_upload_settlements(upload_id,closure_id,owner_id,reservation_id,token,lease_expires_at,claimed_at,state)
        VALUES(?,?,?,?,?,1,?,'claimed')`,
      values: [f.id, run, f.ids.user, f.reservation, crypto.randomUUID(), now - 10],
    },
  ]);
  await atomicBatch(env.DB, [
    { sql: "UPDATE reservations SET state='released' WHERE id=?", values: [f.reservation] },
    {
      sql: `UPDATE multipart_upload_settlements
        SET state='settled',object_state='absent',settled_at=? WHERE upload_id=?`,
      values: [now, f.id],
    },
    { sql: "UPDATE blobs SET state='gc_candidate' WHERE id=?", values: [f.blob] },
    {
      sql: "INSERT INTO gc_candidates(blob_id,state,not_before) VALUES(?,'candidate',0)",
      values: [f.blob],
    },
  ]);
  expect(await runGarbageCollection(mutationEnv(), env.BLOBS, 1, { maxBlobs: 1 })).toMatchObject({
    claimed: 1,
    deleted: 1,
  });
  expect(
    await env.DB.prepare("SELECT state FROM blobs WHERE id=?").bind(f.blob).first("state"),
  ).toBe("deleted");
  expect(
    await env.DB.prepare("SELECT state FROM gc_candidates WHERE blob_id=?")
      .bind(f.blob)
      .first("state"),
  ).toBe("deleted");
  // The settled settlement releases the inventory hold: once the blob is proven
  // absent, finalization also clears the frozen cleanup flag.
  expect(
    await env.DB.prepare("SELECT cleanup_pending FROM uploads WHERE id=?")
      .bind(f.id)
      .first("cleanup_pending"),
  ).toBe(0);
});
