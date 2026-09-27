import { applyD1Migrations, evictDurableObject, runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { RESTORE_BACKUPS_PROBE_KEY } from "../../../shared/src/restoreBackups";
import type { RestoreSnapshotChallenge } from "../../../shared/src/restoreSnapshot";
import type { RestoreTimeTravelGrant } from "../../../shared/src/restoreTimeTravel";
import { RESTORE_SNAPSHOT_CONTROL_QUERY } from "../../src/db/restoreSnapshot";
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
const result = { bookmark: "restored-new-bookmark", previousBookmark: "before-restore" };
let epoch: number, id: string, timestamp: string;
const observation = () => ({ bookmark: "opaque", timestamp, observedAt: Date.now() });
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

beforeEach(async () => {
  await finish(await begin());
  // The provider itself is simulated. Roll back the D1 control row, retaining DO evidence.
  await env.DB.prepare("UPDATE control SET restore_freeze_token=NULL").run();
  await env.DB.prepare(
    "UPDATE control SET epoch=1,maintenance=0,gc_paused=0,admission_revision=0,admission_token=NULL",
  ).run();
});
const challenge = () => control().challengeDatabaseRestoreSnapshot(epoch, id, targets);
const proof = (c: RestoreSnapshotChallenge) => ({
  validator: "restored-snapshot-v1" as const,
  schemaSha256: "a".repeat(64),
  migrations: Array.from({ length: 46 }, (_, n) => ({
    name: String(n + 1).padStart(4, "0") + "_fixture.sql",
    sha256: "b".repeat(64),
  })),
  data: { bytes: 100, sha256: "c".repeat(64) },
  tables: c.mirror.tables.map((name) => ({ name, rows: 0, sha256: "d".repeat(64) })),
});
const attest = (c: RestoreSnapshotChallenge) =>
  control().attestDatabaseRestoreSnapshot(epoch, id, c, proof(c));
const adopt = () =>
  runInDurableObject(control(), (_instance, state) =>
    configured(state).beginDatabaseRestoreAdoption(epoch, id, targets),
  );
const verifySnapshot = async () => attest(await challenge());

it("adopts exactly the reserved epoch after a fresh D1 marker, retaining maintenance and the restore hold", async () => {
  await verifySnapshot();
  const c = await adopt();
  expect(c.newEpoch).toBe(epoch + 1);
  expect((await control().inspectDatabaseRestore(epoch, id)).state).toBe("adoption_written");
  expect(await control().recover()).toEqual({ epoch, maintenance: true, gcPaused: true });
  expect(
    await env.DB.prepare(
      "SELECT epoch,maintenance,gc_paused,admission_token,backup_token,restore_freeze_token FROM control",
    ).first(),
  ).toEqual({
    epoch: epoch + 1,
    maintenance: 1,
    gc_paused: 1,
    admission_token: c.token,
    backup_token: null,
    restore_freeze_token: null,
  });
  await evictDurableObject(control());
  expect(await adopt()).toEqual(c);
  const saved = await control().attestDatabaseRestoreAdoption(epoch, id, c);
  expect(saved.state).toBe("epoch_adopted");
  expect(JSON.stringify(saved)).not.toContain(c.token);
  await evictDurableObject(control());
  expect(await control().attestDatabaseRestoreAdoption(epoch, id, c)).toEqual(saved);
  expect(await control().recover()).toEqual({
    epoch: epoch + 1,
    maintenance: true,
    gcPaused: true,
  });
  await runInDurableObject(control(), async (instance) => {
    await expect(instance.resumeAdmission(epoch + 1)).rejects.toThrow(/database_restore_active/);
    await expect(instance.resumeGarbageCollection(epoch + 1)).rejects.toThrow();
    await expect(instance.bumpEpoch(epoch + 1, "operator")).rejects.toThrow(
      /database_restore_active/,
    );
    await expect(instance.cancelDatabaseRestore(epoch, id)).rejects.toThrow(/epoch_reserved/);
    await expect(instance.challengeDatabaseRestoreSnapshot(epoch, id, targets)).rejects.toThrow();
  });
  expect((await control().beginRecoveryAudit(epoch + 1)).epoch).toBe(epoch + 1);
});

it("requires the write flag only for the first adoption dispatch", async () => {
  await verifySnapshot();
  await runInDurableObject(control(), async (instance) => {
    await expect(instance.beginDatabaseRestoreAdoption(epoch, id, targets)).rejects.toThrow(
      /write_disabled/,
    );
  });
  const c = await adopt();
  expect(await control().beginDatabaseRestoreAdoption(epoch, id, targets)).toEqual(c);
  expect((await control().attestDatabaseRestoreAdoption(epoch, id, c)).state).toBe("epoch_adopted");
});

it.each(["unverified", "expired", "changed"])(
  "refuses adoption with %s snapshot evidence before dispatch",
  async (kind) => {
    const c = await challenge();
    if (kind !== "unverified") await attest(c);
    if (kind === "expired") vi.spyOn(Date, "now").mockReturnValue(c.expiresAt);
    if (kind === "changed")
      await env.DB.prepare("UPDATE control SET updated_at=updated_at+1").run();
    const before = await env.DB.prepare("SELECT * FROM control").first();
    await runInDurableObject(control(), async (_instance, state) => {
      await expect(
        configured(state).beginDatabaseRestoreAdoption(epoch, id, targets),
      ).rejects.toThrow(/snapshot_/);
      expect(
        state.storage.sql.exec("SELECT * FROM control_database_restore_adoption").toArray(),
      ).toHaveLength(0);
    });
    expect(await env.DB.prepare("SELECT * FROM control").first()).toEqual(before);
  },
);

it("reconciles a lost D1 success without a second batch or an automatic DO publication", async () => {
  await verifySnapshot();
  await runInDurableObject(control(), async (_instance, state) => {
    const batch = vi.fn(async (statements: D1PreparedStatement[]) => {
      await env.DB.batch(statements);
      throw new Error("lost_response");
    });
    const db = new Proxy(env.DB, {
      get: (target, key) =>
        key === "batch"
          ? batch
          : typeof Reflect.get(target, key) === "function"
            ? Reflect.get(target, key).bind(target)
            : Reflect.get(target, key),
    });
    const instance = new ControlDO(state, { ...env, DB: db, RESTORE_WRITE_ENABLED: "true" });
    await expect(instance.beginDatabaseRestoreAdoption(epoch, id, targets)).rejects.toThrow(
      /lost_response/,
    );
    expect((await instance.inspectDatabaseRestore(epoch, id)).state).toBe("adoption_pending");
    expect((await instance.recover()).epoch).toBe(epoch);
    const c = await instance.beginDatabaseRestoreAdoption(epoch, id, targets);
    expect(batch).toHaveBeenCalledTimes(1);
    expect((await instance.attestDatabaseRestoreAdoption(epoch, id, c)).state).toBe(
      "epoch_adopted",
    );
    expect(batch).toHaveBeenCalledTimes(1);
  });
});

it("keeps a rejected atomic batch pending and never retries its mutation", async () => {
  await verifySnapshot();
  await runInDurableObject(control(), async (_instance, state) => {
    const batch = vi.fn(async (_statements: D1PreparedStatement[]) => {
      throw new Error("unknown_native_failure");
    });
    const db = new Proxy(env.DB, {
      get: (target, key) =>
        key === "batch"
          ? batch
          : typeof Reflect.get(target, key) === "function"
            ? Reflect.get(target, key).bind(target)
            : Reflect.get(target, key),
    });
    const instance = new ControlDO(state, { ...env, DB: db, RESTORE_WRITE_ENABLED: "true" });
    await expect(instance.beginDatabaseRestoreAdoption(epoch, id, targets)).rejects.toThrow(
      /unknown_native_failure/,
    );
    await expect(instance.beginDatabaseRestoreAdoption(epoch, id, targets)).rejects.toThrow(
      /mirror_conflict/,
    );
    expect(batch).toHaveBeenCalledTimes(1);
    expect((await instance.inspectDatabaseRestore(epoch, id)).state).toBe("adoption_pending");
    await expect(instance.challengeDatabaseRestoreSnapshot(epoch, id, targets)).rejects.toThrow(
      /snapshot_unavailable/,
    );
  });
  expect((await control().recover()).epoch).toBe(epoch);
});

it("records a late native success without publishing the epoch after its call deadline", async () => {
  await verifySnapshot();
  await runInDurableObject(control(), async (_instance, state) => {
    const at = Date.now();
    const batch = vi.fn(async (statements: D1PreparedStatement[]) => {
      const saved = await env.DB.batch(statements);
      vi.spyOn(Date, "now").mockReturnValue(at + 30000);
      return saved;
    });
    const db = new Proxy(env.DB, {
      get: (target, key) =>
        key === "batch"
          ? batch
          : typeof Reflect.get(target, key) === "function"
            ? Reflect.get(target, key).bind(target)
            : Reflect.get(target, key),
    });
    const instance = new ControlDO(state, { ...env, DB: db, RESTORE_WRITE_ENABLED: "true" });
    await expect(instance.beginDatabaseRestoreAdoption(epoch, id, targets)).rejects.toThrow(
      /adoption_timeout/,
    );
    vi.restoreAllMocks();
    expect((await instance.inspectDatabaseRestore(epoch, id)).state).toBe("adoption_written");
    expect((await instance.recover()).epoch).toBe(epoch);
    await instance.attestDatabaseRestoreAdoption(
      epoch,
      id,
      await instance.beginDatabaseRestoreAdoption(epoch, id, targets),
    );
    expect((await instance.recover()).epoch).toBe(epoch + 1);
    expect(batch).toHaveBeenCalledTimes(1);
  });
});

it("rejects a control change between snapshot preflight and atomic dispatch", async () => {
  await verifySnapshot();
  await runInDurableObject(control(), async (_instance, state) => {
    const batch = vi.fn(async (statements: D1PreparedStatement[]) => {
      await env.DB.prepare("UPDATE control SET updated_at=updated_at+1").run();
      return env.DB.batch(statements);
    });
    const db = new Proxy(env.DB, {
      get: (target, key) =>
        key === "batch"
          ? batch
          : typeof Reflect.get(target, key) === "function"
            ? Reflect.get(target, key).bind(target)
            : Reflect.get(target, key),
    });
    const instance = new ControlDO(state, { ...env, DB: db, RESTORE_WRITE_ENABLED: "true" });
    await expect(instance.beginDatabaseRestoreAdoption(epoch, id, targets)).rejects.toThrow();
    expect((await instance.recover()).epoch).toBe(epoch);
    expect(await env.DB.prepare("SELECT epoch FROM control").first("epoch")).toBe(1);
    expect((await instance.inspectDatabaseRestore(epoch, id)).state).toBe("adoption_pending");
  });
});

it.each(["token", "target", "control"])(
  "rejects %s disagreement before DO publication",
  async (kind) => {
    await verifySnapshot();
    const c = await adopt();
    if (kind === "token") c.token = crypto.randomUUID();
    if (kind === "target") c.targets.target.databaseId = crypto.randomUUID();
    if (kind === "control")
      await env.DB.prepare("UPDATE control SET updated_at=updated_at+1").run();
    await runInDurableObject(control(), async (instance) => {
      await expect(instance.attestDatabaseRestoreAdoption(epoch, id, c)).rejects.toThrow(
        /conflict/,
      );
    });
    expect((await control().recover()).epoch).toBe(epoch);
  },
);

it("binds the restored snapshot to the original request and records an observation without changing D1", async () => {
  const before = await env.DB.prepare("SELECT * FROM control").first();
  const c = await challenge();
  expect(c).toMatchObject({
    id,
    epoch,
    newEpoch: epoch + 1,
    targets,
    restoreResult: result,
    mirror: { snapshotEpoch: 1 },
  });
  expect(c.mirror.tables).toHaveLength(68);
  expect((await control().inspectDatabaseRestore(epoch, id)).state).toBe("snapshot_checking");
  const saved = await attest(c);
  expect(saved).toMatchObject({
    state: "snapshot_verified",
    tables: 68,
    validator: "restored-snapshot-v1",
  });
  expect(saved.snapshotVerifiedAt).toBeGreaterThanOrEqual(c.issuedAt);
  expect(JSON.stringify(saved)).not.toContain(c.challengeId);
  await evictDurableObject(control());
  expect(await attest(c)).toEqual(saved);
  expect(await env.DB.prepare("SELECT * FROM control").first()).toEqual(before);
  expect(await control().recover()).toEqual({ epoch, maintenance: true, gcPaused: true });
  await runInDurableObject(control(), async (instance) => {
    await expect(instance.resumeAdmission(epoch)).rejects.toThrow();
    await expect(instance.cancelDatabaseRestore(epoch, id)).rejects.toThrow(/epoch_reserved/);
  });
});

it("invalidates an earlier verified observation before a new one starts", async () => {
  const first = await challenge();
  await attest(first);
  const second = await challenge();
  expect(second.challengeId).not.toBe(first.challengeId);
  await runInDurableObject(control(), async (instance) => {
    await expect(
      instance.attestDatabaseRestoreSnapshot(epoch, id, first, proof(first)),
    ).rejects.toThrow(/snapshot_conflict/);
  });
  expect((await control().inspectDatabaseRestore(epoch, id)).state).toBe("snapshot_checking");
  expect((await attest(second)).state).toBe("snapshot_verified");
});

it.each(["control", "schema", "catalogue"])(
  "rejects changed %s while the verifier was reading",
  async (kind) => {
    const c = await challenge();
    if (kind === "control")
      await env.DB.prepare("UPDATE control SET updated_at=updated_at+1").run();
    if (kind === "schema")
      await env.DB.prepare("CREATE INDEX snapshot_fixture_index ON users(id)").run();
    if (kind === "catalogue")
      await env.DB.prepare("CREATE TABLE snapshot_fixture_extra(id TEXT)").run();
    try {
      await runInDurableObject(control(), async (instance) => {
        await expect(
          instance.attestDatabaseRestoreSnapshot(epoch, id, c, proof(c)),
        ).rejects.toThrow(/snapshot_changed/);
      });
      expect((await control().inspectDatabaseRestore(epoch, id)).state).toBe("snapshot_checking");
    } finally {
      if (kind === "schema") await env.DB.prepare("DROP INDEX snapshot_fixture_index").run();
      if (kind === "catalogue") await env.DB.prepare("DROP TABLE snapshot_fixture_extra").run();
    }
  },
);

it.each(["expired", "clock_back", "token", "targets", "tables", "hash"])(
  "rejects invalid snapshot evidence: %s",
  async (kind) => {
    const c = await challenge(),
      changed = structuredClone(c),
      evidence = proof(c);
    if (kind === "expired") vi.spyOn(Date, "now").mockReturnValue(c.expiresAt);
    if (kind === "clock_back") vi.spyOn(Date, "now").mockReturnValue(c.issuedAt - 1);
    if (kind === "token") changed.challengeId = crypto.randomUUID();
    if (kind === "targets") changed.targets.backups.bucket = "other";
    if (kind === "tables") evidence.tables.pop();
    if (kind === "hash") evidence.data.sha256 = "bad";
    await runInDurableObject(control(), async (instance) => {
      await expect(
        instance.attestDatabaseRestoreSnapshot(epoch, id, changed, evidence),
      ).rejects.toThrow();
    });
    expect((await control().inspectDatabaseRestore(epoch, id)).state).toBe("snapshot_checking");
  },
);

it("refuses to replace an already recorded proof with different data", async () => {
  const c = await challenge();
  await attest(c);
  await runInDurableObject(control(), async (instance) => {
    await expect(
      instance.attestDatabaseRestoreSnapshot(epoch, id, c, {
        ...proof(c),
        data: { bytes: 101, sha256: "e".repeat(64) },
      }),
    ).rejects.toThrow(/snapshot_conflict/);
  });
});

it("rejects a selection that no longer agrees with the actual execution grant", async () => {
  const c = await challenge();
  await runInDurableObject(control(), async (instance, state) => {
    state.storage.sql.exec(
      "UPDATE control_database_restore SET source_json=? WHERE id=?",
      JSON.stringify({ kind: "time_travel", bookmark: "other" }),
      id,
    );
    await expect(instance.attestDatabaseRestoreSnapshot(epoch, id, c, proof(c))).rejects.toThrow(
      /snapshot_unavailable/,
    );
  });
});

it("refuses a different target and a changed reservation history", async () => {
  await runInDurableObject(control(), async (instance) => {
    await expect(
      instance.challengeDatabaseRestoreSnapshot(epoch, id, {
        ...targets,
        backups: { ...targets.backups, bucket: "other" },
      }),
    ).rejects.toThrow(/snapshot_unavailable/);
    await env.BACKUPS.put(`${EPOCH_PREFIX}${epoch + 1}.json`, "conflict");
    await expect(instance.challengeDatabaseRestoreSnapshot(epoch, id, targets)).rejects.toThrow(
      /epoch_history_conflict/,
    );
  });
});

it("does not read back or reissue a reserved history PUT without its native completion", async () => {
  await runInDurableObject(control(), async (instance, state) => {
    const old = state.storage.sql.exec("SELECT * FROM control_restore_epoch_write").one();
    state.storage.sql.exec("DELETE FROM control_restore_epoch_write");
    state.storage.sql.exec(
      "INSERT INTO control_restore_epoch_write VALUES(1,?,?,?,?,'reserved')",
      old.token,
      old.epoch,
      old.at,
      old.reason,
    );
    await expect(instance.challengeDatabaseRestoreSnapshot(epoch, id, targets)).rejects.toThrow(
      /epoch_history_write_unsettled/,
    );
    expect(
      state.storage.sql.exec("SELECT state FROM control_restore_epoch_write").one().state,
    ).toBe("reserved");
  });
});

it("never publishes a late challenge after its D1 read timed out", async () => {
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
        query !== RESTORE_SNAPSHOT_CONTROL_QUERY
          ? env.DB.prepare(query)
          : {
              all: async () => {
                const value = await env.DB.prepare(query).all();
                entered();
                await gate;
                return value;
              },
            },
    } as D1Database;
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const instance = new ControlDO(state, { ...env, DB: db });
      const pending = instance
        .challengeDatabaseRestoreSnapshot(epoch, id, targets)
        .catch((error: Error) => error.message);
      await arrival;
      await vi.advanceTimersByTimeAsync(25000);
      expect(await pending).toBe("database_restore_snapshot_timeout");
      release();
      await vi.advanceTimersByTimeAsync(1);
      expect(
        state.storage.sql.exec("SELECT challenge_json FROM control_database_restore_snapshot").one()
          .challenge_json,
      ).toBeNull();
    } finally {
      release();
      vi.useRealTimers();
    }
  });
});
