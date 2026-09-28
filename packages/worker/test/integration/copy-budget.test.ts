import { applyD1Migrations } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { claimCopyJob, releaseCopyJobClaim } from "../../src/jobs/copyClaim";
import { executeCopyJob } from "../../src/jobs/copyExecutor";
import { cleanupStoppedCopyJob, stopExpiredCopyJob } from "../../src/jobs/copyLifecycle";
import { repairStoppedCopyJobs } from "../../src/jobs/copyMaintenance";
import { copyNextSmallBlob } from "../../src/jobs/copyPut";
import { handleOutboxBatch } from "../../src/jobs/queue";
import { auditOwnerLedger } from "../../src/services/refs";
import { acquireSystemMutation, commitSystemMutation } from "../../src/services/systemMutation";
import { copyJobCounters, copyJobFixture, copyJobWithBlobs } from "../fixtures/copyJob";
import { clearEndedR2TestWrites, mutationEnv } from "../fixtures/mutationAdmission";
import { admitted, injectBatch } from "../fixtures/uploadEnv";

beforeAll(() => applyD1Migrations(env.DB, env.TEST_MIGRATIONS));
beforeEach(async () => {
  await env.DB.prepare("UPDATE control SET maintenance=1").run();
  await env.DB.prepare("UPDATE control SET epoch=1,maintenance=0,gc_paused=1").run();
});
afterEach(clearEndedR2TestWrites);
const app = (db = env.DB) => ({ ...mutationEnv(db), LOCKS: admitted().LOCKS });
type Fixture = Awaited<ReturnType<typeof copyJobFixture>>;
const counters = (f: Fixture, calls: number, invocations = 0) =>
  env.DB.prepare("UPDATE bulk_jobs SET r2_calls=?,invocation_count=? WHERE id=?")
    .bind(calls, invocations, f.job.id)
    .run();
function noNative() {
  const unexpected = vi.fn(() => {
    throw new Error("unexpected_copy_native");
  });
  return {
    ...app(),
    BLOBS: {
      get: unexpected,
      put: unexpected,
      head: unexpected,
      createMultipartUpload: unexpected,
      resumeMultipartUpload: unexpected,
    } as unknown as R2Bucket,
    unexpected,
  };
}
it.each([3, 9 * 1024 * 1024])(
  "stops %s bytes before dispatch when unavoidable work exceeds remaining calls",
  async (size) => {
    const f = await copyJobFixture(false, new Uint8Array(size)),
      a = noNative(),
      spent = size === 3 ? 19999 : 19997;
    await counters(f, spent);
    expect(await executeCopyJob(a, f.job.outboxId)).toMatchObject({ state: "stopped", steps: 0 });
    expect(a.unexpected).not.toHaveBeenCalled();
    expect(await copyJobCounters(f.job.id)).toMatchObject({
      state: "failed",
      r2_calls: spent,
      invocation_count: 0,
    });
    expect(await auditOwnerLedger(env.DB, f.target.ids.user)).toMatchObject({
      reserved_bytes: size,
      physical_bytes: 0,
    });
    expect(await cleanupStoppedCopyJob(app(), f.job.id)).toMatchObject({
      settled: 1,
      remaining: 0,
    });
    expect(await auditOwnerLedger(env.DB, f.target.ids.user)).toMatchObject({
      reserved_bytes: 0,
      physical_bytes: 0,
    });
  },
);
it("allows a multipart whose four native calls fit the exact remaining budget", async () => {
  const f = await copyJobFixture(false, new Uint8Array(9 * 1024 * 1024));
  await counters(f, 19996);
  expect(await executeCopyJob(app(), f.job.outboxId)).toMatchObject({
    state: "completed",
    steps: 3,
  });
  expect(await copyJobCounters(f.job.id)).toMatchObject({
    state: "completed",
    r2_calls: 20000,
    invocation_count: 1,
  });
});
it("uses the existing smaller part geometry and preserves its handle until proven abort", async () => {
  const f = await copyJobFixture(false, new Uint8Array(9 * 1024 * 1024));
  expect(
    await executeCopyJob(app(), f.job.outboxId, { maxSteps: 1, partBytes: 8 * 1024 * 1024 }),
  ).toMatchObject({ state: "yielded", steps: 1 });
  await counters(f, 19996, 1); // Four left; the fixed two-part upload still needs five.
  const a = noNative();
  expect(await executeCopyJob(a, f.job.outboxId)).toMatchObject({ state: "stopped" });
  expect(a.unexpected).not.toHaveBeenCalled();
  expect(await cleanupStoppedCopyJob(app(), f.job.id)).toMatchObject({
    settled: 0,
    held: 1,
    remaining: 1,
  });
  expect(await repairStoppedCopyJobs(app(), 1, { jobId: f.job.id })).toMatchObject({
    settled: 1,
    remaining: 0,
  });
  expect(await auditOwnerLedger(env.DB, f.target.ids.user)).toMatchObject({
    reserved_bytes: 0,
    physical_bytes: 0,
  });
});
it("uses the remaining invocation count, then Queue acks only after all untouched holds settle", async () => {
  const f = await copyJobWithBlobs(57),
    a = noNative();
  await counters(f, 0, 199);
  const message = { body: { outboxId: f.job.outboxId }, ack: vi.fn(), retry: vi.fn() };
  expect(await handleOutboxBatch(a, { messages: [message] })).toEqual({ acked: 0, retried: 1 });
  expect(await handleOutboxBatch(a, { messages: [message] })).toEqual({ acked: 1, retried: 0 });
  expect(a.unexpected).not.toHaveBeenCalled();
  expect(await copyJobCounters(f.job.id)).toMatchObject({
    state: "failed",
    r2_calls: 0,
    invocation_count: 199,
  });
  expect(await auditOwnerLedger(env.DB, f.target.ids.user)).toMatchObject({
    reserved_bytes: 0,
    physical_bytes: 0,
  });
});
it.each([false, true])(
  "resumes stored data at 20000 calls for DB-only publication (lost checkpoint=%s)",
  async (lost) => {
    const f = await copyJobFixture();
    await counters(f, 19998);
    const claim = await claimCopyJob(app(), f.job.outboxId);
    if (lost) {
      const db = injectBatch(
        (s) => s.startsWith("UPDATE bulk_jobs SET checkpoint"),
        async () => {
          throw new Error("checkpoint_not_committed");
        },
        false,
      );
      await expect(copyNextSmallBlob(app(db), claim)).rejects.toThrow();
    } else expect(await copyNextSmallBlob(app(), claim)).toBe("stored");
    await releaseCopyJobClaim(app(), claim);
    expect(await stopExpiredCopyJob(app(), f.job.id)).toBe(false);
    expect(await repairStoppedCopyJobs(app(), 1, { jobId: f.job.id })).toMatchObject({
      jobId: null,
    });
    const a = noNative();
    expect(await executeCopyJob(a, f.job.outboxId)).toMatchObject({
      state: "completed",
      steps: lost ? 1 : 0,
    });
    expect(a.unexpected).not.toHaveBeenCalled();
    expect(await copyJobCounters(f.job.id)).toMatchObject({
      state: "completed",
      r2_calls: 20000,
      invocation_count: 2,
    });
    expect(await auditOwnerLedger(env.DB, f.target.ids.user)).toMatchObject({
      reserved_bytes: 0,
      physical_bytes: 3,
    });
  },
);
it("retains an unknown final PUT and permits its late observation before DB-only completion", async () => {
  const f = await copyJobFixture();
  await counters(f, 19998);
  const claim = await claimCopyJob(app(), f.job.outboxId);
  let entered!: () => void, finish!: () => void;
  const started = new Promise<void>((r) => {
      entered = r;
    }),
    wait = new Promise<void>((r) => {
      finish = r;
    });
  const a = {
    ...app(),
    BLOBS: {
      get: env.BLOBS.get.bind(env.BLOBS),
      put: async (...args: Parameters<R2Bucket["put"]>) => {
        const result = await env.BLOBS.put(...args);
        entered();
        await wait;
        return result;
      },
    } as unknown as R2Bucket,
  };
  const transfer = copyNextSmallBlob(a, claim),
    rejected = expect(transfer).rejects.toThrow();
  await started;
  await releaseCopyJobClaim(app(), claim);
  expect(await stopExpiredCopyJob(app(), f.job.id)).toBe(false);
  await expect(claimCopyJob(app(), f.job.outboxId)).rejects.toThrow();
  expect(await auditOwnerLedger(env.DB, f.target.ids.user)).toMatchObject({ reserved_bytes: 3 });
  finish();
  await rejected;
  const resumed = noNative();
  expect(await executeCopyJob(resumed, f.job.outboxId)).toMatchObject({ state: "completed" });
  expect(resumed.unexpected).not.toHaveBeenCalled();
  expect(await copyJobCounters(f.job.id)).toMatchObject({ r2_calls: 20000 });
});
it("rechecks a concurrent live claim inside the stop transaction", async () => {
  const f = await copyJobFixture();
  await counters(f, 19999);
  let claim!: Awaited<ReturnType<typeof claimCopyJob>>;
  const db = injectBatch(
    (s) => s.startsWith("UPDATE bulk_jobs SET state="),
    async () => {
      claim = await claimCopyJob(app(), f.job.outboxId);
    },
    false,
  );
  await expect(stopExpiredCopyJob(app(db), f.job.id)).rejects.toThrow();
  expect(await copyJobCounters(f.job.id)).toMatchObject({ state: "running", r2_calls: 19999 });
  expect(await stopExpiredCopyJob(app(), f.job.id)).toBe(false);
  await releaseCopyJobClaim(app(), claim);
  expect(await stopExpiredCopyJob(app(), f.job.id)).toBe(true);
});
it("rejects an unproven budget stop even with a valid system admission", async () => {
  const f = await copyJobFixture();
  const admission = await acquireSystemMutation(app(), f.target.ids.user, "copy.stop");
  await expect(
    commitSystemMutation(env.DB, admission, f.target.ids.user, [
      {
        sql: "UPDATE bulk_jobs SET state='failed',error_code='copy_budget_exhausted',stopped_at=?,stop_epoch=1 WHERE id=?",
        values: [Date.now(), f.job.id],
      },
    ]),
  ).rejects.toThrow("copy_stop_unproven");
  expect(await copyJobCounters(f.job.id)).toMatchObject({
    state: "pending",
    invocation_count: 0,
    r2_calls: 0,
  });
});
