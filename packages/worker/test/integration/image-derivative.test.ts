import { applyD1Migrations, evictDurableObject, runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { CONTROL_NAME } from "../../src/do/controlName";
import {
  prepareImageDerivative,
  publishImageDerivative,
  storeImageDerivative,
} from "../../src/jobs/imageDerivative";
import { putFile } from "../../src/services/putFile";
import { auditOwnerLedger } from "../../src/services/refs";
import { davBucket } from "../fixtures/davPut";
import { imageDerivativeFixture as fixture } from "../fixtures/imageDerivative";
import { clearEndedR2TestWrites, mutationEnv } from "../fixtures/mutationAdmission";
import { admitted, injectBatch } from "../fixtures/uploadEnv";

const control = () => env.CONTROL.get(env.CONTROL.idFromName(CONTROL_NAME));
beforeAll(() => applyD1Migrations(env.DB, env.TEST_MIGRATIONS));
beforeEach(async () => {
  await clearEndedR2TestWrites();
  await env.DB.prepare(
    "UPDATE control SET epoch=1,maintenance=0,gc_paused=0,backup_token=NULL,backup_frozen=0,restore_freeze_token=NULL",
  ).run();
  await env.DB.prepare("UPDATE mutation_admissions SET state='closed' WHERE state='active'").run();
  await runInDurableObject(control(), (_, state) => state.storage.deleteAll());
  await evictDurableObject(control());
});
afterEach(() => vi.restoreAllMocks());
it("stores validated WebP once, publishes it, and charges physical rather than logical bytes", async () => {
  const f = await fixture();
  const before = await auditOwnerLedger(env.DB, f.ids.user);
  const result = await storeImageDerivative(f.app, f.grant.id, f.output);
  expect(result.key).toBe(`u/${f.ids.user}/d/${f.node.blob}/image-webp-v1/sm/${f.grant.id}`);
  expect(new Uint8Array(await (await env.BLOBS.get(result.key))!.arrayBuffer())).toEqual(
    f.output.bytes,
  );
  expect(await f.saved()).toMatchObject({
    state: "ready",
    r2_key: result.key,
    size: f.output.bytes.length,
    attempts: 1,
  });
  expect(await auditOwnerLedger(env.DB, f.ids.user)).toMatchObject({
    used_bytes: before!.used_bytes,
    reserved_bytes: 0,
    physical_bytes: before!.physical_bytes + f.output.bytes.length,
    incorrect_refs: 0,
  });
  const put = vi.fn();
  expect(
    await storeImageDerivative({ ...f.app, BLOBS: davBucket({ put }) }, f.grant.id, f.output),
  ).toEqual(result);
  expect(put).not.toHaveBeenCalled();
  expect(
    await env.DB.prepare(
      "SELECT COUNT(*) n FROM r2_write_attempts WHERE kind='image.put' AND r2_key=?",
    )
      .bind(result.key)
      .first<number>("n"),
  ).toBe(1);
  await expect(
    env.DB.prepare("DELETE FROM r2_write_attempts WHERE r2_key=?").bind(result.key).run(),
  ).rejects.toThrow("image_native_receipt_held");
});
it("rejects mismatched bytes before allocating storage or dispatching PUT", async () => {
  const f = await fixture(),
    put = vi.fn();
  const bytes = f.output.bytes.slice();
  bytes[bytes.length - 1] = bytes[bytes.length - 1]! ^ 1;
  await expect(
    storeImageDerivative({ ...f.app, BLOBS: davBucket({ put }) }, f.grant.id, {
      ...f.output,
      bytes,
    }),
  ).rejects.toThrow("output_mismatch");
  expect(put).not.toHaveBeenCalled();
  expect(await f.saved()).toBeNull();
});
it.each(["size", "checksum"])(
  "charges actual stored bytes but refuses a mismatched %s from native storage",
  async (kind) => {
    const f = await fixture();
    const before = await auditOwnerLedger(env.DB, f.ids.user);
    const changed =
      kind === "size" ? new Uint8Array(f.output.bytes.length + 10) : f.output.bytes.slice();
    changed[0] = changed[0]! ^ 1;
    const bucket = davBucket({
      put: async (key: string) => {
        const object = await env.BLOBS.put(key, changed, {
          onlyIf: { etagDoesNotMatch: "*" },
          sha256: await crypto.subtle.digest("SHA-256", changed),
        });
        if (!object) throw new Error("fixture_collision");
        return object;
      },
    });
    await expect(
      storeImageDerivative({ ...f.app, BLOBS: bucket }, f.grant.id, f.output),
    ).rejects.toThrow();
    expect(await f.saved()).toMatchObject({ state: "running" });
    expect(await auditOwnerLedger(env.DB, f.ids.user)).toMatchObject({
      used_bytes: before!.used_bytes,
      reserved_bytes: 0,
      image_reserved_bytes: f.output.bytes.length,
      physical_bytes: before!.physical_bytes + changed.length,
      observed_physical_bytes: before!.observed_physical_bytes + changed.length,
      incorrect_refs: 0,
    });
    expect(
      await env.DB.prepare(
        "SELECT state FROM r2_write_attempts WHERE owner_id=? AND kind='image.put'",
      )
        .bind(f.ids.user)
        .first(),
    ).toEqual({ state: "succeeded" });
  },
);
it("honors quota before storing any derivative", async () => {
  const f = await fixture(),
    put = vi.fn();
  await env.DB.prepare("UPDATE users SET quota_bytes=used_bytes WHERE id=?").bind(f.ids.user).run();
  await expect(
    storeImageDerivative({ ...f.app, BLOBS: davBucket({ put }) }, f.grant.id, f.output),
  ).rejects.toThrow();
  expect(put).not.toHaveBeenCalled();
  expect(await f.saved()).toBeNull();
});
it.each(["credential", "parent", "claim", "epoch"])(
  "retains actual bytes but refuses publication after %s changes",
  async (kind) => {
    const f = await fixture();
    let calls = 0;
    const bucket = davBucket({
      put: async (...args: Parameters<R2Bucket["put"]>) => {
        const object = await env.BLOBS.put(...args);
        calls++;
        if (kind === "credential")
          await env.DB.prepare("UPDATE app_passwords SET revoked_at=? WHERE id=?")
            .bind(Date.now(), f.input.principal.credential_id.slice(3))
            .run();
        if (kind === "parent")
          await env.DB.prepare("UPDATE nodes SET parent_id=? WHERE id=?")
            .bind(f.ids.root, f.node.id)
            .run();
        if (kind === "claim")
          await env.DB.prepare("UPDATE outbox SET claim_token=? WHERE outbox_id=?")
            .bind(crypto.randomUUID(), f.grant.outboxId)
            .run();
        if (kind === "epoch")
          await env.DB.prepare("UPDATE control SET epoch=2,maintenance=1").run();
        return object;
      },
    });
    await expect(
      storeImageDerivative({ ...f.app, BLOBS: bucket }, f.grant.id, f.output),
    ).rejects.toThrow();
    expect(calls).toBe(1);
    expect(await f.saved()).toMatchObject({ state: "running" });
    const ledger = await auditOwnerLedger(env.DB, f.ids.user);
    expect(ledger).toMatchObject({
      physical_bytes: 99 + f.output.bytes.length,
      image_reserved_bytes: f.output.bytes.length,
      incorrect_refs: 0,
    });
    expect(ledger!.physical_bytes).toBe(ledger!.observed_physical_bytes);
  },
);
it("does not PUT after losing the prepare transaction acknowledgement", async () => {
  const f = await fixture(),
    put = vi.fn();
  const db = injectBatch(
    (sql) => sql.includes("INSERT INTO image_derivative_objects"),
    async () => {
      throw new Error("prepare lost");
    },
    true,
  );
  await expect(
    storeImageDerivative({ ...f.app, DB: db, BLOBS: davBucket({ put }) }, f.grant.id, f.output),
  ).rejects.toThrow("prepare lost");
  expect(put).not.toHaveBeenCalled();
  expect(await f.saved()).toMatchObject({ state: "running" });
  expect(await auditOwnerLedger(env.DB, f.ids.user)).toMatchObject({
    image_reserved_bytes: f.output.bytes.length,
  });
});
it("never repeats a PUT whose native response was lost", async () => {
  const f = await fixture();
  let calls = 0;
  const bucket = davBucket({
    put: async (...args: Parameters<R2Bucket["put"]>) => {
      await env.BLOBS.put(...args);
      calls++;
      throw new Error("native lost");
    },
  });
  await expect(
    storeImageDerivative({ ...f.app, BLOBS: bucket }, f.grant.id, f.output),
  ).rejects.toThrow();
  await expect(
    storeImageDerivative({ ...f.app, BLOBS: bucket }, f.grant.id, f.output),
  ).rejects.toThrow();
  expect(calls).toBe(1);
  expect(
    await env.DB.prepare(
      "SELECT state FROM r2_write_attempts WHERE kind='image.put' AND owner_id=?",
    )
      .bind(f.ids.user)
      .first(),
  ).toEqual({ state: "pending" });
  expect(await auditOwnerLedger(env.DB, f.ids.user)).toMatchObject({
    image_reserved_bytes: f.output.bytes.length,
  });
});
it("refuses an existing immutable generation instead of overwriting it", async () => {
  const f = await fixture(),
    claim = await prepareImageDerivative(f.app, f.grant.id, f.output);
  await env.BLOBS.put(claim.key, "collision");
  await expect(storeImageDerivative(f.app, f.grant.id, f.output)).rejects.toThrow(
    "destination_exists",
  );
  expect(await (await env.BLOBS.get(claim.key))!.text()).toBe("collision");
  expect(await f.saved()).toMatchObject({ state: "running" });
});
it("recovers a committed publication acknowledgement without another PUT", async () => {
  const f = await fixture();
  const db = injectBatch(
    (sql) => sql.includes("UPDATE derivative_results SET state='ready'"),
    async () => {
      throw new Error("publish lost");
    },
    true,
  );
  const result = await storeImageDerivative({ ...f.app, DB: db }, f.grant.id, f.output);
  expect(await f.saved()).toMatchObject({ state: "ready", r2_key: result.key });
  expect(await auditOwnerLedger(env.DB, f.ids.user)).toMatchObject({ reserved_bytes: 0 });
});
it("rejects publish, quota release and pin removal without native storage proof", async () => {
  const f = await fixture(),
    claim = await prepareImageDerivative(f.app, f.grant.id, f.output);
  await expect(publishImageDerivative(f.app, claim)).rejects.toThrow();
  await expect(
    env.DB.prepare("UPDATE reservations SET state='released' WHERE id=?").bind(claim.blobId).run(),
  ).rejects.toThrow("unsettled");
  await expect(
    env.DB.prepare("DELETE FROM blob_pins WHERE pin_id=?").bind(claim.blobId).run(),
  ).rejects.toThrow("retained");
  expect(await auditOwnerLedger(env.DB, f.ids.user)).toMatchObject({
    image_reserved_bytes: f.output.bytes.length,
  });
});
it("allows only one native writer for concurrent storage of a generation", async () => {
  const f = await fixture();
  await prepareImageDerivative(f.app, f.grant.id, f.output);
  const put = vi.fn((...args: Parameters<R2Bucket["put"]>) => env.BLOBS.put(...args));
  const results = await Promise.allSettled([
    storeImageDerivative({ ...f.app, BLOBS: davBucket({ put }) }, f.grant.id, f.output),
    storeImageDerivative({ ...f.app, BLOBS: davBucket({ put }) }, f.grant.id, f.output),
  ]);
  expect(results.filter((x) => x.status === "fulfilled")).toHaveLength(1);
  expect(put).toHaveBeenCalledTimes(1);
  expect(await f.saved()).toMatchObject({ state: "ready" });
});
it("rechecks original authority inside the native PUT grant transaction", async () => {
  const f = await fixture();
  await prepareImageDerivative(f.app, f.grant.id, f.output);
  const db = injectBatch(
    (sql) => sql.includes("INSERT INTO r2_write_attempts"),
    async () => {
      await env.DB.prepare("UPDATE app_passwords SET revoked_at=? WHERE id=?")
        .bind(Date.now(), f.input.principal.credential_id.slice(3))
        .run();
    },
    false,
  );
  const put = vi.fn();
  await expect(
    storeImageDerivative(
      { ...mutationEnv(env.DB, db), BLOBS: davBucket({ put }) },
      f.grant.id,
      f.output,
    ),
  ).rejects.toThrow();
  expect(put).not.toHaveBeenCalled();
  expect(await f.saved()).toMatchObject({ state: "running" });
});
it("can generate a thumbnail at full logical quota when physical headroom remains", async () => {
  const f = await fixture();
  const body = new Uint8Array(4096);
  const other = await putFile(admitted(), {
    ...f.input,
    requestId: crypto.randomUUID(),
    name: "other.bin",
    size: body.length,
    body: new Blob([body]).stream(),
  });
  expect(other.kind).toBe("terminal");
  await env.DB.prepare("UPDATE users SET quota_bytes=used_bytes WHERE id=?").bind(f.ids.user).run();
  const before = await auditOwnerLedger(env.DB, f.ids.user);
  const claim = await prepareImageDerivative(f.app, f.grant.id, f.output);
  expect(await auditOwnerLedger(env.DB, f.ids.user)).toMatchObject({
    used_bytes: before!.used_bytes,
    reserved_bytes: 0,
    image_reserved_bytes: f.output.bytes.length,
  });
  await storeImageDerivative(f.app, f.grant.id, f.output);
  expect(await auditOwnerLedger(env.DB, f.ids.user)).toMatchObject({
    used_bytes: before!.used_bytes,
    reserved_bytes: 0,
    image_reserved_bytes: 0,
  });
  expect(await f.saved()).toMatchObject({ state: "ready", r2_key: claim.key });
});
it("accounts for held image capacity when admitting an ordinary upload reservation", async () => {
  const f = await fixture(),
    before = await auditOwnerLedger(env.DB, f.ids.user);
  await env.DB.prepare("UPDATE users SET quota_bytes=? WHERE id=?")
    .bind(Math.ceil((before!.physical_bytes + f.output.bytes.length) / 1.2), f.ids.user)
    .run();
  await prepareImageDerivative(f.app, f.grant.id, f.output);
  await expect(
    env.DB.prepare(
      "INSERT INTO reservations(id,owner_id,bytes,state,expires_at,epoch) VALUES(?,?,20,'reserved',?,1)",
    )
      .bind(crypto.randomUUID(), f.ids.user, Date.now() + 10000)
      .run(),
  ).rejects.toThrow("quota_exceeded");
  expect(await auditOwnerLedger(env.DB, f.ids.user)).toMatchObject({
    reserved_bytes: 0,
    image_reserved_bytes: f.output.bytes.length,
  });
});
