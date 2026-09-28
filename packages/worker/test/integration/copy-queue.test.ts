import { applyD1Migrations } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { COPY_EXECUTION_LIMITS, claimCopyJob, releaseCopyJobClaim } from "../../src/jobs/copyClaim";
import { executeCopyJob } from "../../src/jobs/copyExecutor";
import {
  cancelCopyJob,
  cleanupStoppedCopyJob,
  stopExpiredCopyJob,
} from "../../src/jobs/copyLifecycle";
import { dispatchOutbox } from "../../src/jobs/outbox";
import { handleOutboxBatch } from "../../src/jobs/queue";
import { auditOwnerLedger } from "../../src/services/refs";
import { copyJobCounters, copyJobFixture, copyJobWithBlobs } from "../fixtures/copyJob";
import { clearEndedR2TestWrites, mutationEnv } from "../fixtures/mutationAdmission";
import { outboxFixture } from "../fixtures/outbox";
import { admitted, injectBatch } from "../fixtures/uploadEnv";

beforeAll(() => applyD1Migrations(env.DB, env.TEST_MIGRATIONS));
beforeEach(async () => {
  await env.DB.prepare("UPDATE control SET maintenance=1").run();
  await env.DB.prepare("UPDATE control SET epoch=1,maintenance=0").run();
});
afterEach(clearEndedR2TestWrites);
const app = (db = env.DB) => ({ ...mutationEnv(db), LOCKS: admitted(db).LOCKS });
type Fixture = Awaited<ReturnType<typeof copyJobFixture>>;
const delivery = (f: Fixture) => ({
  body: { outboxId: f.job.outboxId },
  ack: vi.fn(),
  retry: vi.fn(),
});
const cancel = (f: Fixture) => cancelCopyJob(mutationEnv(), f.request.principal, f.job.id);
async function consume(f: Fixture, a = app()) {
  const message = delivery(f);
  const result = await handleOutboxBatch(a, { messages: [message] });
  expect(message.ack).toHaveBeenCalledTimes(result.acked);
  expect(message.retry).toHaveBeenCalledTimes(result.retried);
  return result;
}
it.each([0, 3, 9 * 1024 * 1024])(
  "executes a %s-byte copy and acks its durable publication",
  async (size) => {
    const f = await copyJobFixture(size === 0, new Uint8Array(size));
    expect(await consume(f)).toEqual({ acked: 1, retried: 0 });
    const before = await copyJobCounters(f.job.id);
    expect(before).toMatchObject({ state: "completed", invocation_count: 1 });
    expect(await consume(f)).toEqual({ acked: 1, retried: 0 });
    expect(await copyJobCounters(f.job.id)).toEqual(before);
    expect(await auditOwnerLedger(env.DB, f.target.ids.user)).toMatchObject({
      used_bytes: 3 + size,
      reserved_bytes: 0,
      physical_bytes: size,
      incorrect_refs: 0,
    });
  },
);
it("retries a yielded copy and resumes it from durable Outbox redispatch", async () => {
  const f = await copyJobWithBlobs(9);
  // Leave exactly one GET+PUT in this claim. Wall-clock yield may happen before
  // 56 real copies on a slower runner; this test specifically exercises R2 yield.
  const prepaid = COPY_EXECUTION_LIMITS.invocationR2Calls - 2;
  const db = injectBatch(
    (s) => s.startsWith("UPDATE bulk_jobs SET state='running',checkpoint="),
    async () => {
      await env.DB.batch([
        env.DB.prepare("UPDATE bulk_jobs SET r2_calls=? WHERE id=?").bind(prepaid, f.job.id),
        env.DB.prepare("UPDATE job_leases SET r2_calls=? WHERE job_id=?").bind(prepaid, f.job.id),
      ]);
    },
    true,
  );
  expect(await consume(f, app(db))).toEqual({ acked: 0, retried: 1 });
  expect(await copyJobCounters(f.job.id)).toMatchObject({
    state: "running",
    r2_calls: COPY_EXECUTION_LIMITS.invocationR2Calls,
    lease_calls: COPY_EXECUTION_LIMITS.invocationR2Calls,
    invocation_count: 1,
  });
  expect(
    await env.DB.prepare("SELECT checkpoint FROM bulk_jobs WHERE id=?")
      .bind(f.job.id)
      .first("checkpoint"),
  ).toBe('{"v":1,"blob":1,"offset":0}');
  await env.DB.prepare("UPDATE outbox SET dispatch_expires_at=0 WHERE outbox_id=?")
    .bind(f.job.outboxId)
    .run();
  const send = vi.fn(async () => ({ metadata: { metrics: { backlogCount: 1, backlogBytes: 0 } } }));
  expect(await dispatchOutbox(mutationEnv(), { send }, f.job.outboxId, 1)).toBe("sent");
  expect(send).toHaveBeenCalledWith({ outboxId: f.job.outboxId }, { contentType: "json" });
  expect(await consume(f)).toEqual({ acked: 1, retried: 0 });
  expect(await copyJobCounters(f.job.id)).toMatchObject({
    r2_calls: prepaid + 18,
    invocation_count: 2,
  });
  expect(await auditOwnerLedger(env.DB, f.target.ids.user)).toMatchObject({
    used_bytes: 30,
    physical_bytes: 27,
    reserved_bytes: 0,
  });
});
it("retains a duplicate behind a live claim without replacing that claim", async () => {
  const f = await copyJobFixture(),
    claim = await claimCopyJob(mutationEnv(), f.job.outboxId);
  expect(await consume(f)).toEqual({ acked: 0, retried: 1 });
  expect(
    await env.DB.prepare("SELECT claim_token FROM job_leases WHERE job_id=?")
      .bind(f.job.id)
      .first("claim_token"),
  ).toBe(claim.token);
  await releaseCopyJobClaim(mutationEnv(), claim);
  expect(await consume(f)).toEqual({ acked: 1, retried: 0 });
});
it("settles a cancelled untouched job before ack and accepts the duplicate", async () => {
  const f = await copyJobFixture();
  await cancel(f);
  expect(await consume(f)).toEqual({ acked: 1, retried: 0 });
  expect(await consume(f)).toEqual({ acked: 1, retried: 0 });
  expect(await auditOwnerLedger(env.DB, f.target.ids.user)).toMatchObject({
    reserved_bytes: 0,
    physical_bytes: 0,
  });
  expect(
    await env.DB.prepare("SELECT COUNT(*) FROM copy_cleanup_receipts WHERE job_id=?")
      .bind(f.job.id)
      .first(),
  ).toEqual({ "COUNT(*)": 1 });
});
it("stops a budget-exhausted job and acks only after proven cleanup", async () => {
  const f = await copyJobFixture();
  await env.DB.prepare("UPDATE bulk_jobs SET invocation_count=200 WHERE id=?").bind(f.job.id).run();
  expect(await consume(f)).toEqual({ acked: 1, retried: 0 });
  expect(await copyJobCounters(f.job.id)).toMatchObject({ state: "failed", r2_calls: 0 });
  expect(await auditOwnerLedger(env.DB, f.target.ids.user)).toMatchObject({ reserved_bytes: 0 });
});
it("retains a stopped multipart with an open handle instead of acking its failed Outbox", async () => {
  const f = await copyJobFixture(false, new Uint8Array(9 * 1024 * 1024));
  await executeCopyJob(app(), f.job.outboxId, { maxSteps: 1 });
  await cancel(f);
  expect(await consume(f)).toEqual({ acked: 0, retried: 1 });
  expect(await auditOwnerLedger(env.DB, f.target.ids.user)).toMatchObject({
    reserved_bytes: 9 * 1024 * 1024,
  });
});
it("settles later holds in bounded pages even when the first native attempt is unknown", async () => {
  const f = await copyJobWithBlobs(34);
  const db = injectBatch(
    (s) => s.startsWith("UPDATE copy_job_blobs SET transfer_state='claimed'"),
    async () => {
      throw Error("lost_prepare_ack");
    },
    true,
  );
  expect(await consume(f, app(db))).toEqual({ acked: 0, retried: 1 });
  await cancel(f);
  expect(await consume(f)).toEqual({ acked: 0, retried: 1 });
  expect(await auditOwnerLedger(env.DB, f.target.ids.user)).toMatchObject({ reserved_bytes: 6 });
  expect(await consume(f)).toEqual({ acked: 0, retried: 1 });
  expect(await auditOwnerLedger(env.DB, f.target.ids.user)).toMatchObject({ reserved_bytes: 3 });
  expect(
    await env.DB.prepare("SELECT COUNT(*) FROM copy_cleanup_receipts WHERE job_id=?")
      .bind(f.job.id)
      .first(),
  ).toEqual({ "COUNT(*)": 33 });
});
it("retains a publication after lost delivery ack and never copies twice", async () => {
  const f = await copyJobFixture(),
    message = delivery(f);
  message.ack.mockImplementationOnce(() => {
    throw Error("delivery_ack_lost");
  });
  expect(await handleOutboxBatch(app(), { messages: [message] })).toEqual({ acked: 0, retried: 1 });
  const before = await copyJobCounters(f.job.id);
  expect(before).toMatchObject({ state: "completed" });
  expect(await consume(f)).toEqual({ acked: 1, retried: 0 });
  expect(await copyJobCounters(f.job.id)).toEqual(before);
});
it("retries revoked access without starting a native write", async () => {
  const f = await copyJobFixture();
  await f.revoke();
  expect(await consume(f)).toEqual({ acked: 0, retried: 1 });
  expect(await copyJobCounters(f.job.id)).toMatchObject({ invocation_count: 0, r2_calls: 0 });
});
it("does not let failed copy receipts fall through when storage bindings are missing", async () => {
  const f = await copyJobFixture();
  await cancel(f);
  expect(
    await handleOutboxBatch(
      { DB: env.DB, CONTROL: mutationEnv().CONTROL },
      { messages: [delivery(f)] },
    ),
  ).toEqual({ acked: 0, retried: 1 });
  expect(await auditOwnerLedger(env.DB, f.target.ids.user)).toMatchObject({ reserved_bytes: 3 });
});
it.each([0, NaN, Infinity, "too_far"])(
  "rejects an invalid shared cleanup/stop deadline %s",
  async (value) => {
    const f = await copyJobFixture();
    await cancel(f);
    const deadline = value === "too_far" ? Date.now() + 60_000 : (value as number);
    await expect(cleanupStoppedCopyJob(mutationEnv(), f.job.id, { deadline })).rejects.toThrow(
      "invalid_copy_cleanup",
    );
    await expect(stopExpiredCopyJob(mutationEnv(), f.job.id, deadline)).rejects.toThrow(
      "invalid_copy_stop",
    );
    expect(await auditOwnerLedger(env.DB, f.target.ids.user)).toMatchObject({ reserved_bytes: 3 });
  },
);
it("gives a copy the invocation budget and retains later copy deliveries", async () => {
  const first = await copyJobFixture(),
    second = await copyJobFixture();
  const done = delivery(first),
    waiting = delivery(second);
  expect(await handleOutboxBatch(app(), { messages: [done, waiting] })).toEqual({
    acked: 1,
    retried: 1,
  });
  expect(waiting.retry).toHaveBeenCalledTimes(1);
  expect(await copyJobCounters(second.job.id)).toMatchObject({
    invocation_count: 0,
    r2_calls: 0,
  });
  expect(await consume(second)).toEqual({ acked: 1, retried: 0 });
});
it.each(["copy", "node"])("does not combine copy and node budgets, first=%s", async (first) => {
  const f = await copyJobFixture(),
    node = await outboxFixture();
  const send = async () => ({ metadata: { metrics: { backlogCount: 1, backlogBytes: 0 } } });
  expect(await dispatchOutbox(mutationEnv(), { send }, node.id, 1)).toBe("sent");
  const copyMessage = delivery(f),
    nodeMessage = { body: { outboxId: node.id }, ack: vi.fn(), retry: vi.fn() };
  const messages = first === "copy" ? [copyMessage, nodeMessage] : [nodeMessage, copyMessage];
  expect(await handleOutboxBatch(app(), { messages })).toEqual({ acked: 1, retried: 1 });
  expect(messages[0]!.ack).toHaveBeenCalledTimes(1);
  expect(messages[1]!.retry).toHaveBeenCalledTimes(1);
  expect(await copyJobCounters(f.job.id)).toMatchObject({
    invocation_count: first === "copy" ? 1 : 0,
  });
  expect(await handleOutboxBatch(app(), { messages: [messages[1]!] })).toEqual({
    acked: 1,
    retried: 0,
  });
});
it("accounts for a real PUT that completes during cancellation, then acks its cleanup", async () => {
  const f = await copyJobFixture(),
    a = app();
  a.BLOBS = {
    get: env.BLOBS.get.bind(env.BLOBS),
    put: async (...args: Parameters<R2Bucket["put"]>) => {
      const object = await env.BLOBS.put(...args);
      await cancel(f);
      return object;
    },
  } as unknown as R2Bucket;
  expect(await consume(f, a)).toEqual({ acked: 0, retried: 1 });
  expect(await consume(f)).toEqual({ acked: 1, retried: 0 });
  expect(await auditOwnerLedger(env.DB, f.target.ids.user)).toMatchObject({
    used_bytes: 3,
    reserved_bytes: 0,
    physical_bytes: 3,
  });
  expect(
    await env.DB.prepare("SELECT state FROM blobs WHERE id=?")
      .bind(f.job.id + "_b00001")
      .first("state"),
  ).toBe("orphan");
});
