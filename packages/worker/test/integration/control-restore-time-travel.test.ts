import { applyD1Migrations, evictDurableObject, runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { RESTORE_BACKUPS_PROBE_KEY } from "../../../shared/src/restoreBackups";
import type { RestoreTimeTravelGrant } from "../../../shared/src/restoreTimeTravel";
import { CONTROL_NAME, ControlDO } from "../../src/do/ControlDO";
import { EPOCH_PREFIX } from "../../src/do/epochHistory";
import { RECOVERY_FINAL_QUERY } from "../../src/do/recoveryAudit";
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
const result = { bookmark: "restored-new-bookmark", previousBookmark: "before-restore" };
let epoch: number, id: string, timestamp: string;
const observation = () => ({ bookmark: "opaque", timestamp, observedAt: Date.now() });
const execution = (state: DurableObjectState) =>
  state.storage.sql.exec("SELECT * FROM control_database_restore_execution").toArray()[0];
const configured = (state: DurableObjectState) =>
  new ControlDO(state, { ...env, RESTORE_WRITE_ENABLED: "true" });
const begin = () =>
  runInDurableObject(control(), (_instance, state) =>
    configured(state).beginDatabaseRestoreTimeTravel(epoch, id, targets, observation()),
  );
const finish = (grant: RestoreTimeTravelGrant) =>
  control().finishDatabaseRestoreTimeTravel(epoch, id, grant, result);
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
  timestamp = new Date(Date.now() - 60000).toISOString();
  await control().prepareDatabaseRestore(epoch, id, { kind: "time_travel", bookmark: "opaque" });
  const challenge = await control().challengeDatabaseRestoreD1(epoch, id, targets.target);
  await control().attestDatabaseRestoreD1(epoch, id, challenge);
  await control().attestDatabaseRestoreBookmark(epoch, id, challenge, observation());
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
    await instance.reserveDatabaseRestoreEpoch(epoch, id, targets);
  });
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

it("requires separate write enablement before issuing a grant", async () => {
  await runInDurableObject(control(), async (instance, state) => {
    await expect(
      instance.beginDatabaseRestoreTimeTravel(epoch, id, targets, observation()),
    ).rejects.toThrow(/write_disabled/);
    expect(execution(state)).toBeUndefined();
  });
});

it("persists one dispatch before returning and keeps the old epoch and hold after native success", async () => {
  const mirror = await env.DB.prepare("SELECT * FROM control").first();
  const grant = await begin();
  expect(grant).toMatchObject({
    id,
    epoch,
    newEpoch: epoch + 1,
    targets,
    bookmark: "opaque",
    timestamp,
  });
  expect(grant.expiresAt - grant.issuedAt).toBe(5000);
  await runInDurableObject(control(), async (_instance, state) => {
    expect(execution(state)).toMatchObject({ state: "pending", grant_json: JSON.stringify(grant) });
    await expect(
      configured(state).beginDatabaseRestoreTimeTravel(epoch, id, targets, observation()),
    ).rejects.toThrow(/dispatch_unavailable/);
  });
  expect(await finish(grant)).toMatchObject({
    state: "restore_written",
    newEpoch: epoch + 1,
    restoreResult: result,
  });
  await evictDurableObject(control());
  expect(await finish(grant)).toEqual(await control().inspectDatabaseRestore(epoch, id));
  expect(await control().recover()).toEqual({ epoch, maintenance: true, gcPaused: true });
  expect(await env.DB.prepare("SELECT * FROM control").first()).toEqual(mirror);
  await runInDurableObject(control(), async (instance) => {
    await expect(instance.resumeAdmission(epoch)).rejects.toThrow();
    await expect(instance.bumpEpoch(epoch, "restore")).rejects.toThrow(/database_restore_active/);
    await expect(instance.cancelDatabaseRestore(epoch, id)).rejects.toThrow(/epoch_reserved/);
  });
});

it("never reissues an unknown grant after eviction or deadline expiry", async () => {
  const grant = await begin();
  await evictDurableObject(control());
  vi.spyOn(Date, "now").mockReturnValue(grant.expiresAt + 60000);
  await runInDurableObject(control(), async (instance, state) => {
    await expect(
      configured(state).beginDatabaseRestoreTimeTravel(epoch, id, targets, observation()),
    ).rejects.toThrow(/dispatch_unavailable/);
    const status = await instance.inspectDatabaseRestore(epoch, id);
    expect(status.state).toBe("restore_pending");
    expect(JSON.stringify(status)).not.toContain(grant.token);
  });
  expect((await finish(grant)).state).toBe("restore_written");
});

it("records completion even when the restored D1 schema is unavailable and dispatch is disabled", async () => {
  const grant = await begin();
  await runInDurableObject(control(), async (_instance, state) => {
    const database = new Proxy(env.DB, {
      get() {
        throw new Error("restored schema unavailable");
      },
    });
    const instance = new ControlDO(state, { ...env, DB: database, RESTORE_WRITE_ENABLED: "false" });
    expect((await instance.finishDatabaseRestoreTimeTravel(epoch, id, grant, result)).state).toBe(
      "restore_written",
    );
    expect(await instance.recover()).toEqual({ epoch, maintenance: true, gcPaused: true });
  });
});

it.each(["token", "bookmark", "newEpoch", "targets"])(
  "rejects a changed completion %s",
  async (field) => {
    const grant = await begin(),
      changed = structuredClone(grant);
    if (field === "token") changed.token = crypto.randomUUID();
    if (field === "bookmark") changed.bookmark = "other";
    if (field === "newEpoch") changed.newEpoch++;
    if (field === "targets") changed.targets.backups.bucket = "other";
    await runInDurableObject(control(), async (instance, state) => {
      await expect(
        instance.finishDatabaseRestoreTimeTravel(epoch, id, changed, result),
      ).rejects.toThrow(/execution_conflict/);
      expect(execution(state)?.state).toBe("pending");
    });
  },
);

it("never replaces a persisted successful response", async () => {
  const grant = await begin();
  await finish(grant);
  await runInDurableObject(control(), async (instance, state) => {
    await expect(
      instance.finishDatabaseRestoreTimeTravel(epoch, id, grant, {
        ...result,
        previousBookmark: "other",
      }),
    ).rejects.toThrow(/execution_conflict/);
    expect(() => state.storage.sql.exec("DELETE FROM control_database_restore_execution")).toThrow(
      /execution_conflict/,
    );
    expect(() =>
      state.storage.sql.exec(
        "UPDATE control_database_restore_execution SET state='pending',result_json=NULL",
      ),
    ).toThrow(/execution_conflict/);
  });
});

it.each([
  "timestamp",
  "bookmark",
  "stale",
  "future",
  "targets",
  "history",
  "freeze",
  "maintenance",
])("rejects invalid preflight: %s", async (kind) => {
  await runInDurableObject(control(), async (_instance, state) => {
    const observed = observation(),
      input = structuredClone(targets);
    if (kind === "timestamp") observed.timestamp = new Date(Date.now() - 120000).toISOString();
    if (kind === "bookmark") observed.bookmark = "other";
    if (kind === "stale") observed.observedAt -= 30001;
    if (kind === "future") observed.observedAt += 10000;
    if (kind === "targets") input.backups.bucket = "other";
    if (kind === "history") await env.BACKUPS.put(`${EPOCH_PREFIX}${epoch + 1}.json`, "conflict");
    if (kind === "freeze")
      await env.DB.prepare("UPDATE control SET restore_freeze_token=NULL").run();
    if (kind === "maintenance")
      state.storage.sql.exec(
        "INSERT INTO control_maintenance_tasks VALUES(?,?)",
        crypto.randomUUID(),
        epoch,
      );
    await expect(
      configured(state).beginDatabaseRestoreTimeTravel(epoch, id, input, observed),
    ).rejects.toThrow();
    expect(execution(state)).toBeUndefined();
  });
});

it("two simultaneous requests can return only one grant", async () => {
  await runInDurableObject(control(), async (_instance, state) => {
    const instance = configured(state);
    const results = await Promise.allSettled(
      [1, 2].map(() => instance.beginDatabaseRestoreTimeTravel(epoch, id, targets, observation())),
    );
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((r) => r.status === "rejected")).toHaveLength(1);
    expect(execution(state)?.state).toBe("pending");
  });
});

it.each(["control_epoch_write", "control_restore_epoch_write"])(
  "requires native completion of %s before dispatch",
  async (table) => {
    await runInDurableObject(control(), async (_instance, state) => {
      const receipt = state.storage.sql.exec(`SELECT * FROM ${table}`).one();
      state.storage.sql.exec(`DELETE FROM ${table}`);
      state.storage.sql.exec(
        `INSERT INTO ${table} VALUES(1,?,?,?,?,'pending')`,
        receipt.token,
        receipt.epoch,
        receipt.at,
        receipt.reason,
      );
      await expect(
        configured(state).beginDatabaseRestoreTimeTravel(epoch, id, targets, observation()),
      ).rejects.toThrow(/epoch_history_write_unsettled/);
      expect(execution(state)).toBeUndefined();
    });
  },
);

it("cannot issue a grant from a final D1 observation that completes after the preflight timeout", async () => {
  await runInDurableObject(control(), async (_instance, state) => {
    let entered!: () => void, release!: () => void;
    const arrival = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const db = {
      prepare: (query: string) =>
        query !== RECOVERY_FINAL_QUERY
          ? env.DB.prepare(query)
          : {
              bind: (...values: unknown[]) => ({
                first: async () => {
                  const ready = await env.DB.prepare(query)
                    .bind(...values)
                    .first();
                  entered();
                  await gate;
                  return ready;
                },
              }),
            },
    } as D1Database;
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const instance = new ControlDO(state, { ...env, DB: db, RESTORE_WRITE_ENABLED: "true" });
      const pending = instance
        .beginDatabaseRestoreTimeTravel(epoch, id, targets, observation())
        .catch((error: Error) => error.message);
      await arrival;
      await vi.advanceTimersByTimeAsync(25000);
      expect(await pending).toBe("database_restore_dispatch_timeout");
      release();
      await vi.advanceTimersByTimeAsync(1);
      expect(execution(state)).toBeUndefined();
      expect((await instance.inspectDatabaseRestore(epoch, id)).state).toBe("epoch_reserved");
    } finally {
      release();
      vi.useRealTimers();
    }
  });
});

it("requires a clear final D1 fence even when the mirror still matches", async () => {
  await runInDurableObject(control(), async (_instance, state) => {
    const db = {
      prepare: (query: string) =>
        query !== RECOVERY_FINAL_QUERY
          ? env.DB.prepare(query)
          : {
              bind: () => ({ first: async () => null }),
            },
    } as D1Database;
    const instance = new ControlDO(state, { ...env, DB: db, RESTORE_WRITE_ENABLED: "true" });
    await expect(
      instance.beginDatabaseRestoreTimeTravel(epoch, id, targets, observation()),
    ).rejects.toThrow(/dispatch_pending/);
    expect(execution(state)).toBeUndefined();
  });
});
