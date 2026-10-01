import { applyD1Migrations } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeAll, beforeEach, expect, it, vi } from "vitest";
import type { MutationRequest } from "../../src/db/mutationAdmission";
import { primary } from "../../src/db/primary";
import {
  inspectRecoveryPage,
  type RecoveryCursor,
  requeueDeliveryExhaustedOutbox,
} from "../../src/do/recoveryAudit";
import type { Env } from "../../src/env";
import worker from "../../src/index";
import { consumeOutbox } from "../../src/jobs/consumeOutbox";
import { type DeadLetterDelivery, handleDeadLetterBatch } from "../../src/jobs/deadLetter";
import { dispatchPendingOutbox, type OutboxSender } from "../../src/jobs/outbox";
import { acquireSystemMutation, mutationEnv } from "../fixtures/mutationAdmission";
import { outboxFixture } from "../fixtures/outbox";

beforeAll(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
});

beforeEach(async () => {
  await env.DB.prepare(`UPDATE control SET epoch=1,maintenance=0,gc_paused=0,
    bootstrap_done_at=NULL,bootstrap_iss=NULL,bootstrap_sub=NULL`).run();
  await env.DB.prepare("UPDATE mutation_admissions SET state='closed' WHERE state<>'closed'").run();
  await env.DB.prepare(
    "UPDATE outbox SET state='completed',dispatch_token=NULL,dispatch_expires_at=NULL,claim_token=NULL,claim_expires_at=NULL",
  ).run();
  await env.DB.prepare(
    "UPDATE outbox_dead_letters SET status='requeued',requeue_count=1 WHERE status='failed'",
  ).run();
  await env.DB.prepare("DELETE FROM job_leases").run();
});

function delivery(
  body: unknown,
  options: { id?: string; attempts?: number; loseAck?: boolean } = {},
) {
  let acked = 0;
  let retried = 0;
  const message: DeadLetterDelivery = {
    id: options.id ?? crypto.randomUUID(),
    attempts: options.attempts ?? 10,
    body,
    ack() {
      if (options.loseAck) throw new Error("queue_ack_lost");
      acked++;
    },
    retry() {
      retried++;
    },
  };
  return { message, counts: () => ({ acked, retried }) };
}

function racingEnv(afterAdmission: () => Promise<void>): Env {
  return {
    ...env,
    CONTROL: {
      idFromName: () => "singleton",
      get: () => ({
        status: async () => ({ epoch: 1, maintenance: false, gcPaused: false }),
        acquireSystemMutation: async (request: MutationRequest) => {
          const admission = await acquireSystemMutation(request);
          await afterAdmission();
          return admission;
        },
      }),
    },
  } as unknown as Env;
}

async function maintenance(ownerId: string): Promise<void> {
  await env.DB.prepare(`UPDATE control SET maintenance=1,gc_paused=1,
    bootstrap_done_at=1,bootstrap_iss='https://access.invalid',bootstrap_sub=?`)
    .bind(ownerId)
    .run();
}

it("durably captures max-attempt metadata and converges after a lost Queue acknowledgement", async () => {
  const f = await outboxFixture();
  const messageId = crypto.randomUUID();
  const lost = delivery({ outboxId: f.id }, { id: messageId, attempts: 10, loseAck: true });
  expect(await handleDeadLetterBatch(mutationEnv(), { messages: [lost.message] })).toEqual({
    acked: 0,
    retried: 1,
  });
  expect(lost.counts()).toEqual({ acked: 0, retried: 1 });
  const grants = await primary(env.DB)
    .prepare(
      "SELECT COUNT(*) AS n FROM mutation_admissions WHERE permit_id LIKE 'system:outbox.dead-letter:%'",
    )
    .first<number>("n");
  const duplicate = delivery({ outboxId: f.id }, { id: messageId, attempts: 11 });
  expect(await handleDeadLetterBatch(mutationEnv(), { messages: [duplicate.message] })).toEqual({
    acked: 1,
    retried: 0,
  });
  expect(
    await primary(env.DB)
      .prepare(`SELECT observed_attempts,status,requeue_count,
        first_observed_at<=last_observed_at AS ordered
        FROM outbox_dead_letters WHERE outbox_id=? AND queue_message_id=?`)
      .bind(f.id, messageId)
      .first(),
  ).toEqual({ observed_attempts: 11, status: "failed", requeue_count: 0, ordered: 1 });
  expect(
    await primary(env.DB)
      .prepare(
        "SELECT COUNT(*) AS n FROM mutation_admissions WHERE permit_id LIKE 'system:outbox.dead-letter:%'",
      )
      .first<number>("n"),
  ).toBe(grants);
});

it("recovers a lost D1 acknowledgement only from the durable failed row and ledger", async () => {
  const f = await outboxFixture();
  let lost = false;
  const db = {
    prepare: env.DB.prepare.bind(env.DB),
    async batch(statements: D1PreparedStatement[]) {
      const result = await env.DB.batch(statements);
      if (!lost) {
        lost = true;
        throw new Error("d1_ack_lost");
      }
      return result;
    },
  } as unknown as D1Database;
  const message = delivery({ outboxId: f.id });
  expect(
    await handleDeadLetterBatch(mutationEnv(db, env.DB), { messages: [message.message] }),
  ).toEqual({ acked: 1, retried: 0 });
  expect(
    await primary(env.DB)
      .prepare(`SELECT b.state,d.status FROM outbox b JOIN outbox_dead_letters d
        ON d.outbox_id=b.outbox_id WHERE b.outbox_id=?`)
      .bind(f.id)
      .first(),
  ).toEqual({ state: "failed", status: "failed" });
});

it("retries live claims, malformed payloads, and unavailable admission without mutation", async () => {
  const f = await outboxFixture();
  await env.DB.prepare("UPDATE outbox SET claim_token='live',claim_expires_at=? WHERE outbox_id=?")
    .bind(Date.now() + 60_000, f.id)
    .run();
  const live = delivery({ outboxId: f.id });
  const malformed = delivery({ outboxId: f.id, extra: true });
  const unavailable = delivery({ outboxId: f.id });
  const rejected = {
    ...mutationEnv(),
    CONTROL: {
      idFromName: () => "singleton",
      get: () => ({
        status: async () => ({ epoch: 1, maintenance: false, gcPaused: false }),
        acquireSystemMutation: async () => {
          throw new Error("mutation_unavailable");
        },
      }),
    },
  } as unknown as Env;
  expect(
    await handleDeadLetterBatch(mutationEnv(), { messages: [live.message, malformed.message] }),
  ).toEqual({ acked: 0, retried: 2 });
  await env.DB.prepare("UPDATE outbox SET claim_expires_at=0 WHERE outbox_id=?").bind(f.id).run();
  expect(await handleDeadLetterBatch(rejected, { messages: [unavailable.message] })).toEqual({
    acked: 0,
    retried: 1,
  });
  expect(
    await primary(env.DB).prepare("SELECT state FROM outbox WHERE outbox_id=?").bind(f.id).first(),
  ).toEqual({ state: "pending" });
});

it.each(["token", "epoch", "maintenance"])(
  "retries when the %s fence changes after admission",
  async (race) => {
    const f = await outboxFixture();
    if (race === "token") {
      await env.DB.prepare(`UPDATE outbox SET state='dispatching',
        dispatch_token='original',dispatch_expires_at=0 WHERE outbox_id=?`)
        .bind(f.id)
        .run();
    }
    const source = racingEnv(async () => {
      if (race === "token")
        await env.DB.prepare("UPDATE outbox SET dispatch_token='replacement' WHERE outbox_id=?")
          .bind(f.id)
          .run();
      if (race === "epoch") await env.DB.prepare("UPDATE control SET epoch=2").run();
      if (race === "maintenance")
        await env.DB.prepare("UPDATE control SET maintenance=1,gc_paused=1").run();
    });
    const message = delivery({ outboxId: f.id });
    expect(await handleDeadLetterBatch(source, { messages: [message.message] })).toEqual({
      acked: 0,
      retried: 1,
    });
    expect(
      await primary(env.DB)
        .prepare("SELECT state FROM outbox WHERE outbox_id=?")
        .bind(f.id)
        .first("state"),
    ).not.toBe("failed");
    expect(
      await primary(env.DB)
        .prepare("SELECT 1 FROM outbox_dead_letters WHERE outbox_id=?")
        .bind(f.id)
        .first(),
    ).toBeNull();
  },
);

it("retries when the shared batch deadline expires after admission", async () => {
  const f = await outboxFixture();
  const startedAt = Date.now();
  const clock = vi.spyOn(Date, "now").mockReturnValue(startedAt);
  const source = racingEnv(async () => {
    clock.mockReturnValue(startedAt + 25_001);
  });
  const message = delivery({ outboxId: f.id });
  try {
    expect(await handleDeadLetterBatch(source, { messages: [message.message] })).toEqual({
      acked: 0,
      retried: 1,
    });
    expect(
      await primary(env.DB)
        .prepare("SELECT state FROM outbox WHERE outbox_id=?")
        .bind(f.id)
        .first(),
    ).toEqual({ state: "pending" });
  } finally {
    clock.mockRestore();
  }
});

it("retries when rollback proof cannot be read", async () => {
  const f = await outboxFixture();
  let proofReads = 0;
  const db = {
    prepare(query: string) {
      const statement = env.DB.prepare(query);
      if (!query.includes("SELECT 1 FROM outbox_dead_letters d JOIN outbox b")) return statement;
      proofReads++;
      if (proofReads === 1) return statement;
      return {
        bind: () => ({
          first: async () => {
            throw new Error("d1_proof_unreadable");
          },
        }),
      };
    },
    async batch() {
      throw new Error("d1_rollback");
    },
  } as unknown as D1Database;
  const message = delivery({ outboxId: f.id });
  expect(
    await handleDeadLetterBatch(mutationEnv(db, env.DB), { messages: [message.message] }),
  ).toEqual({
    acked: 0,
    retried: 1,
  });
  expect(
    await primary(env.DB).prepare("SELECT state FROM outbox WHERE outbox_id=?").bind(f.id).first(),
  ).toEqual({ state: "pending" });
});

it("routes configured DLQ batches and retries unknown queue names as a whole", async () => {
  const f = await outboxFixture();
  const dlq = delivery({ outboxId: f.id });
  const retryAll = vi.fn();
  await worker.queue(
    {
      queue: env.JOBS_DLQ_NAME,
      messages: [dlq.message],
      retryAll,
    } as unknown as MessageBatch,
    mutationEnv(),
  );
  expect(dlq.counts()).toEqual({ acked: 1, retried: 0 });
  await worker.queue(
    {
      queue: "unexpected-queue",
      messages: [],
      retryAll,
    } as unknown as MessageBatch,
    mutationEnv(),
  );
  expect(retryAll).toHaveBeenCalledTimes(1);
});

it("requeues at most twenty current-epoch delivery failures and is idempotent", async () => {
  const fixtures = [];
  for (let i = 0; i < 21; i++) {
    const f = await outboxFixture();
    fixtures.push(f);
    await env.DB.prepare("UPDATE outbox SET state='failed' WHERE outbox_id=?").bind(f.id).run();
    await env.DB.prepare(`INSERT INTO outbox_dead_letters(
      outbox_id,queue_message_id,observed_attempts,first_observed_at,last_observed_at,status,epoch
    ) VALUES(?,?,10,1,1,'failed',1)`)
      .bind(f.id, crypto.randomUUID())
      .run();
  }
  await env.DB.prepare("UPDATE control SET epoch=2").run();
  const stale = await outboxFixture(undefined, 2);
  await env.DB.prepare("UPDATE outbox SET state='failed' WHERE outbox_id=?").bind(stale.id).run();
  await env.DB.prepare(`INSERT INTO outbox_dead_letters(
    outbox_id,queue_message_id,observed_attempts,first_observed_at,last_observed_at,status,epoch
  ) VALUES(?,?,10,1,1,'failed',2)`)
    .bind(stale.id, crypto.randomUUID())
    .run();
  await env.DB.prepare("UPDATE control SET epoch=1").run();
  const unrecorded = await outboxFixture();
  await env.DB.prepare("UPDATE outbox SET state='failed' WHERE outbox_id=?")
    .bind(unrecorded.id)
    .run();
  const first = fixtures[0];
  if (!first) throw new Error("missing_fixture");
  await maintenance(first.ids.user);
  expect(await requeueDeliveryExhaustedOutbox(mutationEnv(), 1, 20)).toBe(20);
  expect(
    await primary(env.DB)
      .prepare("SELECT COUNT(*) AS n FROM outbox WHERE state='pending'")
      .first<number>("n"),
  ).toBeGreaterThanOrEqual(20);
  expect(await requeueDeliveryExhaustedOutbox(mutationEnv(), 1, 20)).toBe(1);
  expect(await requeueDeliveryExhaustedOutbox(mutationEnv(), 1, 20)).toBe(0);
  expect(
    await primary(env.DB)
      .prepare(`SELECT COUNT(*) AS n FROM outbox_dead_letters
        WHERE status='requeued' AND requeue_count=1`)
      .first<number>("n"),
  ).toBeGreaterThanOrEqual(21);
  expect(
    await primary(env.DB)
      .prepare("SELECT state FROM outbox WHERE outbox_id IN (?,?) ORDER BY outbox_id")
      .bind(stale.id, unrecorded.id)
      .all(),
  ).toMatchObject({ results: [{ state: "failed" }, { state: "failed" }] });
});

it("redispatches the same durable ID and leaves completion to the existing consumer", async () => {
  const f = await outboxFixture();
  const dead = delivery({ outboxId: f.id });
  expect(await handleDeadLetterBatch(mutationEnv(), { messages: [dead.message] })).toEqual({
    acked: 1,
    retried: 0,
  });
  await maintenance(f.ids.user);
  expect(await requeueDeliveryExhaustedOutbox(mutationEnv(), 1, 1)).toBe(1);
  const duplicate = delivery(
    { outboxId: f.id },
    { id: dead.message.id, attempts: dead.message.attempts + 1 },
  );
  expect(await handleDeadLetterBatch(mutationEnv(), { messages: [duplicate.message] })).toEqual({
    acked: 1,
    retried: 0,
  });
  expect(
    await primary(env.DB).prepare("SELECT state FROM outbox WHERE outbox_id=?").bind(f.id).first(),
  ).toEqual({ state: "pending" });
  await env.DB.prepare("UPDATE control SET maintenance=0,gc_paused=0").run();
  const sent: unknown[] = [];
  const queue: OutboxSender = {
    async send(body) {
      sent.push(body);
      return { metadata: { metrics: { backlogCount: 0, backlogBytes: 0 } } };
    },
  };
  expect(await dispatchPendingOutbox(mutationEnv(), queue, 1, 1)).toEqual({
    inspected: 1,
    sent: 1,
  });
  expect(sent).toEqual([{ outboxId: f.id }]);
  expect(await consumeOutbox(mutationEnv(), f.id)).toBe("completed");
  expect(
    await primary(env.DB)
      .prepare(`SELECT b.state,d.status,d.requeue_count FROM outbox b
        JOIN outbox_dead_letters d ON d.outbox_id=b.outbox_id WHERE b.outbox_id=?`)
      .bind(f.id)
      .first(),
  ).toEqual({ state: "completed", status: "requeued", requeue_count: 1 });
});

it("does not requeue a delivery after its saved credential is revoked", async () => {
  const f = await outboxFixture();
  const dead = delivery({ outboxId: f.id });
  expect(await handleDeadLetterBatch(mutationEnv(), { messages: [dead.message] })).toEqual({
    acked: 1,
    retried: 0,
  });
  await env.DB.prepare("UPDATE sessions SET revoked_at=? WHERE id=?")
    .bind(Date.now(), f.ids.session)
    .run();
  await maintenance(f.ids.user);
  await expect(requeueDeliveryExhaustedOutbox(mutationEnv(), 1, 1)).rejects.toThrow();
  expect(
    await primary(env.DB)
      .prepare(`SELECT b.state,d.status,d.requeue_count FROM outbox b
        JOIN outbox_dead_letters d ON d.outbox_id=b.outbox_id WHERE b.outbox_id=?`)
      .bind(f.id)
      .first(),
  ).toEqual({ state: "failed", status: "failed", requeue_count: 0 });
});

it("rejects inconsistent dead-letter state during recovery audit", async () => {
  const f = await outboxFixture();
  const dead = delivery({ outboxId: f.id });
  await handleDeadLetterBatch(mutationEnv(), { messages: [dead.message] });
  await maintenance(f.ids.user);
  await env.DB.prepare(
    "UPDATE outbox_dead_letters SET status='requeued',requeue_count=1 WHERE outbox_id=?",
  )
    .bind(f.id)
    .run();
  let cursor: RecoveryCursor | null = { stage: "outbox", afterId: "" };
  let mismatch: unknown;
  while (cursor?.stage === "outbox") {
    try {
      cursor = (await inspectRecoveryPage(env.DB, env.BLOBS, 1, cursor, 20)).next;
    } catch (error) {
      mismatch = error;
      break;
    }
  }
  expect(mismatch).toBeInstanceOf(Error);
  expect((mismatch as Error).message).toMatch(/recovery_outbox_dead_letter_mismatch/);
  await env.DB.prepare("UPDATE outbox SET state='pending' WHERE outbox_id=?").bind(f.id).run();
});
