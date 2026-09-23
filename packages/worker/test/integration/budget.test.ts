import { applyD1Migrations, evictDurableObject, runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeAll, expect, it } from "vitest";
import { atomicBatch } from "../../src/db/primary";
import { BudgetDO } from "../../src/do/BudgetDO";
import { stageTargetManifest, type TargetEntry } from "../../src/services/targetManifest";
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
  const manifest = await stageTargetManifest(env.BLOBS, [
    {
      spaceId: f.ids.space,
      nodeId: f.ids.file,
      blobId: f.ids.blob,
      purpose: "content",
      size: totalBytes,
    },
  ]);
  const ids = {
    budget: `u:${f.ids.user}`,
    target: manifest.id,
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
        VALUES(?,?,?,?,?,?,?,1)`,
      values: [
        ids.target,
        f.ids.user,
        f.ids.credential,
        manifest.hash,
        manifest.ref,
        totalBytes,
        now + 600000,
      ],
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

async function anotherSession(
  f: Awaited<ReturnType<typeof fixture>>,
  targets: readonly TargetEntry[],
) {
  const manifest = await stageTargetManifest(env.BLOBS, targets);
  const ticket = crypto.randomUUID(),
    session = crypto.randomUUID(),
    now = Date.now();
  await atomicBatch(env.DB, [
    {
      sql: "INSERT INTO target_sets(id,owner_id,credential_id,manifest_hash,manifest_ref,total_bytes,expires_at,epoch) VALUES(?,?,?,?,?,?,?,1)",
      values: [
        manifest.id,
        f.f.ids.user,
        f.f.ids.credential,
        manifest.hash,
        manifest.ref,
        manifest.totalBytes,
        now + 600_000,
      ],
    },
    {
      sql: "INSERT INTO tickets(id,credential_id,target_set_id,budget_id,purpose,epoch,issued_at,expires_at) VALUES(?,?,?,?,'content',1,?,?)",
      values: [ticket, f.f.ids.credential, manifest.id, f.ids.budget, now, now + 600_000],
    },
    {
      sql: "INSERT INTO content_sessions(id,user_id,issued_by_credential_id,target_set_id,budget_id,ticket_id,epoch,issued_at,expires_at) VALUES(?,?,?,?,?,?,1,?,?)",
      values: [
        session,
        f.f.ids.user,
        f.f.ids.credential,
        manifest.id,
        f.ids.budget,
        ticket,
        now,
        now + 600_000,
      ],
    },
  ]);
  return { session, ticket, manifest };
}

function target(
  f: Awaited<ReturnType<typeof fixture>>,
  size: number,
  blobId = f.f.ids.blob,
): TargetEntry {
  return { spaceId: f.f.ids.space, nodeId: f.f.ids.file, blobId, purpose: "content", size };
}

it("admits different targets while renewal, overlapping manifests and COW aliases cannot reset spent bytes", async () => {
  const f = await fixture();
  const original = target(f, 3);
  const alias = { ...original, nodeId: crypto.randomUUID() };
  const same = await anotherSession(f, [alias]);
  const next = target(f, 7, crypto.randomUUID());
  const larger = await anotherSession(f, [next]);
  const overlap = await anotherSession(f, [original, alias, next]);
  await runInDurableObject(f.stub, async (_, state) => {
    const budget = new BudgetDO(state, env);
    const base = { budgetId: f.ids.budget, sessionId: f.ids.content, epoch: 1 };
    const first = await budget.reserve({ ...base, requestId: crypto.randomUUID(), bytes: 9 });
    await budget.settle({
      budgetId: base.budgetId,
      requestId: first.requestId,
      deliveredBytes: null,
    });
    await expect(
      budget.reserve({
        ...base,
        sessionId: same.session,
        requestId: crypto.randomUUID(),
        bytes: 1,
      }),
    ).rejects.toThrow("budget_exceeded");
    await budget.reserve({
      ...base,
      sessionId: larger.session,
      requestId: crypto.randomUUID(),
      bytes: 7,
    });
    expect(budget.status()).toMatchObject({
      byteLimit: 30,
      bytesCharged: 16,
      requests: 2,
      active: 1,
    });
  });
  await evictDurableObject(f.stub);
  await runInDurableObject(f.stub, async (_, state) => {
    const budget = new BudgetDO(state, env);
    const base = { budgetId: f.ids.budget, sessionId: overlap.session, epoch: 1 };
    await budget.reserve({ ...base, requestId: crypto.randomUUID(), bytes: 14 });
    await expect(
      budget.reserve({ ...base, requestId: crypto.randomUUID(), bytes: 1 }),
    ).rejects.toThrow("budget_exceeded");
    expect(budget.status()).toMatchObject({
      byteLimit: 30,
      bytesCharged: 30,
      requests: 3,
      active: 2,
    });
    expect(
      state.storage.sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM budget_targets").one().n,
    ).toBe(2);
  });
});

it("rejects conflicting sizes and corrupted manifests without changing allowance or request counters", async () => {
  const f = await fixture();
  const changed = await anotherSession(f, [target(f, 4)]);
  const corrupt = await anotherSession(f, [target(f, 100, crypto.randomUUID())]);
  await env.BLOBS.put(corrupt.manifest.ref, "corrupt");
  await runInDurableObject(f.stub, async (_, state) => {
    const budget = new BudgetDO(state, env);
    const base = { budgetId: f.ids.budget, sessionId: f.ids.content, epoch: 1, bytes: 1 };
    await budget.reserve({ ...base, requestId: crypto.randomUUID() });
    const before = budget.status();
    await expect(
      budget.reserve({ ...base, sessionId: changed.session, requestId: crypto.randomUUID() }),
    ).rejects.toThrow("budget_target_conflict");
    await expect(
      budget.reserve({ ...base, sessionId: corrupt.session, requestId: crypto.randomUUID() }),
    ).rejects.toThrow("invalid_target_manifest");
    expect(budget.status()).toEqual(before);
  });
});

it("preserves legacy counters until expiry instead of granting the original targets twice", async () => {
  const f = await fixture();
  const larger = await anotherSession(f, [target(f, 7, crypto.randomUUID())]);
  await runInDurableObject(f.stub, async (_, state) => {
    const budget = new BudgetDO(state, env);
    const base = { budgetId: f.ids.budget, sessionId: f.ids.content, epoch: 1 };
    await budget.reserve({ ...base, requestId: crypto.randomUUID(), bytes: 9 });
    state.storage.sql.exec("DELETE FROM budget_allowance_window");
    state.storage.sql.exec("DELETE FROM budget_targets");
    await expect(
      budget.reserve({ ...base, requestId: crypto.randomUUID(), bytes: 1 }),
    ).rejects.toThrow("budget_exceeded");
    await expect(
      budget.reserve({
        ...base,
        sessionId: larger.session,
        requestId: crypto.randomUUID(),
        bytes: 1,
      }),
    ).rejects.toThrow("budget_exceeded");
    expect(budget.status()).toMatchObject({ byteLimit: 9, bytesCharged: 9, requests: 1 });
    state.storage.sql.exec("UPDATE budget_state SET expires_at=1");
    await budget.reserve({
      ...base,
      sessionId: larger.session,
      requestId: crypto.randomUUID(),
      bytes: 7,
    });
    expect(budget.status()).toMatchObject({ byteLimit: 21, bytesCharged: 7, requests: 2 });
  });
});

it("rechecks ticket revocation after fetching the allowance manifest", async () => {
  const f = await fixture();
  await runInDurableObject(f.stub, async (_, state) => {
    const bucket = {
      async get(key: string) {
        const object = await env.BLOBS.get(key);
        await env.DB.prepare("UPDATE tickets SET cancelled_at=? WHERE id=?")
          .bind(Date.now(), f.ids.ticket)
          .run();
        return object;
      },
    } as R2Bucket;
    const budget = new BudgetDO(state, { ...env, BLOBS: bucket });
    await expect(
      budget.reserve({
        budgetId: f.ids.budget,
        sessionId: f.ids.content,
        requestId: crypto.randomUUID(),
        epoch: 1,
        bytes: 1,
      }),
    ).rejects.toThrow("budget_authorization_denied");
    expect(budget.status()).toBeNull();
  });
});

it("bounds the target ledger at 1,024 entries and keeps maximum lease rows below one MiB", async () => {
  const f = await fixture(0);
  const entry = (i: number) => target(f, 0, `blob-${i}`.padEnd(128, "x"));
  const first = await anotherSession(
    f,
    Array.from({ length: 1_000 }, (_, i) => entry(i)),
  );
  const rest = await anotherSession(
    f,
    Array.from({ length: 24 }, (_, i) => entry(i + 1_000)),
  );
  const excess = await anotherSession(f, [entry(1_024)]);
  await runInDurableObject(f.stub, async (_, state) => {
    const budget = new BudgetDO(state, env);
    const base = { budgetId: f.ids.budget, epoch: 1, bytes: 0 };
    for (const sessionId of [first.session, rest.session]) {
      const lease = await budget.reserve({ ...base, sessionId, requestId: crypto.randomUUID() });
      await budget.settle({
        budgetId: base.budgetId,
        requestId: lease.requestId,
        deliveredBytes: 0,
      });
    }
    await expect(
      budget.reserve({ ...base, sessionId: excess.session, requestId: crypto.randomUUID() }),
    ).rejects.toThrow("budget_exceeded");
    expect(budget.status()).toMatchObject({ requests: 2, byteLimit: 0 });
    expect(
      state.storage.sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM budget_targets").one().n,
    ).toBe(1_024);
    for (let i = 2; i < 1_023; i++)
      state.storage.sql.exec(
        "INSERT INTO budget_leases VALUES(?,?,0,0,?,'settled')",
        `lease-${i}`.padEnd(64, "x"),
        "s".repeat(64),
        Date.now() + 600_000,
      );
    await budget.reserve({ ...base, sessionId: first.session, requestId: "r".repeat(64) });
    expect(
      state.storage.sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM budget_leases").one().n,
    ).toBe(1_024);
    expect(state.storage.sql.databaseSize).toBeLessThanOrEqual(1_048_576);
    await expect(
      budget.reserve({ ...base, sessionId: first.session, requestId: crypto.randomUUID() }),
    ).rejects.toThrow("budget_exceeded");
  });
});

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

it("restarts a budget only after its previous D1-backed lifetime expires", async () => {
  const f = await fixture();
  await runInDurableObject(f.stub, async (_, state) => {
    const budget = new BudgetDO(state, env);
    const request = {
      budgetId: f.ids.budget,
      sessionId: f.ids.content,
      requestId: crypto.randomUUID(),
      epoch: 1,
      bytes: 9,
    };
    await budget.reserve(request);
    await budget.settle({
      budgetId: request.budgetId,
      requestId: request.requestId,
      deliveredBytes: null,
    });
    await expect(budget.reserve({ ...request, requestId: crypto.randomUUID() })).rejects.toThrow(
      /budget_exceeded/,
    );
    state.storage.sql.exec("UPDATE budget_state SET expires_at=1");
    await budget.reserve({ ...request, requestId: crypto.randomUUID() });
    expect(budget.status()).toMatchObject({ bytesCharged: 9, requests: 2, active: 1 });
  });
});

it("keeps the ten-minute request limit when a shorter ticket budget expires and is renewed", async () => {
  const f = await fixture(0);
  await runInDurableObject(f.stub, async (_, state) => {
    const budget = new BudgetDO(state, env);
    const base = { budgetId: f.ids.budget, sessionId: f.ids.content, epoch: 1, bytes: 0 };
    await budget.reserve({ ...base, requestId: crypto.randomUUID() });
    // The byte lifetime ended and D1 now authorizes a renewed ticket, but the rate
    // window has not elapsed. The full 1,024-request boundary is exercised below.
    state.storage.sql.exec("UPDATE budget_state SET expires_at=1,requests=1024");
    state.storage.sql.exec("UPDATE budget_leases SET expires_at=1");
    await expect(budget.reserve({ ...base, requestId: crypto.randomUUID() })).rejects.toThrow(
      "budget_exceeded",
    );
    expect(budget.status()).toMatchObject({ requests: 1024 });
    state.storage.sql.exec("UPDATE budget_state SET window_start=?", Date.now() - 600_001);
    await budget.reserve({ ...base, requestId: crypto.randomUUID() });
    expect(budget.status()).toMatchObject({ requests: 1, active: 1 });
  });
});

it("enforces eight parallel leases and releases expired concurrency through the alarm", async () => {
  const f = await fixture(100);
  const additional = await anotherSession(f, [target(f, 100, crypto.randomUUID())]);
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
    await expect(
      budget.reserve({ ...base, sessionId: additional.session, requestId: crypto.randomUUID() }),
    ).rejects.toThrow("budget_exceeded");
    expect(budget.status()).toMatchObject({ byteLimit: 300, bytesCharged: 8, requests: 8 });
    expect(
      state.storage.sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM budget_targets").one().n,
    ).toBe(1);
    await budget.settle({ budgetId: f.ids.budget, requestId: ids[0] ?? "", deliveredBytes: 1 });
    await budget.reserve({
      ...base,
      sessionId: additional.session,
      requestId: crypto.randomUUID(),
    });
    expect(budget.status()).toMatchObject({ byteLimit: 600 });
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

// This exercises 1,024 real D1 admissions, which can exceed the default timeout under load.
it("counts every zero-byte request and stops at 1,024 within the budget window", {
  timeout: 60_000,
}, async () => {
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
