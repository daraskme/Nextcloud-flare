import { applyD1Migrations, evictDurableObject, runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { advanceMutations } from "../../src/db/mutationAdmission";
import { atomicBatch } from "../../src/db/primary";
import { CONTROL_NAME, ControlDO } from "../../src/do/ControlDO";
import { EPOCH_PREFIX } from "../../src/do/epochHistory";
import { BINDING_PROBE_KEY } from "../../src/r2/bindingProbe";
import { multipartInventoryFixture } from "../fixtures/multipartInventory";
import { inventoryEnv, uploadsXml, uploadXml } from "../fixtures/s3Inventory";
import { injectBatch } from "../fixtures/uploadEnv";

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
  await control().quiesce(epoch);
  await env.DB.prepare(
    "UPDATE uploads SET cleanup_next_at=9999999999999 WHERE mode='multipart'",
  ).run();
  await env.DB.prepare(
    "UPDATE r2_binding_probe SET lease_expires_at=1 WHERE lease_token IS NOT NULL",
  ).run();
});
afterEach(() => vi.restoreAllMocks());

async function fixture(error = false) {
  const f = await multipartInventoryFixture();
  vi.spyOn(globalThis, "fetch").mockImplementation(async (request) => {
    if (
      request instanceof Request &&
      new URL(request.url).pathname.endsWith(`/${BINDING_PROBE_KEY}`)
    ) {
      const probe = await env.BLOBS.get(BINDING_PROBE_KEY);
      return probe ? new Response(probe.body) : new Response(null, { status: 404 });
    }
    if (error) throw new Error("list_unavailable");
    return new Response(
      uploadsXml({ prefix: f.key, uploads: uploadXml(f.key, f.handle.uploadId) }),
    );
  });
  return f;
}
async function fill(space: string, seeds: string[]) {
  await atomicBatch(
    env.DB,
    seeds.map((id) => ({
      sql: "INSERT INTO mutation_admissions(id,permit_id,space_id,epoch,system,maintenance,requested_at,wait_until) VALUES(?,?,?,?,1,1,strftime('%s','now')*1000,strftime('%s','now')*1000+5000)",
      values: [id, "system:upload.inventory-call:" + id, space, epoch],
    })),
  );
  expect((await advanceMutations(env.DB)).filter((r) => r.state === "active")).toHaveLength(32);
}
async function waiting(space: string, prefix: string) {
  await expect
    .poll(
      () =>
        env.DB.prepare(
          "SELECT COUNT(*) n FROM mutation_admissions WHERE space_id=? AND state='waiting' AND permit_id LIKE ?",
        )
          .bind(space, prefix + "%")
          .first("n"),
      { timeout: 4000, interval: 25 },
    )
    .toBe(1);
}
async function held(id: string) {
  expect(
    await env.DB.prepare("SELECT state FROM reservations WHERE id=?").bind(id).first("state"),
  ).toBe("reserved");
}

it.each(["call", "page", "abort", "release", "observe", "error"] as const)(
  "internal inventory %s waits in the same 32-slot ControlDO queue",
  async (stage) => {
    const f = await fixture(stage === "error"),
      seeds = Array.from({ length: 32 }, () => crypto.randomUUID());
    if (stage === "observe") await env.BLOBS.put(f.key, "abc");
    const prefix = `system:upload.inventory-${stage}:`;
    const outcome = runInDurableObject(control(), async (_, state) => {
      const instance = new ControlDO(state, { ...env, ...inventoryEnv });
      const native = instance.acquireSystemMutation.bind(instance);
      let filled = false;
      instance.acquireSystemMutation = async (r) => {
        if (!filled && r.permitId.startsWith(prefix)) {
          filled = true;
          await fill(f.ids.space, seeds);
        }
        return native(r);
      };
      try {
        return { value: await instance.repairUnidentifiedMultipartUploads(epoch, 1) };
      } catch (error) {
        return { error: String(error) };
      } finally {
        instance.acquireSystemMutation = native;
      }
    });
    try {
      await waiting(f.ids.space, prefix);
      await held(f.reservation);
      expect(
        await env.DB.prepare("SELECT cleanup_token FROM uploads WHERE id=?")
          .bind(f.id)
          .first("cleanup_token"),
      ).toEqual(expect.any(String));
      if (stage === "call")
        expect(
          await env.DB.prepare("SELECT cleanup_calls FROM uploads WHERE id=?")
            .bind(f.id)
            .first("cleanup_calls"),
        ).toBe(0);
      if (stage === "page")
        expect(
          await env.DB.prepare("SELECT pages FROM multipart_inventory_scans WHERE upload_id=?")
            .bind(f.id)
            .first("pages"),
        ).toBe(0);
      if (stage === "abort")
        expect(
          await env.DB.prepare(
            "SELECT state,attempts FROM multipart_inventory_handles WHERE upload_id=?",
          )
            .bind(f.id)
            .first(),
        ).toEqual({ state: "observed", attempts: 1 });
      if (stage === "observe")
        expect(
          await env.DB.prepare("SELECT physical_bytes FROM users WHERE id=?")
            .bind(f.ids.user)
            .first("physical_bytes"),
        ).toBe(0);
      if (stage === "release")
        expect(
          await env.DB.prepare("SELECT state FROM multipart_inventory_handles WHERE upload_id=?")
            .bind(f.id)
            .first("state"),
        ).toBe("aborted");
      await env.DB.prepare("UPDATE mutation_admissions SET state='closed' WHERE id=?")
        .bind(seeds[0]!)
        .run();
      const result = await outcome;
      if ("error" in result) throw new Error(result.error);
      expect(result.value).toMatchObject({
        repair: { aborted: stage === "error" ? 0 : 1, retried: stage === "error" ? 1 : 0 },
        audit: { stage: "users", completed: false },
      });
      const receipts = await env.DB.prepare(
        "SELECT state,committed_at,system,maintenance FROM mutation_admissions WHERE space_id=? AND permit_id LIKE ? AND committed_at IS NOT NULL",
      )
        .bind(f.ids.space, prefix + "%")
        .all();
      expect(receipts.results.length).toBeGreaterThan(0);
      for (const r of receipts.results)
        expect(r).toEqual({
          state: "closed",
          committed_at: expect.any(Number),
          system: 1,
          maintenance: 1,
        });
      await held(f.reservation);
    } finally {
      await env.DB.prepare(
        "UPDATE mutation_admissions SET state='closed' WHERE space_id=? AND state<>'closed'",
      )
        .bind(f.ids.space)
        .run();
      await outcome;
    }
  },
);

it("keeps a lost internal budget ACK across eviction and separately charges its retry", async () => {
  const f = await fixture();
  const result = await runInDurableObject(control(), async (_, state) => {
    const db = injectBatch(
      (sql) => sql.includes("SET cleanup_calls=cleanup_calls+1"),
      async () => {
        throw new Error("ack_lost");
      },
      true,
    );
    const instance = new ControlDO(state, { ...env, ...inventoryEnv, DB: db });
    try {
      return { value: await instance.repairUnidentifiedMultipartUploads(epoch, 1) };
    } catch (error) {
      return { error: String(error) };
    }
  });
  if ("error" in result) throw new Error(result.error);
  expect(result.value.repair).toMatchObject({ r2Calls: 0, aborted: 0, retried: 1 });
  expect(
    await env.DB.prepare("SELECT cleanup_calls FROM uploads WHERE id=?")
      .bind(f.id)
      .first("cleanup_calls"),
  ).toBe(1);
  expect(
    await env.DB.prepare("SELECT COUNT(*) n FROM multipart_inventory_handles WHERE upload_id=?")
      .bind(f.id)
      .first("n"),
  ).toBe(0);
  await held(f.reservation);
  await evictDurableObject(control());
  expect(await control().status()).toMatchObject({ epoch, maintenance: true, gcPaused: true });
  await env.DB.prepare("UPDATE uploads SET cleanup_next_at=0,cleanup_lease_expires_at=0 WHERE id=?")
    .bind(f.id)
    .run();
  const retry = await runInDurableObject(control(), async (_, state) => {
    const instance = new ControlDO(state, { ...env, ...inventoryEnv });
    try {
      return { value: await instance.repairUnidentifiedMultipartUploads(epoch, 1) };
    } catch (error) {
      return { error: String(error) };
    }
  });
  if ("error" in retry) throw new Error(retry.error);
  expect(retry.value.repair).toMatchObject({ r2Calls: 4, aborted: 1, retried: 0 });
  expect(
    await env.DB.prepare("SELECT cleanup_calls FROM uploads WHERE id=?")
      .bind(f.id)
      .first("cleanup_calls"),
  ).toBe(5);
  expect(
    await env.DB.prepare("SELECT state,attempts FROM multipart_inventory_handles WHERE upload_id=?")
      .bind(f.id)
      .first(),
  ).toEqual({ state: "aborted", attempts: 1 });
  await held(f.reservation);
});
