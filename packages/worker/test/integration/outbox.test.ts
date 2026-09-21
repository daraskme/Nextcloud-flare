import { applyD1Migrations } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeAll, beforeEach, expect, it } from "vitest";
import { grantPermit } from "../../src/db/permits";
import { atomicBatch } from "../../src/db/primary";
import {
  dispatchOutbox,
  dispatchPendingOutbox,
  type OutboxMessage,
  type OutboxSender,
} from "../../src/jobs/outbox";
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
      sql: `INSERT INTO operations(op_id,principal_kind,principal_id,credential_id,space_id,kind,state,request_digest,epoch,permit_id,permit_expires_at,claimed_expires_at,expected_steps,created_at,updated_at)
      VALUES(?,'user',?,?,?,'node.create','committed','digest',1,?,?,?,0,1,1)`,
      values: [
        id,
        f.ids.user,
        f.ids.credential,
        f.ids.space,
        permit.permit_id,
        permit.expires_at,
        permit.expires_at,
      ],
    },
    {
      sql: "INSERT INTO outbox(outbox_id,op_id,kind,payload_ref,state,epoch,created_at,updated_at) VALUES(?,?,'node.created',?,'pending',1,1,1)",
      values: [id, id, f.ids.folder],
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
      // Terminal operations cannot be reopened; point a fixture event at a separate claimed operation instead.
      await env.DB.prepare(
        `INSERT INTO operations SELECT op_id||'-claimed',principal_kind,principal_id,credential_id,credential_version,space_id,kind,'claimed',request_digest,epoch,permit_id,permit_expires_at,claimed_expires_at,expected_steps,NULL,NULL,created_at,updated_at,operands_json FROM operations WHERE op_id=?`,
      )
        .bind(f.id)
        .run();
      await env.DB.prepare("UPDATE outbox SET op_id=? WHERE outbox_id=?")
        .bind(`${f.id}-claimed`, f.id)
        .run();
    }
    expect(await dispatchOutbox(env.DB, s.queue, f.id, 1)).toBe("busy");
    expect(s.messages).toEqual([]);
  },
);

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
