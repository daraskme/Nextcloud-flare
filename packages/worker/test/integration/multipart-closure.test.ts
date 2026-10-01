import { applyD1Migrations, runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { atomicBatch } from "../../src/db/primary";
import { CONTROL_NAME, ControlDO } from "../../src/do/ControlDO";
import { RECOVERY_FINAL_QUERY } from "../../src/do/recoveryAudit";
import { abortMultipartBucketHandle } from "../../src/jobs/multipartBucketAbort";
import {
  observeMultipartBucketParts,
  scanMultipartBucket,
} from "../../src/jobs/multipartBucketInventory";
import {
  advanceMultipartClosure,
  multipartClosureStatus,
  settleMultipartClosure,
} from "../../src/jobs/multipartClosure";
import { R2S3Inventory } from "../../src/r2/s3Inventory";
import { auditOwnerLedger } from "../../src/services/refs";
import { foundationFixture } from "../fixtures/foundation";
import { multipartBucketClient, multipartBucketFixture } from "../fixtures/multipartBucket";
import { multipartInventoryFixture } from "../fixtures/multipartInventory";
import { mutationEnv } from "../fixtures/mutationAdmission";
import { inventoryEnv, uploadsXml } from "../fixtures/s3Inventory";
import { injectBatch } from "../fixtures/uploadEnv";

beforeAll(async () => applyD1Migrations(env.DB, env.TEST_MIGRATIONS));
beforeEach(async () => {
  await env.DB.prepare("UPDATE control SET epoch=1,maintenance=1,gc_paused=1").run();
  await env.DB.prepare(
    "UPDATE r2_binding_probe SET lease_expires_at=1 WHERE lease_token IS NOT NULL",
  ).run();
});
afterEach(() => vi.restoreAllMocks());

async function emptyInventory() {
  const remote = await multipartBucketFixture(false);
  await remote.handle.abort();
  const client = multipartBucketClient(remote);
  client.uploads.mockImplementation(async () => new Response(uploadsXml({ uploads: "" })));
  return client;
}

async function prove(inventory: R2S3Inventory) {
  const app = mutationEnv();
  const actions: string[] = [];
  for (let step = 0; step < 6; step++) {
    const result = await advanceMultipartClosure(app, env.BLOBS, inventory, 1, { quietMs: 1 });
    actions.push(result.action);
    if (result.action === "waiting") await new Promise((resolve) => setTimeout(resolve, 2));
    if (result.action === "proven") {
      expect(actions).toEqual(expect.arrayContaining(["scanned", "proven"]));
      return result.status.id!;
    }
  }
  throw new Error("multipart_closure_not_proven");
}

async function stoppedUpload(options: { share?: boolean } = {}) {
  const f = await multipartInventoryFixture({ known: true, share: options.share === true });
  await f.handle.abort();
  const now = Date.now();
  await atomicBatch(env.DB, [
    {
      sql: `UPDATE uploads SET state='failed',accept_parts=0,in_flight=0,cleanup_pending=1,
        multipart_cleanup_started_at=? WHERE id=?`,
      values: [now, f.id],
    },
    {
      sql: "UPDATE blobs SET state='orphan' WHERE id=?",
      values: [f.blob],
    },
  ]);
  const source = JSON.stringify(new R2S3Inventory(inventoryEnv).source);
  const round = crypto.randomUUID();
  await atomicBatch(env.DB, [
    {
      sql: `INSERT INTO multipart_inventory_scans(
        upload_id,r2_key,source,epoch,round_id,pages,completed_at,next_scan_at
      ) VALUES(?,?,?,?,?,1,?,0)`,
      values: [f.id, f.key, source, 1, round, now],
    },
    {
      sql: `INSERT INTO multipart_inventory_handles(
        id,upload_id,r2_upload_id,first_source,initiated_at,first_seen_at,last_seen_at,last_round_id,
        state,attempts,last_attempt_at,aborted_at
      ) VALUES(?,?,?,?,?,?,?,?, 'aborted',1,?,?)`,
      values: [
        crypto.randomUUID(),
        f.id,
        f.handle.uploadId,
        source,
        now,
        now,
        now,
        round,
        now,
        now,
      ],
    },
  ]);
  return f;
}

it("proves a quiet absence, settles held bytes, and exposes recovery/operator status", async () => {
  const f = await multipartBucketFixture();
  const discovered = multipartBucketClient(f);
  const handleId = (await scanMultipartBucket(mutationEnv(), env.BLOBS, discovered.inventory, 1))
    .handles[0]!.id;
  await observeMultipartBucketParts(mutationEnv(), env.BLOBS, discovered.inventory, 1, handleId);
  const abort = vi.fn(async () => f.handle.abort());
  const bucket = new Proxy(env.BLOBS, {
    get(target, property) {
      if (property === "resumeMultipartUpload") return () => ({ abort });
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  await abortMultipartBucketHandle(
    mutationEnv(),
    bucket,
    discovered.inventory,
    1,
    handleId,
    crypto.randomUUID(),
  );
  const { inventory } = await emptyInventory();
  const closureId = await prove(inventory);
  expect(await scanMultipartBucket(mutationEnv(), env.BLOBS, inventory, 1)).toMatchObject({
    completed: true,
  });
  await env.DB.prepare(
    "UPDATE control SET bootstrap_done_at=1,bootstrap_iss='https://access.invalid',bootstrap_sub=?",
  )
    .bind(f.ids.user)
    .run();
  expect(await env.DB.prepare(RECOVERY_FINAL_QUERY).bind(1).first()).toBeNull();
  expect(await multipartClosureStatus(env.DB, 1, 1)).toMatchObject({
    id: closureId,
    phase: "proven",
    unsettled: { handles: 1, heldBytes: 3 },
  });
  const settled = await settleMultipartClosure(mutationEnv(), env.BLOBS, inventory, 1, closureId, {
    limit: 1,
  });
  expect(settled).toMatchObject({
    handles: 1,
    uploads: 0,
    retried: 0,
    status: { unsettled: { handles: 0, heldBytes: 0 } },
  });
  expect(await auditOwnerLedger(env.DB, f.ids.user)).toMatchObject({
    physical_bytes: 0,
    observed_physical_bytes: 0,
  });
  expect(await env.DB.prepare(RECOVERY_FINAL_QUERY).bind(1).first()).not.toBeNull();
  await runInDurableObject(
    env.CONTROL.get(env.CONTROL.idFromName(CONTROL_NAME)),
    async (_, state) => {
      const control = new ControlDO(state, { ...env, ...inventoryEnv });
      state.storage.sql.exec("UPDATE control_state SET phase='ready',epoch=1 WHERE singleton=1");
      state.storage.sql.exec(
        "UPDATE control_admission SET epoch=1,phase='closed',gc_paused=1 WHERE singleton=1",
      );
      state.storage.sql.exec(
        "UPDATE control_gc_policy SET epoch=1,operator_paused=1,prior_gc_paused=1 WHERE singleton=1",
      );
      await expect(control.inspectMultipartClosure(1, 1)).resolves.toMatchObject({
        closure: { id: closureId, phase: "proven", unsettled: { handles: 0 } },
        audit: { epoch: 1, stage: "users", completed: false },
      });
    },
  );
});

it("releases exact owner/share reservations in bounded resumable steps and recovers a lost D1 reply", async () => {
  const first = await stoppedUpload({ share: true });
  const second = await stoppedUpload();
  const { inventory } = await emptyInventory();
  const closureId = await prove(inventory);
  const fault = injectBatch(
    (sql) => sql.includes("UPDATE reservations SET state='released'"),
    async () => {
      throw new Error("lost_ack");
    },
    true,
  );
  expect(
    await settleMultipartClosure(mutationEnv(fault), env.BLOBS, inventory, 1, closureId, {
      limit: 1,
    }),
  ).toMatchObject({
    uploads: 1,
    absent: 1,
    retried: 0,
    status: { unsettled: { uploads: 1, reservedBytes: 3 } },
  });
  expect(
    await env.DB.prepare("SELECT state FROM reservations WHERE id=?")
      .bind(first.reservation)
      .first("state"),
  ).toBe("released");
  expect(
    await env.DB.prepare("SELECT reserved_bytes FROM shares WHERE id=?")
      .bind(first.share)
      .first("reserved_bytes"),
  ).toBe(0);
  expect(
    await settleMultipartClosure(mutationEnv(), env.BLOBS, inventory, 1, closureId, { limit: 1 }),
  ).toMatchObject({
    uploads: 1,
    absent: 1,
    retried: 0,
    status: { unsettled: { uploads: 0, reservedBytes: 0 } },
  });
  for (const f of [first, second])
    expect(
      await env.DB.prepare("SELECT reserved_bytes FROM users WHERE id=?")
        .bind(f.ids.user)
        .first("reserved_bytes"),
    ).toBe(0);
  expect(
    await env.DB.prepare(
      "SELECT COUNT(*) n FROM multipart_upload_settlements WHERE state='settled'",
    ).first("n"),
  ).toBe(2);
});

it("keeps reservation capacity on an ambiguous HEAD and retries the exact durable claim", async () => {
  const f = await stoppedUpload();
  const { inventory } = await emptyInventory();
  const closureId = await prove(inventory);
  const uncertain = new Proxy(env.BLOBS, {
    get(target, property) {
      if (property === "head")
        return async (key: string) =>
          key === f.key ? Promise.reject(new Error("response_lost")) : target.head(key);
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  const uncertainResult = await settleMultipartClosure(
    mutationEnv(),
    uncertain,
    inventory,
    1,
    closureId,
  );
  expect(uncertainResult).toMatchObject({
    uploads: 1,
    retried: 1,
    r2Calls: 1,
    status: { unsettled: { uploads: 1, reservedBytes: 3 } },
  });
  expect(
    await env.DB.prepare("SELECT state FROM reservations WHERE id=?")
      .bind(f.reservation)
      .first("state"),
  ).toBe("reserved");
  expect(
    await env.DB.prepare(
      "SELECT state,head_calls FROM multipart_upload_settlements WHERE upload_id=?",
    )
      .bind(f.id)
      .first(),
  ).toEqual({ state: "claimed", head_calls: 1 });
  await env.DB.prepare(
    "UPDATE multipart_upload_settlements SET lease_expires_at=1 WHERE upload_id=?",
  )
    .bind(f.id)
    .run();
  expect(
    await settleMultipartClosure(mutationEnv(), env.BLOBS, inventory, 1, closureId),
  ).toMatchObject({
    uploads: 1,
    absent: 1,
    retried: 0,
    status: { unsettled: { uploads: 0, reservedBytes: 0 } },
  });
  expect(
    await env.DB.prepare(
      "SELECT state,head_calls FROM multipart_upload_settlements WHERE upload_id=?",
    )
      .bind(f.id)
      .first(),
  ).toEqual({ state: "settled", head_calls: 2 });
});

it("fences maintenance, epoch changes, and cross-owner settlement identities", async () => {
  const { inventory } = await emptyInventory();
  await env.DB.prepare("UPDATE control SET maintenance=0,gc_paused=0").run();
  await expect(
    advanceMultipartClosure(mutationEnv(), env.BLOBS, inventory, 1, { quietMs: 1 }),
  ).rejects.toThrow();
  await env.DB.prepare("UPDATE control SET maintenance=1,gc_paused=1").run();
  const closureId = await prove(inventory);
  await env.DB.prepare("UPDATE control SET epoch=2").run();
  await expect(multipartClosureStatus(env.DB, 2)).resolves.toMatchObject({
    id: null,
    phase: "idle",
    epoch: 2,
  });
  await expect(
    settleMultipartClosure(mutationEnv(), env.BLOBS, inventory, 1, closureId),
  ).rejects.toThrow();
  await env.DB.prepare("UPDATE control SET epoch=1").run();
  const owner = foundationFixture(crypto.randomUUID(), Date.now() - 1000);
  await atomicBatch(env.DB, owner.statements);
  await expect(
    env.DB.prepare(
      `INSERT INTO multipart_bucket_handle_settlements(
        handle_id,closure_id,owner_id,held_bytes,settled_at
      ) VALUES(?,?,?,?,?)`,
    )
      .bind(crypto.randomUUID(), closureId, owner.ids.user, 0, Date.now())
      .run(),
  ).rejects.toThrow();
});
