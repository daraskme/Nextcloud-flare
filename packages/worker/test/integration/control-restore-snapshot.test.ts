import { applyD1Migrations, evictDurableObject, runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { RESTORE_BACKUPS_PROBE_KEY } from "../../../shared/src/restoreBackups";
import type { RestoreSnapshotChallenge } from "../../../shared/src/restoreSnapshot";
import type { RestoreTimeTravelGrant } from "../../../shared/src/restoreTimeTravel";
import { atomicBatch } from "../../src/db/primary";
import { insertR2Write, type R2WriteGrant } from "../../src/db/r2Write";
import { RESTORE_SNAPSHOT_CONTROL_QUERY } from "../../src/db/restoreSnapshot";
import { exportTables } from "../../src/db/schemaContract";
import { CONTROL_NAME, ControlDO } from "../../src/do/ControlDO";
import { ControlDatabaseRestore } from "../../src/do/controlDatabaseRestore";
import { ControlKdf } from "../../src/do/controlKdf";
import { EPOCH_PREFIX } from "../../src/do/epochHistory";
import { KdfSettlements } from "../../src/do/kdfSettlements";
import { BINDING_PROBE_KEY } from "../../src/r2/bindingProbe";
import { rollbackNativeReceipt } from "../fixtures/nativeRollback";
import { inventoryEnv } from "../fixtures/s3Inventory";
import { injectBatch } from "../fixtures/uploadEnv";

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
const adopted = async () => {
  await verifySnapshot();
  await control().attestDatabaseRestoreAdoption(epoch, id, await adopt());
};
const auditedRestore = async () => {
  for (let i = 0; i < 30; i++) {
    const result = await control().auditDatabaseRestoreRecovery(epoch, id, 20);
    if (result.audit.completed) return result;
  }
  throw new Error("recovery_fixture_incomplete");
};
const releaseRecovery = () =>
  runInDurableObject(control(), (_instance, state) =>
    configured(state).releaseDatabaseRestoreRecovery(epoch, id),
  );

it("settles live KDF non-dispatch evidence while retaining proof until archival succeeds", async () => {
  await adopted();
  const native = vi.spyOn(crypto.subtle, "deriveBits");
  await runInDurableObject(control(), async (_, state) => {
    // Explicit interrupted-handler fixture: no native dispatch and no D1 claim.
    const store = new KdfSettlements(state.storage.sql, env.DB),
      grant = {
        id: crypto.randomUUID(),
        token: crypto.randomUUID(),
        epoch: 1,
        deadline: Date.now() - 60000,
      };
    store.reserve(grant);
    state.storage.sql.exec(
      "CREATE TRIGGER fixture_history_unavailable BEFORE INSERT ON control_native_history BEGIN SELECT RAISE(ABORT,'history_unavailable'); END",
    );
    await expect(store.settle(grant, "not_started")).rejects.toThrow(/history_unavailable/);
    expect(state.storage.sql.exec("SELECT state FROM control_kdf_receipts").one().state).toBe(
      "not_started",
    );
  });
  await evictDurableObject(control());
  await control().repairDatabaseRestoreNative(epoch, id);
  expect((await control().repairDatabaseRestoreNative(epoch, id)).repair).toMatchObject({
    completed: true,
    unknown: 0,
    databasePending: { kdf: 0, r2: 0 },
    live: { kdf: { checked: 1, reconciled: 0, pending: 1, unknown: 0 } },
  });
  await runInDurableObject(control(), async (instance, state) => {
    await expect(instance.nextRecoveryAuditPage(epoch + 1)).rejects.toThrow(/kdf_unsettled/);
    state.storage.sql.exec("DROP TRIGGER fixture_history_unavailable");
  });
  await evictDurableObject(control());
  expect((await control().repairDatabaseRestoreNative(epoch, id)).repair.live.kdf).toEqual({
    checked: 1,
    reconciled: 1,
    pending: 0,
    unknown: 0,
  });
  expect(native).not.toHaveBeenCalled();
  expect((await control().inspectDatabaseRestore(epoch, id)).state).toBe("epoch_adopted");
  expect((await control().recover()).maintenance).toBe(true);
});

it.each(["current", "stop"])(
  "repairs live R2 completion without dispatching another delete: %s",
  async (source) => {
    await adopted();
    const grant: R2WriteGrant = {
      id: crypto.randomUUID(),
      token: crypto.randomUUID(),
      epoch: epoch + 1,
      ownerId: "fixture",
      kind: "manifest.delete",
      key: `target-sets/${crypto.randomUUID()}`,
      startedAt: Date.now(),
      deadline: Date.now() + 5000,
    };
    // Explicit dispatch fixture: preserve the exact live grant before actual native I/O.
    await atomicBatch(env.DB, [insertR2Write(grant, "pending")]);
    await runInDurableObject(control(), async (_, state) => {
      state.storage.sql.exec(
        "INSERT INTO control_r2_write_receipts VALUES(?,?,?,'pending')",
        grant.id,
        grant.token,
        JSON.stringify(grant),
      );
    });
    await env.BLOBS.put(grant.key, "actual native object");
    const native = vi.spyOn(env.BLOBS, "delete");
    await env.BLOBS.delete(grant.key);
    await runInDurableObject(control(), async (_, state) => {
      const db = injectBatch(
        (sql) => sql.startsWith("UPDATE r2_write_attempts"),
        async () => {
          throw new Error("settlement_unavailable");
        },
        false,
      );
      await expect(
        new ControlDO(state, { ...env, DB: db }).finishR2Write(grant, "succeeded"),
      ).rejects.toThrow(/unsettled/);
      expect(
        state.storage.sql.exec("SELECT state FROM control_r2_write_receipts").one().state,
      ).toBe("succeeded");
    });
    await evictDurableObject(control());
    if (source === "stop") {
      await runInDurableObject(control(), async (instance, state) => {
        const db = injectBatch(
          (sql) => sql.startsWith("UPDATE r2_write_attempts"),
          async () => {
            await instance.quiesce(epoch + 1);
          },
          true,
        );
        await expect(
          new ControlDO(state, { ...env, DB: db }).repairDatabaseRestoreNative(epoch, id),
        ).rejects.toThrow(/recovery_conflict/);
        expect(
          state.storage.sql
            .exec("SELECT 1 FROM control_database_restore_native_repair WHERE id=?", id)
            .toArray(),
        ).toHaveLength(0);
      });
      expect(native).toHaveBeenCalledTimes(1);
      expect((await control().recover()).maintenance).toBe(true);
      return;
    }
    expect((await control().repairDatabaseRestoreNative(epoch, id)).repair).toMatchObject({
      live: { r2: { checked: 1, reconciled: 1, pending: 0, unknown: 0 } },
      databasePending: { kdf: 0, r2: 0 },
    });
    expect(
      await env.DB.prepare("SELECT state FROM r2_write_attempts WHERE id=?")
        .bind(grant.id)
        .first("state"),
    ).toBe("succeeded");
    expect(native).toHaveBeenCalledTimes(1);
    expect((await control().inspectDatabaseRestore(epoch, id)).state).toBe("epoch_adopted");
  },
);

it("reports a D1 claim appearing behind a completed cursor without treating the scan as proof of absence", async () => {
  const claimId = crypto.randomUUID();
  await env.DB.prepare("UPDATE control SET kdf_not_before=0").run();
  await env.DB.prepare(`INSERT INTO kdf_attempts(id,dispatch_token,epoch,issued_at,expires_at)
    VALUES(?,?,1,strftime('%s','now')*1000,strftime('%s','now')*1000+5000)`)
    .bind(claimId, crypto.randomUUID())
    .run();
  const retire = () =>
    env.DB.prepare(
      "UPDATE kdf_attempts SET state='not_started',finished_at=MAX(issued_at,strftime('%s','now')*1000) WHERE id=? AND state='claimed'",
    )
      .bind(claimId)
      .run();
  await retire();
  try {
    await adopted();
    expect((await control().repairDatabaseRestoreNative(epoch, id)).repair.stage).toBe("r2");
    // The KDF page has already passed; simulate a subsequently visible restored claim.
    await rollbackNativeReceipt(env.DB, "kdf_attempts", claimId);
    expect((await control().repairDatabaseRestoreNative(epoch, id)).repair).toMatchObject({
      completed: true,
      checked: 0,
      unknown: 0,
      databasePending: { kdf: 1, r2: 0 },
      live: { kdf: { pending: 0 }, r2: { pending: 0 } },
    });
    expect((await control().inspectDatabaseRestore(epoch, id)).state).toBe("epoch_adopted");
  } finally {
    // This fixture never dispatched crypto.
    await retire();
  }
});

it("reports DO-only unknown KDF and R2 holds even when the D1 scan is empty", async () => {
  await adopted();
  await runInDurableObject(control(), async (_, state) => {
    // Unsent synthetic grants model interruption before a D1 row was observed.
    new KdfSettlements(state.storage.sql, env.DB).reserve({
      id: crypto.randomUUID(),
      token: crypto.randomUUID(),
      epoch: 1,
      deadline: Date.now() - 60000,
    });
    const grant: R2WriteGrant = {
      id: crypto.randomUUID(),
      token: crypto.randomUUID(),
      epoch: 1,
      ownerId: "fixture",
      kind: "manifest.delete",
      key: `target-sets/${crypto.randomUUID()}`,
      startedAt: Date.now() - 65000,
      deadline: Date.now() - 60000,
    };
    state.storage.sql.exec(
      "INSERT INTO control_r2_write_receipts VALUES(?,?,?,'pending')",
      grant.id,
      grant.token,
      JSON.stringify(grant),
    );
  });
  await control().repairDatabaseRestoreNative(epoch, id);
  await evictDurableObject(control());
  expect((await control().repairDatabaseRestoreNative(epoch, id)).repair).toMatchObject({
    completed: true,
    unknown: 0,
    databasePending: { kdf: 0, r2: 0 },
    live: {
      kdf: { checked: 0, reconciled: 0, pending: 1, unknown: 1 },
      r2: { checked: 0, reconciled: 0, pending: 1, unknown: 1 },
    },
  });
  await runInDurableObject(control(), async (instance, state) => {
    expect(state.storage.sql.exec("SELECT state FROM control_kdf_receipts").one().state).toBe(
      "reserved",
    );
    expect(state.storage.sql.exec("SELECT state FROM control_r2_write_receipts").one().state).toBe(
      "pending",
    );
    await expect(instance.nextRecoveryAuditPage(epoch + 1)).rejects.toThrow(/unsettled/);
  });
  expect((await control().recover()).maintenance).toBe(true);
});

it("audits the restored epoch, releases its exact hold, then resumes admission and GC in separate steps", async () => {
  await adopted();
  const audited = await auditedRestore();
  expect(audited.audit).toMatchObject({ epoch: epoch + 1, stage: "complete", completed: true });
  expect((await control().recover()).maintenance).toBe(true);
  expect((await releaseRecovery()).state).toBe("recovery_ready");
  expect(await control().recover()).toEqual({
    epoch: epoch + 1,
    maintenance: true,
    gcPaused: true,
  });
  await evictDurableObject(control());
  expect((await control().releaseDatabaseRestoreRecovery(epoch, id)).state).toBe("recovery_ready");
  const resumed = await control().resumeDatabaseRestoreRecovery(epoch, id);
  expect(resumed).toMatchObject({
    state: "service_resumed",
    control: { epoch: epoch + 1, maintenance: false, gcPaused: true },
  });
  await evictDurableObject(control());
  expect((await control().resumeDatabaseRestoreRecovery(epoch, id)).state).toBe("service_resumed");
  const finished = await control().resumeDatabaseRestoreGc(epoch, id);
  expect(finished).toMatchObject({
    state: "gc_resumed",
    control: { epoch: epoch + 1, maintenance: false, gcPaused: false },
  });
  await control().pauseGarbageCollection(epoch + 1);
  expect((await control().resumeDatabaseRestoreGc(epoch, id)).control.gcPaused).toBe(true);
  expect((await control().recover()).gcPaused).toBe(true);
});

it("runs request-scoped native repair pages after adoption and invalidates the prior complete audit", async () => {
  await adopted();
  await auditedRestore();
  expect((await control().repairDatabaseRestoreNative(epoch, id, 1)).repair).toMatchObject({
    stage: "r2",
    completed: false,
  });
  await evictDurableObject(control());
  expect((await control().repairDatabaseRestoreNative(epoch, id, 1)).repair).toMatchObject({
    stage: "complete",
    completed: true,
    unknown: 0,
  });
  await runInDurableObject(control(), async (_, state) => {
    await expect(configured(state).releaseDatabaseRestoreRecovery(epoch, id)).rejects.toThrow(
      /audit_incomplete/,
    );
  });
  expect((await control().auditDatabaseRestoreRecovery(epoch, id)).audit).toMatchObject({
    stage: "users",
    pages: 0,
  });
  await auditedRestore();
  await releaseRecovery();
  await runInDurableObject(control(), async (instance) => {
    await expect(instance.repairDatabaseRestoreNative(epoch, id)).rejects.toThrow(
      /recovery_released/,
    );
  });
});

it("rejects native repair before adoption, for another request, and for invalid page limits", async () => {
  await runInDurableObject(control(), async (instance) => {
    await expect(instance.repairDatabaseRestoreNative(epoch, id)).rejects.toThrow(
      /recovery_unavailable/,
    );
  });
  await adopted();
  await runInDurableObject(control(), async (instance) => {
    await expect(
      instance.repairDatabaseRestoreNative(epoch, crypto.randomUUID()),
    ).rejects.toThrow();
    await expect(instance.repairDatabaseRestoreNative(epoch, id, 21)).rejects.toThrow(
      /invalid_recovery_limit/,
    );
  });
});

it("repairs a real native KDF after an unknown first row without releasing that row or the restore hold", async () => {
  const unknownId = "00000000-0000-0000-0000-000000000001",
    completedId = crypto.randomUUID(),
    native = vi.spyOn(crypto.subtle, "deriveBits");
  await env.DB.prepare("UPDATE control SET kdf_not_before=0").run();
  await env.DB.prepare(`INSERT INTO kdf_attempts(id,dispatch_token,epoch,issued_at,expires_at)
    VALUES(?,?,1,strftime('%s','now')*1000,strftime('%s','now')*1000+5000)`)
    .bind(unknownId, crypto.randomUUID())
    .run();
  try {
    await runInDurableObject(control(), async (_, state) => {
      // This fixture supplies the pre-restore native execution; the private recovery path never does.
      await new ControlKdf(
        env.DB,
        async () => {},
        () => {},
        new KdfSettlements(state.storage.sql, env.DB),
      ).derive({
        id: completedId,
        epoch: 1,
        deadline: Date.now() + 5000,
        input: new Uint8Array(32).fill(4).buffer,
        salt: new Uint8Array(16).fill(8),
      });
    });
    await rollbackNativeReceipt(env.DB, "kdf_attempts", completedId);
    await adopted();
    expect((await control().repairDatabaseRestoreNative(epoch, id, 1)).repair).toMatchObject({
      checked: 1,
      reconciled: 0,
      unknown: 1,
      completed: false,
    });
    await evictDurableObject(control());
    expect((await control().repairDatabaseRestoreNative(epoch, id, 1)).repair).toMatchObject({
      checked: 2,
      reconciled: 1,
      unknown: 1,
      completed: false,
    });
    await control().repairDatabaseRestoreNative(epoch, id, 1);
    expect((await control().repairDatabaseRestoreNative(epoch, id, 1)).repair).toMatchObject({
      checked: 2,
      reconciled: 1,
      unknown: 1,
      completed: true,
    });
    expect(native).toHaveBeenCalledTimes(1);
    expect(
      await env.DB.prepare("SELECT state FROM kdf_attempts WHERE id=?")
        .bind(unknownId)
        .first("state"),
    ).toBe("claimed");
    expect(
      await env.DB.prepare("SELECT state FROM kdf_attempts WHERE id=?")
        .bind(completedId)
        .first("state"),
    ).toBe("finished");
    expect((await control().inspectDatabaseRestore(epoch, id)).state).toBe("epoch_adopted");
    expect((await control().recover()).maintenance).toBe(true);
    // Starting a new pass revisits unknown rows and skips already-terminal work.
    expect((await control().repairDatabaseRestoreNative(epoch, id, 20)).repair).toMatchObject({
      checked: 1,
      reconciled: 0,
      unknown: 1,
    });
  } finally {
    // The unknown fixture had no native dispatch. Retire it so subsequent tests can freeze.
    await env.DB.prepare(`UPDATE kdf_attempts SET state='not_started',finished_at=MAX(issued_at,strftime('%s','now')*1000)
      WHERE id IN (?,?) AND state='claimed'`)
      .bind(unknownId, completedId)
      .run();
  }
});

it("keeps the restore hold until the full audit and restored FTS rebuild are proved", async () => {
  await adopted();
  await runInDurableObject(control(), async (_instance, state) => {
    const instance = configured(state);
    await expect(instance.releaseDatabaseRestoreRecovery(epoch, id)).rejects.toThrow(
      /audit_incomplete/,
    );
    await expect(instance.resumeDatabaseRestoreRecovery(epoch, id)).rejects.toThrow(/unreleased/);
    await expect(instance.resumeDatabaseRestoreGc(epoch, id)).rejects.toThrow(/not_resumed/);
  });
  await auditedRestore();
  await runInDurableObject(control(), async (_instance, state) => {
    state.storage.sql.exec("DELETE FROM control_database_restore_recovery_fts WHERE id=?", id);
    await expect(configured(state).releaseDatabaseRestoreRecovery(epoch, id)).rejects.toThrow(
      /recovery_conflict/,
    );
  });
  expect((await control().auditDatabaseRestoreRecovery(epoch, id)).audit).toMatchObject({
    stage: "users",
    pages: 0,
  });
  expect((await control().inspectDatabaseRestore(epoch, id)).state).toBe("epoch_adopted");
});

it("restarts the request's FTS proof and audit after a maintenance repair", async () => {
  await adopted();
  await auditedRestore();
  await control().rebuildRecoveryFts(epoch + 1);
  await runInDurableObject(control(), async (_instance, state) => {
    await expect(configured(state).releaseDatabaseRestoreRecovery(epoch, id)).rejects.toThrow(
      /audit_incomplete/,
    );
  });
  const restarted = await control().auditDatabaseRestoreRecovery(epoch, id);
  expect(restarted.audit).toMatchObject({ stage: "users", pages: 0, completed: false });
  await auditedRestore();
  expect((await releaseRecovery()).state).toBe("recovery_ready");
});

it("refuses to release a hold while an interrupted maintenance task remains", async () => {
  await adopted();
  await auditedRestore();
  await runInDurableObject(control(), async (_instance, state) => {
    state.storage.sql.exec(
      "INSERT INTO control_maintenance_tasks VALUES(?,?)",
      crypto.randomUUID(),
      epoch + 1,
    );
    await expect(configured(state).releaseDatabaseRestoreRecovery(epoch, id)).rejects.toThrow(
      /maintenance_active/,
    );
  });
  expect((await control().recover()).maintenance).toBe(true);
});

it("rechecks restored pending native writes in the final release transaction", async () => {
  await adopted();
  await auditedRestore();
  await env.DB.prepare(`INSERT INTO r2_write_attempts(id,token,epoch,owner_id,kind,r2_key,dispatch_before,started_at,state)
    VALUES(?,?,?,'fixture','manifest.delete','fixture',strftime('%s','now')*1000+5000,strftime('%s','now')*1000,'pending')`)
    .bind(crypto.randomUUID(), crypto.randomUUID(), epoch + 1)
    .run();
  try {
    await runInDurableObject(control(), async (_instance, state) => {
      await expect(configured(state).releaseDatabaseRestoreRecovery(epoch, id)).rejects.toThrow();
      expect(
        state.storage.sql.exec("SELECT 1 FROM control_database_restore_release").toArray(),
      ).toHaveLength(0);
    });
    expect((await control().inspectDatabaseRestore(epoch, id)).state).toBe("epoch_adopted");
  } finally {
    // This fixture inserted only a dispatch row; no native request was actually sent.
    await env.DB.prepare(
      "UPDATE r2_write_attempts SET state='not_started',finished_at=strftime('%s','now')*1000 WHERE r2_key='fixture' AND state='pending'",
    ).run();
  }
});

it("migrates an existing DO restore journal without erasing its active selection", async () => {
  await runInDurableObject(control(), async (_instance, state) => {
    await state.storage.deleteAll();
    state.storage.sql.exec(`CREATE TABLE control_database_restore(
      id TEXT PRIMARY KEY,epoch INTEGER NOT NULL,source_json TEXT NOT NULL,
      phase TEXT NOT NULL CHECK(phase IN ('preparing','cancelled')),created_at INTEGER NOT NULL)`);
    state.storage.sql.exec(
      "CREATE UNIQUE INDEX control_database_restore_active ON control_database_restore((1)) WHERE phase='preparing'",
    );
    state.storage.sql.exec(
      "INSERT INTO control_database_restore VALUES(?,2,?,'preparing',1)",
      id,
      JSON.stringify({ kind: "time_travel", bookmark: "legacy" }),
    );
    const restore = new ControlDatabaseRestore(state.storage.sql);
    expect(restore.inspect(2, id)).toMatchObject({
      state: "preparing",
      source: { kind: "time_travel", bookmark: "legacy" },
    });
    expect(restore.active()).toBe(true);
    expect(() =>
      restore.begin(2, crypto.randomUUID(), { kind: "time_travel", bookmark: "other" }),
    ).toThrow(/database_restore_active/);
    expect(
      state.storage.sql.exec("SELECT released_at FROM control_database_restore").one().released_at,
    ).toBeNull();
  });
});

it("requires the write flag for first release but retains a released receipt when disabled", async () => {
  await adopted();
  await auditedRestore();
  await runInDurableObject(control(), async (instance) => {
    await expect(instance.releaseDatabaseRestoreRecovery(epoch, id)).rejects.toThrow(
      /write_disabled/,
    );
  });
  await releaseRecovery();
  expect((await control().releaseDatabaseRestoreRecovery(epoch, id)).state).toBe("recovery_ready");
});

it("does not use a released request to reopen a newer stop and audit", async () => {
  await adopted();
  await auditedRestore();
  await releaseRecovery();
  await control().resumeDatabaseRestoreRecovery(epoch, id);
  await control().beginRecoveryAudit(epoch + 1);
  for (let i = 0; i < 30; i++)
    if ((await control().nextRecoveryAuditPage(epoch + 1, 20)).completed) break;
  await runInDurableObject(control(), async (instance) => {
    await expect(instance.resumeDatabaseRestoreRecovery(epoch, id)).rejects.toThrow(
      /audit_incomplete|recovery_conflict/,
    );
    await expect(instance.resumeDatabaseRestoreGc(epoch, id)).rejects.toThrow(/recovery_conflict/);
  });
  expect((await control().recover()).maintenance).toBe(true);
});

it("allows another restore request after release and refuses the old request while it is active", async () => {
  await adopted();
  await auditedRestore();
  await releaseRecovery();
  const nextId = crypto.randomUUID();
  expect(
    (
      await control().prepareDatabaseRestore(epoch + 1, nextId, {
        kind: "time_travel",
        bookmark: "next",
      })
    ).state,
  ).toBe("preparing");
  await runInDurableObject(control(), async (instance) => {
    await expect(instance.resumeDatabaseRestoreRecovery(epoch, id)).rejects.toThrow(
      /recovery_unavailable/,
    );
  });
});

it("does not release on a late final D1 observation", async () => {
  await adopted();
  await auditedRestore();
  await runInDurableObject(control(), async (_instance, state) => {
    const at = Date.now();
    const db = new Proxy(env.DB, {
      get: (target, key) =>
        key === "batch"
          ? async (statements: D1PreparedStatement[]) => {
              const result = await target.batch(statements);
              vi.spyOn(Date, "now").mockReturnValue(at + 30000);
              return result;
            }
          : typeof Reflect.get(target, key) === "function"
            ? Reflect.get(target, key).bind(target)
            : Reflect.get(target, key),
    });
    const instance = new ControlDO(state, { ...env, DB: db, RESTORE_WRITE_ENABLED: "true" });
    await expect(instance.releaseDatabaseRestoreRecovery(epoch, id)).rejects.toThrow(
      /recovery_timeout/,
    );
    vi.restoreAllMocks();
    expect((await instance.inspectDatabaseRestore(epoch, id)).state).toBe("epoch_adopted");
  });
  expect((await releaseRecovery()).state).toBe("recovery_ready");
});

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
  expect(c.mirror.tables).toHaveLength(78);
  expect([...c.mirror.tables].sort()).toEqual([...exportTables].sort());
  expect((await control().inspectDatabaseRestore(epoch, id)).state).toBe("snapshot_checking");
  const saved = await attest(c);
  expect(saved).toMatchObject({
    state: "snapshot_verified",
    tables: 78,
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
