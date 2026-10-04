import { applyD1Migrations, evictDurableObject, runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { KdfUnavailableError } from "../../src/auth/kdf";
import { atomicBatch } from "../../src/db/primary";
import { CONTROL_NAME, ControlDO } from "../../src/do/ControlDO";
import { ControlKdf } from "../../src/do/controlKdf";
import { EPOCH_PREFIX } from "../../src/do/epochHistory";
import { type KdfDispatch, KdfSettlements } from "../../src/do/kdfSettlements";

beforeAll(() => applyD1Migrations(env.DB, env.TEST_MIGRATIONS));
const fixtures: string[] = [];
beforeEach(async () => {
  await env.DB.prepare("UPDATE control SET epoch=1,maintenance=0").run();
  await env.DB.prepare("UPDATE control SET kdf_not_before=0").run();
});
afterEach(async () => {
  vi.restoreAllMocks();
  // Only synthetic claims with no native dispatch are retired by this fixture cleanup.
  for (const id of fixtures.splice(0))
    await env.DB.prepare(
      "UPDATE kdf_attempts SET state='not_started',finished_at=MAX(issued_at,strftime('%s','now')*1000) WHERE id=? AND state='claimed'",
    )
      .bind(id)
      .run();
});
const request = () => ({
  id: crypto.randomUUID(),
  epoch: 1,
  deadline: Date.now() + 5000,
  input: new Uint8Array(32).fill(5).buffer,
  salt: new Uint8Array(16).fill(2),
});
const dispatch = (deadline = Date.now() + 5000): KdfDispatch => ({
  id: crypto.randomUUID(),
  token: crypto.randomUUID(),
  epoch: 1,
  deadline,
});
const saved = (r: KdfDispatch) =>
  env.DB.prepare("SELECT * FROM kdf_attempts WHERE id=?").bind(r.id).first();
async function claim(r: KdfDispatch) {
  fixtures.push(r.id);
  await env.DB.prepare(`INSERT INTO kdf_attempts(id,dispatch_token,epoch,issued_at,expires_at)
    VALUES(?,?,?,strftime('%s','now')*1000,MIN(?,strftime('%s','now')*1000+5000))`)
    .bind(r.id, r.token, r.epoch, r.deadline)
    .run();
}
function fixture() {
  const stub = env.CONTROL.get(env.CONTROL.idFromName(`kdf-settle-${crypto.randomUUID()}`));
  return {
    stub,
    use: <T>(
      action: (store: KdfSettlements, state: DurableObjectState) => Promise<T>,
      db = env.DB,
    ) =>
      runInDurableObject(stub, async (_, state) =>
        action(new KdfSettlements(state.storage.sql, db, () => state.storage.sync()), state),
      ),
  };
}
function fault(kind: "write" | "write-ack" | "read"): D1Database {
  const wrap = (statement: D1PreparedStatement, sql: string): D1PreparedStatement =>
    new Proxy(statement, {
      get(target, property) {
        if (property === "bind") return (...args: unknown[]) => wrap(target.bind(...args), sql);
        if (property === "run" && sql.startsWith("UPDATE kdf_attempts SET state="))
          return async () => {
            if (kind === "read") return target.run();
            if (kind === "write-ack") await target.run();
            throw new Error("settlement_write_lost");
          };
        if (
          property === "first" &&
          kind === "read" &&
          sql.startsWith("SELECT state,epoch,expires_at FROM kdf_attempts")
        )
          return async () => {
            throw new Error("settlement_read_lost");
          };
        const value = Reflect.get(target, property, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
  return {
    batch: env.DB.batch.bind(env.DB),
    prepare: (sql: string) => wrap(env.DB.prepare(sql), sql),
  } as unknown as D1Database;
}

it("persists actual native completion, repairs after eviction, and never repeats crypto", async () => {
  const f = fixture(),
    native = vi.spyOn(crypto.subtle, "deriveBits"),
    r = request();
  await f.use(async (store) => {
    await expect(
      new ControlKdf(
        fault("write"),
        async () => {},
        () => {},
        store,
      ).derive(r),
    ).rejects.toBeInstanceOf(KdfUnavailableError);
  }, fault("write"));
  expect(native).toHaveBeenCalledTimes(1);
  await f.use(async (_, state) => {
    const row = state.storage.sql.exec("SELECT * FROM control_kdf_receipts").one();
    expect(row).toMatchObject({ id: r.id, epoch: 1, state: "finished" });
    expect(Object.keys(row).sort()).toEqual([
      "deadline",
      "dispatch_started",
      "epoch",
      "id",
      "state",
      "token",
    ]);
  });
  expect(
    await env.DB.prepare("SELECT state FROM kdf_attempts WHERE id=?").bind(r.id).first("state"),
  ).toBe("claimed");
  await evictDurableObject(f.stub);
  expect(await f.use((store) => store.repair())).toEqual({
    checked: 1,
    reconciled: 1,
    pending: 0,
    unknown: 0,
  });
  expect(native).toHaveBeenCalledTimes(1);
  expect(
    await env.DB.prepare("SELECT state FROM kdf_attempts WHERE id=?").bind(r.id).first("state"),
  ).toBe("finished");
});

it.each(["write-ack", "read"] as const)(
  "reconciles a committed settlement after losing its %s without refunding rate",
  async (kind) => {
    const f = fixture(),
      r = dispatch();
    await claim(r);
    await f.use(async (store) => {
      store.reserve(r);
      if (kind === "write-ack") await store.settle(r, "finished");
      else await expect(store.settle(r, "finished")).rejects.toThrow();
    }, fault(kind));
    expect(await saved(r)).toMatchObject({ state: "finished" });
    const repaired = await f.use((store) => store.repair());
    expect(repaired.pending).toBe(0);
    expect(repaired.reconciled).toBe(kind === "read" ? 1 : 0);
    expect(await saved(r)).toMatchObject({ state: "finished" });
  },
);

it("keeps unproven dispatched work across eviction and does not repair an unrelated D1 claim", async () => {
  const f = fixture(),
    r = dispatch();
  await claim(r);
  await f.use(async (store) => {
    store.reserve(r);
    await store.beginDispatch(r);
  });
  await evictDurableObject(f.stub);
  expect(await f.use((store) => store.repair())).toEqual({
    checked: 1,
    reconciled: 0,
    pending: 1,
    unknown: 1,
  });
  await f.use(async (store) => {
    expect(() => store.assertEmpty()).toThrow("recovery_kdf_unsettled");
  });
  expect(await saved(r)).toMatchObject({ state: "claimed" });
  const unrelated = fixture();
  expect((await unrelated.use((store) => store.repair())).checked).toBe(0);
  expect(await saved(r)).toMatchObject({ state: "claimed" });
});

it("keeps absent unsent proof until a D1 write barrier passes the original deadline; a late claim fails", async () => {
  const f = fixture(),
    r = dispatch(Date.now() + 2000);
  await f.use(async (store) => {
    store.reserve(r);
    await expect(store.settle(r, "not_started")).rejects.toThrow("kdf_unavailable");
    expect((await store.repair()).pending).toBe(1);
  });
  await new Promise((resolve) => setTimeout(resolve, Math.max(1, r.deadline - Date.now() + 1100)));
  expect(await f.use((store) => store.repair())).toEqual({
    checked: 1,
    reconciled: 1,
    pending: 0,
    unknown: 0,
  });
  await expect(claim(r)).rejects.toThrow();
  expect(await saved(r)).toBeNull();
});

it("does not release another handler's claim when the same request ID is reused", async () => {
  const f = fixture(),
    original = dispatch(),
    duplicate = { ...original, token: crypto.randomUUID(), deadline: Date.now() + 1000 };
  await claim(original);
  await f.use(async (store) => {
    store.reserve(duplicate);
    await expect(store.settle(duplicate, "not_started")).rejects.toThrow();
  });
  await new Promise((resolve) =>
    setTimeout(resolve, Math.max(1, duplicate.deadline - Date.now() + 1100)),
  );
  expect((await f.use((store) => store.repair())).pending).toBe(0);
  expect(await saved(original)).toMatchObject({ state: "claimed", dispatch_token: original.token });
});

it("retains a proof if the absence barrier acknowledgement is lost", async () => {
  const f = fixture(),
    r = dispatch(Date.now() - 1000);
  const db = {
    prepare: env.DB.prepare.bind(env.DB),
    batch: async (statements: D1PreparedStatement[]) => {
      await env.DB.batch(statements);
      throw new Error("barrier_ack_lost");
    },
  } as unknown as D1Database;
  await f.use(async (store) => {
    store.reserve(r);
    await expect(store.settle(r, "not_started")).rejects.toThrow("barrier_ack_lost");
    expect((await store.repair()).pending).toBe(1);
  }, db);
  expect((await f.use((store) => store.repair())).pending).toBe(0);
});

it("bounds local outstanding records before any new claim or crypto dispatch", async () => {
  const f = fixture(),
    native = vi.spyOn(crypto.subtle, "deriveBits"),
    r = request();
  await f.use(async (store, state) => {
    for (let i = 0; i < 20; i++) {
      const r = dispatch();
      store.reserve(r);
      await store.beginDispatch(r);
    }
    await expect(
      new ControlKdf(
        env.DB,
        async () => {},
        () => {},
        store,
      ).derive(r),
    ).rejects.toThrow("kdf_unavailable");
    expect(state.storage.sql.exec("SELECT COUNT(*) AS n FROM control_kdf_receipts").one().n).toBe(
      20,
    );
    expect(() => state.storage.sql.exec("DELETE FROM control_kdf_receipts")).toThrow(
      "kdf_completion_required",
    );
  });
  expect(native).not.toHaveBeenCalled();
  expect(
    await env.DB.prepare("SELECT 1 FROM kdf_attempts WHERE id=?").bind(r.id).first(),
  ).toBeNull();
});

it("enforces immutable proof identity and bounded repair pages", async () => {
  const f = fixture(),
    rows = [dispatch(), dispatch()];
  for (const row of rows) await claim(row);
  await f.use(async (store, state) => {
    for (const row of rows) {
      store.reserve(row);
      await expect(store.settle(row, "finished")).rejects.toThrow();
    }
    expect(() =>
      state.storage.sql.exec("UPDATE control_kdf_receipts SET deadline=deadline+1"),
    ).toThrow("immutable_kdf_receipt");
  }, fault("write"));
  expect(await f.use((store) => store.repair(1))).toEqual({
    checked: 1,
    reconciled: 1,
    pending: 1,
    unknown: 0,
  });
  expect((await f.use((store) => store.repair())).pending).toBe(0);
  await f.use(async (store) => {
    await expect(store.repair(21)).rejects.toThrow("invalid_kdf_repair_limit");
  });
});

it("refuses conflicting terminal receipts instead of rewriting them", async () => {
  const f = fixture(),
    r = dispatch();
  await claim(r);
  await env.DB.prepare(
    "UPDATE kdf_attempts SET state='not_started',finished_at=issued_at WHERE id=?",
  )
    .bind(r.id)
    .run();
  await f.use(async (store) => {
    store.reserve(r);
    await expect(store.settle(r, "finished")).rejects.toThrow();
    expect((await store.repair()).pending).toBe(1);
    await expect(store.settle(r, "not_started")).rejects.toThrow();
  });
  expect(await saved(r)).toMatchObject({ state: "not_started" });
});

it("preserves actual completion in D1 when local completion storage fails", async () => {
  const f = fixture(),
    r = request();
  await f.use(async (_, state) => {
    const sql = {
      exec: (query: string, ...values: SqlStorageValue[]) => {
        if (query.startsWith("UPDATE control_kdf_receipts SET state="))
          throw new Error("storage_unavailable");
        return state.storage.sql.exec(query, ...values);
      },
    } as SqlStorage;
    const store = new KdfSettlements(sql, env.DB, () => state.storage.sync());
    await expect(
      new ControlKdf(
        env.DB,
        async () => {},
        () => {},
        store,
      ).derive(r),
    ).rejects.toThrow("kdf_unavailable");
    expect((await store.repair()).unknown).toBe(1);
  });
  expect(
    await env.DB.prepare("SELECT state FROM kdf_attempts WHERE id=?").bind(r.id).first("state"),
  ).toBe("finished");
  await evictDurableObject(f.stub);
  expect(await f.use((store) => store.repair())).toMatchObject({
    reconciled: 1,
    pending: 0,
    unknown: 0,
  });
});

it("repairs old-epoch completion through ControlDO maintenance RPC and requires a new full audit", async () => {
  const stub = env.CONTROL.get(env.CONTROL.idFromName(CONTROL_NAME));
  await env.BACKUPS.put(
    `${EPOCH_PREFIX}1.json`,
    JSON.stringify({ epoch: 1, at: 1, reason: "operator" }),
  );
  let { epoch } = await stub.recover();
  const audit = async () => {
    await stub.beginRecoveryAudit(epoch);
    let done = false;
    for (let i = 0; i < 20 && !done; i++)
      done = (await stub.nextRecoveryAuditPage(epoch)).completed;
    expect(done).toBe(true);
    await stub.resumeAdmission(epoch);
  };
  await audit();
  await env.DB.prepare("UPDATE control SET kdf_not_before=0").run();
  const r = { ...request(), epoch };
  await runInDurableObject(stub, async (_, state) => {
    const instance = new ControlDO(state, { ...env, DB: fault("write") });
    await expect(instance.deriveKdf(r)).rejects.toThrow("kdf_unavailable");
  });
  epoch = (await stub.bumpEpoch(epoch, "operator")).epoch;
  await evictDurableObject(stub);
  await runInDurableObject(stub, async (instance) => {
    await expect(instance.nextRecoveryAuditPage(epoch)).rejects.toThrow("recovery_kdf_unsettled");
  });
  expect(await stub.repairKdfSettlements(epoch, 20)).toEqual({
    checked: 1,
    reconciled: 1,
    pending: 0,
    unknown: 0,
  });
  await runInDurableObject(stub, async (instance) => {
    await expect(instance.resumeAdmission(epoch)).rejects.toThrow("recovery_audit_incomplete");
  });
  await audit();
  expect(
    await env.DB.prepare("SELECT state FROM kdf_attempts WHERE id=?").bind(r.id).first("state"),
  ).toBe("finished");
  expect(await stub.status()).toMatchObject({ epoch, maintenance: false });
  await stub.beginRecoveryAudit(epoch);
  let done = false;
  for (let i = 0; i < 20 && !done; i++) done = (await stub.nextRecoveryAuditPage(epoch)).completed;
  expect(done).toBe(true);
  await runInDurableObject(stub, async (instance, state) => {
    // An interrupted reservation blocks resume until repair proves it never dispatched.
    const store = new KdfSettlements(state.storage.sql, env.DB, () => state.storage.sync());
    store.reserve({ ...dispatch(Date.now() - 60000), epoch });
    await expect(instance.resumeAdmission(epoch)).rejects.toThrow("recovery_kdf_unsettled");
  });
  expect(await stub.repairKdfSettlements(epoch)).toMatchObject({ pending: 0, unknown: 0 });
  await audit();
  expect(await stub.status()).toMatchObject({ maintenance: false });
});

it("recovers a local completion write whose acknowledgement was lost", async () => {
  const f = fixture(),
    r = request();
  await f.use(async (_, state) => {
    const sql = {
      exec: (query: string, ...values: SqlStorageValue[]) => {
        const result = state.storage.sql.exec(query, ...values);
        if (query.startsWith("UPDATE control_kdf_receipts SET state="))
          throw new Error("local_ack_lost");
        return result;
      },
    } as SqlStorage;
    const store = new KdfSettlements(sql, env.DB, () => state.storage.sync());
    await expect(
      new ControlKdf(
        env.DB,
        async () => {},
        () => {},
        store,
      ).derive(r),
    ).rejects.toThrow("kdf_unavailable");
  });
  await evictDurableObject(f.stub);
  expect(await f.use((store) => store.repair())).toEqual({
    checked: 1,
    reconciled: 1,
    pending: 0,
    unknown: 0,
  });
  expect(
    await env.DB.prepare("SELECT state FROM kdf_attempts WHERE id=?").bind(r.id).first("state"),
  ).toBe("finished");
});

it("concurrent repeated repair preserves one terminal receipt and its rate charge", async () => {
  const f = fixture(),
    r = dispatch();
  await claim(r);
  await f.use(async (store) => {
    store.reserve(r);
    await expect(store.settle(r, "finished")).rejects.toThrow();
  }, fault("write"));
  await f.use(async (store) => {
    const results = await Promise.all([store.repair(), store.repair()]);
    expect(results.every((result) => result.pending === 0)).toBe(true);
    expect(await store.repair()).toEqual({ checked: 0, reconciled: 0, pending: 0, unknown: 0 });
  });
  expect(await saved(r)).toMatchObject({ state: "finished" });
});

it("repairs a crash before dispatch even after a D1 claim, and fences the suspended handler", async () => {
  const f = fixture(),
    r = dispatch();
  await claim(r);
  await f.use(async (store) => {
    store.reserve(r);
  });
  await evictDurableObject(f.stub);
  expect(await f.use((store) => store.repair())).toEqual({
    checked: 1,
    reconciled: 1,
    pending: 0,
    unknown: 0,
  });
  expect(await saved(r)).toMatchObject({ state: "not_started" });
  await f.use(async (store) => {
    await expect(store.beginDispatch(r)).rejects.toThrow("kdf_unavailable");
  });
});

it("keeps a repaired pre-claim reservation until a delayed claim can no longer arrive", async () => {
  const f = fixture(),
    r = dispatch();
  await f.use(async (store) => {
    store.reserve(r);
    expect(await store.repair()).toMatchObject({ pending: 1, unknown: 0 });
    await expect(store.beginDispatch(r)).rejects.toThrow("kdf_unavailable");
  });
  await claim(r);
  expect(await f.use((store) => store.repair())).toMatchObject({ pending: 0 });
  expect(await saved(r)).toMatchObject({ state: "not_started" });
});

it("recovers a started reservation using exact D1 terminal evidence", async () => {
  const f = fixture(),
    r = dispatch();
  await claim(r);
  await f.use(async (store) => {
    store.reserve(r);
    await store.beginDispatch(r);
  });
  await env.DB.prepare(
    "UPDATE kdf_attempts SET state='finished',finished_at=issued_at WHERE id=? AND dispatch_token=?",
  )
    .bind(r.id, r.token)
    .run();
  await evictDurableObject(f.stub);
  expect(await f.use((store) => store.repair())).toEqual({
    checked: 1,
    reconciled: 1,
    pending: 0,
    unknown: 0,
  });
});

it("never calls native crypto when dispatch intent cannot be made durable", async () => {
  const f = fixture(),
    r = request(),
    native = vi.spyOn(crypto.subtle, "deriveBits");
  await f.use(async (_, state) => {
    const store = new KdfSettlements(state.storage.sql, env.DB, async () => {
      throw new Error("sync_failed");
    });
    await expect(
      new ControlKdf(
        env.DB,
        async () => {},
        () => {},
        store,
      ).derive(r),
    ).rejects.toThrow("kdf_unavailable");
  });
  expect(native).not.toHaveBeenCalled();
  expect(
    await env.DB.prepare("SELECT state FROM kdf_attempts WHERE id=?").bind(r.id).first("state"),
  ).toBe("not_started");
});

it("migrates legacy reserved receipts conservatively without releasing unknown native work", async () => {
  const f = fixture(),
    r = dispatch();
  await claim(r);
  await f.use(async (_, state) => {
    // Simulate a receipt inserted by the older binary: its new column defaults to started.
    state.storage.sql.exec(
      "INSERT INTO control_kdf_receipts(token,id,epoch,deadline,state) VALUES(?,?,?,?,'reserved')",
      r.token,
      r.id,
      r.epoch,
      r.deadline,
    );
  });
  await evictDurableObject(f.stub);
  expect(await f.use((store) => store.repair())).toMatchObject({ pending: 1, unknown: 1 });
  expect(await saved(r)).toMatchObject({ state: "claimed" });
});

it("retains unknown native work when both completion stores fail", async () => {
  const f = fixture(),
    r = request();
  fixtures.push(r.id);
  await f.use(async (_, state) => {
    const sql = {
      exec: (query: string, ...values: SqlStorageValue[]) => {
        if (query.startsWith("UPDATE control_kdf_receipts SET state="))
          throw new Error("local_lost");
        return state.storage.sql.exec(query, ...values);
      },
    } as SqlStorage;
    const db = fault("write");
    const store = new KdfSettlements(sql, db, () => state.storage.sync());
    await expect(
      new ControlKdf(
        db,
        async () => {},
        () => {},
        store,
      ).derive(r),
    ).rejects.toThrow("kdf_unavailable");
  });
  await evictDurableObject(f.stub);
  expect(await f.use((store) => store.repair())).toMatchObject({ pending: 1, unknown: 1 });
  expect(
    await env.DB.prepare("SELECT state FROM kdf_attempts WHERE id=?").bind(r.id).first("state"),
  ).toBe("claimed");
});

it("upgrades the old SQLite schema without treating legacy reservations as unstarted", async () => {
  const f = fixture(),
    r = dispatch();
  await claim(r);
  await runInDurableObject(f.stub, async (_, state) => {
    state.storage.sql.exec("DROP TABLE control_kdf_receipts");
    state.storage.sql.exec(`CREATE TABLE control_kdf_receipts(
      token TEXT PRIMARY KEY,id TEXT NOT NULL,epoch INTEGER NOT NULL,deadline INTEGER NOT NULL,
      state TEXT NOT NULL CHECK(state IN ('reserved','finished','not_started')))`);
    state.storage.sql.exec(
      "INSERT INTO control_kdf_receipts VALUES(?,?,?,?,'reserved')",
      r.token,
      r.id,
      r.epoch,
      r.deadline,
    );
    const store = new KdfSettlements(state.storage.sql, env.DB, () => state.storage.sync());
    expect(
      state.storage.sql.exec("SELECT dispatch_started FROM control_kdf_receipts").one()
        .dispatch_started,
    ).toBe(1);
    expect(await store.repair()).toMatchObject({ pending: 1, unknown: 1 });
    expect(() =>
      state.storage.sql.exec("UPDATE control_kdf_receipts SET dispatch_started=0"),
    ).toThrow("immutable_kdf_receipt");
  });
});

it("does not cancel a later reservation that started while an earlier repair awaited D1", async () => {
  const f = fixture(),
    rows = [dispatch(), dispatch()].sort((a, b) => a.token.localeCompare(b.token));
  for (const r of rows) await claim(r);
  await f.use(async (_, state) => {
    let interleaved = false;
    let store: KdfSettlements;
    const wrap = (statement: D1PreparedStatement, sql: string): D1PreparedStatement =>
      new Proxy(statement, {
        get(target, property) {
          if (property === "bind") return (...args: unknown[]) => wrap(target.bind(...args), sql);
          if (property === "run" && sql.startsWith("UPDATE kdf_attempts SET state="))
            return async () => {
              if (!interleaved) {
                interleaved = true;
                await store.beginDispatch(rows[1]!);
              }
              return target.run();
            };
          const value = Reflect.get(target, property, target);
          return typeof value === "function" ? value.bind(target) : value;
        },
      });
    const db = {
      batch: env.DB.batch.bind(env.DB),
      prepare: (sql: string) => wrap(env.DB.prepare(sql), sql),
    } as unknown as D1Database;
    store = new KdfSettlements(state.storage.sql, db, () => state.storage.sync());
    for (const r of rows) store.reserve(r);
    expect(await store.repair()).toMatchObject({ reconciled: 1, pending: 1, unknown: 1 });
    expect(await saved(rows[0]!)).toMatchObject({ state: "not_started" });
    expect(await saved(rows[1]!)).toMatchObject({ state: "claimed" });
  });
});
