import { applyD1Migrations } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import type { MutationRequest, SystemMutationAdmission } from "../../src/db/mutationAdmission";
import { repairUnidentifiedMultipartUploads } from "../../src/jobs/multipartInventoryRepair";
import { BINDING_PROBE_KEY } from "../../src/r2/bindingProbe";
import { R2S3Inventory } from "../../src/r2/s3Inventory";
import type { SystemMutationSource } from "../../src/services/systemMutation";
import { multipartInventoryFixture } from "../fixtures/multipartInventory";
import { acquireSystemMutation, mutationEnv } from "../fixtures/mutationAdmission";
import { inventoryEnv, uploadsXml, uploadXml } from "../fixtures/s3Inventory";
import { systemMutationFault } from "../fixtures/systemMutationFault";
import { injectBatch } from "../fixtures/uploadEnv";

beforeAll(() => applyD1Migrations(env.DB, env.TEST_MIGRATIONS));
beforeEach(async () => {
  await env.DB.prepare("UPDATE control SET epoch=1,maintenance=1,gc_paused=1").run();
  await env.DB.prepare(
    "UPDATE r2_binding_probe SET lease_expires_at=1 WHERE lease_token IS NOT NULL",
  ).run();
  await env.DB.prepare(
    "UPDATE uploads SET cleanup_next_at=9999999999999 WHERE mode='multipart'",
  ).run();
  await env.DB.prepare("UPDATE mutation_admissions SET state='closed' WHERE state<>'closed'").run();
});
afterEach(() => vi.restoreAllMocks());
const stages = [
  "reset",
  "call",
  "observe",
  "handle",
  "page",
  "abort",
  "release",
  "handle-error",
  "upload-error",
] as const;
type Stage = (typeof stages)[number];
type Gate = (r: MutationRequest) => Promise<SystemMutationAdmission>;
const prefix = (stage: Stage) =>
  `system:upload.inventory-${stage.endsWith("-error") ? "error" : stage}:`;

async function fixture(stage: Stage) {
  const f = await multipartInventoryFixture();
  let empty = stage === "reset" || stage === "handle";
  const calls = { head: 0, list: 0, abort: 0 };
  const client = new R2S3Inventory(inventoryEnv, {
    fetch: async (request) => {
      if (new URL(request.url).pathname.endsWith(`/${BINDING_PROBE_KEY}`)) {
        const probe = await env.BLOBS.get(BINDING_PROBE_KEY);
        return probe ? new Response(probe.body) : new Response(null, { status: 404 });
      }
      calls.list++;
      if (stage === "upload-error") throw new Error("list_unavailable");
      return new Response(
        uploadsXml({ prefix: f.key, uploads: empty ? "" : uploadXml(f.key, f.handle.uploadId) }),
      );
    },
  });
  if (empty) {
    expect(
      await repairUnidentifiedMultipartUploads(mutationEnv(), env.BLOBS, client, 1),
    ).toMatchObject({ retried: 0 });
    await env.DB.prepare("UPDATE uploads SET cleanup_next_at=0 WHERE id=?").bind(f.id).run();
    if (stage === "reset")
      await env.DB.prepare("UPDATE multipart_inventory_scans SET next_scan_at=0 WHERE upload_id=?")
        .bind(f.id)
        .run();
    else
      await env.DB.prepare("UPDATE uploads SET r2_upload_id=? WHERE id=?")
        .bind(f.handle.uploadId, f.id)
        .run();
    empty = false;
    calls.list = 0;
  }
  if (stage === "observe") await env.BLOBS.put(f.key, "abc");
  const bucket = {
    get: env.BLOBS.get.bind(env.BLOBS),
    put: env.BLOBS.put.bind(env.BLOBS),
    head: async (key: string) => {
      calls.head++;
      return env.BLOBS.head(key);
    },
    resumeMultipartUpload: (key: string, uploadId: string) => ({
      key,
      uploadId,
      abort: async () => {
        calls.abort++;
        if (stage === "handle-error") throw new Error("abort_unconfirmed");
        await env.BLOBS.resumeMultipartUpload(key, uploadId).abort();
      },
    }),
  } as R2Bucket;
  const configure = (gate: Gate = acquireSystemMutation, db = env.DB): SystemMutationSource => ({
    DB: db,
    systemControl: {
      status: () => mutationEnv().CONTROL.get(env.CONTROL.idFromName("fixture")).status(),
      acquireSystemMutation: gate,
    },
  });
  const run = (source = configure(), maxWallMs = 25000) =>
    repairUnidentifiedMultipartUploads(source, bucket, client, 1, { maxUploads: 1, maxWallMs });
  const row = () =>
    env.DB.prepare(
      "SELECT cleanup_token,cleanup_pending,cleanup_error,multipart_cleanup_closed,cleanup_calls FROM uploads WHERE id=?",
    )
      .bind(f.id)
      .first();
  const handles = () =>
    env.DB.prepare(
      "SELECT state,attempts,last_error FROM multipart_inventory_handles WHERE upload_id=?",
    )
      .bind(f.id)
      .all()
      .then((r) => r.results);
  const receipts = () =>
    env.DB.prepare(
      "SELECT state,committed_at,system,maintenance FROM mutation_admissions WHERE space_id=? AND permit_id LIKE ? ORDER BY seq",
    )
      .bind(f.ids.space, prefix(stage) + "%")
      .all()
      .then((r) => r.results);
  const held = async () => {
    expect(
      await env.DB.prepare("SELECT state FROM reservations WHERE id=?")
        .bind(f.reservation)
        .first("state"),
    ).toBe("reserved");
    expect(await row()).toMatchObject({ cleanup_pending: 1, multipart_cleanup_closed: null });
  };
  return { ...f, stage, calls, configure, run, row, handles, receipts, held };
}

it.each(stages)(
  "commits %s through the shared system ledger without releasing reservations",
  async (stage) => {
    const f = await fixture(stage);
    expect(await f.run()).toMatchObject({ retried: stage.endsWith("-error") ? 1 : 0 });
    const receipts = await f.receipts();
    expect(receipts.length).toBeGreaterThan(0);
    for (const r of receipts)
      expect(r).toEqual({
        state: "closed",
        committed_at: expect.any(Number),
        system: 1,
        maintenance: 1,
      });
    await f.held();
  },
);

it.each(stages)("keeps %s unchanged when shared admission is unavailable", async (stage) => {
  const f = await fixture(stage);
  let attempts = 0;
  expect(
    await f.run(
      f.configure(async (r) => {
        if (r.permitId.startsWith(prefix(stage))) {
          attempts++;
          throw new Error("queue_full");
        }
        return acquireSystemMutation(r);
      }),
    ),
  ).toMatchObject({ retried: 1 });
  expect(attempts).toBeGreaterThan(0);
  expect(await f.receipts()).toEqual([]);
  expect(await f.row()).toMatchObject({ cleanup_token: expect.any(String) });
  if (["reset", "call", "handle"].includes(stage))
    expect(f.calls).toEqual({ head: 0, list: 0, abort: 0 });
  if (stage === "observe")
    expect(
      await env.DB.prepare("SELECT 1 FROM blob_storage WHERE blob_id=?").bind(f.blob).first(),
    ).toBeNull();
  if (stage === "page") expect(await f.handles()).toEqual([]);
  if (stage === "abort")
    expect(await f.handles()).toMatchObject([{ state: "observed", attempts: 1 }]);
  await f.held();
});

it.each(stages)("recovers %s DB acknowledgements but never replays dispatch", async (stage) => {
  const f = await fixture(stage),
    fault = systemMutationFault(prefix(stage), "ack");
  expect(await f.run(f.configure(undefined, fault.db))).toMatchObject({
    retried: stage === "call" || stage.endsWith("-error") ? 1 : 0,
  });
  expect(fault.fired()).toBe(true);
  expect((await f.receipts())[0]).toMatchObject({
    state: "closed",
    committed_at: expect.any(Number),
  });
  if (stage === "call") {
    expect(f.calls).toEqual({ head: 0, list: 0, abort: 0 });
    expect(fault.reads()).toBe(0);
    expect(await f.row()).toMatchObject({ cleanup_calls: 1 });
  } else expect(fault.reads()).toBeGreaterThan(0);
  await f.held();
});

it.each(stages)("rolls back %s and retains its unresolved admission", async (stage) => {
  const f = await fixture(stage),
    fault = systemMutationFault(prefix(stage), "rollback");
  expect(await f.run(f.configure(undefined, fault.db))).toMatchObject({ retried: 1 });
  expect(fault.fired()).toBe(true);
  expect((await f.receipts())[0]).toMatchObject({ state: "active", committed_at: null });
  expect(await f.row()).toMatchObject({ cleanup_token: expect.any(String) });
  if (stage === "page") expect(await f.handles()).toEqual([]);
  if (stage === "abort")
    expect(await f.handles()).toMatchObject([{ state: "observed", attempts: 1 }]);
  await f.held();
});

it.each(stages)("rechecks the fresh binding proof after waiting for %s", async (stage) => {
  const f = await fixture(stage);
  let expired = false;
  await expect(
    f.run(
      f.configure(async (r) => {
        const receipt = await acquireSystemMutation(r);
        if (r.permitId.startsWith(prefix(stage))) {
          expired = true;
          await env.DB.prepare("UPDATE r2_binding_probe SET lease_expires_at=1").run();
        }
        return receipt;
      }),
    ),
  ).rejects.toThrow("r2_binding_verification_failed");
  expect(expired).toBe(true);
  expect((await f.receipts())[0]).toMatchObject({ state: "active", committed_at: null });
  expect(await f.row()).toMatchObject({ cleanup_token: expect.any(String) });
  await f.held();
});

it.each([1, 2, 3])(
  "never dispatches operation %i from a lost budget ACK or receipt readback",
  async (nth) => {
    const f = await fixture("call"),
      fault = systemMutationFault(prefix("call"), "reads", nth);
    expect(await f.run(f.configure(undefined, fault.db))).toMatchObject({
      r2Calls: nth - 1,
      retried: 1,
      aborted: 0,
    });
    expect(fault.fired()).toBe(true);
    expect(fault.reads()).toBe(0);
    expect(f.calls).toEqual({ head: nth > 1 ? 1 : 0, list: nth > 2 ? 1 : 0, abort: 0 });
    expect(await f.row()).toMatchObject({ cleanup_calls: nth });
    if (nth === 3) expect(await f.handles()).toMatchObject([{ state: "observed", attempts: 1 }]);
    await f.held();
  },
);

it.each(["page", "abort"] as const)(
  "retains exact %s recovery when the common receipt is unreadable",
  async (stage) => {
    const f = await fixture(stage),
      fault = systemMutationFault(prefix(stage), "reads");
    expect(await f.run(f.configure(undefined, fault.db))).toMatchObject({ aborted: 1, retried: 0 });
    expect(fault.fired()).toBe(true);
    expect(f.calls.abort).toBe(1);
    await f.held();
  },
);

it.each(["epoch", "pause", "token", "lease", "pin", "round"] as const)(
  "rechecks %s after waiting for the abort budget",
  async (kind) => {
    const f = await fixture("call");
    let budgets = 0;
    const outcome = f.run(
      f.configure(async (r) => {
        const receipt = await acquireSystemMutation(r);
        if (r.permitId.startsWith(prefix("call")) && ++budgets === 3) {
          if (kind === "epoch") await env.DB.prepare("UPDATE control SET epoch=2").run();
          if (kind === "pause") await env.DB.prepare("UPDATE control SET gc_paused=0").run();
          if (kind === "token")
            await env.DB.prepare("UPDATE uploads SET cleanup_token='replacement' WHERE id=?")
              .bind(f.id)
              .run();
          if (kind === "lease")
            await env.DB.prepare("UPDATE uploads SET cleanup_lease_expires_at=0 WHERE id=?")
              .bind(f.id)
              .run();
          if (kind === "pin")
            await env.DB.prepare(
              "INSERT INTO blob_pins(pin_id,blob_id,purpose,created_at) VALUES(?,?,'backup',1)",
            )
              .bind(crypto.randomUUID(), f.blob)
              .run();
          if (kind === "round")
            await env.DB.prepare(
              "UPDATE multipart_inventory_scans SET round_id=?,pages=0,completed_at=NULL WHERE upload_id=?",
            )
              .bind(crypto.randomUUID(), f.id)
              .run();
        }
        return receipt;
      }),
    );
    if (kind === "epoch" || kind === "pause")
      await expect(outcome).rejects.toThrow("r2_binding_verification_failed");
    else expect(await outcome).toMatchObject({ aborted: 0, retried: 1 });
    expect(f.calls.abort).toBe(0);
    expect(await f.handles()).toMatchObject([{ state: "observed", attempts: 0 }]);
    if (kind === "token")
      expect(await f.row()).toMatchObject({ cleanup_token: "replacement", cleanup_error: null });
    await f.held();
  },
);

it.each(["admission", "ack"] as const)(
  "rechecks the run deadline after slow %s before dispatch",
  async (stage) => {
    const f = await fixture("call");
    const now = Date.now.bind(Date);
    let late = false;
    vi.spyOn(Date, "now").mockImplementation(() => now() + (late ? 30000 : 0));
    const db =
      stage === "ack"
        ? injectBatch(
            (sql) => sql.includes("SET cleanup_calls=cleanup_calls+1"),
            async () => {
              late = true;
            },
            true,
          )
        : env.DB;
    expect(
      await f.run(
        f.configure(async (r) => {
          const receipt = await acquireSystemMutation(r);
          if (stage === "admission" && r.permitId.startsWith(prefix("call"))) late = true;
          return receipt;
        }, db),
      ),
    ).toMatchObject({ r2Calls: 0, retried: 1 });
    expect(f.calls).toEqual({ head: 0, list: 0, abort: 0 });
    expect(await f.row()).toMatchObject({ cleanup_calls: stage === "ack" ? 1 : 0 });
    await f.held();
  },
);

it("records storage facts for a disabled owner with revoked credentials", async () => {
  const f = await fixture("observe");
  await env.DB.prepare("UPDATE users SET disabled_at=1 WHERE id=?").bind(f.ids.user).run();
  await env.DB.prepare("UPDATE sessions SET revoked_at=1 WHERE id=?").bind(f.ids.session).run();
  expect(await f.run()).toMatchObject({ aborted: 1, retried: 0 });
  expect(
    await env.DB.prepare("SELECT physical_bytes,reserved_bytes FROM users WHERE id=?")
      .bind(f.ids.user)
      .first(),
  ).toEqual({ physical_bytes: 3, reserved_bytes: 3 });
  await f.held();
});
