import { applyD1Migrations } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeAll, beforeEach, expect, it } from "vitest";
import { grantPermit } from "../../src/db/permits";
import { atomicBatch } from "../../src/db/primary";
import type { Env } from "../../src/env";
import worker from "../../src/index";
import { consumeOutbox } from "../../src/jobs/consumeOutbox";
import {
  dispatchOutbox,
  dispatchPendingOutbox,
  type OutboxMessage,
  type OutboxSender,
} from "../../src/jobs/outbox";
import { handleOutboxBatch, type OutboxDelivery } from "../../src/jobs/queue";
import { foundationFixture } from "../fixtures/foundation";

beforeAll(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
});
beforeEach(async () => {
  await env.DB.prepare("UPDATE control SET epoch=1,maintenance=0").run();
});

async function fixture() {
  const f = foundationFixture(crypto.randomUUID(), Date.now() - 1000);
  await atomicBatch(env.DB, f.statements);
  const permit = await grantPermit(env.DB, crypto.randomUUID(), f.ids.space, 1);
  const id = crypto.randomUUID();
  await atomicBatch(env.DB, [
    {
      sql: `INSERT INTO operations(op_id,principal_kind,principal_id,credential_id,space_id,kind,state,request_digest,epoch,permit_id,permit_expires_at,claimed_expires_at,expected_steps,created_at,updated_at,operands_json)
      VALUES(?,'user',?,?,?,'node.create','committed','digest',1,?,?,?,0,1,1,?)`,
      values: [
        id,
        f.ids.user,
        f.ids.credential,
        f.ids.space,
        permit.permit_id,
        permit.expires_at,
        permit.expires_at,
        JSON.stringify({ parentId: f.ids.root }),
      ],
    },
    {
      sql: "INSERT INTO outbox(outbox_id,op_id,kind,payload_ref,state,epoch,created_at,updated_at) VALUES(?,?,'node.created',?,'pending',1,1,1)",
      values: [id, id, f.ids.folder],
    },
    {
      sql: "INSERT INTO operation_steps(op_id,step_no,kind,affected_id) VALUES(?,1,'node',?)",
      values: [id, f.ids.folder],
    },
  ]);
  return { ...f, id };
}

function sender(callback?: () => Promise<void>) {
  const messages: OutboxMessage[] = [];
  const queue: OutboxSender = {
    async send(body, options) {
      expect(options?.contentType).toBe("json");
      messages.push(body);
      await callback?.();
      return { metadata: { metrics: { backlogCount: messages.length, backlogBytes: 0 } } };
    },
  };
  return { messages, queue };
}

function admittedEnv(queue: OutboxSender = env.JOBS, maintenance = false): Env {
  return {
    ...env,
    CONTROL: {
      idFromName: () => "singleton",
      get: () => ({
        status: async () => ({ epoch: 1, maintenance, gcPaused: maintenance }),
      }),
    },
    JOBS: queue,
  } as unknown as Env;
}

it("sends only the outbox ID and keeps an active sent lease from duplicate dispatch", async () => {
  const f = await fixture();
  const s = sender();
  expect(await dispatchOutbox(env.DB, s.queue, f.id, 1)).toBe("sent");
  expect(s.messages).toEqual([{ outboxId: f.id }]);
  expect(await dispatchOutbox(env.DB, s.queue, f.id, 1)).toBe("busy");
  expect(s.messages).toHaveLength(1);
});

it("never downgrades completed when a fast consumer finishes before the producer marks sent", async () => {
  const f = await fixture();
  const s = sender(async () => {
    await env.DB.prepare("UPDATE outbox SET state='completed' WHERE outbox_id=?").bind(f.id).run();
  });
  expect(await dispatchOutbox(env.DB, s.queue, f.id, 1)).toBe("completed");
  expect(await dispatchOutbox(env.DB, s.queue, f.id, 1)).toBe("completed");
  expect(s.messages).toHaveLength(1);
});

it("resends the same ID after a send acknowledgement is lost and its lease expires", async () => {
  const f = await fixture();
  const s = sender(async () => {
    throw new Error("send_ack_lost");
  });
  expect(await dispatchOutbox(env.DB, s.queue, f.id, 1)).toBe("retry");
  expect(await dispatchOutbox(env.DB, s.queue, f.id, 1)).toBe("busy");
  await env.DB.prepare("UPDATE outbox SET dispatch_expires_at=0 WHERE outbox_id=?")
    .bind(f.id)
    .run();
  const retry = sender();
  expect(await dispatchOutbox(env.DB, retry.queue, f.id, 1)).toBe("sent");
  expect(s.messages).toEqual(retry.messages);
});

it.each([1, 3])("reconciles a lost D1 response on dispatch batch %s", async (lost) => {
  const f = await fixture();
  const s = sender();
  let calls = 0;
  const db = {
    prepare: env.DB.prepare.bind(env.DB),
    async batch(statements: D1PreparedStatement[]) {
      const result = await env.DB.batch(statements);
      if (++calls === lost) throw new Error("d1_ack_lost");
      return result;
    },
  } as unknown as D1Database;
  expect(await dispatchOutbox(db, s.queue, f.id, 1)).toBe("sent");
  expect(s.messages).toHaveLength(1);
});

it("fences a slow producer after another producer takes the expired lease", async () => {
  const f = await fixture();
  const next = sender();
  let winner: string | null = null;
  const slow = sender(async () => {
    await env.DB.prepare("UPDATE outbox SET dispatch_expires_at=0 WHERE outbox_id=?")
      .bind(f.id)
      .run();
    expect(await dispatchOutbox(env.DB, next.queue, f.id, 1)).toBe("sent");
    winner = await env.DB.prepare("SELECT dispatch_token FROM outbox WHERE outbox_id=?")
      .bind(f.id)
      .first<string>("dispatch_token");
  });
  expect(await dispatchOutbox(env.DB, slow.queue, f.id, 1)).toBe("retry");
  expect(
    await env.DB.prepare("SELECT dispatch_token FROM outbox WHERE outbox_id=?")
      .bind(f.id)
      .first("dispatch_token"),
  ).toBe(winner);
  expect(slow.messages).toEqual(next.messages);
});

it.each(["maintenance", "epoch", "uncommitted"])(
  "does not send across the %s fence",
  async (condition) => {
    const f = await fixture();
    const s = sender();
    if (condition === "maintenance") await env.DB.prepare("UPDATE control SET maintenance=1").run();
    if (condition === "epoch") await env.DB.prepare("UPDATE control SET epoch=2").run();
    if (condition === "uncommitted") {
      // Terminal operations and outbox identities cannot be repointed.
      await env.DB.prepare(
        `INSERT INTO operations SELECT op_id||'-claimed',principal_kind,principal_id,credential_id,credential_version,space_id,kind,'claimed',request_digest,epoch,permit_id,permit_expires_at,claimed_expires_at,expected_steps,NULL,NULL,created_at,updated_at,operands_json FROM operations WHERE op_id=?`,
      )
        .bind(f.id)
        .run();
      await env.DB.prepare(
        "INSERT INTO outbox(outbox_id,op_id,kind,payload_ref,state,epoch,created_at,updated_at) VALUES(?,?,'node.created',?,'pending',1,1,1)",
      )
        .bind(`${f.id}-claimed`, `${f.id}-claimed`, f.ids.folder)
        .run();
    }
    expect(
      await dispatchOutbox(
        env.DB,
        s.queue,
        condition === "uncommitted" ? `${f.id}-claimed` : f.id,
        1,
      ),
    ).toBe("busy");
    expect(s.messages).toEqual([]);
  },
);

it("keeps the durable event identity immutable", async () => {
  const f = await fixture();
  for (const [column, value] of [
    ["op_id", `${f.id}-other`],
    ["kind", "other"],
    ["payload_ref", "other"],
    ["epoch", 2],
    ["created_at", 2],
  ] as const) {
    await expect(
      env.DB.prepare(`UPDATE outbox SET ${column}=? WHERE outbox_id=?`).bind(value, f.id).run(),
    ).rejects.toThrow(/immutable_outbox_identity/);
  }
});

async function dispatchedEvent() {
  const f = await fixture();
  expect(await dispatchOutbox(env.DB, sender().queue, f.id, 1)).toBe("sent");
  return f;
}

it("claims and completes a current event, then accepts duplicate delivery", async () => {
  const f = await dispatchedEvent();
  expect(await consumeOutbox(env.DB, f.id)).toBe("completed");
  expect(await consumeOutbox(env.DB, f.id)).toBe("completed");
  expect(
    await env.DB.prepare("SELECT state FROM outbox WHERE outbox_id=?").bind(f.id).first("state"),
  ).toBe("completed");
});

it("keeps the original event valid after a later node mutation", async () => {
  const f = await dispatchedEvent();
  await env.DB.prepare("UPDATE nodes SET last_op_id=? WHERE id=?")
    .bind(`${f.id}-later`, f.ids.folder)
    .run();
  expect(await consumeOutbox(env.DB, f.id)).toBe("completed");
});

function delivery(body: unknown, loseAck = false) {
  let acked = 0;
  let retried = 0;
  const message: OutboxDelivery = {
    body,
    ack() {
      if (loseAck) throw new Error("queue_ack_lost");
      acked++;
    },
    retry() {
      retried++;
    },
  };
  return { message, counts: () => ({ acked, retried }) };
}

it("acks only completed IDs and retries invalid or unavailable deliveries", async () => {
  const f = await dispatchedEvent();
  const valid = delivery({ outboxId: f.id });
  const invalid = delivery({ outboxId: f.id, payload: "unexpected" });
  const absent = delivery({ outboxId: crypto.randomUUID() });
  expect(
    await handleOutboxBatch(env.DB, { messages: [valid.message, invalid.message, absent.message] }),
  ).toEqual({ acked: 1, retried: 2 });
  expect(valid.counts()).toEqual({ acked: 1, retried: 0 });
  expect(invalid.counts()).toEqual({ acked: 0, retried: 1 });
  expect(absent.counts()).toEqual({ acked: 0, retried: 1 });
});

it("acks a durable failed event after recovery without replaying it", async () => {
  const f = await fixture();
  await env.DB.prepare("UPDATE outbox SET state='failed' WHERE outbox_id=?").bind(f.id).run();
  expect(await consumeOutbox(env.DB, f.id)).toBe("failed");
  const stale = delivery({ outboxId: f.id });
  expect(await handleOutboxBatch(env.DB, { messages: [stale.message] })).toEqual({
    acked: 1,
    retried: 0,
  });
  expect(stale.counts()).toEqual({ acked: 1, retried: 0 });
});

it("routes Queue deliveries only when ControlDO and D1 agree on admission", async () => {
  const f = await dispatchedEvent();
  const first = delivery({ outboxId: f.id });
  let wholeBatchRetries = 0;
  const batch = (message: OutboxDelivery) =>
    ({
      messages: [message],
      retryAll() {
        wholeBatchRetries++;
      },
    }) as unknown as MessageBatch;
  await worker.queue(batch(first.message), admittedEnv());
  expect(first.counts()).toEqual({ acked: 1, retried: 0 });
  expect(wholeBatchRetries).toBe(0);
  await env.DB.prepare("UPDATE control SET maintenance=1").run();
  const second = delivery({ outboxId: f.id });
  await worker.queue(batch(second.message), admittedEnv());
  expect(second.counts()).toEqual({ acked: 0, retried: 0 });
  expect(wholeBatchRetries).toBe(1);
});

it("runs bounded Cron outbox repair only after admission and resends expired leases", async () => {
  const f = await fixture();
  const s = sender();
  const deliveries = () => s.messages.filter((message) => message.outboxId === f.id);
  const runtime = admittedEnv(s.queue);
  await worker.scheduled({} as ScheduledController, admittedEnv(s.queue, true));
  expect(s.messages).toEqual([]);
  await env.DB.prepare("UPDATE control SET maintenance=1").run();
  await worker.scheduled({} as ScheduledController, runtime);
  expect(s.messages).toEqual([]);
  await env.DB.prepare("UPDATE control SET maintenance=0").run();
  await worker.scheduled({} as ScheduledController, runtime);
  expect(deliveries()).toEqual([{ outboxId: f.id }]);
  await worker.scheduled({} as ScheduledController, runtime);
  expect(deliveries()).toHaveLength(1);
  await env.DB.prepare("UPDATE outbox SET dispatch_expires_at=0 WHERE outbox_id=?")
    .bind(f.id)
    .run();
  await worker.scheduled({} as ScheduledController, runtime);
  expect(deliveries()).toEqual([{ outboxId: f.id }, { outboxId: f.id }]);
});

it("converges after a lost Queue ack without repeating the D1 result", async () => {
  const f = await dispatchedEvent();
  const lost = delivery({ outboxId: f.id }, true);
  expect(await handleOutboxBatch(env.DB, { messages: [lost.message] })).toEqual({
    acked: 0,
    retried: 1,
  });
  const token = await env.DB.prepare("SELECT claim_token FROM outbox WHERE outbox_id=?")
    .bind(f.id)
    .first("claim_token");
  const duplicate = delivery({ outboxId: f.id });
  expect(await handleOutboxBatch(env.DB, { messages: [duplicate.message] })).toEqual({
    acked: 1,
    retried: 0,
  });
  expect(
    await env.DB.prepare("SELECT claim_token FROM outbox WHERE outbox_id=?")
      .bind(f.id)
      .first("claim_token"),
  ).toBe(token);
});

it("uses the saved create scope for a share that has no read action", async () => {
  const f = await fixture();
  const shareId = crypto.randomUUID();
  const sessionId = crypto.randomUUID();
  const credentialId = `ss:${sessionId}`;
  const eventId = crypto.randomUUID();
  const permit = await env.DB.prepare(
    "SELECT permit_id,permit_expires_at FROM operations WHERE op_id=?",
  )
    .bind(f.id)
    .first<{ permit_id: string; permit_expires_at: number }>();
  if (!permit) throw new Error("fixture_permit_missing");
  await atomicBatch(env.DB, [
    {
      sql: "INSERT INTO shares(id,owner_id,root_node_id,kind,created_at) VALUES(?,?,?,'link',1)",
      values: [shareId, f.ids.user, f.ids.root],
    },
    { sql: "INSERT INTO share_actions(share_id,action) VALUES(?,'create')", values: [shareId] },
    {
      sql: "INSERT INTO share_sessions(id,share_id,share_version,secret_digest,epoch,issued_at,expires_at) VALUES(?,?,1,?,1,1,?)",
      values: [sessionId, shareId, sessionId, Date.now() + 600000],
    },
    {
      sql: "INSERT INTO credentials(id,kind,share_session_id) VALUES(?,'share',?)",
      values: [credentialId, sessionId],
    },
    {
      sql: `INSERT INTO operations(op_id,principal_kind,principal_id,credential_id,credential_version,space_id,kind,state,request_digest,epoch,permit_id,permit_expires_at,claimed_expires_at,expected_steps,created_at,updated_at,operands_json)
        VALUES(?,'link_share',?,?,1,?,'node.create','committed','share',1,?,?,?,0,1,1,?)`,
      values: [
        eventId,
        shareId,
        credentialId,
        f.ids.space,
        permit.permit_id,
        permit.permit_expires_at,
        permit.permit_expires_at,
        JSON.stringify({ parentId: f.ids.root }),
      ],
    },
    {
      sql: "INSERT INTO outbox(outbox_id,op_id,kind,payload_ref,state,epoch,created_at,updated_at) VALUES(?,?,'node.created',?,'pending',1,1,1)",
      values: [eventId, eventId, f.ids.folder],
    },
    {
      sql: "INSERT INTO operation_steps(op_id,step_no,kind,affected_id) VALUES(?,1,'node',?)",
      values: [eventId, f.ids.folder],
    },
    { sql: "UPDATE nodes SET last_op_id=? WHERE id=?", values: [eventId, f.ids.folder] },
  ]);
  expect(await dispatchOutbox(env.DB, sender().queue, eventId, 1)).toBe("sent");
  expect(await consumeOutbox(env.DB, eventId)).toBe("completed");
});

it("rejects stale event credentials and an old epoch before claim", async () => {
  const revoked = await dispatchedEvent();
  await env.DB.prepare("UPDATE sessions SET revoked_at=? WHERE id=?")
    .bind(Date.now(), revoked.ids.session)
    .run();
  expect(await consumeOutbox(env.DB, revoked.id)).toBe("retry");
  expect(
    await env.DB.prepare("SELECT claim_token FROM outbox WHERE outbox_id=?")
      .bind(revoked.id)
      .first("claim_token"),
  ).toBeNull();

  const old = await dispatchedEvent();
  await env.DB.prepare("UPDATE control SET epoch=2").run();
  expect(await consumeOutbox(env.DB, old.id)).toBe("retry");
});

it("reconciles a lost completion acknowledgement from the terminal row", async () => {
  const f = await dispatchedEvent();
  let calls = 0;
  const db = {
    prepare: env.DB.prepare.bind(env.DB),
    async batch(statements: D1PreparedStatement[]) {
      const result = await env.DB.batch(statements);
      if (++calls === 2) throw new Error("d1_ack_lost");
      return result;
    },
  } as unknown as D1Database;
  expect(await consumeOutbox(db, f.id)).toBe("completed");
});

it("does not complete when the credential is revoked after claim", async () => {
  const f = await dispatchedEvent();
  let calls = 0;
  const db = {
    prepare: env.DB.prepare.bind(env.DB),
    async batch(statements: D1PreparedStatement[]) {
      const result = await env.DB.batch(statements);
      if (++calls === 1) {
        await env.DB.prepare("UPDATE sessions SET revoked_at=? WHERE id=?")
          .bind(Date.now(), f.ids.session)
          .run();
      }
      return result;
    },
  } as unknown as D1Database;
  expect(await consumeOutbox(db, f.id)).toBe("retry");
  expect(
    await env.DB.prepare("SELECT state FROM outbox WHERE outbox_id=?").bind(f.id).first("state"),
  ).toBe("sent");
});

it("fences a worker whose claim lease was taken over", async () => {
  const f = await dispatchedEvent();
  let calls = 0;
  const db = {
    prepare: env.DB.prepare.bind(env.DB),
    async batch(statements: D1PreparedStatement[]) {
      const result = await env.DB.batch(statements);
      if (++calls === 1) {
        await env.DB.prepare("UPDATE outbox SET claim_expires_at=0 WHERE outbox_id=?")
          .bind(f.id)
          .run();
        expect(await consumeOutbox(env.DB, f.id)).toBe("completed");
      }
      return result;
    },
  } as unknown as D1Database;
  expect(await consumeOutbox(db, f.id)).toBe("completed");
  expect(
    await env.DB.prepare("SELECT state FROM outbox WHERE outbox_id=?").bind(f.id).first("state"),
  ).toBe("completed");
});

it("does not redispatch while a consumer claim is live", async () => {
  const f = await dispatchedEvent();
  await env.DB.prepare(
    "UPDATE outbox SET dispatch_expires_at=0,claim_token=?,claim_expires_at=? WHERE outbox_id=?",
  )
    .bind(crypto.randomUUID(), Date.now() + 60_000, f.id)
    .run();
  const s = sender();
  expect(await dispatchOutbox(env.DB, s.queue, f.id, 1)).toBe("busy");
  expect(s.messages).toEqual([]);
  await env.DB.prepare("UPDATE outbox SET claim_expires_at=0 WHERE outbox_id=?").bind(f.id).run();
  expect(await dispatchOutbox(env.DB, s.queue, f.id, 1)).toBe("sent");
});

it("bounds repair dispatch and reclaims sent work whose consumer result is still absent", async () => {
  const first = await fixture();
  const second = await fixture();
  const s = sender();
  // Other tests keep intentionally unfinished rows; close their dispatch admission for this repair fixture.
  await env.DB.prepare(
    "UPDATE outbox SET dispatch_expires_at=?,state='sent' WHERE state<>'completed' AND outbox_id NOT IN (?,?)",
  )
    .bind(Date.now() + 60000, first.id, second.id)
    .run();
  expect(await dispatchPendingOutbox(env.DB, s.queue, 1, 1)).toEqual({ inspected: 1, sent: 1 });
  expect(await dispatchPendingOutbox(env.DB, s.queue, 1, 1)).toEqual({ inspected: 1, sent: 1 });
  expect(s.messages).toHaveLength(2);
  await env.DB.prepare("UPDATE outbox SET dispatch_expires_at=0 WHERE outbox_id=?")
    .bind(first.id)
    .run();
  expect(await dispatchPendingOutbox(env.DB, s.queue, 1, 1)).toEqual({ inspected: 1, sent: 1 });
  expect(s.messages[2]).toEqual({ outboxId: first.id });
  await expect(dispatchPendingOutbox(env.DB, s.queue, 1, 101)).rejects.toThrow(
    "invalid_outbox_dispatch",
  );
});
