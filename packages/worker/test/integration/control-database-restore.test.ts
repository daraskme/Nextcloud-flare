import { applyD1Migrations, evictDurableObject, runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeAll, beforeEach, expect, it } from "vitest";
import { atomicBatch } from "../../src/db/primary";
import { CONTROL_NAME, ControlDO } from "../../src/do/ControlDO";
import type { DatabaseRestoreSource } from "../../src/do/controlDatabaseRestore";
import { EPOCH_PREFIX } from "../../src/do/epochHistory";
import { foundationFixture } from "../fixtures/foundation";
import { injectBatch } from "../fixtures/uploadEnv";

const control = () => env.CONTROL.get(env.CONTROL.idFromName(CONTROL_NAME));
const f = foundationFixture(crypto.randomUUID(), Date.now() - 1000);
const source = (): DatabaseRestoreSource => ({
  kind: "logical",
  id: crypto.randomUUID(),
  epoch: 1,
  manifestSha256: "a".repeat(64),
});
let epoch = 0;
async function audit(
  rpc: Pick<ControlDO, "beginRecoveryAudit" | "nextRecoveryAuditPage"> = control(),
) {
  await rpc.beginRecoveryAudit(epoch);
  for (let page = 0; page < 20; page++)
    if ((await rpc.nextRecoveryAuditPage(epoch, 20)).completed) return;
  throw new Error("fixture_audit_incomplete");
}

/** Interleave once after a real primary observation but before its result reaches the caller. */
function afterFirst(predicate: (sql: string) => boolean, effect: () => Promise<void>): D1Database {
  let fired = false;
  return {
    prepare(sql: string) {
      const wrap = (statement: D1PreparedStatement): D1PreparedStatement =>
        new Proxy(statement, {
          get(target, key) {
            if (key === "bind") return (...values: unknown[]) => wrap(target.bind(...values));
            if (key === "first")
              return async (...args: unknown[]) => {
                const result = await Reflect.apply(target.first, target, args);
                if (!fired && predicate(sql)) {
                  fired = true;
                  await effect();
                }
                return result;
              };
            const value = Reflect.get(target, key, target);
            return typeof value === "function" ? value.bind(target) : value;
          },
        });
      return wrap(env.DB.prepare(sql));
    },
    batch: env.DB.batch.bind(env.DB),
  } as D1Database;
}

function unavailableDb(): D1Database {
  return {
    prepare() {
      throw new Error("primary_unavailable");
    },
  } as unknown as D1Database;
}
async function flags() {
  return env.DB.prepare("SELECT epoch,maintenance,gc_paused FROM control").first();
}
const system = () => ({
  epoch,
  spaceId: f.ids.space,
  deadline: Date.now() + 5000,
  permitId: "system:upload.observe:" + crypto.randomUUID(),
});
const global = () => ({
  epoch,
  deadline: Date.now() + 5000,
  permitId: "global:r2.probe-phase:" + crypto.randomUUID(),
});

beforeAll(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
  await env.BACKUPS.put(
    EPOCH_PREFIX + "1.json",
    JSON.stringify({ epoch: 1, at: 1, reason: "operator" }),
  );
  await atomicBatch(env.DB, f.statements);
  const object = (await env.BLOBS.put(`u/${f.ids.user}/b/${f.ids.blob}`, "abc"))!;
  await atomicBatch(env.DB, [
    {
      sql: "UPDATE control SET bootstrap_done_at=1,bootstrap_iss='https://access.invalid',bootstrap_sub=?",
      values: [f.ids.user],
    },
    {
      sql: "INSERT INTO blob_storage(blob_id,bytes,r2_etag,observed_at) VALUES(?,3,?,1)",
      values: [f.ids.blob, object.etag],
    },
  ]);
});
beforeEach(async () => {
  await runInDurableObject(control(), async (_instance, state) => {
    await state.storage.deleteAll();
  });
  await evictDurableObject(control());
  epoch = (await control().recover()).epoch;
  await audit();
  await control().resumeAdmission(epoch);
  await control().resumeGarbageCollection(epoch);
});

it("pins a logical selection and closes admission without issuing an epoch or an overwrite permission", async () => {
  const id = crypto.randomUUID(),
    selected = source();
  const before = (await env.BACKUPS.list({ prefix: EPOCH_PREFIX })).objects.map((o) => o.key);
  const result = await control().prepareDatabaseRestore(epoch, id, selected);
  expect(result).toEqual({
    id,
    epoch,
    source: selected,
    state: "preparing",
    createdAt: expect.any(Number),
  });
  expect(await flags()).toEqual({ epoch, maintenance: 1, gc_paused: 1 });
  expect(await control().status()).toEqual({ epoch, maintenance: true, gcPaused: true });
  expect((await env.BACKUPS.list({ prefix: EPOCH_PREFIX })).objects.map((o) => o.key)).toEqual(
    before,
  );
});

it("replays the same selection across eviction and refuses to change its identity", async () => {
  const id = crypto.randomUUID(),
    selected = source();
  const initial = await control().prepareDatabaseRestore(epoch, id, selected);
  await evictDurableObject(control());
  expect(await control().inspectDatabaseRestore(epoch, id)).toEqual(initial);
  expect(await control().prepareDatabaseRestore(epoch, id, { ...selected })).toEqual(initial);
  await runInDurableObject(control(), async (instance) => {
    await expect(instance.prepareDatabaseRestore(epoch, id, source())).rejects.toThrow(
      /database_restore_conflict/,
    );
    await expect(instance.prepareDatabaseRestore(epoch + 1, id, selected)).rejects.toThrow(
      /database_restore_conflict/,
    );
    await expect(
      instance.prepareDatabaseRestore(epoch, crypto.randomUUID(), selected),
    ).rejects.toThrow(/database_restore_active/);
    await expect(instance.cancelDatabaseRestore(epoch, crypto.randomUUID())).rejects.toThrow(
      /database_restore_missing/,
    );
    await expect(instance.cancelDatabaseRestore(epoch + 1, id)).rejects.toThrow(
      /database_restore_conflict/,
    );
  });
  expect(await control().inspectDatabaseRestore(epoch, id)).toEqual(initial);
});

it("pins an opaque Time Travel bookmark without pretending to verify or execute it", async () => {
  const selected = {
    kind: "time_travel" as const,
    bookmark: "00000001-00000002-00000003-00000004",
  };
  expect(
    await control().prepareDatabaseRestore(epoch, crypto.randomUUID(), selected),
  ).toMatchObject({ source: selected, state: "preparing" });
});

it("accepts the UUID identity contract used by previously published logical generations", async () => {
  const selected = {
    kind: "logical" as const,
    id: "00000000-0000-0000-0000-000000000001",
    epoch: 1,
    manifestSha256: "b".repeat(64),
  };
  expect(
    await control().prepareDatabaseRestore(epoch, crypto.randomUUID(), selected),
  ).toMatchObject({ source: selected });
});

it.each([
  null,
  { kind: "unknown" },
  { kind: "time_travel", bookmark: "x\ny" },
  { kind: "time_travel", bookmark: "x".repeat(257) },
  { kind: "logical", id: "invalid", epoch: 1, manifestSha256: "a".repeat(64) },
  { kind: "logical", id: crypto.randomUUID(), epoch: 0, manifestSha256: "a".repeat(64) },
  { kind: "logical", id: crypto.randomUUID(), epoch: 1, manifestSha256: "a".repeat(63) },
])("rejects an invalid selection before changing either store (%j)", async (selected) => {
  await runInDurableObject(control(), async (instance, state) => {
    await expect(
      instance.prepareDatabaseRestore(
        epoch,
        crypto.randomUUID(),
        selected as DatabaseRestoreSource,
      ),
    ).rejects.toThrow(/invalid_/);
    expect(state.storage.sql.exec("SELECT 1 FROM control_database_restore").toArray()).toEqual([]);
  });
  expect(await flags()).toEqual({ epoch, maintenance: 0, gc_paused: 0 });
});

it("rejects invalid request IDs and stale epochs without leaving a hold", async () => {
  await runInDurableObject(control(), async (instance, state) => {
    await expect(instance.prepareDatabaseRestore(epoch, "invalid", source())).rejects.toThrow(
      /invalid_database_restore/,
    );
    await expect(
      instance.prepareDatabaseRestore(epoch - 1, crypto.randomUUID(), source()),
    ).rejects.toThrow(/database_restore_epoch_conflict/);
    expect(state.storage.sql.exec("SELECT 1 FROM control_database_restore").toArray()).toEqual([]);
  });
  expect((await control().status()).maintenance).toBe(false);
});

it("blocks reopening, epoch changes, backups and normal grants while allowing stopped repair admission", async () => {
  await control().prepareDatabaseRestore(epoch, crypto.randomUUID(), source());
  await audit();
  await runInDurableObject(control(), async (instance) => {
    const id = crypto.randomUUID();
    for (const call of [
      () => instance.resumeAdmission(epoch),
      () => instance.resumeGarbageCollection(epoch),
      () => instance.pauseGarbageCollection(epoch),
      () => instance.bumpEpoch(epoch, "restore"),
      () => instance.beginBackup(epoch, id),
      () => instance.planDailyBackup(epoch),
      () => instance.inspectBackupInventory(epoch),
      () => instance.pruneBackup(epoch, id),
      () => instance.sweepBackups(epoch),
      () => instance.releaseBackup(epoch, id),
      () => instance.cancelBackup(epoch, id),
      () => instance.completeBackup(epoch, id, "a".repeat(64)),
      () => instance.acquireRestorePause(epoch, "op_" + "a".repeat(64)),
      () => instance.releaseRestorePause(epoch, crypto.randomUUID()),
    ])
      await expect(call()).rejects.toThrow(/database_restore_active/);
    await expect(
      instance.acquireMutation({ ...system(), permitId: crypto.randomUUID() }),
    ).rejects.toThrow(/mutation_unavailable/);
    await expect(
      instance.acquireBootstrapMutation({ ...global(), permitId: crypto.randomUUID() }),
    ).rejects.toThrow(/mutation_unavailable/);
    await expect(
      instance.deriveKdf({
        id: crypto.randomUUID(),
        epoch,
        deadline: Date.now() + 5000,
        input: new ArrayBuffer(32),
        salt: new Uint8Array(16),
      }),
    ).rejects.toThrow(/kdf_unavailable/);
  });
  expect(await control().acquireSystemMutation(system())).toMatchObject({
    system: 1,
    maintenance: 1,
  });
  expect(await control().acquireGlobalMutation(global())).toMatchObject({
    system: 1,
    maintenance: 1,
  });
});

it("persists the hold before a primary outage, preventing normal and open-mode internal work", async () => {
  const id = crypto.randomUUID(),
    selected = source();
  await runInDurableObject(control(), async (_instance, state) => {
    const broken = new ControlDO(state, {
      ...env,
      DB: unavailableDb(),
    });
    await expect(broken.prepareDatabaseRestore(epoch, id, selected)).rejects.toThrow(
      /primary_unavailable/,
    );
  });
  await evictDurableObject(control());
  expect(await flags()).toEqual({ epoch, maintenance: 0, gc_paused: 0 });
  expect(await control().status()).toEqual({ epoch, maintenance: true, gcPaused: true });
  await runInDurableObject(control(), async (instance) => {
    await expect(instance.acquireSystemMutation(system())).rejects.toThrow(
      /database_restore_active/,
    );
    await expect(instance.acquireGlobalMutation(global())).rejects.toThrow(
      /database_restore_active/,
    );
    await expect(instance.resumeAdmission(epoch)).rejects.toThrow(/database_restore_active/);
  });
  expect(await control().prepareDatabaseRestore(epoch, id, selected)).toMatchObject({
    state: "preparing",
  });
  expect(await flags()).toEqual({ epoch, maintenance: 1, gc_paused: 1 });
});

it("retains preparation after a stop rollback and reconciles it after eviction", async () => {
  const id = crypto.randomUUID(),
    selected = source();
  await env.DB.prepare(
    "CREATE TRIGGER reject_restore_stop BEFORE UPDATE ON control WHEN NEW.maintenance=1 BEGIN SELECT RAISE(ABORT,'injected_stop'); END",
  ).run();
  try {
    await runInDurableObject(control(), async (instance) => {
      await expect(instance.prepareDatabaseRestore(epoch, id, selected)).rejects.toThrow(
        /injected_stop/,
      );
    });
  } finally {
    await env.DB.prepare("DROP TRIGGER reject_restore_stop").run();
  }
  expect(await flags()).toEqual({ epoch, maintenance: 0, gc_paused: 0 });
  await evictDurableObject(control());
  expect((await control().status()).maintenance).toBe(true);
  expect(await control().prepareDatabaseRestore(epoch, id, selected)).toMatchObject({
    state: "preparing",
  });
  expect(await flags()).toEqual({ epoch, maintenance: 1, gc_paused: 1 });
});

it("reconciles a committed stop whose acknowledgement was lost", async () => {
  const id = crypto.randomUUID();
  await runInDurableObject(control(), async (_instance, state) => {
    const db = injectBatch(
      (sql) => sql.includes("UPDATE control SET maintenance=1"),
      async () => {
        throw new Error("ack_lost");
      },
      true,
    );
    const instance = new ControlDO(state, { ...env, DB: db });
    expect(await instance.prepareDatabaseRestore(epoch, id, source())).toMatchObject({
      state: "preparing",
    });
  });
  expect(await flags()).toEqual({ epoch, maintenance: 1, gc_paused: 1 });
});

it("cancels only the specified preparation, invalidates the audit and never reopens automatically", async () => {
  const id = crypto.randomUUID(),
    selected = source();
  await control().prepareDatabaseRestore(epoch, id, selected);
  await audit();
  expect(await control().cancelDatabaseRestore(epoch, id)).toMatchObject({
    id,
    state: "cancelled",
  });
  expect(await flags()).toEqual({ epoch, maintenance: 1, gc_paused: 1 });
  await runInDurableObject(control(), async (instance) => {
    await expect(instance.resumeAdmission(epoch)).rejects.toThrow(/recovery_audit_incomplete/);
  });
  await audit();
  await control().resumeAdmission(epoch);
  await control().resumeGarbageCollection(epoch);
  await evictDurableObject(control());
  expect(await control().prepareDatabaseRestore(epoch, id, selected)).toMatchObject({
    state: "cancelled",
  });
  expect(await control().cancelDatabaseRestore(epoch, id)).toMatchObject({ state: "cancelled" });
  expect(await flags()).toEqual({ epoch, maintenance: 0, gc_paused: 0 });
  const next = crypto.randomUUID();
  await control().prepareDatabaseRestore(epoch, next, source());
  await control().cancelDatabaseRestore(epoch, id);
  expect(await control().inspectDatabaseRestore(epoch, next)).toMatchObject({ state: "preparing" });
  expect((await control().status()).maintenance).toBe(true);
});

it("does not create a competing hold while a backup barrier exists", async () => {
  const backupId = crypto.randomUUID(),
    restoreId = crypto.randomUUID();
  await control().beginBackup(epoch, backupId);
  try {
    await runInDurableObject(control(), async (instance, state) => {
      await expect(instance.prepareDatabaseRestore(epoch, restoreId, source())).rejects.toThrow(
        /backup_active/,
      );
      expect(state.storage.sql.exec("SELECT 1 FROM control_database_restore").toArray()).toEqual(
        [],
      );
    });
  } finally {
    await control().cancelBackup(epoch, backupId);
  }
  expect((await control().status()).maintenance).toBe(false);
});

it("keeps the hold after a D1 rollback and refuses cancellation against a different epoch", async () => {
  const id = crypto.randomUUID();
  await control().prepareDatabaseRestore(epoch, id, source());
  // Only the control-row rollback is simulated; this is not a Time Travel drill.
  await env.DB.prepare(
    "UPDATE control SET epoch=1,maintenance=0,gc_paused=0,admission_revision=0,admission_token=NULL",
  ).run();
  await evictDurableObject(control());
  expect(await control().status()).toEqual({ epoch, maintenance: true, gcPaused: true });
  await runInDurableObject(control(), async (instance) => {
    await expect(instance.cancelDatabaseRestore(epoch, id)).rejects.toThrow();
    await expect(instance.bumpEpoch(epoch, "restore")).rejects.toThrow(/database_restore_active/);
    await expect(instance.resumeAdmission(epoch)).rejects.toThrow(/database_restore_active/);
  });
  expect(await control().inspectDatabaseRestore(epoch, id)).toMatchObject({ state: "preparing" });
  expect(await flags()).toEqual({ epoch: 1, maintenance: 0, gc_paused: 0 });
});

it("refuses to overwrite an older admission token even when the restored D1 epoch is unchanged", async () => {
  const id = crypto.randomUUID(),
    selected = source();
  const original = (await env.DB.prepare(
    "SELECT admission_revision,admission_token FROM control",
  ).first<{ admission_revision: number; admission_token: string }>())!;
  await control().prepareDatabaseRestore(epoch, id, selected);
  await env.DB.prepare(`UPDATE control SET maintenance=0,gc_paused=0,gc_operator_paused=0,
    admission_revision=?,admission_token=?`)
    .bind(original.admission_revision, original.admission_token)
    .run();
  await evictDurableObject(control());
  await runInDurableObject(control(), async (instance) => {
    for (const call of [
      () => instance.prepareDatabaseRestore(epoch, id, selected),
      () => instance.cancelDatabaseRestore(epoch, id),
      () => instance.quiesce(epoch),
    ])
      await expect(call()).rejects.toThrow(/database_restore_mirror_conflict/);
  });
  expect(
    await env.DB.prepare("SELECT admission_revision,admission_token FROM control").first(),
  ).toEqual(original);
  expect(await flags()).toEqual({ epoch, maintenance: 0, gc_paused: 0 });
  expect((await control().status()).maintenance).toBe(true);
  expect(await control().inspectDatabaseRestore(epoch, id)).toMatchObject({ state: "preparing" });
});

it("fences an admission reopen whose D1 batch was already waiting", async () => {
  await control().quiesce(epoch);
  await audit();
  await runInDurableObject(control(), async (instance, state) => {
    const db = injectBatch(
      (sql) => sql.includes("UPDATE control SET maintenance=0"),
      async () => {
        await instance.prepareDatabaseRestore(epoch, crypto.randomUUID(), source());
      },
      false,
    );
    const delayed = new ControlDO(state, { ...env, DB: db });
    await expect(delayed.resumeAdmission(epoch)).rejects.toThrow();
  });
  expect(await flags()).toEqual({ epoch, maintenance: 1, gc_paused: 1 });
  expect((await control().status()).maintenance).toBe(true);
});

it("retries a failed stop of an opening transition without losing the durable hold", async () => {
  const id = crypto.randomUUID(),
    selected = source();
  await control().quiesce(epoch);
  await audit();
  await runInDurableObject(control(), async (_instance, state) => {
    const db = injectBatch(
      (sql) => sql.includes("UPDATE control SET maintenance=0"),
      async () => {
        const failedStop = new ControlDO(state, {
          ...env,
          DB: injectBatch(
            (sql) => sql.includes("UPDATE control SET maintenance=1"),
            async () => {
              throw new Error("stop_rolled_back");
            },
            false,
          ),
        });
        await expect(failedStop.prepareDatabaseRestore(epoch, id, selected)).rejects.toThrow(
          /stop_rolled_back/,
        );
        throw new Error("resume_abandoned");
      },
      false,
    );
    await expect(new ControlDO(state, { ...env, DB: db }).resumeAdmission(epoch)).rejects.toThrow(
      /resume_abandoned/,
    );
  });
  await evictDurableObject(control());
  expect((await control().status()).maintenance).toBe(true);
  expect(await control().prepareDatabaseRestore(epoch, id, selected)).toMatchObject({
    state: "preparing",
  });
  expect(await flags()).toEqual({ epoch, maintenance: 1, gc_paused: 1 });
});

it("keeps the singleton boundary on restore reads and writes", async () => {
  const other = env.CONTROL.get(env.CONTROL.idFromName("not-the-control-singleton"));
  await runInDurableObject(other, async (instance) => {
    await expect(
      instance.prepareDatabaseRestore(epoch, crypto.randomUUID(), source()),
    ).rejects.toThrow(/control_singleton_required/);
    await expect(instance.inspectDatabaseRestore(epoch, crypto.randomUUID())).rejects.toThrow(
      /control_singleton_required/,
    );
    await expect(instance.cancelDatabaseRestore(epoch, crypto.randomUUID())).rejects.toThrow(
      /control_singleton_required/,
    );
  });
});

it.each(["backup", "epoch"] as const)(
  "fences a delayed %s request before it writes a durable intent",
  async (kind) => {
    const id = crypto.randomUUID();
    await runInDurableObject(control(), async (instance, state) => {
      const db = afterFirst(
        (sql) =>
          sql.includes(kind === "backup" ? "SELECT epoch,watermark" : "backup_token IS NULL"),
        async () => {
          await instance.prepareDatabaseRestore(epoch, crypto.randomUUID(), source());
        },
      );
      const delayed = new ControlDO(state, { ...env, DB: db });
      await expect(
        kind === "backup" ? delayed.beginBackup(epoch, id) : delayed.bumpEpoch(epoch, "operator"),
      ).rejects.toThrow(/database_restore_active/);
      expect(state.storage.sql.exec("SELECT phase FROM control_state").one()).toEqual({
        phase: "ready",
      });
      expect(
        state.storage.sql.exec("SELECT 1 FROM control_backup WHERE phase<>'released'").toArray(),
      ).toEqual([]);
    });
    expect(await flags()).toEqual({ epoch, maintenance: 1, gc_paused: 1 });
    expect(
      await env.DB.prepare("SELECT 1 FROM backup_runs WHERE id=?").bind(id).first(),
    ).toBeNull();
  },
);

it("does not return an old open status after a hold begins during a primary read", async () => {
  await runInDurableObject(control(), async (_instance, state) => {
    const db = afterFirst(
      (sql) => sql.includes("admission_revision=?"),
      async () => {
        const broken = new ControlDO(state, { ...env, DB: unavailableDb() });
        await expect(
          broken.prepareDatabaseRestore(epoch, crypto.randomUUID(), source()),
        ).rejects.toThrow(/primary_unavailable/);
      },
    );
    const delayed = new ControlDO(state, { ...env, DB: db });
    await expect(delayed.status()).rejects.toThrow(/database_restore_active/);
  });
  expect((await control().status()).maintenance).toBe(true);
  expect(await flags()).toEqual({ epoch, maintenance: 0, gc_paused: 0 });
});

it("does not let a late duplicate cancellation stop a freshly audited reopening", async () => {
  const id = crypto.randomUUID();
  await control().prepareDatabaseRestore(epoch, id, source());
  await runInDurableObject(control(), async (instance, state) => {
    const db = afterFirst(
      (sql) => sql.includes("backup_token IS NULL"),
      async () => {
        await instance.cancelDatabaseRestore(epoch, id);
        await audit(instance);
        await instance.resumeAdmission(epoch);
        await instance.resumeGarbageCollection(epoch);
      },
    );
    const delayed = new ControlDO(state, { ...env, DB: db });
    expect(await delayed.cancelDatabaseRestore(epoch, id)).toMatchObject({ state: "cancelled" });
  });
  expect(await flags()).toEqual({ epoch, maintenance: 0, gc_paused: 0 });
  expect((await control().status()).maintenance).toBe(false);
});

it("preserves unknown KDF executions across preparation and cancellation", async () => {
  const id = crypto.randomUUID(),
    token = crypto.randomUUID(),
    request = crypto.randomUUID();
  await env.DB.prepare("UPDATE control SET kdf_not_before=0").run();
  await env.DB.prepare(`INSERT INTO kdf_attempts(id,dispatch_token,epoch,issued_at,expires_at)
    VALUES(?,?,?,strftime('%s','now')*1000,strftime('%s','now')*1000+5000)`)
    .bind(request, token, epoch)
    .run();
  await runInDurableObject(control(), async (_instance, state) => {
    state.storage.sql.exec(
      "INSERT INTO control_kdf_receipts VALUES(?,?,?,?,'reserved')",
      token,
      request,
      epoch,
      Date.now() + 5000,
    );
  });
  try {
    await control().prepareDatabaseRestore(epoch, id, source());
    await evictDurableObject(control());
    await control().cancelDatabaseRestore(epoch, id);
    expect(
      await env.DB.prepare("SELECT state FROM kdf_attempts WHERE id=?")
        .bind(request)
        .first("state"),
    ).toBe("claimed");
    await runInDurableObject(control(), async (instance, state) => {
      expect(
        state.storage.sql.exec("SELECT state FROM control_kdf_receipts WHERE token=?", token).one(),
      ).toEqual({ state: "reserved" });
      await expect(instance.resumeAdmission(epoch)).rejects.toThrow(/recovery_kdf_unsettled/);
    });
  } finally {
    // Test fixture only: production never declares an unknown execution not_started.
    await env.DB.prepare(
      "UPDATE kdf_attempts SET state='not_started',finished_at=issued_at WHERE id=?",
    )
      .bind(request)
      .run();
  }
});
