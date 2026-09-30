import { applyD1Migrations, evictDurableObject, runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterEach, beforeAll, beforeEach, expect, it } from "vitest";
import {
  type BackupGeneration,
  backupManifestKey,
  backupPartKey,
} from "../../../shared/src/backupPublication";
import { authorizeNode } from "../../src/auth/authorize";
import { sha256 } from "../../src/backup/publication";
import {
  assertSystemMutationAdmission,
  enqueueGlobalMutation,
} from "../../src/db/mutationAdmission";
import { atomicBatch } from "../../src/db/primary";
import { exportTables } from "../../src/db/schemaContract";
import { CONTROL_NAME, ControlDO } from "../../src/do/ControlDO";
import { EPOCH_PREFIX } from "../../src/do/epochHistory";
import type { Env } from "../../src/env";
import { claimOperation, operationIntent } from "../../src/jobs/operations";
import { createFolder } from "../../src/services/createFolder";
import { publicationFixture } from "../fixtures/backupPublication";
import { foundationFixture } from "../fixtures/foundation";
import { injectBatch } from "../fixtures/uploadEnv";

const control = () => env.CONTROL.get(env.CONTROL.idFromName(CONTROL_NAME));
const f = foundationFixture(crypto.randomUUID(), Date.now() - 1000);
const epoch = 2;
beforeAll(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
  await env.BACKUPS.put(
    EPOCH_PREFIX + "1.json",
    JSON.stringify({ epoch: 1, at: 1, reason: "operator" }),
  );
  expect((await control().recover()).epoch).toBe(epoch);
  await atomicBatch(
    env.DB,
    f.statements.map((s) =>
      s.sql.startsWith("INSERT INTO sessions")
        ? { ...s, sql: s.sql.replace("?,1,?,?,?)", "?,2,?,?,?)") }
        : s,
    ),
  );
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
  await control().quiesce(epoch);
  await control().failStaleOutbox(epoch);
  await control().beginRecoveryAudit(epoch);
  let complete = false;
  for (let i = 0; i < 20; i++)
    if ((await control().nextRecoveryAuditPage(epoch, 20)).completed) {
      complete = true;
      break;
    }
  expect(complete).toBe(true);
  await control().resumeAdmission(epoch);
  await control().resumeGarbageCollection(epoch);
});
afterEach(async () => {
  await runInDurableObject(control(), async (instance, state) => {
    const row = state.storage.sql
      .exec<{ id: string }>("SELECT id FROM control_backup WHERE phase<>'released'")
      .toArray()[0];
    if (row) await instance.cancelBackup(epoch, row.id);
  });
  await env.DB.prepare(
    "UPDATE reservations SET state='released' WHERE id IN ('pending-backup','pending-completion') AND state='reserved'",
  ).run();
});
const normal = () => ({
  permitId: crypto.randomUUID(),
  spaceId: f.ids.space,
  epoch,
  deadline: Date.now() + 5000,
});
const system = () => ({ ...normal(), permitId: "system:upload.observe:" + crypto.randomUUID() });
const global = () => ({
  permitId: "global:r2.probe-phase:" + crypto.randomUUID(),
  epoch,
  deadline: Date.now() + 5000,
});
it("completes an R2 publication and restores the prior open policy without consuming pending upload capacity", async () => {
  const id = crypto.randomUUID(),
    payload = new TextEncoder().encode("SQL fixture");
  await env.DB.prepare(
    "INSERT INTO reservations(id,owner_id,bytes,state,expires_at,epoch) VALUES('pending-completion',?,5,'reserved',?,?)",
  )
    .bind(f.ids.user, Date.now() + 86400000, epoch)
    .run();
  await control().beginBackup(epoch, id);
  const generation = (await env.DB.prepare(
    "SELECT id,epoch,barrier_token AS token,created_at AS createdAt,watermark FROM backup_runs WHERE id=?",
  )
    .bind(id)
    .first<BackupGeneration>())!;
  const publication = await publicationFixture(generation, [payload]),
    bytes = new TextEncoder().encode(JSON.stringify(publication)),
    hash = await sha256(bytes);
  await env.BACKUPS.put(backupPartKey(id, 0, publication.parts[0]!.sha256), payload);
  await env.BACKUPS.put(backupManifestKey(id), bytes);
  expect((await control().completeBackup(epoch, id, hash)).state).toBe("completed");
  expect(await control().status()).toEqual({ epoch, maintenance: false, gcPaused: false });
  expect(
    await env.DB.prepare("SELECT reserved_bytes FROM users WHERE id=?")
      .bind(f.ids.user)
      .first("reserved_bytes"),
  ).toBe(5);
});
async function snapshot() {
  const result = await env.DB.batch(
    exportTables.map((t) => env.DB.prepare(`SELECT * FROM "${t}" ORDER BY 1`)),
  );
  return result.map((r) => r.results);
}
it("freezes every normal table after draining real grants, preserves pending capacity, and restores the original policy", async () => {
  const grant = await control().acquireSystemMutation(system()),
    id = crypto.randomUUID();
  await env.DB.prepare(
    "INSERT INTO reservations(id,owner_id,bytes,state,expires_at,epoch) VALUES('pending-backup',?,5,'reserved',?,?)",
  )
    .bind(f.ids.user, Date.now() + 86400000, epoch)
    .run();
  const frozen = await control().beginBackup(epoch, id);
  expect(frozen).toEqual({ id, epoch, state: "frozen", watermark: null });
  expect(await control().status()).toEqual({ epoch, maintenance: true, gcPaused: true });
  const before = await snapshot();
  for (const sql of [
    "UPDATE users SET reserved_bytes=0",
    "DELETE FROM reservations",
    "UPDATE settings SET signup_enabled=1",
    "UPDATE control SET epoch=epoch+1",
    "DELETE FROM control",
    "INSERT OR REPLACE INTO control(singleton,epoch,updated_at) VALUES(1,2,0)",
    "UPDATE control SET backup_frozen=0,maintenance=0",
  ])
    await expect(env.DB.prepare(sql).run()).rejects.toThrow();
  await expect(atomicBatch(env.DB, [assertSystemMutationAdmission(grant)])).rejects.toThrow();
  await runInDurableObject(control(), async (instance) => {
    await expect(instance.acquireMutation(normal())).rejects.toThrow();
    await expect(instance.acquireSystemMutation(system())).rejects.toThrow();
    await expect(instance.acquireGlobalMutation(global())).rejects.toThrow();
    await expect(
      instance.deriveKdf({
        id: crypto.randomUUID(),
        epoch,
        deadline: Date.now() + 5000,
        input: new ArrayBuffer(32),
        salt: new Uint8Array(16),
      }),
    ).rejects.toThrow();
    await expect(instance.resumeAdmission(epoch)).rejects.toThrow("backup_active");
    await expect(instance.quiesce(epoch)).rejects.toThrow("backup_active");
    await expect(instance.repairExpiredUploads(epoch)).rejects.toThrow("backup_active");
    await expect(instance.bumpEpoch(epoch, "operator")).rejects.toThrow("backup_active");
    await expect(instance.releaseBackup(epoch, crypto.randomUUID())).rejects.toThrow(
      "backup_conflict",
    );
  });
  expect(await snapshot()).toEqual(before);
  expect((await env.BACKUPS.list({ prefix: EPOCH_PREFIX })).objects).toHaveLength(2);
  await evictDurableObject(control());
  expect(await control().beginBackup(epoch, id)).toEqual(frozen);
  expect((await control().releaseBackup(epoch, id)).state).toBe("released");
  expect(await control().status()).toEqual({ epoch, maintenance: false, gcPaused: false });
  expect(
    await env.DB.prepare("SELECT reserved_bytes FROM users WHERE id=?")
      .bind(f.ids.user)
      .first("reserved_bytes"),
  ).toBe(5);
  expect(
    await env.DB.prepare("SELECT state,manifest_key,released_at FROM backup_runs WHERE id=?")
      .bind(id)
      .first(),
  ).toEqual({ state: "exporting", manifest_key: null, released_at: expect.any(Number) });
  expect((await control().beginBackup(epoch, id)).state).toBe("released");
  expect(await control().acquireSystemMutation(system())).toMatchObject({
    system: 1,
    maintenance: 0,
  });
});

it.each(["closed", "operator-pause"] as const)(
  "restores the prior %s policy without opening a recovery gate",
  async (mode) => {
    if (mode === "closed") await control().quiesce(epoch);
    else await control().pauseGarbageCollection(epoch);
    const before = await control().status(),
      id = crypto.randomUUID();
    await control().beginBackup(epoch, id);
    await evictDurableObject(control());
    await control().releaseBackup(epoch, id);
    expect(await control().status()).toEqual(before);
  },
);

it("captures the latest committed watermark without changing terminal operations", async () => {
  const result = await createFolder(env, {
    principal: { kind: "user", user_id: f.ids.user, credential_id: f.ids.credential, epoch },
    idempotencyKey: crypto.randomUUID(),
    spaceId: f.ids.space,
    parentId: f.ids.folder,
    name: "Before backup",
    lockTokens: [],
  });
  expect(result).toMatchObject({ kind: "terminal", operation: { state: "committed" } });
  const operations = (await env.DB.prepare("SELECT * FROM operations ORDER BY op_id").all())
      .results,
    id = crypto.randomUUID();
  const frozen = await control().beginBackup(epoch, id);
  expect(frozen.watermark).toBe((result as { operation: { id: string } }).operation.id);
  expect((await env.DB.prepare("SELECT * FROM operations ORDER BY op_id").all()).results).toEqual(
    operations,
  );
  await control().releaseBackup(epoch, id);
});

it("revokes an open namespace permit and settles its claimed operation before the snapshot", async () => {
  const principal = {
    kind: "user" as const,
    user_id: f.ids.user,
    credential_id: f.ids.credential,
    epoch,
  };
  const authorized = await authorizeNode(env.DB, principal, {
    operation: "node.create",
    parentId: f.ids.folder,
    spaceId: f.ids.space,
  });
  const intent = await operationIntent(
    principal,
    crypto.randomUUID(),
    f.ids.space,
    "node.create",
    { parentId: f.ids.folder, name: "Pending" },
    { parentId: f.ids.folder },
  );
  const permit = await env.LOCKS.get(env.LOCKS.idFromName(f.ids.space)).acquireCreate({
    requestId: intent.id,
    spaceId: f.ids.space,
    parentId: f.ids.folder,
    principal,
    lockTokens: [],
  });
  expect((await claimOperation(env.DB, intent, permit, authorized, 7)).kind).toBe("claimed");
  const id = crypto.randomUUID();
  await control().beginBackup(epoch, id);
  expect(
    await env.DB.prepare("SELECT state FROM operations WHERE op_id=?")
      .bind(intent.id)
      .first("state"),
  ).toBe("failed");
  expect(
    await env.DB.prepare("SELECT state FROM permits WHERE permit_id=?")
      .bind(permit.permit_id)
      .first("state"),
  ).toBe("revoked");
  expect(
    await env.DB.prepare("SELECT COUNT(*) n FROM mutation_admissions WHERE state<>'closed'").first(
      "n",
    ),
  ).toBe(0);
  await control().releaseBackup(epoch, id);
});

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
it.each(["prepare", "freeze"] as const)(
  "fences a delayed %s batch after cancellation restores admission",
  async (stage) => {
    const id = crypto.randomUUID(),
      entered = deferred(),
      resume = deferred();
    await runInDurableObject(control(), async (instance, state) => {
      const delayed = new ControlDO(state, {
        ...env,
        DB: injectBatch(
          (sql) =>
            sql.includes(
              stage === "prepare" ? "INSERT INTO backup_runs(id" : "SET backup_frozen=1",
            ),
          async () => {
            entered.resolve();
            await resume.promise;
          },
          false,
        ),
      });
      const pending = delayed.beginBackup(epoch, id).then(
        (value) => ({ value }),
        (error) => ({ error }),
      );
      await entered.promise;
      try {
        expect((await instance.cancelBackup(epoch, id)).state).toBe("released");
      } finally {
        resume.resolve();
      }
      expect(await pending).toHaveProperty("error");
      expect(await instance.status()).toEqual({ epoch, maintenance: false, gcPaused: false });
    });
    expect(
      await env.DB.prepare("SELECT state FROM backup_runs WHERE id=?").bind(id).first("state"),
    ).toBe("failed");
  },
);

it("rolls the thaw and admission policy back if the release batch fails after clearing the freeze flag", async () => {
  const id = crypto.randomUUID();
  await control().beginBackup(epoch, id);
  const before = await snapshot();
  await env.DB.prepare(`CREATE TRIGGER test_release_failure BEFORE UPDATE OF released_at ON backup_runs
    WHEN NEW.released_at IS NOT NULL BEGIN SELECT RAISE(ABORT,'release_rollback'); END`).run();
  try {
    await runInDurableObject(control(), async (instance) => {
      await expect(instance.releaseBackup(epoch, id)).rejects.toThrow("release_rollback");
      expect(await instance.status()).toEqual({ epoch, maintenance: true, gcPaused: true });
    });
    expect(await snapshot()).toEqual(before);
  } finally {
    await env.DB.prepare("DROP TRIGGER test_release_failure").run();
  }
  await evictDurableObject(control());
  expect((await control().releaseBackup(epoch, id)).state).toBe("released");
});

it("a delayed duplicate release cannot thaw the next generation", async () => {
  const first = crypto.randomUUID(),
    second = crypto.randomUUID(),
    entered = deferred(),
    resume = deferred();
  await control().beginBackup(epoch, first);
  await runInDurableObject(control(), async (instance, state) => {
    const delayed = new ControlDO(state, {
      ...env,
      DB: injectBatch(
        (sql) => sql.includes("SET backup_token=NULL"),
        async () => {
          entered.resolve();
          await resume.promise;
        },
        false,
      ),
    });
    const pending = delayed.releaseBackup(epoch, first).then(
      (value) => ({ value }),
      (error) => ({ error }),
    );
    await entered.promise;
    try {
      await instance.releaseBackup(epoch, first);
      await instance.beginBackup(epoch, second);
    } finally {
      resume.resolve();
    }
    expect(await pending).toHaveProperty("error");
    expect(await instance.status()).toEqual({ epoch, maintenance: true, gcPaused: true });
    await instance.releaseBackup(epoch, second);
  });
});

it.each(["prepare", "freeze", "release"] as const)(
  "retains the %s intent when both ACK and primary readback are lost",
  async (stage) => {
    const id = crypto.randomUUID();
    let lost = false;
    await runInDurableObject(control(), async (_instance, state) => {
      const underlying = injectBatch(
        (sql) =>
          sql.includes(
            stage === "prepare"
              ? "INSERT INTO backup_runs(id"
              : stage === "freeze"
                ? "SET backup_frozen=1"
                : "SET backup_token=NULL",
          ),
        async () => {
          lost = true;
          throw new Error("ack_lost");
        },
        true,
      );
      const db = {
        prepare(sql: string) {
          const statement = underlying.prepare(sql);
          if (!sql.startsWith("SELECT")) return statement;
          const wrap = (s: D1PreparedStatement): D1PreparedStatement =>
            new Proxy(s, {
              get(t, k) {
                if (k === "bind") return (...values: unknown[]) => wrap(t.bind(...values));
                if (k === "first")
                  return (...args: unknown[]) => {
                    if (lost) throw new Error("primary_unreadable");
                    return Reflect.apply(t.first, t, args);
                  };
                const v = Reflect.get(t, k, t);
                return typeof v === "function" ? v.bind(t) : v;
              },
            });
          return wrap(statement);
        },
        batch: underlying.batch.bind(underlying),
      } as D1Database;
      const instance = new ControlDO(state, { ...env, DB: db });
      if (stage === "release") {
        await instance.beginBackup(epoch, id);
        await expect(instance.releaseBackup(epoch, id)).rejects.toThrow("primary_unreadable");
      } else await expect(instance.beginBackup(epoch, id)).rejects.toThrow("primary_unreadable");
      expect(await instance.status()).toEqual({ epoch, maintenance: true, gcPaused: true });
    });
    expect(lost).toBe(true);
    await evictDurableObject(control());
    if (stage !== "release") expect((await control().beginBackup(epoch, id)).state).toBe("frozen");
    expect((await control().releaseBackup(epoch, id)).state).toBe("released");
    expect(await control().status()).toEqual({ epoch, maintenance: false, gcPaused: false });
  },
);

it("refuses a second backup and a stale release after a new generation freezes", async () => {
  const first = crypto.randomUUID(),
    second = crypto.randomUUID();
  await control().beginBackup(epoch, first);
  await runInDurableObject(control(), async (instance) => {
    await expect(instance.beginBackup(epoch, second)).rejects.toThrow("backup_active");
  });
  await control().releaseBackup(epoch, first);
  await control().beginBackup(epoch, second);
  await runInDurableObject(control(), async (instance) => {
    await expect(instance.releaseBackup(epoch, first)).rejects.toThrow("backup_conflict");
  });
  expect(await env.DB.prepare("SELECT backup_frozen FROM control").first("backup_frozen")).toBe(1);
  await control().cancelBackup(epoch, second);
  expect(
    await env.DB.prepare("SELECT state FROM backup_runs WHERE id=?").bind(second).first("state"),
  ).toBe("failed");
  expect((await control().beginBackup(epoch, first)).state).toBe("released");
  expect(await control().status()).toEqual({ epoch, maintenance: false, gcPaused: false });
});

it.each(["prepare", "freeze", "release"] as const)(
  "reconciles a lost %s batch reply from its exact receipt",
  async (stage) => {
    const id = crypto.randomUUID();
    let fired = false;
    await runInDurableObject(control(), async (_instance, state) => {
      const db = injectBatch(
        (sql) =>
          sql.includes(
            stage === "prepare"
              ? "INSERT INTO backup_runs(id"
              : stage === "freeze"
                ? "SET backup_frozen=1"
                : "SET backup_token=NULL",
          ),
        async () => {
          fired = true;
          throw new Error("ack_lost");
        },
        true,
      );
      const instance = new ControlDO(state, { ...env, DB: db });
      expect((await instance.beginBackup(epoch, id)).state).toBe("frozen");
      expect((await instance.releaseBackup(epoch, id)).state).toBe("released");
    });
    expect(fired).toBe(true);
    expect(await control().status()).toEqual({ epoch, maintenance: false, gcPaused: false });
  },
);

it("keeps a durable preparing intent after rollback, blocks grants and can cancel without a snapshot", async () => {
  const id = crypto.randomUUID();
  await runInDurableObject(control(), async (_instance, state) => {
    const instance = new ControlDO(state, {
      ...env,
      DB: injectBatch(
        (sql) => sql.includes("INSERT INTO backup_runs(id"),
        async () => {
          throw new Error("rollback");
        },
        false,
      ),
    });
    await expect(instance.beginBackup(epoch, id)).rejects.toThrow("rollback");
    expect(await instance.status()).toEqual({ epoch, maintenance: true, gcPaused: true });
  });
  await evictDurableObject(control());
  await runInDurableObject(control(), async (instance) => {
    await expect(instance.acquireGlobalMutation(global())).rejects.toThrow();
    await expect(instance.releaseBackup(epoch, id)).rejects.toThrow("backup_not_frozen");
    expect((await instance.cancelBackup(epoch, id)).state).toBe("released");
  });
  expect(await control().status()).toEqual({ epoch, maintenance: false, gcPaused: false });
  expect(
    await env.DB.prepare("SELECT state FROM backup_runs WHERE id=?").bind(id).first("state"),
  ).toBe("failed");
});

it("keeps the database fenced after total coordinator storage loss and refuses epoch publication", async () => {
  const id = crypto.randomUUID();
  await control().beginBackup(epoch, id);
  const before = await snapshot(),
    objects = await env.BACKUPS.list({ prefix: EPOCH_PREFIX });
  await runInDurableObject(control(), async (_instance, state) => {
    const tables = ["control_state", "control_admission", "control_gc_policy", "control_backup"];
    const saved = tables.map((table) => ({
      table,
      rows: state.storage.sql.exec(`SELECT * FROM ${table}`).toArray(),
    }));
    await state.storage.deleteAll();
    const instance = new ControlDO(state, env);
    await expect(instance.recover()).rejects.toThrow("backup_active");
    // Restore only the test fixture's captured coordinator, after verifying total-loss fail-closed behavior.
    state.storage.transactionSync(() => {
      for (const { table, rows } of saved) {
        state.storage.sql.exec(`DELETE FROM ${table}`);
        for (const row of rows)
          state.storage.sql.exec(
            `INSERT INTO ${table}(${Object.keys(row).join(",")}) VALUES(${Object.keys(row)
              .map(() => "?")
              .join(",")})`,
            ...Object.values(row),
          );
      }
    });
  });
  expect(await snapshot()).toEqual(before);
  expect((await env.BACKUPS.list({ prefix: EPOCH_PREFIX })).objects).toEqual(objects.objects);
});

it("blocks direct system/global admission during preparation even when maintenance matches", async () => {
  const id = crypto.randomUUID();
  await runInDurableObject(control(), async (_instance, state) => {
    const instance = new ControlDO(state, {
      ...env,
      DB: injectBatch(
        (sql) => sql.includes("SET backup_frozen=1"),
        async () => {
          throw new Error("not_yet");
        },
        false,
      ),
    });
    await expect(instance.beginBackup(epoch, id)).rejects.toThrow("not_yet");
  });
  await expect(
    enqueueGlobalMutation(env.DB, { ...global(), spaceId: null, system: 1, maintenance: 1 }),
  ).rejects.toThrow();
  expect(await env.DB.prepare("SELECT backup_frozen FROM control").first("backup_frozen")).toBe(0);
  await control().beginBackup(epoch, id);
  await control().releaseBackup(epoch, id);
});

it("prevents new backup admission while a maintenance task or restore pause is active", async () => {
  await runInDurableObject(control(), async (instance, state) => {
    state.storage.sql.exec("INSERT INTO control_maintenance_tasks VALUES('active',?)", epoch);
    await expect(instance.beginBackup(epoch, crypto.randomUUID())).rejects.toThrow(
      "backup_maintenance_active",
    );
    state.storage.sql.exec("DELETE FROM control_maintenance_tasks");
    const pause = await instance.acquireRestorePause(epoch, "op_" + "a".repeat(64));
    await expect(instance.beginBackup(epoch, crypto.randomUUID())).rejects.toThrow(
      "backup_admission_busy",
    );
    await instance.releaseRestorePause(epoch, pause.token);
  });
});

it("waits for a live job lease before allowing the export snapshot", async () => {
  const id = crypto.randomUUID(),
    job = crypto.randomUUID();
  const result = await createFolder(env, {
    principal: { kind: "user", user_id: f.ids.user, credential_id: f.ids.credential, epoch },
    idempotencyKey: crypto.randomUUID(),
    spaceId: f.ids.space,
    parentId: f.ids.folder,
    name: "Job source",
    lockTokens: [],
  });
  expect(result).toMatchObject({ kind: "terminal", operation: { state: "committed" } });
  await env.DB.prepare(
    "INSERT INTO bulk_jobs(id,owner_id,credential_id,op_id,kind,state,epoch,grant_snapshot,created_at,updated_at) VALUES(?,?,?,?,'node.copy','pending',?,'{}',1,1)",
  )
    .bind(
      job,
      f.ids.user,
      f.ids.credential,
      (result as { operation: { id: string } }).operation.id,
      epoch,
    )
    .run();
  await env.DB.prepare("INSERT INTO job_leases VALUES(?,?,?, ?,1)")
    .bind(job, crypto.randomUUID(), epoch, Date.now() + 60000)
    .run();
  await runInDurableObject(control(), async (instance) => {
    await expect(instance.beginBackup(epoch, id)).rejects.toThrow();
  });
  expect(await env.DB.prepare("SELECT backup_frozen FROM control").first("backup_frozen")).toBe(0);
  await env.DB.prepare("UPDATE job_leases SET expires_at=0 WHERE job_id=?").bind(job).run();
  expect((await control().beginBackup(epoch, id)).state).toBe("frozen");
  await control().releaseBackup(epoch, id);
});
