import { applyD1Migrations } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { atomicBatch } from "../../src/db/primary";
import { claimCopyJob, releaseCopyJobClaim } from "../../src/jobs/copyClaim";
import { executeCopyJob } from "../../src/jobs/copyExecutor";
import { cancelCopyJob, cleanupStoppedCopyJob } from "../../src/jobs/copyLifecycle";
import { copyNextBlob } from "../../src/jobs/copyMultipart";
import { reconcileCopyObject } from "../../src/jobs/copyReconcile";
import { auditOwnerLedger } from "../../src/services/refs";
import { copyJobCounters, copyJobFixture } from "../fixtures/copyJob";
import { clearEndedR2TestWrites, mutationEnv } from "../fixtures/mutationAdmission";
import { admitted, injectBatch } from "../fixtures/uploadEnv";

const MiB = 1024 * 1024;
beforeAll(() => applyD1Migrations(env.DB, env.TEST_MIGRATIONS));
beforeEach(async () => {
  await env.DB.prepare("UPDATE control SET maintenance=1").run();
  await env.DB.prepare("UPDATE control SET epoch=1,maintenance=0").run();
});
afterEach(clearEndedR2TestWrites);
const app = (db = env.DB) => ({ ...mutationEnv(db, db), LOCKS: admitted(db).LOCKS });
const run = (f: Awaited<ReturnType<typeof copyJobFixture>>, options = {}, a = app()) =>
  executeCopyJob(a, f.job.outboxId, { partBytes: 8 * MiB, ...options });
const stored = (id: string) =>
  env.DB.prepare("SELECT state,checkpoint,r2_calls,invocation_count FROM bulk_jobs WHERE id=?")
    .bind(id)
    .first();
it.each([0, 3, 9 * MiB])(
  "copies and publishes %s bytes in one invocation and replays without a lease",
  async (size) => {
    const f = await copyJobFixture(size === 0, new Uint8Array(size));
    expect(await run(f)).toMatchObject({ state: "completed", jobId: f.job.id });
    expect(await stored(f.job.id)).toMatchObject({
      state: "completed",
      invocation_count: 1,
      r2_calls: size > 8 * MiB ? 6 : 2,
    });
    const before = await stored(f.job.id);
    expect(await run(f)).toEqual({ state: "completed", jobId: f.job.id, steps: 0 });
    expect(await stored(f.job.id)).toEqual(before);
    expect(await auditOwnerLedger(env.DB, f.target.ids.user)).toMatchObject({
      used_bytes: 3 + size,
      reserved_bytes: 0,
      physical_bytes: size,
      incorrect_refs: 0,
    });
  },
);
it("resumes from each multipart checkpoint without repeating create or part calls", async () => {
  const f = await copyJobFixture(false, new Uint8Array(9 * MiB));
  for (const calls of [1, 3, 5, 6]) {
    expect(await run(f, { maxSteps: 1 })).toMatchObject({ state: "yielded", steps: 1 });
    expect(await copyJobCounters(f.job.id)).toMatchObject({ r2_calls: calls });
    expect(
      await env.DB.prepare("SELECT expires_at FROM job_leases WHERE job_id=?")
        .bind(f.job.id)
        .first("expires_at"),
    ).toBe(0);
  }
  expect(await run(f)).toMatchObject({ state: "completed", steps: 0 });
  expect(await stored(f.job.id)).toMatchObject({ invocation_count: 5, r2_calls: 6 });
});
async function many() {
  const f = await copyJobFixture();
  await cancelCopyJob(mutationEnv(), f.request.principal, f.job.id);
  await cleanupStoppedCopyJob(mutationEnv(), f.job.id);
  for (let i = 0; i < 8; i++) {
    const id = crypto.randomUUID(),
      key = `u/${f.source.ids.user}/b/${id}`;
    const object = await env.BLOBS.put(key, "abc");
    await atomicBatch(env.DB, [
      {
        sql: "INSERT INTO blobs(id,owner_id,r2_key,size,content_etag,state,created_at) VALUES(?,?,?,3,?,'committed',1)",
        values: [id, f.source.ids.user, key, '"b-' + id + '"'],
      },
      {
        sql: "INSERT INTO blob_storage(blob_id,bytes,r2_etag,observed_at) VALUES(?,3,?,1)",
        values: [id, object!.etag],
      },
      {
        sql: "INSERT INTO nodes(id,space_id,owner_id,parent_id,name,name_ci,kind,current_blob_id,created_at,updated_at) VALUES(?,?,?,?,?,?,'file',?,1,1)",
        values: [
          crypto.randomUUID(),
          f.source.ids.space,
          f.source.ids.user,
          f.source.ids.folder,
          "file" + i,
          "file" + i,
          id,
        ],
      },
    ]);
  }
  return { ...f, job: await f.enqueue() };
}
it("yields before a native pair would exceed the invocation budget and finishes the rest", async () => {
  const f = await many();
  expect(await run(f)).toMatchObject({ state: "yielded", steps: 8 });
  expect(await copyJobCounters(f.job.id)).toMatchObject({
    r2_calls: 16,
    lease_calls: 16,
    invocation_count: 1,
  });
  expect(await run(f)).toMatchObject({ state: "completed", steps: 1 });
  expect(await stored(f.job.id)).toMatchObject({ r2_calls: 18, invocation_count: 2 });
  expect(await auditOwnerLedger(env.DB, f.target.ids.user)).toMatchObject({
    used_bytes: 30,
    physical_bytes: 27,
    reserved_bytes: 0,
  });
});
it("publishes at the exact global call limit without reserving another native call", async () => {
  const f = await copyJobFixture();
  await env.DB.prepare("UPDATE bulk_jobs SET r2_calls=19998 WHERE id=?").bind(f.job.id).run();
  expect(await run(f)).toMatchObject({ state: "completed" });
  expect(await stored(f.job.id)).toMatchObject({ r2_calls: 20000 });
});
it("does not prepare a PUT when only one global call remains", async () => {
  const f = await copyJobFixture();
  await env.DB.prepare("UPDATE bulk_jobs SET r2_calls=19999 WHERE id=?").bind(f.job.id).run();
  expect(await run(f)).toMatchObject({ state: "yielded", steps: 0 });
  expect(
    await env.DB.prepare(
      "SELECT transfer_state,transfer_attempt FROM copy_job_blobs WHERE job_id=?",
    )
      .bind(f.job.id)
      .first(),
  ).toEqual({ transfer_state: "pending", transfer_attempt: null });
  expect(await stored(f.job.id)).toMatchObject({ r2_calls: 19999 });
});
it.each(["invocations", "calls", "epoch"])(
  "stops a %s exhausted job without releasing holds",
  async (kind) => {
    const f = await copyJobFixture();
    if (kind === "invocations")
      await env.DB.prepare("UPDATE bulk_jobs SET invocation_count=200 WHERE id=?")
        .bind(f.job.id)
        .run();
    if (kind === "calls")
      await env.DB.prepare("UPDATE bulk_jobs SET r2_calls=20000 WHERE id=?").bind(f.job.id).run();
    if (kind === "epoch") await env.DB.prepare("UPDATE control SET maintenance=1,epoch=2").run();
    expect(await run(f)).toMatchObject({ state: "stopped" });
    expect(await run(f)).toMatchObject({ state: "stopped" });
    expect(await auditOwnerLedger(env.DB, f.target.ids.user)).toMatchObject({
      reserved_bytes: 3,
      physical_bytes: 0,
    });
  },
);
it("leaves an existing live claim intact when another executor starts", async () => {
  const f = await copyJobFixture(),
    claim = await claimCopyJob(mutationEnv(), f.job.outboxId);
  await expect(run(f)).rejects.toThrow();
  expect(
    await env.DB.prepare("SELECT claim_token,expires_at FROM job_leases WHERE job_id=?")
      .bind(f.job.id)
      .first(),
  ).toEqual({ claim_token: claim.token, expires_at: claim.expiresAt });
  await releaseCopyJobClaim(mutationEnv(), claim);
  expect(await run(f)).toMatchObject({ state: "completed" });
});
it("retains a prepared-but-unrecorded attempt on replay", async () => {
  const f = await copyJobFixture();
  const db = injectBatch(
    (s) => s.startsWith("UPDATE copy_job_blobs SET transfer_state='claimed'"),
    async () => {
      throw Error("prepare_reply_lost");
    },
    true,
  );
  await expect(run(f, {}, app(db))).rejects.toThrow();
  expect(await run(f)).toMatchObject({ state: "held", steps: 0 });
  expect(await stored(f.job.id)).toMatchObject({ r2_calls: 1 });
  expect(await env.BLOBS.head(`u/${f.target.ids.user}/b/${f.job.id}_b00001`)).toBeNull();
});
it("reauthorizes after a partial invocation and preserves holds when access is revoked", async () => {
  const f = await copyJobFixture(false, new Uint8Array(9 * MiB));
  expect(await run(f, { maxSteps: 1 })).toMatchObject({ state: "yielded" });
  await f.revoke();
  await expect(run(f)).rejects.toThrow();
  expect(await stored(f.job.id)).toMatchObject({ r2_calls: 1, invocation_count: 1 });
});
it("stops after cancellation during a native PUT and never publishes", async () => {
  const f = await copyJobFixture(),
    a = app();
  a.BLOBS = {
    get: env.BLOBS.get.bind(env.BLOBS),
    put: async (...args: Parameters<R2Bucket["put"]>) => {
      const object = await env.BLOBS.put(...args);
      await cancelCopyJob(mutationEnv(), f.request.principal, f.job.id);
      return object;
    },
  } as unknown as R2Bucket;
  await expect(run(f, {}, a)).rejects.toThrow();
  expect(await run(f)).toMatchObject({ state: "stopped" });
  expect(await stored(f.job.id)).toMatchObject({ state: "cancelled" });
  expect(await auditOwnerLedger(env.DB, f.target.ids.user)).toMatchObject({
    used_bytes: 3,
    reserved_bytes: 3,
    physical_bytes: 3,
  });
});
function failObservation() {
  return new Proxy(env.DB, {
    get(target, key) {
      if (key === "prepare")
        return (sql: string) =>
          target.prepare(
            sql.startsWith("INSERT INTO blob_storage")
              ? "INSERT INTO _assert(v) SELECT 1 WHERE ? IS NOT NULL OR ? IS NOT NULL OR ? IS NOT NULL"
              : sql,
          );
      const value = Reflect.get(target, key);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}
it("repairs a lost observation within the claim budget and publishes without a second PUT", async () => {
  const f = await copyJobFixture();
  await expect(run(f, {}, app(failObservation()))).rejects.toThrow();
  expect(await stored(f.job.id)).toMatchObject({ r2_calls: 2 });
  expect(await run(f)).toMatchObject({ state: "completed", steps: 2 });
  expect(await stored(f.job.id)).toMatchObject({ r2_calls: 3, invocation_count: 2 });
});
it("charges a lost reconciliation read ACK but does not dispatch HEAD", async () => {
  const f = await copyJobFixture(),
    claim = await claimCopyJob(mutationEnv(), f.job.outboxId);
  await expect(copyNextBlob(app(failObservation()), claim)).rejects.toThrow();
  const db = injectBatch(
    (s) => s.startsWith("UPDATE job_leases SET r2_calls"),
    async () => {
      throw Error("lost_read_ack");
    },
    true,
  );
  const head = vi.fn(env.BLOBS.head.bind(env.BLOBS));
  await expect(
    reconcileCopyObject(
      { ...app(db), BLOBS: { head } as unknown as R2Bucket },
      f.job.id,
      f.source.ids.blob,
      claim,
    ),
  ).rejects.toThrow("lost_read_ack");
  expect(head).not.toHaveBeenCalled();
  expect(await copyJobCounters(f.job.id)).toMatchObject({ r2_calls: 3, lease_calls: 3 });
  await releaseCopyJobClaim(mutationEnv(), claim);
});
it("binds executor repair to the original current blob and request-local claim", async () => {
  const f = await copyJobFixture(),
    claim = await claimCopyJob(mutationEnv(), f.job.outboxId);
  for (const [id, blob, current] of [
    [f.job.id, "other", claim],
    ["copy_" + "0".repeat(64), f.source.ids.blob, claim],
    [f.job.id, f.source.ids.blob, { ...claim }],
  ] as const)
    await expect(reconcileCopyObject(app(), id, blob, current)).rejects.toThrow();
  expect(await copyJobCounters(f.job.id)).toMatchObject({ r2_calls: 0, lease_calls: 0 });
  await releaseCopyJobClaim(mutationEnv(), claim);
});
it("refuses an executor repair HEAD after its invocation call budget is spent", async () => {
  const f = await copyJobFixture(),
    claim = await claimCopyJob(mutationEnv(), f.job.outboxId);
  await expect(copyNextBlob(app(failObservation()), claim)).rejects.toThrow();
  await env.DB.prepare("UPDATE job_leases SET r2_calls=16 WHERE job_id=?").bind(f.job.id).run();
  const head = vi.fn(env.BLOBS.head.bind(env.BLOBS));
  await expect(
    reconcileCopyObject(
      { ...app(), BLOBS: { head } as unknown as R2Bucket },
      f.job.id,
      f.source.ids.blob,
      claim,
    ),
  ).rejects.toThrow();
  expect(head).not.toHaveBeenCalled();
  expect(await copyJobCounters(f.job.id)).toMatchObject({ r2_calls: 2, lease_calls: 16 });
  await releaseCopyJobClaim(mutationEnv(), claim);
});
it("finishes a lost publication ACK without repeating the completed execution", async () => {
  const f = await copyJobFixture();
  const db = injectBatch(
    (s) => s.startsWith("UPDATE bulk_jobs SET publish_op_id="),
    async () => {
      throw Error("lost_publication_ack");
    },
    true,
  );
  expect(await run(f, {}, app(db))).toMatchObject({ state: "completed" });
  expect(await run(f)).toMatchObject({ state: "completed", steps: 0 });
  expect(await stored(f.job.id)).toMatchObject({ invocation_count: 1, r2_calls: 2 });
});
it.each([{ maxSteps: 0 }, { maxSteps: 33 }, { partBytes: 1 }, { deadline: 0 }])(
  "rejects invalid execution options %j",
  async (options) => {
    const f = await copyJobFixture();
    await expect(run(f, options)).rejects.toThrow("invalid_copy_execution");
    expect(await stored(f.job.id)).toMatchObject({ invocation_count: 0 });
  },
);
