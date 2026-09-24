import { applyD1Migrations, evictDurableObject, runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import {
  advanceMutations,
  commitGlobalMutationAdmission,
  type GlobalMutationAdmission,
  type MutationRequest,
} from "../../src/db/mutationAdmission";
import { grantPermit } from "../../src/db/permits";
import { atomicBatch } from "../../src/db/primary";
import { CONTROL_NAME, ControlDO } from "../../src/do/ControlDO";
import { ControlMutations } from "../../src/do/controlMutations";
import { EPOCH_PREFIX } from "../../src/do/epochHistory";
import { withVerifiedR2Inventory } from "../../src/jobs/r2BindingVerification";
import { BINDING_PROBE_KEY } from "../../src/r2/bindingProbe";
import { R2S3Inventory } from "../../src/r2/s3Inventory";
import { foundationFixture } from "../fixtures/foundation";
import { inventoryEnv } from "../fixtures/s3Inventory";
import { systemMutationFault } from "../fixtures/systemMutationFault";

const control = () => env.CONTROL.get(env.CONTROL.idFromName(CONTROL_NAME));
let epoch = 2,
  space = "";
const globalRequest = () => ({
  permitId: "global:r2.probe-phase:" + crypto.randomUUID(),
  epoch,
  deadline: Date.now() + 5000,
});
beforeAll(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
  await env.BACKUPS.put(
    EPOCH_PREFIX + "1.json",
    JSON.stringify({ epoch: 1, at: 1, reason: "operator" }),
  );
  epoch = (await control().recover()).epoch;
  expect(await env.DB.prepare("SELECT COUNT(*) n FROM users").first("n")).toBe(0);
  const unowned = await control().acquireGlobalMutation(globalRequest());
  expect(unowned).toMatchObject({ space_id: null, system: 1, maintenance: 1 });
  await atomicBatch(env.DB, commitGlobalMutationAdmission(unowned));
  const f = foundationFixture(crypto.randomUUID(), Date.now() - 1000);
  space = f.ids.space;
  await atomicBatch(env.DB, f.statements);
  const object = (await env.BLOBS.put(`u/${f.ids.user}/b/${f.ids.blob}`, "abc"))!;
  await atomicBatch(env.DB, [
    {
      sql: "UPDATE control SET bootstrap_done_at=1,bootstrap_iss='https://access.invalid',bootstrap_sub=?",
      values: [f.ids.user],
    },
    {
      sql: "INSERT INTO blob_storage(blob_id,bytes,r2_etag,observed_at) VALUES(?,3,?,1)",
      values: [f.ids.blob, object.etag],
    },
  ]);
});
beforeEach(async () => {
  await control().quiesce(epoch);
  await env.DB.prepare(
    "UPDATE r2_binding_probe SET lease_expires_at=1 WHERE lease_token IS NOT NULL",
  ).run();
});
afterEach(() => vi.restoreAllMocks());
async function fill(maintenance: 0 | 1) {
  const ids = Array.from({ length: 32 }, () => crypto.randomUUID());
  await atomicBatch(
    env.DB,
    ids.map((id, i) => ({
      sql: "INSERT INTO mutation_admissions(id,permit_id,space_id,epoch,system,maintenance,requested_at,wait_until) VALUES(?,?,?,?,?,?,strftime('%s','now')*1000,strftime('%s','now')*1000+5000)",
      values: [
        id,
        maintenance ? (i % 2 ? "global:r2.probe-phase:" : "system:upload.observe:") + id : id,
        maintenance && i % 2 ? null : space,
        epoch,
        maintenance,
        maintenance,
      ],
    })),
  );
  expect((await advanceMutations(env.DB)).filter((r) => r.state === "active")).toHaveLength(32);
  return ids;
}
async function waiting(prefix: string) {
  await expect
    .poll(
      () =>
        env.DB.prepare(
          "SELECT COUNT(*) n FROM mutation_admissions WHERE state='waiting' AND substr(permit_id,1,length(?))=?",
        )
          .bind(prefix, prefix)
          .first("n"),
      { timeout: 4000, interval: 25 },
    )
    .toBe(1);
}
const readS3 = async () => {
  const probe = await env.BLOBS.get(BINDING_PROBE_KEY);
  return probe ? new Response(probe.body) : new Response(null, { status: 404 });
};
it("open global work waits behind namespace work and returns its slot for a normal permit", async () => {
  await control().beginRecoveryAudit(epoch);
  let complete = false;
  for (let i = 0; i < 30; i++)
    if ((await control().nextRecoveryAuditPage(epoch, 20)).completed) {
      complete = true;
      break;
    }
  expect(complete).toBe(true);
  await control().resumeAdmission(epoch);
  await runInDurableObject(control(), async (instance) => {
    await expect(
      instance.acquireMutation({
        ...globalRequest(),
        spaceId: space,
        system: 1,
        maintenance: 0,
      } as MutationRequest),
    ).rejects.toThrow("mutation_unavailable");
    await expect(
      instance.acquireBootstrapMutation({
        ...globalRequest(),
        spaceId: space,
        system: 1,
        maintenance: 0,
      } as MutationRequest),
    ).rejects.toThrow("mutation_unavailable");
  });
  const ids = await fill(0),
    r = globalRequest(),
    pending = control()
      .acquireGlobalMutation(r)
      .then((value) => value);
  try {
    await waiting(r.permitId);
    await env.DB.prepare("UPDATE mutation_admissions SET state='closed' WHERE id=?")
      .bind(ids[0]!)
      .run();
    const global = await pending;
    expect(global).toMatchObject({ space_id: null, system: 1, maintenance: 0 });
    await atomicBatch(env.DB, commitGlobalMutationAdmission(global));
    const normal = await control().acquireMutation({
      permitId: crypto.randomUUID(),
      spaceId: space,
      epoch,
      deadline: Date.now() + 5000,
    });
    expect(await grantPermit(env.DB, normal.permit_id, space, epoch, normal)).toMatchObject({
      permit_id: normal.permit_id,
    });
  } finally {
    await control().quiesce(epoch);
    await pending.catch(() => {});
  }
});
it.each(["claim", "call", "phase", "release", "error"] as const)(
  "internal probe %s uses the same full coordinator and closed-mode ledger",
  async (kind) => {
    const prefix = `global:r2.probe-${kind}:`;
    vi.spyOn(globalThis, "fetch").mockImplementation(
      kind === "error" ? async () => new Response("0".repeat(64)) : readS3,
    );
    let ids: string[] = [],
      permit = "";
    const pending = runInDurableObject(control(), async (_, state) => {
      const instance = new ControlDO(state, { ...env, ...inventoryEnv });
      const native = instance.acquireGlobalMutation.bind(instance);
      instance.acquireGlobalMutation = async (r) => {
        if (!permit && r.permitId.startsWith(prefix)) {
          permit = r.permitId;
          ids = await fill(1);
        }
        return native(r);
      };
      try {
        return await instance.verifyInventoryBinding(epoch).then(
          () => "verified",
          (e: Error) => e.message,
        );
      } finally {
        instance.acquireGlobalMutation = native;
      }
    });
    try {
      await waiting(prefix);
      expect(
        await env.DB.prepare(
          "SELECT COUNT(*) n FROM mutation_admissions WHERE state='active'",
        ).first("n"),
      ).toBe(32);
      await env.DB.prepare("UPDATE mutation_admissions SET state='closed' WHERE id=?")
        .bind(ids[0]!)
        .run();
      expect(await pending).toBe(kind === "error" ? "r2_binding_mismatch" : "verified");
      expect(
        await env.DB.prepare(
          "SELECT state,committed_at,space_id,system,maintenance FROM mutation_admissions WHERE permit_id=?",
        )
          .bind(permit)
          .first(),
      ).toEqual({
        state: "closed",
        committed_at: expect.any(Number),
        space_id: null,
        system: 1,
        maintenance: 1,
      });
      expect(await control().status()).toMatchObject({ epoch, maintenance: true, gcPaused: true });
    } finally {
      await env.DB.prepare(
        "UPDATE mutation_admissions SET state='closed' WHERE state<>'closed'",
      ).run();
      await pending;
    }
  },
);
it("global direct-ACK loss survives eviction and only a fresh expired-lease generation dispatches", async () => {
  const fault = systemMutationFault("global:r2.probe-call:", "reads");
  const get = vi.fn(env.BLOBS.get.bind(env.BLOBS)),
    put = vi.fn(env.BLOBS.put.bind(env.BLOBS));
  const run = (db = env.DB) =>
    withVerifiedR2Inventory(
      { ...env, DB: db },
      { get, put } as unknown as R2Bucket,
      new R2S3Inventory(inventoryEnv, { fetch: readS3 }),
      epoch,
      async () => true,
    );

  await expect(run(fault.db)).rejects.toThrow();

  expect(get).not.toHaveBeenCalled();
  expect(put).not.toHaveBeenCalled();
  expect(fault.reads()).toBe(0);
  const first = await env.DB.prepare("SELECT nonce FROM r2_binding_probe").first("nonce");

  await evictDurableObject(control());

  await expect(run()).rejects.toThrow();

  expect(get).not.toHaveBeenCalled();
  await env.DB.prepare(
    "UPDATE r2_binding_probe SET lease_expires_at=1 WHERE lease_token IS NOT NULL",
  ).run();

  expect(await run()).toBe(true);

  expect(get).toHaveBeenCalledTimes(1);
  expect(put).toHaveBeenCalledTimes(1);
  expect(await env.DB.prepare("SELECT nonce FROM r2_binding_probe").first("nonce")).not.toBe(first);
});
it("global RPC rejects owner/bootstrap IDs and strips caller scope or mode fields", async () => {
  await runInDurableObject(control(), async (instance) => {
    for (const permitId of [
      crypto.randomUUID(),
      "bootstrap:" + crypto.randomUUID(),
      "system:upload.observe:" + crypto.randomUUID(),
      "global:unlisted:" + crypto.randomUUID(),
    ])
      await expect(
        instance.acquireGlobalMutation({ ...globalRequest(), permitId }),
      ).rejects.toThrow("mutation_unavailable");
    const r = globalRequest();
    await expect(instance.acquireSystemMutation({ ...r, spaceId: space })).rejects.toThrow(
      "mutation_unavailable",
    );
    await expect(
      instance.acquireBootstrapMutation({
        ...r,
        spaceId: space,
        system: 1,
        maintenance: 1,
      } as MutationRequest),
    ).rejects.toThrow("mutation_unavailable");
    const grant = await instance.acquireGlobalMutation({
      ...r,
      spaceId: space,
      system: 0,
      maintenance: 0,
    } as MutationRequest);
    expect(grant).toMatchObject({ space_id: null, system: 1, maintenance: 1 });
    await atomicBatch(env.DB, commitGlobalMutationAdmission(grant));
  });
});
it("global pending RPCs are bounded before an unresolved mode mirror and retain the bound after caller expiry", async () => {
  let finish!: () => void;
  const stalled = new Promise<void>((r) => {
      finish = r;
    }),
    admit = vi.fn(async () => stalled);
  const queue = new ControlMutations(env.DB, admit, () => {});
  const request = {
    ...globalRequest(),
    deadline: Date.now() + 500,
    spaceId: null,
    system: 1 as const,
    maintenance: 1 as const,
  };
  const pending = Array.from({ length: 256 }, () =>
    queue.acquire(request).catch(() => "unavailable"),
  );
  await expect(queue.acquire(request)).rejects.toThrow("mutation_unavailable");
  expect(admit).toHaveBeenCalledTimes(256);
  expect(await Promise.all(pending)).toEqual(Array(256).fill("unavailable"));
  await expect(queue.acquire({ ...request, deadline: Date.now() + 5000 })).rejects.toThrow(
    "mutation_unavailable",
  );
  expect(admit).toHaveBeenCalledTimes(256);
  finish();
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
  const a = (await queue.acquire({
    ...globalRequest(),
    spaceId: null,
    system: 1,
    maintenance: 1,
  })) as GlobalMutationAdmission;
  await atomicBatch(env.DB, commitGlobalMutationAdmission(a));
});
