import { applyD1Migrations, runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { atomicBatch } from "../../src/db/primary";
import { CONTROL_NAME, ControlDO } from "../../src/do/ControlDO";
import { EPOCH_PREFIX } from "../../src/do/epochHistory";
import { inspectRecoveryFinalFence, inspectRecoveryPage } from "../../src/do/recoveryAudit";
import {
  type VerifiedR2Inventory,
  withVerifiedR2Inventory,
} from "../../src/jobs/r2BindingVerification";
import { BINDING_PROBE_KEY, BINDING_PROBE_KIND } from "../../src/r2/bindingProbe";
import { R2S3Inventory } from "../../src/r2/s3Inventory";
import { foundationFixture } from "../fixtures/foundation";
import { mutationEnv } from "../fixtures/mutationAdmission";
import { inventoryEnv } from "../fixtures/s3Inventory";
import { injectBatch } from "../fixtures/uploadEnv";

const epoch = 2;
const control = () => env.CONTROL.get(env.CONTROL.idFromName(CONTROL_NAME));
const row = () =>
  env.DB.prepare("SELECT * FROM r2_binding_probe WHERE singleton=1").first<
    Record<string, unknown>
  >();
const expire = () =>
  env.DB.prepare(
    "UPDATE r2_binding_probe SET lease_expires_at=1 WHERE lease_token IS NOT NULL",
  ).run();
const metadata = { customMetadata: { ncf_kind: BINDING_PROBE_KIND } };
const readS3 = async () => {
  const object = await env.BLOBS.get(BINDING_PROBE_KEY);
  return object ? new Response(object.body) : new Response(null, { status: 404 });
};
const client = () => new R2S3Inventory(inventoryEnv, { fetch: readS3 });
const verify = (
  options: {
    db?: D1Database;
    bucket?: R2Bucket;
    inventory?: R2S3Inventory;
    action?: (verified: VerifiedR2Inventory) => Promise<unknown>;
  } = {},
) =>
  withVerifiedR2Inventory(
    mutationEnv(options.db ?? env.DB),
    options.bucket ?? env.BLOBS,
    options.inventory ?? client(),
    epoch,
    options.action ?? (async (v) => v.observation),
  );
const audit = () => inspectRecoveryPage(env.DB, env.BLOBS, epoch, { stage: "r2", afterId: "" }, 20);

beforeAll(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
  await env.BACKUPS.put(
    `${EPOCH_PREFIX}1.json`,
    JSON.stringify({ epoch: 1, at: 1, reason: "operator" }),
  );
  expect(await control().recover()).toMatchObject({ epoch });
});
beforeEach(async () => {
  await env.DB.prepare("UPDATE control SET epoch=2,maintenance=1,gc_paused=1").run();
  await expire();
});
afterEach(() => vi.restoreAllMocks());

it("creates and rotates a single accounted probe through real R2 conditional writes and signed S3 reads", async () => {
  const fetch = vi.fn(async (request: Request) => {
    expect(new URL(request.url).pathname).toBe(`/test-blobs/${BINDING_PROBE_KEY}`);
    expect(new URL(request.url).search).toBe("");
    expect(request.headers.get("Authorization")).toMatch(/\/auto\/s3\/aws4_request/);
    return readS3();
  });
  const inventory = new R2S3Inventory(inventoryEnv, { fetch });
  expect(await verify({ inventory })).toMatchObject({
    bindingVerified: true,
    source: { bucket: "test-blobs" },
  });
  const first = await row();
  expect(first).toMatchObject({
    generation: 1,
    phase: "idle",
    calls: 3,
    allocated_bytes: 64,
    lease_token: null,
    expected_etag: null,
  });
  expect((await env.BLOBS.head(BINDING_PROBE_KEY))?.size).toBe(64);
  await verify({ inventory });
  const next = await row();
  expect(next).toMatchObject({
    generation: 2,
    phase: "idle",
    calls: 6,
    allocated_bytes: 64,
    expected_etag: first!.r2_etag,
  });
  expect(next!.nonce).not.toBe(first!.nonce);
  expect(next!.r2_etag).not.toBe(first!.r2_etag);
  expect(await env.DB.prepare("SELECT COUNT(*) FROM r2_binding_probe").first()).toEqual({
    "COUNT(*)": 1,
  });
  expect(fetch).toHaveBeenCalledTimes(2);
});

it("rejects a valid nonce copied to a different bucket before the fresh rotation", async () => {
  await verify();
  const oldNonce = (await row())!.nonce as string;
  const action = vi.fn(async () => true);
  await expect(
    verify({
      inventory: new R2S3Inventory(inventoryEnv, { fetch: async () => new Response(oldNonce) }),
      action,
    }),
  ).rejects.toThrow("r2_binding_mismatch");
  expect(action).not.toHaveBeenCalled();
  expect(await row()).toMatchObject({
    phase: "failed",
    allocated_bytes: 64,
    last_error: "r2_binding_mismatch",
  });
  await expect(inspectRecoveryFinalFence(env.DB, epoch)).rejects.toThrow(
    "recovery_final_fence_pending",
  );
  await expect(audit()).rejects.toThrow("recovery_binding_probe_mismatch");
});

it("rejects missing or inaccessible S3 objects without granting authority", async () => {
  for (const status of [404, 403, 503]) {
    await expire();
    const action = vi.fn(async () => true);
    await expect(
      verify({
        inventory: new R2S3Inventory(inventoryEnv, {
          fetch: async () => new Response("secret upstream detail", { status }),
        }),
        action,
      }),
    ).rejects.toThrow(`s3_inventory_http_${status}`);
    expect(action).not.toHaveBeenCalled();
    expect(await row()).toMatchObject({ phase: "failed", allocated_bytes: 64 });
  }
});

it("scopes proof to its callback and rejects both retained functions and saved SQL after return", async () => {
  let proof: VerifiedR2Inventory | undefined;
  let statement: ReturnType<VerifiedR2Inventory["fence"]> | undefined;
  await verify({
    action: async (v) => {
      proof = v;
      statement = v.fence();
      await v.assertCurrent();
      await atomicBatch(env.DB, [statement]);
    },
  });
  expect(() => proof!.fence()).toThrow("r2_binding_scope_closed");
  await expect(proof!.assertCurrent()).rejects.toThrow("r2_binding_scope_closed");
  await expect(atomicBatch(env.DB, [statement!])).rejects.toThrow();
  await verify({
    action: async () => {
      await expect(atomicBatch(env.DB, [statement!])).rejects.toThrow();
    },
  });
});

it.each(["epoch", "maintenance", "gc_paused", "lease"])(
  "rejects a changed %s during S3 read before callback",
  async (field) => {
    const action = vi.fn(async () => true);
    const inventory = new R2S3Inventory(inventoryEnv, {
      fetch: async () => {
        const response = await readS3();
        if (field === "lease") await expire();
        else await env.DB.prepare(`UPDATE control SET ${field}=${field === "epoch" ? 3 : 0}`).run();
        return response;
      },
    });
    await expect(verify({ inventory, action })).rejects.toThrow("r2_binding_verification_failed");
    expect(action).not.toHaveBeenCalled();
  },
);

it("checks maintenance, GC pause and epoch before dispatch", async () => {
  const fetch = vi.fn(readS3);
  const inventory = new R2S3Inventory(inventoryEnv, { fetch });
  for (const values of [
    [0, 1],
    [1, 0],
  ]) {
    await env.DB.prepare("UPDATE control SET maintenance=?,gc_paused=?")
      .bind(...values)
      .run();
    await expect(verify({ inventory })).rejects.toThrow();
  }
  await env.DB.prepare("UPDATE control SET maintenance=1,gc_paused=1").run();
  await expect(
    withVerifiedR2Inventory(mutationEnv(env.DB), env.BLOBS, inventory, 1, async () => true),
  ).rejects.toThrow();
  expect(fetch).not.toHaveBeenCalled();
});

it("denies concurrent claims and detects expiry after a callback", async () => {
  await expect(
    verify({
      action: async (v) => {
        await expect(verify()).rejects.toThrow();
        await v.assertCurrent();
        await expire();
        await expect(v.assertCurrent()).rejects.toThrow();
        return true;
      },
    }),
  ).rejects.toThrow("r2_binding_verification_failed");
});

it.each([true, false])(
  "a delayed conditional PUT cannot overwrite the winning generation (initial=%s)",
  async (initial) => {
    if (initial) await env.BLOBS.delete(BINDING_PROBE_KEY);
    else await verify();
    let entered!: () => void;
    let release!: () => void;
    const pending = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const bucket = {
      get: env.BLOBS.get.bind(env.BLOBS),
      put: async (...args: Parameters<R2Bucket["put"]>) => {
        entered();
        await held;
        return env.BLOBS.put(...args);
      },
    } as R2Bucket;
    const old = verify({ bucket }).then(
      () => "unexpected_success",
      (error: Error) => error.message,
    );
    await pending;
    await expire();
    await verify();
    const winner = await row();
    release();
    expect(await old).toBe("r2_binding_conflict");
    expect(await row()).toEqual(winner);
    expect(await (await env.BLOBS.get(BINDING_PROBE_KEY))!.text()).toBe(winner!.nonce);
  },
);

it.each([
  ["claim", "INSERT INTO r2_binding_probe", 0],
  ["counter", "SET calls=calls+1", 0],
  ["prepared", "SET phase='prepared'", 1],
  ["observation", "SET phase='written'", 2],
  ["verification", "SET phase='verified'", 3],
] as const)(
  "recovers lost %s acknowledgement only for DB facts, then rotates a new nonce",
  async (_name, sql, dispatched) => {
    const get = vi.fn(env.BLOBS.get.bind(env.BLOBS));
    const put = vi.fn(env.BLOBS.put.bind(env.BLOBS));
    const fetch = vi.fn(readS3);
    const db = injectBatch(
      (query) => query.includes(sql),
      async () => {
        throw new Error("lost private acknowledgement");
      },
      true,
    );
    const action = vi.fn(async () => true);
    const result = verify({
      db,
      bucket: { get, put } as unknown as R2Bucket,
      inventory: new R2S3Inventory(inventoryEnv, { fetch }),
      action,
    });
    const direct = _name === "claim" || _name === "counter";
    if (direct) await expect(result).rejects.toThrow("r2_binding_verification_failed");
    else await expect(result).resolves.toBe(true);
    expect(get.mock.calls.length + put.mock.calls.length + fetch.mock.calls.length).toBe(
      direct ? dispatched : 3,
    );
    expect(action).toHaveBeenCalledTimes(direct ? 0 : 1);
    expect(await row()).toMatchObject({ phase: direct ? "failed" : "idle", allocated_bytes: 64 });
    const failedNonce = (await row())!.nonce;
    await expire();
    await verify();
    expect((await row())!.nonce).not.toBe(failedNonce);
    expect((await row())!.phase).toBe("idle");
  },
);

it("reconciles a committed PUT whose response was lost without replaying its nonce", async () => {
  const bucket = {
    get: env.BLOBS.get.bind(env.BLOBS),
    put: async (...args: Parameters<R2Bucket["put"]>) => {
      await env.BLOBS.put(...args);
      throw new Error("lost R2 response secret");
    },
  } as unknown as R2Bucket;
  await expect(verify({ bucket })).rejects.toThrow("r2_binding_verification_failed");
  const failedNonce = (await row())!.nonce;
  expect(await (await env.BLOBS.get(BINDING_PROBE_KEY))!.text()).toBe(failedNonce);
  await expire();
  await verify();
  expect((await row())!.nonce).not.toBe(failedNonce);
});

it("does not overwrite an unrecognized object at the reserved key", async () => {
  await env.BLOBS.put(BINDING_PROBE_KEY, "unexpected existing data");
  await expect(verify()).rejects.toThrow("invalid_r2_binding_probe");
  expect(await (await env.BLOBS.get(BINDING_PROBE_KEY))!.text()).toBe("unexpected existing data");
  // Restore only this test fixture; the production verifier never deletes unknown objects.
  await env.BLOBS.put(BINDING_PROBE_KEY, "a".repeat(64), metadata);
});

it("tracks the system object during recovery and rejects its disappearance or replacement", async () => {
  await verify();
  await expect(audit()).resolves.toMatchObject({ next: { stage: "outbox" } });
  await expect(inspectRecoveryFinalFence(env.DB, epoch)).resolves.toBeUndefined();
  await env.BLOBS.put(BINDING_PROBE_KEY, "d".repeat(64), metadata);
  await expect(audit()).rejects.toThrow("recovery_binding_probe_mismatch");
  await verify();
  await env.BLOBS.delete(BINDING_PROBE_KEY);
  await expect(audit()).rejects.toThrow("recovery_binding_probe_mismatch");
  await verify();
});

it("preserves allocation, immutable identity and reserved catalogue keys", async () => {
  await verify();
  for (const sql of [
    "DELETE FROM r2_binding_probe",
    "UPDATE r2_binding_probe SET allocated_bytes=0",
    "UPDATE r2_binding_probe SET nonce=lower(hex(randomblob(32)))",
    "UPDATE r2_binding_probe SET source='{}'",
    "UPDATE r2_binding_probe SET r2_etag='rewritten'",
    "UPDATE r2_binding_probe SET calls=0",
  ]) {
    await expect(env.DB.prepare(sql).run()).rejects.toThrow();
  }
  const f = foundationFixture(crypto.randomUUID(), Date.now());
  await atomicBatch(env.DB, f.statements);
  await expect(
    env.DB.prepare(
      "INSERT INTO blobs(id,owner_id,r2_key,size,state,created_at) VALUES(?,?,?,64,'orphan',1)",
    )
      .bind(crypto.randomUUID(), f.ids.user, BINDING_PROBE_KEY)
      .run(),
  ).rejects.toThrow("reserved_r2_binding_key");
});

it("runs the configured ControlDO verification, resets audits and exposes no nonce or secrets", async () => {
  vi.spyOn(globalThis, "fetch").mockImplementation(readS3);
  await env.DB.prepare(
    "UPDATE control SET bootstrap_done_at=1,bootstrap_iss='https://access.invalid',bootstrap_sub='binding-test'",
  ).run();
  await runInDurableObject(control(), async (_instance, state) => {
    const configured = new ControlDO(state, { ...env, ...inventoryEnv });
    const result = await configured.verifyInventoryBinding(epoch);
    expect(result).toMatchObject({
      verification: { bindingVerified: true, source: { bucket: "test-blobs" } },
      audit: { epoch, stage: "users", pages: 0, completed: false },
    });
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain((await row())!.nonce);
    expect(serialized).not.toContain(inventoryEnv.R2_INVENTORY_ACCESS_KEY_ID);
    expect(serialized).not.toContain(inventoryEnv.R2_INVENTORY_SECRET_ACCESS_KEY);
    expect(await configured.status()).toMatchObject({ maintenance: true, gcPaused: true });
    await expect(configured.verifyInventoryBinding(1)).rejects.toThrow();
  });
});
