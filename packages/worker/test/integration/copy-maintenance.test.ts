import { applyD1Migrations } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import worker from "../../src/index";
import { claimCopyJob, releaseCopyJobClaim } from "../../src/jobs/copyClaim";
import { executeCopyJob } from "../../src/jobs/copyExecutor";
import { cancelCopyJob, cleanupStoppedCopyJob } from "../../src/jobs/copyLifecycle";
import { repairStoppedCopyJobs } from "../../src/jobs/copyMaintenance";
import {
  COPY_MAINTENANCE_CRON,
  COPY_MAINTENANCE_ELIGIBLE,
  COPY_MAINTENANCE_FROM,
  claimCopyMaintenance,
  releaseCopyMaintenance,
} from "../../src/jobs/copyMaintenanceClaim";
import { copyNextBlob } from "../../src/jobs/copyMultipart";
import { abortStoppedCopyMultipart } from "../../src/jobs/copyMultipartAbort";
import { reconcileCopyObject } from "../../src/jobs/copyReconcile";
import { auditOwnerLedger } from "../../src/services/refs";
import { acquireSystemMutation, commitSystemMutation } from "../../src/services/systemMutation";
import { copyJobFixture, copyJobWithBlobs } from "../fixtures/copyJob";
import { measureD1 } from "../fixtures/d1Calls";
import { clearEndedR2TestWrites, mutationEnv } from "../fixtures/mutationAdmission";
import { admitted, injectBatch } from "../fixtures/uploadEnv";

beforeAll(() => applyD1Migrations(env.DB, env.TEST_MIGRATIONS));
beforeEach(async () => {
  await env.DB.prepare("UPDATE control SET maintenance=1").run();
  await env.DB.prepare("UPDATE control SET epoch=1,maintenance=0,gc_paused=1").run();
});
afterEach(async () => {
  vi.restoreAllMocks();
  await clearEndedR2TestWrites();
});
type Fixture = Awaited<ReturnType<typeof copyJobFixture>>;
const app = (db = env.DB) => ({ ...mutationEnv(db), LOCKS: admitted(db).LOCKS });
const cancel = (f: Fixture) => cancelCopyJob(mutationEnv(), f.request.principal, f.job.id);
const run = (f: Fixture, options = {}, a = app(), epoch = 1) =>
  repairStoppedCopyJobs(a, epoch, { jobId: f.job.id, ...options });
const counters = (f: Fixture) =>
  env.DB.prepare(
    "SELECT cleanup_after,cleanup_calls,cleanup_total_calls,cleanup_expires_at,cleanup_next_at FROM bulk_jobs WHERE id=?",
  )
    .bind(f.job.id)
    .first();
async function eligible(f: Fixture) {
  const admission = await acquireSystemMutation(
    mutationEnv(),
    f.target.ids.user,
    "copy.maintenance-release",
  );
  await commitSystemMutation(env.DB, admission, f.target.ids.user, [
    { sql: "UPDATE bulk_jobs SET cleanup_next_at=0 WHERE id=?", values: [f.job.id] },
  ]);
}
async function observedMissing() {
  const f = await copyJobFixture();
  const db = new Proxy(env.DB, {
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
  await expect(executeCopyJob(app(db), f.job.outboxId)).rejects.toThrow();
  await cancel(f);
  return f;
}
async function openMultipart() {
  const f = await copyJobFixture(false, new Uint8Array(9 * 1024 * 1024));
  const claim = await claimCopyJob(mutationEnv(), f.job.outboxId);
  expect(await copyNextBlob(app(), claim)).toBe("initialized");
  await releaseCopyJobClaim(mutationEnv(), claim);
  await cancel(f);
  return f;
}
it("settles cancellation without any surviving Queue delivery", async () => {
  const f = await copyJobFixture();
  await cancel(f);
  expect(await run(f)).toEqual({ jobId: f.job.id, inspected: 1, settled: 1, remaining: 0 });
  expect(await auditOwnerLedger(env.DB, f.target.ids.user)).toMatchObject({
    reserved_bytes: 0,
    physical_bytes: 0,
  });
  expect(await run(f)).toMatchObject({ jobId: null });
  expect(await counters(f)).toMatchObject({ cleanup_calls: 0, cleanup_expires_at: 0 });
});
it("aborts a proven open multipart once and consumes its native receipt for cleanup", async () => {
  const f = await openMultipart();
  expect(await run(f)).toMatchObject({ settled: 1, remaining: 0 });
  expect(await counters(f)).toMatchObject({ cleanup_calls: 1, cleanup_total_calls: 1 });
  expect(
    await env.DB.prepare("SELECT disposition FROM copy_cleanup_receipts WHERE job_id=?")
      .bind(f.job.id)
      .first("disposition"),
  ).toBe("aborted");
  expect(await auditOwnerLedger(env.DB, f.target.ids.user)).toMatchObject({
    reserved_bytes: 0,
    physical_bytes: 0,
  });
});
it("recovers an observed object from native success and keeps physical bytes until GC", async () => {
  const f = await observedMissing();
  expect(await run(f)).toMatchObject({ settled: 1, remaining: 0 });
  expect(await counters(f)).toMatchObject({ cleanup_calls: 1, cleanup_total_calls: 1 });
  expect(await auditOwnerLedger(env.DB, f.target.ids.user)).toMatchObject({
    reserved_bytes: 0,
    physical_bytes: 3,
  });
  expect(
    await env.DB.prepare("SELECT state FROM blobs WHERE id=?")
      .bind(f.job.id + "_b00001")
      .first("state"),
  ).toBe("orphan");
});
it.each(["calls", "invocations", "epoch"])(
  "stops and settles a %s-expired job independently of Queue",
  async (kind) => {
    const f = await copyJobFixture();
    if (kind === "calls")
      await env.DB.prepare("UPDATE bulk_jobs SET r2_calls=20000 WHERE id=?").bind(f.job.id).run();
    if (kind === "invocations")
      await env.DB.prepare("UPDATE bulk_jobs SET invocation_count=200 WHERE id=?")
        .bind(f.job.id)
        .run();
    if (kind === "epoch") await env.DB.prepare("UPDATE control SET epoch=2").run();
    expect(await run(f, {}, app(), kind === "epoch" ? 2 : 1)).toMatchObject({
      settled: 1,
      remaining: 0,
    });
  },
);
it("skips live jobs, closed maintenance, wrong epochs and completed jobs", async () => {
  const f = await copyJobFixture();
  expect(await run(f)).toMatchObject({ jobId: null });
  expect(await executeCopyJob(app(), f.job.outboxId)).toMatchObject({ state: "completed" });
  expect(await run(f)).toMatchObject({ jobId: null });
  const stopped = await copyJobFixture();
  await cancel(stopped);
  expect(await run(stopped, {}, app(), 2)).toMatchObject({ jobId: null });
  await env.DB.prepare("UPDATE control SET maintenance=1").run();
  expect(await run(stopped)).toMatchObject({ jobId: null });
});
it("bounds pages and backs off between passes", async () => {
  const f = await copyJobWithBlobs(9);
  await cancel(f);
  const measured = measureD1(env.DB);
  expect(await run(f, {}, app(measured.db))).toMatchObject({
    inspected: 8,
    settled: 8,
    remaining: 1,
  });
  expect(measured.counts.statements).toBeLessThan(650);
  expect(await run(f)).toMatchObject({ jobId: null });
  await eligible(f);
  expect(await run(f)).toMatchObject({ inspected: 1, settled: 1, remaining: 0 });
});
it("retains unknown attempts, advances before inspecting them, and eventually wraps the cursor", async () => {
  const f = await copyJobWithBlobs(3);
  const db = injectBatch(
    (s) => s.startsWith("UPDATE copy_job_blobs SET transfer_state='claimed'"),
    async () => {
      throw Error("prepare_ack_lost");
    },
    true,
  );
  await expect(executeCopyJob(app(db), f.job.outboxId)).rejects.toThrow();
  await cancel(f);
  const first = await env.DB.prepare(
    "SELECT source_blob_id FROM copy_job_blobs WHERE job_id=? ORDER BY source_blob_id LIMIT 1",
  )
    .bind(f.job.id)
    .first<string>("source_blob_id");
  expect(await run(f, { maxBlobs: 1 })).toMatchObject({ inspected: 1, settled: 1, remaining: 2 });
  expect(await counters(f)).toMatchObject({ cleanup_after: first, cleanup_calls: 0 });
  await eligible(f);
  expect(await run(f, { maxBlobs: 1 })).toMatchObject({ inspected: 1, settled: 1, remaining: 1 });
  expect(await counters(f)).toMatchObject({ cleanup_after: "", cleanup_total_calls: 0 });
  await eligible(f);
  expect(await run(f)).toMatchObject({ inspected: 1, settled: 0, remaining: 1 });
});
it("does not replace a live maintenance lease and rejects fabricated or replaced claims", async () => {
  const f = await observedMissing();
  const first = await claimCopyMaintenance(mutationEnv(), f.job.id, 1, Date.now() + 25000);
  expect(await run(f)).toMatchObject({ jobId: null });
  await expect(
    claimCopyMaintenance(mutationEnv(), f.job.id, 1, Date.now() + 25000),
  ).rejects.toThrow();
  await expect(
    reconcileCopyObject(app(), f.job.id, f.source.ids.blob, undefined, {
      maintenance: { ...first },
    }),
  ).rejects.toThrow("copy_maintenance_unavailable");
  await releaseCopyMaintenance(mutationEnv(), first, false);
  await eligible(f);
  const second = await claimCopyMaintenance(mutationEnv(), f.job.id, 1, Date.now() + 25000);
  await expect(
    reconcileCopyObject(app(), f.job.id, f.source.ids.blob, undefined, { maintenance: first }),
  ).rejects.toThrow();
  await expect(
    abortStoppedCopyMultipart(app(), "copy_" + "0".repeat(64), f.source.ids.blob, {
      maintenance: second,
    }),
  ).rejects.toThrow();
  await expect(
    cleanupStoppedCopyJob(app(), f.job.id, { maintenance: { ...second } }),
  ).rejects.toThrow();
  await releaseCopyMaintenance(mutationEnv(), second, false);
});
it.each(["head", "abort"])(
  "charges a lost %s dispatch ACK without sending or refunding",
  async (kind) => {
    const f = kind === "head" ? await observedMissing() : await openMultipart();
    const db = injectBatch(
      (s) => s.startsWith("UPDATE bulk_jobs SET cleanup_calls=cleanup_calls+1"),
      async () => {
        throw Error("dispatch_ack_lost");
      },
      true,
    );
    const head = vi.fn(env.BLOBS.head.bind(env.BLOBS)),
      resume = vi.fn(env.BLOBS.resumeMultipartUpload.bind(env.BLOBS));
    const a = { ...app(db), BLOBS: { head, resumeMultipartUpload: resume } as unknown as R2Bucket };
    expect(await run(f, {}, a)).toMatchObject({ settled: 0, remaining: 1 });
    expect(head).not.toHaveBeenCalled();
    expect(resume).not.toHaveBeenCalled();
    expect(await counters(f)).toMatchObject({ cleanup_calls: 1, cleanup_total_calls: 1 });
    await eligible(f);
    expect(await run(f)).toMatchObject(
      kind === "head" ? { settled: 1, remaining: 0 } : { settled: 0, remaining: 1 },
    );
    expect(await counters(f)).toMatchObject({ cleanup_total_calls: kind === "head" ? 2 : 1 });
  },
);
it("enforces the eight-call lease budget and retains cumulative accounting across retries", async () => {
  const f = await observedMissing(),
    claim = await claimCopyMaintenance(mutationEnv(), f.job.id, 1, Date.now() + 25000);
  const head = vi.fn(async (key: string) => {
    await env.BLOBS.head(key);
    throw Error("head_reply_lost");
  });
  const a = { ...app(), BLOBS: { head } as unknown as R2Bucket };
  for (let n = 0; n < 8; n++)
    expect(
      await reconcileCopyObject(a, f.job.id, f.source.ids.blob, undefined, { maintenance: claim }),
    ).toBe("held");
  await expect(
    reconcileCopyObject(a, f.job.id, f.source.ids.blob, undefined, { maintenance: claim }),
  ).rejects.toThrow();
  expect(head).toHaveBeenCalledTimes(8);
  await releaseCopyMaintenance(mutationEnv(), claim, false);
  await eligible(f);
  expect(await run(f)).toMatchObject({ settled: 1, remaining: 0 });
  expect(await counters(f)).toMatchObject({ cleanup_calls: 1, cleanup_total_calls: 9 });
});
it("rejects maintenance updates without admission and without conserving call counters", async () => {
  const f = await copyJobFixture();
  await cancel(f);
  await expect(
    env.DB.prepare("UPDATE bulk_jobs SET cleanup_next_at=1 WHERE id=?").bind(f.job.id).run(),
  ).rejects.toThrow("copy_maintenance_unproven");
  const claim = await claimCopyMaintenance(mutationEnv(), f.job.id, 1, Date.now() + 25000);
  const admission = await acquireSystemMutation(
    mutationEnv(),
    f.target.ids.user,
    "copy.reconcile-object",
  );
  await expect(
    commitSystemMutation(env.DB, admission, f.target.ids.user, [
      { sql: "UPDATE bulk_jobs SET cleanup_calls=cleanup_calls+1 WHERE id=?", values: [f.job.id] },
    ]),
  ).rejects.toThrow();
  await releaseCopyMaintenance(mutationEnv(), claim, false);
});
it("runs copy maintenance in its separate Cron invocation", async () => {
  const f = await copyJobFixture();
  await cancel(f);
  const send = vi.fn(),
    list = vi.fn();
  const candidate = await env.DB.prepare(
    `SELECT j.id,j.cleanup_token ${COPY_MAINTENANCE_FROM} WHERE c.epoch=1 AND c.maintenance=0 AND ${COPY_MAINTENANCE_ELIGIBLE} ORDER BY j.cleanup_next_at,j.id LIMIT 1`,
  ).first<{ id: string; cleanup_token: string | null }>();
  expect(candidate).not.toBeNull();
  await worker.scheduled({ cron: COPY_MAINTENANCE_CRON } as ScheduledController, {
    ...app(),
    JOBS: { send } as unknown as Queue,
    BLOBS: { list } as unknown as R2Bucket,
  });
  // Other tests may leave held jobs. This invocation must still avoid unrelated native/Queue work.
  expect(send).not.toHaveBeenCalled();
  expect(list).not.toHaveBeenCalled();
  expect(
    await env.DB.prepare("SELECT cleanup_token FROM bulk_jobs WHERE id=?")
      .bind(candidate!.id)
      .first("cleanup_token"),
  ).not.toBe(candidate!.cleanup_token);
});
it("includes entry admission time in the dedicated Cron deadline", async () => {
  const f = await copyJobFixture();
  await cancel(f);
  const a = app(),
    original = a.CONTROL.get(a.CONTROL.idFromName("singleton")),
    before = await counters(f),
    started = Date.now();
  const now = vi.spyOn(Date, "now");
  a.CONTROL = {
    idFromName: a.CONTROL.idFromName.bind(a.CONTROL),
    get: () => ({
      ...original,
      status: async () => {
        now.mockReturnValue(started + 60_000);
        return { epoch: 1, maintenance: false, gcPaused: true };
      },
    }),
  } as unknown as typeof a.CONTROL;
  try {
    await worker.scheduled({ cron: COPY_MAINTENANCE_CRON } as ScheduledController, a);
  } finally {
    now.mockRestore();
  }
  expect(await counters(f)).toEqual(before);
});
it.each(["claim", "cursor", "cleanup", "release"])(
  "recovers a lost DB-only %s ACK without repeating native I/O",
  async (phase) => {
    const f = await observedMissing();
    const prefixes = {
      claim: "UPDATE bulk_jobs SET cleanup_token",
      cursor: "UPDATE bulk_jobs SET cleanup_after",
      cleanup: "INSERT INTO copy_cleanup_receipts",
      release: "UPDATE bulk_jobs SET cleanup_expires_at=0",
    };
    const db = injectBatch(
      (s) => s.startsWith(prefixes[phase as keyof typeof prefixes]),
      async () => {
        throw Error("db_ack_lost");
      },
      true,
    );
    const head = vi.fn(env.BLOBS.head.bind(env.BLOBS));
    expect(await run(f, {}, { ...app(db), BLOBS: { head } as unknown as R2Bucket })).toMatchObject({
      settled: 1,
      remaining: 0,
    });
    expect(head).toHaveBeenCalledTimes(1);
    expect(await counters(f)).toMatchObject({
      cleanup_calls: 1,
      cleanup_total_calls: 1,
      cleanup_expires_at: 0,
    });
  },
);
it.each(["epoch", "maintenance"])(
  "retains holds if %s changes during an observation HEAD",
  async (kind) => {
    const f = await observedMissing();
    const head = async (key: string) => {
      const object = await env.BLOBS.head(key);
      await env.DB.prepare(
        kind === "epoch" ? "UPDATE control SET epoch=2" : "UPDATE control SET maintenance=1",
      ).run();
      return object;
    };
    await expect(
      run(f, {}, { ...app(), BLOBS: { head } as unknown as R2Bucket }),
    ).rejects.toThrow();
    expect(await counters(f)).toMatchObject({ cleanup_calls: 1, cleanup_total_calls: 1 });
    expect(await auditOwnerLedger(env.DB, f.target.ids.user)).toMatchObject({
      reserved_bytes: 3,
      physical_bytes: 0,
    });
  },
);
it.each([{ maxBlobs: 0 }, { maxBlobs: 9 }, { deadline: 0 }, { jobId: "other" }])(
  "rejects invalid limits %j before claiming",
  async (options) => {
    await expect(repairStoppedCopyJobs(app(), 1, options)).rejects.toThrow(
      "invalid_copy_maintenance",
    );
  },
);
