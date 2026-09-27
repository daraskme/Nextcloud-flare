import { applyD1Migrations, evictDurableObject, runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeAll, beforeEach, expect, it, vi } from "vitest";
import { CONTROL_NAME, ControlDO } from "../../src/do/ControlDO";
import { ControlEpochHistory, EPOCH_HISTORY_TIMEOUT_MS } from "../../src/do/controlEpochHistory";
import { EPOCH_PREFIX } from "../../src/do/epochHistory";

const control = () => env.CONTROL.get(env.CONTROL.idFromName(CONTROL_NAME));
const record = { epoch: 2, at: 99, reason: "operator" as const };
const key = `${EPOCH_PREFIX}2.json`;
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
const bucket = (overrides: Partial<R2Bucket> = {}) =>
  ({
    get: (key: string) => env.BACKUPS.get(key),
    put: (...args: Parameters<R2Bucket["put"]>) => env.BACKUPS.put(...args),
    ...overrides,
  }) as R2Bucket;

function reserve(state: DurableObjectState) {
  state.storage.transactionSync(() => {
    state.storage.sql.exec(
      "UPDATE control_state SET phase='pending',epoch=1,pending_epoch=2,pending_at=99,pending_reason='operator',pending_token='attempt'",
    );
    new ControlEpochHistory(state.storage.sql).reserve(record, "attempt");
  });
}

const saved = (state: DurableObjectState) =>
  state.storage.sql.exec<{ state: string }>("SELECT state FROM control_epoch_write").one().state;

beforeAll(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
});
beforeEach(async () => {
  await runInDurableObject(control(), async (_instance, state) => state.storage.deleteAll());
  await evictDurableObject(control());
  const objects = await env.BACKUPS.list({ prefix: EPOCH_PREFIX });
  if (objects.objects.length) await env.BACKUPS.delete(objects.objects.map((v) => v.key));
  await env.DB.prepare("UPDATE control SET epoch=1,maintenance=1,gc_paused=1").run();
});

it("survives eviction before dispatch and records the native end before reading back", async () => {
  await runInDurableObject(control(), async (_instance, state) => reserve(state));
  await evictDurableObject(control());
  await runInDurableObject(control(), async (_instance, state) => {
    const put = vi.fn(async (...args: Parameters<R2Bucket["put"]>) => {
      expect(saved(state)).toBe("pending");
      expect(args[2]).toMatchObject({ onlyIf: { etagDoesNotMatch: "*" } });
      return env.BACKUPS.put(...args);
    });
    const get = vi.fn(async (key: string) => {
      expect(saved(state)).toBe("ended");
      return env.BACKUPS.get(key);
    });
    const instance = new ControlDO(state, { ...env, BACKUPS: bucket({ get, put }) });
    expect(await instance.recover()).toEqual({ epoch: 2, maintenance: true, gcPaused: true });
    expect(put).toHaveBeenCalledTimes(1);
    expect(get).toHaveBeenCalledTimes(1);
    expect(saved(state)).toBe("ended");
  });
});

it.each([false, true])("conditional no-op is terminal, exact content match=%s", async (matches) => {
  await env.BACKUPS.put(key, JSON.stringify({ ...record, at: matches ? 99 : 98 }));
  await runInDurableObject(control(), async (_instance, state) => {
    reserve(state);
    const put = vi.fn(async (...args: Parameters<R2Bucket["put"]>) => {
      const result = await env.BACKUPS.put(...args);
      expect(result).toBeNull();
      return result;
    });
    const instance = new ControlDO(state, { ...env, BACKUPS: bucket({ put }) });
    if (matches) expect((await instance.recover()).epoch).toBe(2);
    else {
      await expect(instance.recover()).rejects.toThrow(/epoch_history_conflict/);
      await expect(instance.recover()).rejects.toThrow(/epoch_history_conflict/);
      expect(await env.DB.prepare("SELECT epoch FROM control").first("epoch")).toBe(1);
    }
    expect(saved(state)).toBe("ended");
    expect(put).toHaveBeenCalledTimes(1);
  });
});

it("does not infer termination for an older pending intent without a receipt", async () => {
  await env.BACKUPS.put(key, JSON.stringify(record));
  await runInDurableObject(control(), async (instance, state) => {
    state.storage.sql.exec(
      "UPDATE control_state SET phase='pending',epoch=1,pending_epoch=2,pending_at=99,pending_reason='operator',pending_token='legacy'",
    );
    await expect(instance.recover()).rejects.toThrow(/epoch_history_receipt_missing/);
    expect(state.storage.sql.exec("SELECT * FROM control_epoch_write").toArray()).toEqual([]);
    expect(await env.DB.prepare("SELECT epoch FROM control").first("epoch")).toBe(1);
  });
});

it("blocks concurrent recovery without dispatching another native PUT", async () => {
  await runInDurableObject(control(), async (instance, state) => {
    reserve(state);
    const entered = deferred(),
      release = deferred();
    const put = vi.fn(async (...args: Parameters<R2Bucket["put"]>) => {
      entered.resolve();
      await release.promise;
      return env.BACKUPS.put(...args);
    });
    const pending = new ControlDO(state, { ...env, BACKUPS: bucket({ put }) }).recover();
    await entered.promise;
    await expect(instance.recover()).rejects.toThrow(/epoch_history_write_unsettled/);
    expect(await env.DB.prepare("SELECT epoch FROM control").first("epoch")).toBe(1);
    release.resolve();
    expect((await pending).epoch).toBe(2);
    expect(put).toHaveBeenCalledTimes(1);
  });
});

it("late native success only records termination; a fresh recovery performs adoption", async () => {
  await runInDurableObject(control(), async (instance, state) => {
    reserve(state);
    const entered = deferred(),
      release = deferred();
    const put = vi.fn(async (...args: Parameters<R2Bucket["put"]>) => {
      const result = await env.BACKUPS.put(...args);
      entered.resolve();
      await release.promise;
      return result;
    });
    const get = vi.fn((key: string) => env.BACKUPS.get(key));
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const custom = new ControlDO(state, { ...env, BACKUPS: bucket({ get, put }) });
      const pending = custom.recover().catch((error: Error) => error.message);
      await entered.promise;
      await vi.advanceTimersByTimeAsync(EPOCH_HISTORY_TIMEOUT_MS);
      expect(await pending).toBe("epoch_history_timeout");
      expect(saved(state)).toBe("pending");
      await expect(instance.recover()).rejects.toThrow(/epoch_history_write_unsettled/);
      release.resolve();
      await vi.advanceTimersByTimeAsync(1);
      expect(saved(state)).toBe("ended");
      expect(get).not.toHaveBeenCalled();
      expect(await env.DB.prepare("SELECT epoch FROM control").first("epoch")).toBe(1);
      expect((await custom.recover()).epoch).toBe(2);
      expect(put).toHaveBeenCalledTimes(1);
    } finally {
      release.resolve();
      vi.useRealTimers();
    }
  });
});

it("late readback cannot adopt after timeout or overwrite a newer epoch", async () => {
  await runInDurableObject(control(), async (instance, state) => {
    reserve(state);
    const entered = deferred(),
      release = deferred();
    const get = vi.fn(async (key: string) => {
      const result = await env.BACKUPS.get(key);
      entered.resolve();
      await release.promise;
      return result;
    });
    const batch = vi.fn((statements: D1PreparedStatement[]) => env.DB.batch(statements));
    const db = { prepare: (sql: string) => env.DB.prepare(sql), batch } as unknown as D1Database;
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const pending = new ControlDO(state, { ...env, DB: db, BACKUPS: bucket({ get }) })
        .recover()
        .catch((error: Error) => error.message);
      await entered.promise;
      await vi.advanceTimersByTimeAsync(EPOCH_HISTORY_TIMEOUT_MS);
      expect(await pending).toBe("epoch_history_timeout");
      expect(saved(state)).toBe("ended");
      expect((await instance.recover()).epoch).toBe(2);
      expect((await instance.bumpEpoch(2, "operator")).epoch).toBe(3);
      release.resolve();
      await vi.advanceTimersByTimeAsync(1);
      expect(batch).not.toHaveBeenCalled();
      expect((await instance.status()).epoch).toBe(3);
      expect(await env.DB.prepare("SELECT epoch FROM control").first("epoch")).toBe(3);
    } finally {
      release.resolve();
      vi.useRealTimers();
    }
  });
});

it("a successful concurrent recovery fences the older read continuation before D1 dispatch", async () => {
  await runInDurableObject(control(), async (instance, state) => {
    reserve(state);
    const entered = deferred(),
      release = deferred();
    const get = vi.fn(async (key: string) => {
      const result = await env.BACKUPS.get(key);
      entered.resolve();
      await release.promise;
      return result;
    });
    const batch = vi.fn((statements: D1PreparedStatement[]) => env.DB.batch(statements));
    const pending = new ControlDO(state, {
      ...env,
      DB: { prepare: (sql: string) => env.DB.prepare(sql), batch } as unknown as D1Database,
      BACKUPS: bucket({ get }),
    })
      .recover()
      .catch((error: Error) => error.message);
    await entered.promise;
    expect((await instance.recover()).epoch).toBe(2);
    release.resolve();
    expect(await pending).toBe("epoch_conflict");
    expect(batch).not.toHaveBeenCalled();
  });
});

it("a delayed D1 response cannot reset the admission state of a newer epoch", async () => {
  await runInDurableObject(control(), async (instance, state) => {
    reserve(state);
    const entered = deferred(),
      release = deferred();
    const batch = vi.fn(async (statements: D1PreparedStatement[]) => {
      const result = await env.DB.batch(statements);
      entered.resolve();
      await release.promise;
      return result;
    });
    const pending = new ControlDO(state, {
      ...env,
      DB: { prepare: (sql: string) => env.DB.prepare(sql), batch } as unknown as D1Database,
    })
      .recover()
      .catch((error: Error) => error.message);
    await entered.promise;
    expect((await instance.recover()).epoch).toBe(2);
    expect((await instance.bumpEpoch(2, "operator")).epoch).toBe(3);
    release.resolve();
    expect(await pending).toBe("epoch_conflict");
    expect((await instance.status()).epoch).toBe(3);
    expect(await env.DB.prepare("SELECT epoch FROM control").first("epoch")).toBe(3);
  });
});

it.each(["pending_token='other'", "pending_at=100", "pending_reason='restore'", "pending_epoch=3"])(
  "requires the complete persisted reservation: %s",
  async (change) => {
    await runInDurableObject(control(), async (instance, state) => {
      reserve(state);
      state.storage.sql.exec(`UPDATE control_state SET ${change}`);
      await expect(instance.recover()).rejects.toThrow(/epoch_history_receipt_conflict/);
      expect(await env.BACKUPS.head(key)).toBeNull();
      expect(saved(state)).toBe("reserved");
    });
  },
);

it.each([
  JSON.stringify({ ...record, extra: true }),
  JSON.stringify({ ...record, epoch: "2" }),
  JSON.stringify(null),
  "{",
  "x".repeat(1025),
])("rejects malformed or conflicting immutable history: %s", async (value) => {
  await env.BACKUPS.put(key, value);
  await runInDurableObject(control(), async (instance, state) => {
    reserve(state);
    await expect(instance.recover()).rejects.toThrow();
    expect(saved(state)).toBe("ended");
    expect(await env.DB.prepare("SELECT epoch FROM control").first("epoch")).toBe(1);
    expect(await (await env.BACKUPS.get(key))!.text()).toBe(value);
  });
});

it("does not publish an orphaned unknown receipt or clear it for another reservation", async () => {
  await runInDurableObject(control(), async (instance, state) => {
    reserve(state);
    state.storage.sql.exec("UPDATE control_epoch_write SET state='pending'");
    state.storage.sql.exec("UPDATE control_state SET phase='ready',epoch=1");
    await expect(instance.status()).rejects.toThrow(/epoch_history_write_unsettled/);
    await expect(instance.recover()).rejects.toThrow(/epoch_history_write_unsettled/);
    await expect(instance.bumpEpoch(1, "operator")).rejects.toThrow(
      /epoch_history_write_unsettled/,
    );
    expect(() => state.storage.sql.exec("DELETE FROM control_epoch_write")).toThrow(
      /epoch_history_write_unsettled/,
    );
    expect(() => state.storage.sql.exec("UPDATE control_epoch_write SET token='other'")).toThrow(
      /epoch_history_receipt_conflict/,
    );
    expect(saved(state)).toBe("pending");
  });
});

it("retains known native termination after failed readback without reissuing the PUT", async () => {
  await runInDurableObject(control(), async (instance, state) => {
    reserve(state);
    const put = vi.fn((...args: Parameters<R2Bucket["put"]>) => env.BACKUPS.put(...args));
    const get = vi.fn(async () => null);
    const custom = new ControlDO(state, { ...env, BACKUPS: bucket({ get, put }) });
    await expect(custom.recover()).rejects.toThrow(/epoch_history_conflict/);
    await expect(custom.recover()).rejects.toThrow(/epoch_history_conflict/);
    expect(saved(state)).toBe("ended");
    expect(put).toHaveBeenCalledTimes(1);
    expect(await env.DB.prepare("SELECT epoch FROM control").first("epoch")).toBe(1);
    expect((await instance.recover()).epoch).toBe(2);
  });
});

it.each(["timeout", "clock_regression"])(
  "does not dispatch if scope verification reaches %s",
  async (kind) => {
    await runInDurableObject(control(), async (_instance, state) => {
      reserve(state);
      const now = Date.now(),
        clock = vi.spyOn(Date, "now").mockReturnValue(now),
        put = vi.fn();
      let checks = 0;
      try {
        await expect(
          new ControlEpochHistory(state.storage.sql).persist(
            bucket({ put }),
            record,
            "attempt",
            () => {
              if (++checks === 2)
                clock.mockReturnValue(
                  kind === "timeout" ? now + EPOCH_HISTORY_TIMEOUT_MS : now - 1,
                );
            },
          ),
        ).rejects.toThrow(/epoch_history_timeout/);
        expect(put).not.toHaveBeenCalled();
        expect(saved(state)).toBe("reserved");
      } finally {
        clock.mockRestore();
      }
    });
  },
);

it("bounds stalled history bodies and cancels them without adopting", async () => {
  await runInDurableObject(control(), async (_instance, state) => {
    reserve(state);
    const entered = deferred(),
      cancel = vi.fn();
    const get = vi.fn(async () => {
      entered.resolve();
      return { size: 10, body: new ReadableStream<Uint8Array>({ cancel }) } as R2ObjectBody;
    });
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const pending = new ControlDO(state, { ...env, BACKUPS: bucket({ get }) })
        .recover()
        .catch((error: Error) => error.message);
      await entered.promise;
      await vi.advanceTimersByTimeAsync(EPOCH_HISTORY_TIMEOUT_MS);
      expect(await pending).toBe("epoch_history_timeout");
      expect(cancel).toHaveBeenCalledTimes(1);
      expect(saved(state)).toBe("ended");
      expect(await env.DB.prepare("SELECT epoch FROM control").first("epoch")).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });
});

it("checks the current reservation again after a delayed D1 backup check", async () => {
  await runInDurableObject(control(), async (instance, state) => {
    reserve(state);
    const entered = deferred(),
      release = deferred(),
      put = vi.fn();
    const prepare = (sql: string) => {
      const statement = env.DB.prepare(sql);
      if (!sql.startsWith("SELECT 1 FROM control")) return statement;
      return {
        first: async () => {
          const result = await statement.first();
          entered.resolve();
          await release.promise;
          return result;
        },
      } as D1PreparedStatement;
    };
    const pending = new ControlDO(state, {
      ...env,
      DB: { prepare } as unknown as D1Database,
      BACKUPS: bucket({ put }),
    })
      .recover()
      .catch((error: Error) => error.message);
    await entered.promise;
    expect((await instance.recover()).epoch).toBe(2);
    release.resolve();
    expect(await pending).toBe("epoch_conflict");
    expect(put).not.toHaveBeenCalled();
  });
});
