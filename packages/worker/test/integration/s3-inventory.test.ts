import { applyD1Migrations, runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterEach, beforeAll, expect, it, vi } from "vitest";
import { atomicBatch } from "../../src/db/primary";
import { CONTROL_NAME, ControlDO } from "../../src/do/ControlDO";
import { EPOCH_PREFIX } from "../../src/do/epochHistory";
import { inspectMultipartInventory } from "../../src/jobs/multipartInventory";
import { R2S3Inventory } from "../../src/r2/s3Inventory";
import { foundationFixture } from "../fixtures/foundation";
import { inventoryEnv, lifecycleRule, partsXml, uploadsXml, xml } from "../fixtures/s3Inventory";

const control = () => env.CONTROL.get(env.CONTROL.idFromName(CONTROL_NAME));
const f = foundationFixture(crypto.randomUUID(), Date.now() - 1000);
const reservation = crypto.randomUUID();

beforeAll(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
  await env.BACKUPS.put(
    `${EPOCH_PREFIX}1.json`,
    JSON.stringify({ epoch: 1, at: 1, reason: "operator" }),
  );
  expect(await control().recover()).toMatchObject({ epoch: 2 });
  await atomicBatch(env.DB, f.statements);
  await env.DB.prepare(
    "UPDATE control SET bootstrap_done_at=1,bootstrap_iss='https://access.invalid',bootstrap_sub=? WHERE singleton=1",
  )
    .bind(f.ids.user)
    .run();
  await env.DB.prepare(
    "INSERT INTO reservations(id,owner_id,bytes,state,expires_at,epoch) VALUES(?,?,123,'reserved',?,1)",
  )
    .bind(reservation, f.ids.user, Date.now() + 60_000)
    .run();
});

afterEach(() => vi.restoreAllMocks());

it("performs real WebCrypto signing in workerd and returns diagnostic upload/part/lifecycle pages", async () => {
  const fetch = vi.fn(async (request: Request) => {
    expect(request.headers.get("Authorization")).toMatch(/\/auto\/s3\/aws4_request/);
    expect(request.redirect).toBe("manual");
    const query = new URL(request.url).searchParams;
    if (query.has("uploads")) return new Response(uploadsXml());
    if (query.has("uploadId")) return new Response(partsXml());
    return new Response(xml("LifecycleConfiguration", lifecycleRule()));
  });
  const client = new R2S3Inventory(inventoryEnv, { fetch });
  expect(await inspectMultipartInventory(env.DB, client, 2, { kind: "uploads" })).toMatchObject({
    kind: "uploads",
    bindingVerified: false,
    closureProven: false,
    source: { bucket: "test-blobs" },
    page: { uploads: [{ uploadId: "upload-1" }] },
  });
  expect(
    await inspectMultipartInventory(env.DB, client, 2, {
      kind: "parts",
      key: "u/owner/b/blob",
      uploadId: "upload-1",
    }),
  ).toMatchObject({
    kind: "parts",
    bindingVerified: false,
    closureProven: false,
    page: { parts: [{ bytes: 123 }] },
  });
  expect(await inspectMultipartInventory(env.DB, client, 2, { kind: "lifecycle" })).toMatchObject({
    kind: "lifecycle",
    bindingVerified: false,
    closureProven: false,
    lifecycle: { sevenDayCoverage: true },
  });
  expect(fetch).toHaveBeenCalledTimes(3);
  expect(
    await env.DB.prepare("SELECT state FROM reservations WHERE id=?")
      .bind(reservation)
      .first("state"),
  ).toBe("reserved");
});

it("requires both maintenance and GC pause before any S3 request", async () => {
  const fetch = vi.fn(async () => new Response(uploadsXml()));
  const client = new R2S3Inventory(inventoryEnv, { fetch });
  for (const [maintenance, paused] of [
    [0, 0],
    [0, 1],
    [1, 0],
  ]) {
    await env.DB.prepare("UPDATE control SET maintenance=?,gc_paused=? WHERE singleton=1")
      .bind(maintenance, paused)
      .run();
    await expect(
      inspectMultipartInventory(env.DB, client, 2, { kind: "uploads" }),
    ).rejects.toThrow();
  }
  await env.DB.prepare("UPDATE control SET maintenance=1,gc_paused=1 WHERE singleton=1").run();
  await expect(inspectMultipartInventory(env.DB, client, 1, { kind: "uploads" })).rejects.toThrow();
  expect(fetch).not.toHaveBeenCalled();
});

it("rejects a late response if the maintenance fence changed during fetch", async () => {
  const client = new R2S3Inventory(inventoryEnv, {
    fetch: async () => {
      await env.DB.prepare("UPDATE control SET gc_paused=0 WHERE singleton=1").run();
      return new Response(uploadsXml({ uploads: "" }));
    },
  });
  try {
    await expect(
      inspectMultipartInventory(env.DB, client, 2, { kind: "uploads" }),
    ).rejects.toThrow();
  } finally {
    await env.DB.prepare("UPDATE control SET gc_paused=1 WHERE singleton=1").run();
  }
});

it("does not release reservations for an empty listing or a missing multipart response", async () => {
  const client = new R2S3Inventory(inventoryEnv, {
    fetch: async () => new Response(uploadsXml({ uploads: "" })),
  });
  expect(await inspectMultipartInventory(env.DB, client, 2, { kind: "uploads" })).toMatchObject({
    closureProven: false,
    page: { uploads: [], next: null },
  });
  const absent = new R2S3Inventory(inventoryEnv, {
    fetch: async () => new Response("<Error><Code>NoSuchUpload</Code></Error>", { status: 404 }),
  });
  await expect(
    inspectMultipartInventory(env.DB, absent, 2, { kind: "parts", key: "u/x", uploadId: "gone" }),
  ).rejects.toThrow("s3_inventory_http_404");
  expect(
    await env.DB.prepare("SELECT state FROM reservations WHERE id=?")
      .bind(reservation)
      .first("state"),
  ).toBe("reserved");
  expect(
    await env.DB.prepare("SELECT reserved_bytes FROM users WHERE id=?")
      .bind(f.ids.user)
      .first("reserved_bytes"),
  ).toBe(123);
});

it("keeps ControlDO diagnostics unavailable without configured S3 credentials", async () => {
  await runInDurableObject(control(), async (instance) => {
    await expect(instance.inspectIncompleteMultipart(2, { kind: "uploads" })).rejects.toThrow(
      "s3_inventory_unconfigured",
    );
  });
  expect(await control().status()).toMatchObject({ epoch: 2, maintenance: true, gcPaused: true });
});

it("resets the recovery audit around a configured ControlDO read without reopening admission", async () => {
  const fetch = vi
    .spyOn(globalThis, "fetch")
    .mockImplementation(async () => new Response(uploadsXml()));
  await runInDurableObject(control(), async (_instance, state) => {
    const configured = new ControlDO(state, { ...env, ...inventoryEnv });
    await configured.beginRecoveryAudit(2);
    await configured.nextRecoveryAuditPage(2, 20);
    const result = await configured.inspectIncompleteMultipart(2, { kind: "uploads" });
    expect(result.audit).toMatchObject({ epoch: 2, stage: "users", pages: 0, completed: false });
    expect(result.observation).toMatchObject({
      kind: "uploads",
      closureProven: false,
      bindingVerified: false,
    });
    expect(JSON.stringify(result)).not.toContain(inventoryEnv.R2_INVENTORY_ACCESS_KEY_ID);
    expect(JSON.stringify(result)).not.toContain(inventoryEnv.R2_INVENTORY_SECRET_ACCESS_KEY);
    expect(await configured.status()).toMatchObject({ maintenance: true, gcPaused: true });
  });
  expect(fetch).toHaveBeenCalledTimes(1);
});

it("rejects a stale ControlDO epoch before dispatch and restarts the audit after read failure", async () => {
  const fetch = vi
    .spyOn(globalThis, "fetch")
    .mockImplementation(async () => new Response("unavailable", { status: 503 }));
  await runInDurableObject(control(), async (_instance, state) => {
    const configured = new ControlDO(state, { ...env, ...inventoryEnv });
    await expect(configured.inspectIncompleteMultipart(1, { kind: "uploads" })).rejects.toThrow();
    expect(fetch).not.toHaveBeenCalled();
    await expect(configured.inspectIncompleteMultipart(2, { kind: "uploads" })).rejects.toThrow(
      "s3_inventory_http_503",
    );
    expect(
      state.storage.sql.exec("SELECT stage,pages FROM recovery_audit_v7 WHERE singleton=1").one(),
    ).toMatchObject({ stage: "users", pages: 0 });
  });
  expect(fetch).toHaveBeenCalledTimes(1);
});
