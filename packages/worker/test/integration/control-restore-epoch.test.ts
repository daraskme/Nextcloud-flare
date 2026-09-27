import { applyD1Migrations, evictDurableObject, runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { RESTORE_BACKUPS_PROBE_KEY } from "../../../shared/src/restoreBackups";
import { exportTables } from "../../src/db/schemaContract";
import { CONTROL_NAME, ControlDO } from "../../src/do/ControlDO";
import { EPOCH_PREFIX } from "../../src/do/epochHistory";
import { BINDING_PROBE_KEY } from "../../src/r2/bindingProbe";
import { inventoryEnv } from "../fixtures/s3Inventory";

const targets = {
  target: {
    mode: "remote" as const,
    accountId: "a".repeat(32),
    databaseId: "00000000-0000-0000-0000-000000000000",
  },
  blobs: { accountId: "a".repeat(32), bucket: "test-blobs", jurisdiction: "default" as const },
  backups: { accountId: "a".repeat(32), bucket: "test-backups", jurisdiction: "default" as const },
};
const control = () => env.CONTROL.get(env.CONTROL.idFromName(CONTROL_NAME));
let epoch: number, id: string;
const reserve = () => control().reserveDatabaseRestoreEpoch(epoch, id, targets);
const row = (state: DurableObjectState) =>
  state.storage.sql
    .exec("SELECT * FROM control_database_restore_epoch WHERE id=?", id)
    .toArray()[0];
const nativeState = (state: DurableObjectState) =>
  state.storage.sql.exec("SELECT state FROM control_restore_epoch_write").one().state;
const mirror = () => env.DB.prepare("SELECT * FROM control").first();
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
function backups(overrides: Partial<R2Bucket>) {
  return {
    list: (options: R2ListOptions) => env.BACKUPS.list(options),
    get: (key: string) => env.BACKUPS.get(key),
    put: (...args: Parameters<R2Bucket["put"]>) => env.BACKUPS.put(...args),
    ...overrides,
  } as R2Bucket;
}
beforeAll(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
  await env.BACKUPS.put(
    EPOCH_PREFIX + "1.json",
    JSON.stringify({ epoch: 1, at: 1, reason: "operator" }),
  );
});
beforeEach(async () => {
  await env.DB.prepare("UPDATE control SET restore_freeze_token=NULL").run();
  await runInDurableObject(control(), async (_instance, state) => state.storage.deleteAll());
  await evictDurableObject(control());
  epoch = (await control().recover()).epoch;
  id = crypto.randomUUID();
  await control().prepareDatabaseRestore(epoch, id, { kind: "time_travel", bookmark: "opaque" });
  const challenge = await control().challengeDatabaseRestoreD1(epoch, id, targets.target);
  await control().attestDatabaseRestoreD1(epoch, id, challenge);
  await control().attestDatabaseRestoreBookmark(epoch, id, challenge, {
    bookmark: "opaque",
    timestamp: new Date(Date.now() - 60000).toISOString(),
  });
  vi.spyOn(globalThis, "fetch").mockImplementation(
    async () => new Response((await env.BLOBS.get(BINDING_PROBE_KEY))!.body),
  );
  await runInDurableObject(control(), async (_instance, state) => {
    const instance = new ControlDO(state, { ...env, ...inventoryEnv });
    const blobs = await instance.verifyDatabaseRestoreBlobs(epoch, id, challenge, targets.blobs);
    const probe = await instance.challengeDatabaseRestoreBackups(
      epoch,
      id,
      challenge,
      targets.backups,
    );
    await instance.attestDatabaseRestoreBackups(
      epoch,
      id,
      challenge,
      probe.attemptId,
      await (await env.BACKUPS.get(RESTORE_BACKUPS_PROBE_KEY))!.text(),
    );
    await instance.freezeDatabaseRestore(epoch, id, targets, {
      challenge,
      blobsAttempt: blobs.attemptId,
      backupsAttempt: probe.attemptId,
    });
  });
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

it("reserves one future epoch, survives eviction, and leaves every D1 table unchanged", async () => {
  const snapshot = async () =>
    (
      await env.DB.batch(exportTables.map((table) => env.DB.prepare(`SELECT * FROM "${table}"`)))
    ).map((v) => v.results);
  const before = await snapshot();
  const result = await reserve();
  expect(result).toMatchObject({
    id,
    epoch,
    newEpoch: epoch + 1,
    state: "epoch_reserved",
    targets,
    validator: "restore-epoch-v1",
  });
  expect(result).not.toHaveProperty("token");
  expect(await (await env.BACKUPS.get(`${EPOCH_PREFIX}${epoch + 1}.json`))!.json()).toEqual({
    epoch: epoch + 1,
    at: result.reservedAt,
    reason: "restore",
  });
  await evictDurableObject(control());
  expect(await reserve()).toEqual(result);
  expect(await control().inspectDatabaseRestore(epoch, id)).toMatchObject({
    state: "epoch_reserved",
    newEpoch: epoch + 1,
  });
  expect(await control().recover()).toEqual({ epoch, maintenance: true, gcPaused: true });
  expect(await snapshot()).toEqual(before);
  await runInDurableObject(control(), async (instance) => {
    await expect(instance.cancelDatabaseRestore(epoch, id)).rejects.toThrow(
      /database_restore_epoch_reserved/,
    );
    await expect(instance.bumpEpoch(epoch, "restore")).rejects.toThrow(/database_restore_active/);
    await expect(instance.resumeAdmission(epoch)).rejects.toThrow();
    await expect(instance.beginBackup(epoch, crypto.randomUUID())).rejects.toThrow();
  });
});

it.each(["missing", "expired", "different_target"])(
  "requires source evidence before reservation: %s",
  async (kind) => {
    await runInDurableObject(control(), async (instance, state) => {
      if (kind === "missing")
        state.storage.sql.exec("DELETE FROM control_database_restore_bookmark");
      else
        state.storage.sql.exec(
          `UPDATE control_database_restore_bookmark SET ${kind === "expired" ? "expires_at=1" : "target_json='{}'"}`,
        );
      await expect(instance.reserveDatabaseRestoreEpoch(epoch, id, targets)).rejects.toThrow(
        /database_restore_epoch_source_/,
      );
      expect(row(state)).toBeUndefined();
      expect((await instance.cancelDatabaseRestore(epoch, id)).state).toBe("cancelled");
    });
  },
);

it("uses the higher of current epoch, logical source epoch and numeric history", async () => {
  await env.BACKUPS.put(`${EPOCH_PREFIX}${epoch + 20}.json`, "fixture history lower bound");
  await runInDurableObject(control(), async (instance, state) => {
    const source = {
      kind: "logical",
      id: crypto.randomUUID(),
      epoch: epoch + 30,
      manifestSha256: "a".repeat(64),
    };
    state.storage.sql.exec(
      "UPDATE control_database_restore SET source_json=? WHERE id=?",
      JSON.stringify(source),
      id,
    );
    state.storage.sql.exec(
      "INSERT INTO control_database_restore_sql VALUES(?,?,?,?,?,'logical-sql-v1')",
      id,
      epoch,
      source.manifestSha256,
      Date.now(),
      Date.now() + 60000,
    );
    expect((await instance.reserveDatabaseRestoreEpoch(epoch, id, targets)).newEpoch).toBe(
      epoch + 31,
    );
  });
});

it("pins the request before listing and rejects cancellation or another allocator", async () => {
  await runInDurableObject(control(), async (instance, state) => {
    const entered = deferred(),
      release = deferred();
    const list = vi.fn(async (options: R2ListOptions) => {
      expect(row(state)?.phase).toBe("allocating");
      entered.resolve();
      await release.promise;
      return env.BACKUPS.list(options);
    });
    const put = vi.fn((...args: Parameters<R2Bucket["put"]>) => env.BACKUPS.put(...args));
    const delayed = new ControlDO(state, { ...env, BACKUPS: backups({ list, put }) });
    const pending = delayed
      .reserveDatabaseRestoreEpoch(epoch, id, targets)
      .catch((e: Error) => e.message);
    await entered.promise;
    await expect(instance.cancelDatabaseRestore(epoch, id)).rejects.toThrow(
      /database_restore_epoch_reserved/,
    );
    const result = await instance.reserveDatabaseRestoreEpoch(epoch, id, targets);
    release.resolve();
    expect(await pending).toBe("database_restore_epoch_conflict");
    expect(result.newEpoch).toBe(epoch + 1);
    expect(put).not.toHaveBeenCalled();
  });
});

it("a lost PUT response blocks exact readback, reissue and cancellation across eviction", async () => {
  const before = await mirror();
  await runInDurableObject(control(), async (instance, state) => {
    const put = vi.fn(async (...args: Parameters<R2Bucket["put"]>) => {
      await env.BACKUPS.put(...args);
      throw new Error("lost_ack");
    });
    const get = vi.fn((key: string) => env.BACKUPS.get(key));
    const custom = new ControlDO(state, { ...env, BACKUPS: backups({ put, get }) });
    await expect(custom.reserveDatabaseRestoreEpoch(epoch, id, targets)).rejects.toThrow(
      /lost_ack/,
    );
    await expect(custom.reserveDatabaseRestoreEpoch(epoch, id, targets)).rejects.toThrow(
      /epoch_history_write_unsettled/,
    );
    expect(put).toHaveBeenCalledTimes(1);
    expect(get).not.toHaveBeenCalled();
    expect(nativeState(state)).toBe("pending");
    expect((await instance.inspectDatabaseRestore(epoch, id)).state).toBe("epoch_reserving");
  });
  await evictDurableObject(control());
  await runInDurableObject(control(), async (instance) => {
    await expect(instance.reserveDatabaseRestoreEpoch(epoch, id, targets)).rejects.toThrow(
      /epoch_history_write_unsettled/,
    );
    await expect(instance.cancelDatabaseRestore(epoch, id)).rejects.toThrow(
      /database_restore_epoch_reserved/,
    );
  });
  expect(await mirror()).toEqual(before);
});

it("late native completion settles only its receipt and requires a new reservation call", async () => {
  await runInDurableObject(control(), async (instance, state) => {
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
      const custom = new ControlDO(state, { ...env, BACKUPS: backups({ put, get }) });
      const pending = custom
        .reserveDatabaseRestoreEpoch(epoch, id, targets)
        .catch((e: Error) => e.message);
      await entered.promise;
      await vi.advanceTimersByTimeAsync(10000);
      expect(await pending).toBe("epoch_history_timeout");
      release.resolve();
      await vi.advanceTimersByTimeAsync(1);
      expect(nativeState(state)).toBe("ended");
      expect(row(state)?.phase).toBe("writing");
      expect(get).not.toHaveBeenCalled();
      expect((await instance.reserveDatabaseRestoreEpoch(epoch, id, targets)).state).toBe(
        "epoch_reserved",
      );
      expect(put).toHaveBeenCalledTimes(1);
    } finally {
      release.resolve();
      vi.useRealTimers();
    }
  });
});

it("an expired history scan cannot allocate or PUT after its response arrives", async () => {
  await runInDurableObject(control(), async (instance, state) => {
    const entered = deferred(),
      release = deferred();
    const list = vi.fn(async (options: R2ListOptions) => {
      const value = await env.BACKUPS.list(options);
      entered.resolve();
      await release.promise;
      return value;
    });
    const put = vi.fn();
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const pending = new ControlDO(state, { ...env, BACKUPS: backups({ list, put }) })
        .reserveDatabaseRestoreEpoch(epoch, id, targets)
        .catch((e: Error) => e.message);
      await entered.promise;
      await vi.advanceTimersByTimeAsync(25000);
      expect(await pending).toBe("database_restore_epoch_timeout");
      release.resolve();
      await vi.advanceTimersByTimeAsync(1);
      expect(row(state)?.phase).toBe("allocating");
      expect(put).not.toHaveBeenCalled();
      expect((await instance.reserveDatabaseRestoreEpoch(epoch, id, targets)).newEpoch).toBe(
        epoch + 1,
      );
    } finally {
      release.resolve();
      vi.useRealTimers();
    }
  });
});

it("retains the original epoch after a history conflict instead of issuing a different number", async () => {
  await runInDurableObject(control(), async (instance, state) => {
    const put = vi.fn(async (...args: Parameters<R2Bucket["put"]>) => {
      await env.BACKUPS.put(args[0], "foreign history");
      return env.BACKUPS.put(...args);
    });
    const custom = new ControlDO(state, { ...env, BACKUPS: backups({ put }) });
    await expect(custom.reserveDatabaseRestoreEpoch(epoch, id, targets)).rejects.toThrow(
      /epoch_history_conflict/,
    );
    await expect(instance.reserveDatabaseRestoreEpoch(epoch, id, targets)).rejects.toThrow(
      /epoch_history_conflict/,
    );
    expect(row(state)?.new_epoch).toBe(epoch + 1);
    expect(nativeState(state)).toBe("ended");
    expect(put).toHaveBeenCalledTimes(1);
  });
});

it("rejects mismatched bindings and a cancelled freeze before allocating", async () => {
  await runInDurableObject(control(), async (instance, state) => {
    await expect(
      instance.reserveDatabaseRestoreEpoch(epoch, id, {
        ...targets,
        backups: { ...targets.backups, bucket: "other" },
      }),
    ).rejects.toThrow(/target_mismatch/);
    expect(row(state)).toBeUndefined();
    await instance.cancelDatabaseRestore(epoch, id);
    await expect(instance.reserveDatabaseRestoreEpoch(epoch, id, targets)).rejects.toThrow(
      /epoch_not_frozen/,
    );
    expect(row(state)).toBeUndefined();
  });
});

it("retries failed history scans under the same durable request", async () => {
  await runInDurableObject(control(), async (instance, state) => {
    const list = vi.fn(async () => {
      throw new Error("history_offline");
    });
    const configured = {
      ...env,
      BACKUPS: backups({ list }),
    };
    delete configured.EPOCH_FLOOR;
    const custom = new ControlDO(state, configured);
    await expect(custom.reserveDatabaseRestoreEpoch(epoch, id, targets)).rejects.toThrow(
      /history_offline/,
    );
    const before = row(state);
    expect(before?.phase).toBe("allocating");
    expect((await instance.reserveDatabaseRestoreEpoch(epoch, id, targets)).newEpoch).toBe(
      epoch + 1,
    );
    expect(row(state)?.history_token).toBe(before?.history_token);
  });
});

it("a changed final D1 mirror retains the same known-ended reservation for retry", async () => {
  await runInDurableObject(control(), async (instance, state) => {
    let reads = 0;
    const prepare = (sql: string) => {
      const statement = env.DB.prepare(sql);
      return {
        first: async () => {
          const result = await statement.first();
          return ++reads === 2 ? { ...result, restore_freeze_token: "other" } : result;
        },
      } as D1PreparedStatement;
    };
    const custom = new ControlDO(state, { ...env, DB: { prepare } as D1Database });
    await expect(custom.reserveDatabaseRestoreEpoch(epoch, id, targets)).rejects.toThrow(
      /freeze_unconfirmed/,
    );
    expect(row(state)?.phase).toBe("writing");
    expect(nativeState(state)).toBe("ended");
    expect((await instance.reserveDatabaseRestoreEpoch(epoch, id, targets)).newEpoch).toBe(
      epoch + 1,
    );
  });
});

it("cancellation that wins the first D1 read prevents any reservation or PUT", async () => {
  await runInDurableObject(control(), async (instance, state) => {
    const entered = deferred(),
      release = deferred(),
      put = vi.fn();
    const prepare = (sql: string) =>
      ({
        first: async () => {
          const value = await env.DB.prepare(sql).first();
          entered.resolve();
          await release.promise;
          return value;
        },
      }) as D1PreparedStatement;
    const pending = new ControlDO(state, {
      ...env,
      DB: { prepare } as D1Database,
      BACKUPS: backups({ put }),
    })
      .reserveDatabaseRestoreEpoch(epoch, id, targets)
      .catch((e: Error) => e.message);
    await entered.promise;
    expect((await instance.cancelDatabaseRestore(epoch, id)).state).toBe("cancelled");
    release.resolve();
    expect(await pending).toBe("database_restore_freeze_conflict");
    expect(row(state)).toBeUndefined();
    expect(put).not.toHaveBeenCalled();
  });
});

it("replays a fixed reservation after source evidence expires without refreshing its proof", async () => {
  const result = await reserve();
  await runInDurableObject(control(), async (instance, state) => {
    const proof = row(state)?.proof_json;
    const clock = vi.spyOn(Date, "now").mockReturnValue(Date.now() + 600000);
    try {
      expect(await instance.reserveDatabaseRestoreEpoch(epoch, id, targets)).toEqual(result);
      expect(row(state)?.proof_json).toBe(proof);
    } finally {
      clock.mockRestore();
    }
  });
});
