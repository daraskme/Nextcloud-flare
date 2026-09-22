import { applyD1Migrations, evictDurableObject, runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeAll, expect, it } from "vitest";
import { atomicBatch } from "../../src/db/primary";
import { BudgetDO } from "../../src/do/BudgetDO";
import { foundationFixture } from "../fixtures/foundation";

beforeAll(async () => applyD1Migrations(env.DB, env.TEST_MIGRATIONS));

it("enforces the owner-wide active budget cap in D1", async () => {
  const f = await fixture(0);
  const insert = env.DB.prepare(
    "INSERT INTO budgets(id,owner_id,user_id,epoch,expires_at,state) VALUES(?,?,?,1,?,'active')",
  );
  const future = Date.now() + 600_000;
  for (let i = 1; i < 64; i++)
    await insert.bind(crypto.randomUUID(), f.f.ids.user, f.f.ids.user, future).run();
  await expect(
    insert.bind(crypto.randomUUID(), f.f.ids.user, f.f.ids.user, future).run(),
  ).rejects.toThrow(/owner_budget_limit/);
  await env.DB.prepare("UPDATE budgets SET state='revoked' WHERE id=?").bind(f.ids.budget).run();
  await insert.bind(crypto.randomUUID(), f.f.ids.user, f.f.ids.user, future).run();
});

async function fixture(totalBytes = 3) {
  const now = Date.now();
  const f = foundationFixture(crypto.randomUUID(), now - 1000);
  await atomicBatch(env.DB, f.statements);
  await env.DB.prepare("UPDATE control SET maintenance=0 WHERE singleton=1").run();
  const ids = {
    budget: `u:${f.ids.user}`,
    target: crypto.randomUUID(),
    ticket: crypto.randomUUID(),
    content: crypto.randomUUID(),
  };
  await atomicBatch(env.DB, [
    {
      sql: "INSERT INTO budgets(id,owner_id,user_id,epoch,expires_at,state) VALUES(?,?,?,1,?,'active')",
      values: [ids.budget, f.ids.user, f.ids.user, now + 600000],
    },
    {
      sql: `INSERT INTO target_sets
        (id,owner_id,credential_id,manifest_hash,manifest_ref,total_bytes,expires_at,epoch)
        VALUES(?,?,?,'hash','manifest',?,?,1)`,
      values: [ids.target, f.ids.user, f.ids.credential, totalBytes, now + 600000],
    },
    {
      sql: `INSERT INTO tickets
        (id,credential_id,target_set_id,budget_id,purpose,epoch,issued_at,expires_at)
        VALUES(?,?,?,?,'content',1,?,?)`,
      values: [ids.ticket, f.ids.credential, ids.target, ids.budget, now, now + 600000],
    },
    {
      sql: `INSERT INTO content_sessions
        (id,user_id,issued_by_credential_id,target_set_id,budget_id,ticket_id,epoch,issued_at,expires_at)
        VALUES(?,?,?,?,?,?,1,?,?)`,
      values: [
        ids.content,
        f.ids.user,
        f.ids.credential,
        ids.target,
        ids.budget,
        ids.ticket,
        now,
        now + 600000,
      ],
    },
  ]);
  const stub = env.BUDGETS.get(env.BUDGETS.idFromName(ids.budget));
  return { f, ids, stub };
}

it("persists charged bytes through eviction, refunds known unused bytes and never refunds unknown results", async () => {
  const f = await fixture();
  const first = {
    budgetId: f.ids.budget,
    sessionId: f.ids.content,
    requestId: crypto.randomUUID(),
    epoch: 1,
    bytes: 5,
  };
  const lease = await runInDurableObject(f.stub, async (_, state) =>
    new BudgetDO(state, env).reserve(first),
  );
  expect(lease.reservedBytes).toBe(5);
  await evictDurableObject(f.stub);
  await runInDurableObject(f.stub, async (_, state) => {
    const budget = new BudgetDO(state, env);
    expect(await budget.reserve(first)).toEqual(lease);
    expect(budget.status()).toMatchObject({
      bytesCharged: 5,
      requests: 1,
      active: 1,
      byteLimit: 9,
    });
    expect(
      await budget.settle({
        budgetId: first.budgetId,
        requestId: first.requestId,
        deliveredBytes: 2,
      }),
    ).toBe(2);
    expect(budget.status()).toMatchObject({ bytesCharged: 2, active: 0 });
    await expect(budget.reserve(first)).rejects.toThrow(/budget_request_conflict/);
    const second = { ...first, requestId: crypto.randomUUID(), bytes: 7 };
    await budget.reserve(second);
    expect(
      await budget.settle({
        budgetId: second.budgetId,
        requestId: second.requestId,
        deliveredBytes: null,
      }),
    ).toBe(7);
    expect(budget.status()).toMatchObject({ bytesCharged: 9, active: 0 });
    await expect(
      budget.reserve({ ...first, requestId: crypto.randomUUID(), bytes: 1 }),
    ).rejects.toThrow(/budget_exceeded/);
  });
});

it("enforces eight parallel leases and releases expired concurrency through the alarm", async () => {
  const f = await fixture(100);
  await runInDurableObject(f.stub, async (_, state) => {
    const budget = new BudgetDO(state, env);
    const base = { budgetId: f.ids.budget, sessionId: f.ids.content, epoch: 1, bytes: 1 };
    const ids: string[] = [];
    for (let i = 0; i < 8; i++) {
      const requestId = crypto.randomUUID();
      ids.push(requestId);
      await budget.reserve({ ...base, requestId });
    }
    expect(budget.status()).toMatchObject({ active: 8, requests: 8, bytesCharged: 8 });
    await expect(budget.reserve({ ...base, requestId: crypto.randomUUID() })).rejects.toThrow(
      /budget_exceeded/,
    );
    await budget.settle({ budgetId: f.ids.budget, requestId: ids[0] ?? "", deliveredBytes: 1 });
    await budget.reserve({ ...base, requestId: crypto.randomUUID() });
    state.storage.sql.exec("UPDATE budget_leases SET expires_at=1 WHERE state='active'");
    await budget.alarm();
    expect(budget.status()).toMatchObject({ active: 0, bytesCharged: 9 });
  });
});

it("rejects a revoked content session before another lease", async () => {
  const f = await fixture();
  await runInDurableObject(f.stub, async (_, state) => {
    const budget = new BudgetDO(state, env);
    await budget.reserve({
      budgetId: f.ids.budget,
      sessionId: f.ids.content,
      requestId: crypto.randomUUID(),
      epoch: 1,
      bytes: 1,
    });
    await env.DB.prepare("UPDATE content_sessions SET revoked_at=? WHERE id=?")
      .bind(Date.now(), f.ids.content)
      .run();
    await expect(
      budget.reserve({
        budgetId: f.ids.budget,
        sessionId: f.ids.content,
        requestId: crypto.randomUUID(),
        epoch: 1,
        bytes: 1,
      }),
    ).rejects.toThrow(/budget_authorization_denied/);
    await env.DB.prepare("UPDATE content_sessions SET revoked_at=NULL WHERE id=?")
      .bind(f.ids.content)
      .run();
    await env.DB.prepare("UPDATE sessions SET revoked_at=? WHERE id=?")
      .bind(Date.now(), f.f.ids.session)
      .run();
    await expect(
      budget.reserve({
        budgetId: f.ids.budget,
        sessionId: f.ids.content,
        requestId: crypto.randomUUID(),
        epoch: 1,
        bytes: 1,
      }),
    ).rejects.toThrow(/budget_authorization_denied/);
  });
});

it("counts every zero-byte request and stops at 1,024 within the budget window", async () => {
  const f = await fixture(0);
  await runInDurableObject(f.stub, async (_, state) => {
    const budget = new BudgetDO(state, env);
    for (let i = 0; i < 1_024; i++) {
      const requestId = crypto.randomUUID();
      await budget.reserve({
        budgetId: f.ids.budget,
        sessionId: f.ids.content,
        requestId,
        epoch: 1,
        bytes: 0,
      });
      await budget.settle({ budgetId: f.ids.budget, requestId, deliveredBytes: 0 });
    }
    expect(budget.status()).toMatchObject({ requests: 1_024, active: 0, bytesCharged: 0 });
    await expect(
      budget.reserve({
        budgetId: f.ids.budget,
        sessionId: f.ids.content,
        requestId: crypto.randomUUID(),
        epoch: 1,
        bytes: 0,
      }),
    ).rejects.toThrow(/budget_exceeded/);
    state.storage.sql.exec("UPDATE budget_leases SET expires_at=1");
    state.storage.sql.exec("UPDATE budget_state SET window_start=?", Date.now() - 600_001);
    const nextId = crypto.randomUUID();
    await budget.reserve({
      budgetId: f.ids.budget,
      sessionId: f.ids.content,
      requestId: nextId,
      epoch: 1,
      bytes: 0,
    });
    expect(budget.status()).toMatchObject({ requests: 1, active: 1 });
    expect(
      state.storage.sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM budget_leases").one().n,
    ).toBe(1);
  });
});

it("stops new leases when D1 maintenance closes admission", async () => {
  const f = await fixture();
  await env.DB.prepare("UPDATE control SET maintenance=1 WHERE singleton=1").run();
  await runInDurableObject(f.stub, async (_, state) => {
    const budget = new BudgetDO(state, env);
    await expect(
      budget.reserve({
        budgetId: f.ids.budget,
        sessionId: f.ids.content,
        requestId: crypto.randomUUID(),
        epoch: 1,
        bytes: 0,
      }),
    ).rejects.toThrow(/budget_authorization_denied/);
  });
});

it("counts distinct requests issued in the same millisecond", async () => {
  const f = await fixture(0);
  await runInDurableObject(f.stub, async (_, state) => {
    const original = Date.now;
    const fixed = original();
    Date.now = () => fixed;
    try {
      const budget = new BudgetDO(state, env);
      for (let i = 0; i < 2; i++) {
        const requestId = crypto.randomUUID();
        await budget.reserve({
          budgetId: f.ids.budget,
          sessionId: f.ids.content,
          requestId,
          epoch: 1,
          bytes: 0,
        });
        await budget.settle({ budgetId: f.ids.budget, requestId, deliveredBytes: 0 });
      }
      expect(budget.status()).toMatchObject({ requests: 2, active: 0 });
    } finally {
      Date.now = original;
    }
  });
});
