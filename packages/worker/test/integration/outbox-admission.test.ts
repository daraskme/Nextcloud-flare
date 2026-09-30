import { applyD1Migrations } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import type { MutationRequest, SystemMutationAdmission } from "../../src/db/mutationAdmission";
import { consumeOutbox } from "../../src/jobs/consumeOutbox";
import { dispatchOutbox, dispatchPendingOutbox } from "../../src/jobs/outbox";
import { handleOutboxBatch } from "../../src/jobs/queue";
import type { SystemMutationSource } from "../../src/services/systemMutation";
import { acquireSystemMutation, mutationEnv } from "../fixtures/mutationAdmission";
import { outboxFixture } from "../fixtures/outbox";
import { systemMutationFault } from "../fixtures/systemMutationFault";
import { injectBatch } from "../fixtures/uploadEnv";

beforeAll(() => applyD1Migrations(env.DB, env.TEST_MIGRATIONS));
beforeEach(async () => {
  await env.DB.prepare("UPDATE control SET epoch=1,maintenance=0,gc_paused=0").run();
  await env.DB.prepare("UPDATE mutation_admissions SET state='closed' WHERE state<>'closed'").run();
  await env.DB.prepare(
    "UPDATE outbox SET state='failed' WHERE state NOT IN ('completed','failed')",
  ).run();
});
afterEach(() => vi.restoreAllMocks());
const stages = ["dispatch-claim", "send", "sent", "consume-claim", "complete"] as const;
type Stage = (typeof stages)[number];
type Gate = (request: MutationRequest) => Promise<SystemMutationAdmission>;
const prefix = (stage: Stage) => `system:outbox.${stage}:`;
const consumer = (stage: Stage) => stage === "consume-claim" || stage === "complete";
const metadata = { metadata: { metrics: { backlogCount: 0, backlogBytes: 0 } } };

async function fixture(stage: Stage) {
  const f = await outboxFixture();
  const send = vi.fn(async () => metadata),
    queue = { send };
  if (consumer(stage)) {
    expect(await dispatchOutbox(mutationEnv(), queue, f.id, 1)).toBe("sent");
    send.mockClear();
  }
  const configure = (gate: Gate = acquireSystemMutation, db = env.DB): SystemMutationSource => ({
    DB: db,
    systemControl: {
      status: () => mutationEnv().CONTROL.get(env.CONTROL.idFromName("fixture")).status(),
      acquireSystemMutation: gate,
    },
  });
  const run = (source = configure()) =>
    consumer(stage) ? consumeOutbox(source, f.id) : dispatchOutbox(source, queue, f.id, 1);
  const row = () =>
    env.DB.prepare("SELECT state,dispatch_token,claim_token FROM outbox WHERE outbox_id=?")
      .bind(f.id)
      .first();
  const receipts = () =>
    env.DB.prepare(
      "SELECT state,committed_at,system,maintenance FROM mutation_admissions WHERE space_id=? AND permit_id LIKE ? ORDER BY seq",
    )
      .bind(f.ids.space, prefix(stage) + "%")
      .all()
      .then((r) => r.results);
  return { ...f, stage, send, queue, configure, run, row, receipts };
}

it.each(stages)("commits %s and closes only its exact shared receipt", async (stage) => {
  const f = await fixture(stage);
  expect(await f.run()).toBe(consumer(stage) ? "completed" : "sent");
  expect(await f.receipts()).toEqual([
    { state: "closed", committed_at: expect.any(Number), system: 1, maintenance: 0 },
  ]);
  expect(f.send).toHaveBeenCalledTimes(consumer(stage) ? 0 : 1);
});

it.each(stages)("does not bypass unavailable %s admission", async (stage) => {
  const f = await fixture(stage);
  let blocked = 0;
  expect(
    await f.run(
      f.configure(async (r) => {
        if (r.permitId.startsWith(prefix(stage))) {
          blocked++;
          throw new Error("full");
        }
        return acquireSystemMutation(r);
      }),
    ),
  ).toBe(stage === "dispatch-claim" ? "busy" : "retry");
  expect(blocked).toBe(1);
  expect(await f.receipts()).toEqual([]);
  expect(f.send).toHaveBeenCalledTimes(stage === "sent" ? 1 : 0);
  expect(await f.row()).toMatchObject({
    state: stage === "dispatch-claim" ? "pending" : consumer(stage) ? "sent" : "dispatching",
  });
});

it.each(stages)(
  "recovers %s DB acknowledgements while requiring a direct send ACK",
  async (stage) => {
    const f = await fixture(stage),
      fault = systemMutationFault(prefix(stage), "ack");
    expect(await f.run(f.configure(undefined, fault.db))).toBe(
      stage === "send" ? "retry" : consumer(stage) ? "completed" : "sent",
    );
    expect(fault.fired()).toBe(true);
    expect(await f.receipts()).toEqual([
      { state: "closed", committed_at: expect.any(Number), system: 1, maintenance: 0 },
    ]);
    expect(f.send).toHaveBeenCalledTimes(consumer(stage) || stage === "send" ? 0 : 1);
    expect(fault.reads()).toBe(stage === "send" ? 0 : 1);
  },
);

it.each(stages)("rolls back %s and retains its unknown slot", async (stage) => {
  const f = await fixture(stage),
    fault = systemMutationFault(prefix(stage), "rollback");
  expect(await f.run(f.configure(undefined, fault.db))).toBe(
    stage === "dispatch-claim" ? "busy" : "retry",
  );
  expect(fault.fired()).toBe(true);
  expect(await f.receipts()).toEqual([
    { state: "active", committed_at: null, system: 1, maintenance: 0 },
  ]);
  expect(f.send).toHaveBeenCalledTimes(stage === "sent" ? 1 : 0);
  if (stage === "consume-claim")
    expect(await f.row()).toMatchObject({ state: "sent", claim_token: null });
});

it.each(stages.flatMap((stage) => ["maintenance", "epoch"].map((change) => ({ stage, change }))))(
  "fences $stage after a waiting $change transition",
  async ({ stage, change }) => {
    const f = await fixture(stage);
    const result = await f.run(
      f.configure(async (r) => {
        const grant = await acquireSystemMutation(r);
        if (r.permitId.startsWith(prefix(stage)))
          await env.DB.prepare(
            change === "epoch" ? "UPDATE control SET epoch=2" : "UPDATE control SET maintenance=1",
          ).run();
        return grant;
      }),
    );
    expect(result).toBe(stage === "dispatch-claim" ? "busy" : "retry");
    expect(f.send).toHaveBeenCalledTimes(stage === "sent" ? 1 : 0);
    expect((await f.receipts())[0]).toMatchObject({ state: "closed", committed_at: null });
  },
);

it.each(["consume-claim", "complete"] as const)(
  "revalidates credentials after waiting for %s",
  async (stage) => {
    const f = await fixture(stage);
    expect(
      await f.run(
        f.configure(async (r) => {
          const grant = await acquireSystemMutation(r);
          if (r.permitId.startsWith(prefix(stage)))
            await env.DB.prepare("UPDATE sessions SET revoked_at=1 WHERE id=?")
              .bind(f.ids.session)
              .run();
          return grant;
        }),
      ),
    ).toBe("retry");
    expect(await f.row()).toMatchObject({ state: "sent" });
    expect((await f.receipts())[0]).toMatchObject({ state: "active", committed_at: null });
  },
);

it.each(["send", "sent"] as const)(
  "rejects a replaced dispatch token after waiting for %s",
  async (stage) => {
    const f = await fixture(stage);
    expect(
      await f.run(
        f.configure(async (r) => {
          const grant = await acquireSystemMutation(r);
          if (r.permitId.startsWith(prefix(stage)))
            await env.DB.prepare("UPDATE outbox SET dispatch_token='replacement' WHERE outbox_id=?")
              .bind(f.id)
              .run();
          return grant;
        }),
      ),
    ).toBe("retry");
    expect(f.send).toHaveBeenCalledTimes(stage === "sent" ? 1 : 0);
    expect(await f.row()).toMatchObject({ state: "dispatching", dispatch_token: "replacement" });
    expect((await f.receipts())[0]).toMatchObject({ state: "active", committed_at: null });
  },
);

it.each(["send", "sent", "complete"] as const)(
  "rechecks the durable lease after waiting for %s",
  async (stage) => {
    const f = await fixture(stage);
    expect(
      await f.run(
        f.configure(async (r) => {
          const grant = await acquireSystemMutation(r);
          if (r.permitId.startsWith(prefix(stage)))
            await env.DB.prepare(
              `UPDATE outbox SET ${stage === "complete" ? "claim_expires_at" : "dispatch_expires_at"}=0 WHERE outbox_id=?`,
            )
              .bind(f.id)
              .run();
          return grant;
        }),
      ),
    ).toBe("retry");
    expect(f.send).toHaveBeenCalledTimes(stage === "sent" ? 1 : 0);
    expect((await f.receipts())[0]).toMatchObject({ state: "active", committed_at: null });
  },
);

it.each(["dispatch-claim", "send", "consume-claim", "complete"] as const)(
  "stops %s when admission returns after the run deadline",
  async (stage) => {
    const f = await fixture(stage),
      now = Date.now.bind(Date);
    let late = false;
    vi.spyOn(Date, "now").mockImplementation(() => now() + (late ? 30000 : 0));
    expect(
      await f.run(
        f.configure(async (r) => {
          const grant = await acquireSystemMutation(r);
          if (r.permitId.startsWith(prefix(stage))) late = true;
          return grant;
        }),
      ),
    ).toBe(stage === "dispatch-claim" ? "busy" : "retry");
    expect(f.send).not.toHaveBeenCalled();
    expect((await f.receipts())[0]).toMatchObject({ state: "active", committed_at: null });
  },
);

it("does not send after a slow direct acknowledgement even though its receipt committed", async () => {
  const f = await fixture("send"),
    now = Date.now.bind(Date);
  let armed = false,
    late = false;
  vi.spyOn(Date, "now").mockImplementation(() => now() + (late ? 30000 : 0));
  const db = injectBatch(
    (sql) => armed && sql.includes("UPDATE mutation_admissions SET state='closed',committed_at="),
    async () => {
      late = true;
    },
    true,
  );
  expect(
    await f.run(
      f.configure(async (r) => {
        const grant = await acquireSystemMutation(r);
        if (r.permitId.startsWith(prefix("send"))) armed = true;
        return grant;
      }, db),
    ),
  ).toBe("retry");
  expect(late).toBe(true);
  expect(f.send).not.toHaveBeenCalled();
  expect((await f.receipts())[0]).toMatchObject({
    state: "closed",
    committed_at: expect.any(Number),
  });
});

it("does not read a send receipt to infer dispatch and later retries the same durable ID", async () => {
  const f = await fixture("send"),
    fault = systemMutationFault(prefix("send"), "reads");
  expect(await f.run(f.configure(undefined, fault.db))).toBe("retry");
  expect(f.send).not.toHaveBeenCalled();
  expect(fault.reads()).toBe(0);
  await env.DB.prepare("UPDATE outbox SET dispatch_expires_at=0 WHERE outbox_id=?")
    .bind(f.id)
    .run();
  expect(await f.run()).toBe("sent");
  expect(f.send).toHaveBeenCalledExactlyOnceWith({ outboxId: f.id }, { contentType: "json" });
});

it("recovers an exact dispatch token when its common claim receipt is unreadable", async () => {
  const f = await fixture("dispatch-claim"),
    fault = systemMutationFault(prefix("dispatch-claim"), "reads");
  expect(await f.run(f.configure(undefined, fault.db))).toBe("sent");
  expect(fault.reads()).toBe(1);
  expect(f.send).toHaveBeenCalledOnce();
  expect((await f.receipts())[0]).toMatchObject({
    state: "closed",
    committed_at: expect.any(Number),
  });
});

it("another consumer's completion never frees the blocked caller's own grant", async () => {
  const f = await fixture("complete");
  let replaced = false;
  expect(
    await f.run(
      f.configure(async (r) => {
        const grant = await acquireSystemMutation(r);
        if (r.permitId.startsWith(prefix("complete")) && !replaced) {
          replaced = true;
          await env.DB.prepare("UPDATE outbox SET claim_expires_at=0 WHERE outbox_id=?")
            .bind(f.id)
            .run();
          expect(await consumeOutbox(mutationEnv(), f.id)).toBe("completed");
        }
        return grant;
      }),
    ),
  ).toBe("completed");
  expect(await f.receipts()).toEqual([
    { state: "active", committed_at: null, system: 1, maintenance: 0 },
    { state: "closed", committed_at: expect.any(Number), system: 1, maintenance: 0 },
  ]);
});

it("a fast consumer may complete while the producer waits to mark sent", async () => {
  const f = await fixture("sent");
  expect(
    await f.run(
      f.configure(async (r) => {
        const grant = await acquireSystemMutation(r);
        if (r.permitId.startsWith(prefix("sent")))
          expect(await consumeOutbox(mutationEnv(), f.id)).toBe("completed");
        return grant;
      }),
    ),
  ).toBe("completed");
  expect(f.send).toHaveBeenCalledOnce();
  expect(await f.row()).toMatchObject({ state: "completed" });
  expect(await f.receipts()).toEqual([
    { state: "active", committed_at: null, system: 1, maintenance: 0 },
  ]);
});

it.each(["completed", "failed"] as const)(
  "acks an already %s delivery without admission",
  async (state) => {
    const f = await fixture("consume-claim");
    await env.DB.prepare("UPDATE outbox SET state=? WHERE outbox_id=?").bind(state, f.id).run();
    const gate = vi.fn(async () => {
        throw new Error("full");
      }),
      ack = vi.fn(),
      retry = vi.fn();
    expect(
      await handleOutboxBatch(f.configure(gate), {
        messages: [{ body: { outboxId: f.id }, ack, retry }],
      }),
    ).toEqual({ acked: 1, retried: 0 });
    expect(gate).not.toHaveBeenCalled();
    expect(ack).toHaveBeenCalledOnce();
    expect(retry).not.toHaveBeenCalled();
    if (state === "completed")
      expect(await dispatchOutbox(f.configure(gate), f.queue, f.id, 1)).toBe("completed");
    expect(gate).not.toHaveBeenCalled();
  },
);

it("keeps Queue delivery retryable on admission overload and a lost caller ACK", async () => {
  const f = await fixture("consume-claim"),
    retry = vi.fn(),
    ack = vi.fn(() => {
      throw new Error("ack_lost");
    });
  const message = { body: { outboxId: f.id }, ack, retry };
  expect(
    await handleOutboxBatch(
      f.configure(async () => {
        throw new Error("full");
      }),
      { messages: [message] },
    ),
  ).toEqual({ acked: 0, retried: 1 });
  expect(ack).not.toHaveBeenCalled();
  expect(await handleOutboxBatch(f.configure(), { messages: [message] })).toEqual({
    acked: 0,
    retried: 1,
  });
  expect(await f.row()).toMatchObject({ state: "completed" });
  const gate = vi.fn(async () => {
    throw new Error("full");
  });
  expect(
    await handleOutboxBatch(f.configure(gate), { messages: [{ ...message, ack: vi.fn() }] }),
  ).toEqual({ acked: 1, retried: 0 });
  expect(gate).not.toHaveBeenCalled();
});

it("bounds a Cron pass with one deadline and retains remaining pending IDs", async () => {
  const f = await fixture("sent"),
    next = await outboxFixture(),
    now = Date.now.bind(Date);
  let late = false;
  vi.spyOn(Date, "now").mockImplementation(() => now() + (late ? 30000 : 0));
  const send = vi.fn(async () => {
    late = true;
    return metadata;
  });
  expect(await dispatchPendingOutbox(f.configure(), { send }, 1, 2)).toEqual({
    inspected: 1,
    sent: 1,
  });
  expect(send).toHaveBeenCalledOnce();
  expect(
    await env.DB.prepare(
      "SELECT COUNT(*) n FROM outbox WHERE outbox_id IN (?,?) AND state='pending'",
    )
      .bind(f.id, next.id)
      .first("n"),
  ).toBe(1);
});

it("retries the unprocessed Queue batch after its fixed deadline", async () => {
  const first = await fixture("complete"),
    second = await fixture("complete"),
    now = Date.now.bind(Date);
  let late = false;
  vi.spyOn(Date, "now").mockImplementation(() => now() + (late ? 30000 : 0));
  const gate = vi.fn(async (r: MutationRequest) => {
    const grant = await acquireSystemMutation(r);
    if (r.permitId.startsWith(prefix("complete"))) late = true;
    return grant;
  });
  const ack = vi.fn(),
    retry = vi.fn();
  expect(
    await handleOutboxBatch(first.configure(gate), {
      messages: [first, second].map((f) => ({ body: { outboxId: f.id }, ack, retry })),
    }),
  ).toEqual({ acked: 0, retried: 2 });
  expect(gate).toHaveBeenCalledTimes(2);
  expect(await second.row()).toMatchObject({ state: "sent", claim_token: null });
  expect(ack).not.toHaveBeenCalled();
  expect(retry).toHaveBeenCalledTimes(2);
});
