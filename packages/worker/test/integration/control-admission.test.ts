import { applyD1Migrations, evictDurableObject, runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeAll, beforeEach, expect, it } from "vitest";
import { atomicBatch } from "../../src/db/primary";
import { CONTROL_NAME, ControlDO } from "../../src/do/ControlDO";
import { EPOCH_PREFIX } from "../../src/do/epochHistory";
import type { Env } from "../../src/env";
import { createFolder } from "../../src/services/createFolder";
import { foundationFixture } from "../fixtures/foundation";

const control = () => env.CONTROL.get(env.CONTROL.idFromName(CONTROL_NAME));
const f = foundationFixture(crypto.randomUUID(), Date.now() - 1000);
let epoch = 2;

beforeAll(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
  await env.BACKUPS.put(
    `${EPOCH_PREFIX}1.json`,
    JSON.stringify({ epoch: 1, at: 1, reason: "operator" }),
  );
  await control().recover();
  await atomicBatch(
    env.DB,
    f.statements.map((statement) =>
      statement.sql.startsWith("INSERT INTO sessions")
        ? { ...statement, sql: statement.sql.replace("?,1,?,?,?)", "?,2,?,?,?)") }
        : statement,
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
  epoch = (await control().recover()).epoch;
  await control().quiesce(epoch);
  await control().failStaleOutbox(epoch);
});

async function audited(
  instance: Pick<ControlDO, "beginRecoveryAudit" | "nextRecoveryAuditPage"> = control(),
) {
  await instance.beginRecoveryAudit(epoch);
  for (let i = 0; i < 20; i++)
    if ((await instance.nextRecoveryAuditPage(epoch, 20)).completed) return;
  throw new Error("audit_fixture_incomplete");
}

function withBatch(batch: (statements: D1PreparedStatement[]) => Promise<D1Result[]>): Env {
  return { ...env, DB: { prepare: env.DB.prepare.bind(env.DB), batch } as D1Database };
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

it("requires a complete current audit and keeps GC paused until a separate explicit resume", async () => {
  await runInDurableObject(control(), async (instance) => {
    await expect(instance.resumeAdmission(epoch)).rejects.toThrow("recovery_audit_incomplete");
    await instance.beginRecoveryAudit(epoch);
    await instance.nextRecoveryAuditPage(epoch);
    await expect(instance.resumeAdmission(epoch)).rejects.toThrow("recovery_audit_incomplete");
    await expect(instance.resumeGarbageCollection(epoch)).rejects.toThrow("admission_not_open");
    await audited(instance);
    expect(await instance.resumeAdmission(epoch)).toEqual({
      epoch,
      maintenance: false,
      gcPaused: true,
    });
    await expect(instance.nextRecoveryAuditPage(epoch)).rejects.toThrow(
      "recovery_admission_not_closed",
    );
    expect(await instance.resumeGarbageCollection(epoch)).toEqual({
      epoch,
      maintenance: false,
      gcPaused: false,
    });
    expect(await instance.resumeAdmission(epoch)).toMatchObject({ gcPaused: false });
    expect(await instance.pauseGarbageCollection(epoch)).toEqual({
      epoch,
      maintenance: false,
      gcPaused: true,
    });
    expect(await instance.quiesce(epoch)).toMatchObject({ maintenance: true, gcPaused: true });
    await expect(instance.resumeAdmission(epoch)).rejects.toThrow("recovery_audit_incomplete");
  });
});

it("preserves active admission across eviction and requires an exact D1 mirror", async () => {
  await audited();
  await control().resumeAdmission(epoch);
  await evictDurableObject(control());
  expect(await control().status()).toMatchObject({ maintenance: false, gcPaused: true });
  await env.DB.prepare("UPDATE control SET admission_token='restored-other-intent'").run();
  await runInDurableObject(control(), async (instance) => {
    await expect(instance.status()).rejects.toThrow("control_mirror_conflict");
  });
  await control().quiesce(epoch);
  expect(await control().status()).toMatchObject({ maintenance: true });
});

it("runs a real namespace mutation through real LockDO and ControlDO after resuming", async () => {
  await audited();
  await control().resumeAdmission(epoch);
  const result = await createFolder(env, {
    principal: { kind: "user", user_id: f.ids.user, credential_id: f.ids.credential, epoch },
    idempotencyKey: crypto.randomUUID(),
    spaceId: f.ids.space,
    parentId: f.ids.root,
    name: "受付再開後のフォルダー",
    lockTokens: [],
  });
  expect(result).toMatchObject({ kind: "terminal", operation: { state: "committed" } });
  expect(
    await env.DB.prepare("SELECT 1 FROM nodes WHERE parent_id=? AND name=?")
      .bind(f.ids.root, "受付再開後のフォルダー")
      .first(),
  ).not.toBeNull();
  await control().quiesce(epoch);
  await expect(
    createFolder(env, {
      principal: { kind: "user", user_id: f.ids.user, credential_id: f.ids.credential, epoch },
      idempotencyKey: crypto.randomUUID(),
      spaceId: f.ids.space,
      parentId: f.ids.root,
      name: "停止中には作成不可",
      lockTokens: [],
    }),
  ).rejects.toThrow();
  await audited();
});

for (const operation of [
  "resumeAdmission",
  "resumeGarbageCollection",
  "pauseGarbageCollection",
  "quiesce",
] as const) {
  for (const committed of [false, true]) {
    it(`reconciles ${operation} ${committed ? "after" : "before"} D1 commit without losing the durable intent`, async () => {
      await audited();
      if (operation !== "resumeAdmission") await control().resumeAdmission(epoch);
      if (operation === "pauseGarbageCollection") await control().resumeGarbageCollection(epoch);
      await runInDurableObject(control(), async (_instance, state) => {
        const testEnv = withBatch(async (statements) => {
          if (committed) await env.DB.batch(statements);
          throw new Error("injected_admission_ack_loss");
        });
        const instance = new ControlDO(state, testEnv);
        if (committed) await instance[operation](epoch);
        else {
          await expect(instance[operation](epoch)).rejects.toThrow("injected_admission_ack_loss");
          expect(await instance.status()).toMatchObject({ maintenance: true });
        }
      });
      await evictDurableObject(control());
      const result = await control()[operation](epoch);
      expect(result).toMatchObject({
        epoch,
        maintenance: operation === "quiesce",
        gcPaused: operation !== "resumeGarbageCollection",
      });
    });
  }
}

it("recovers a committed opening after losing both the batch response and its readback", async () => {
  await audited();
  await runInDurableObject(control(), async (_instance, state) => {
    let committed = false;
    const testEnv = withBatch(async (statements) => {
      await env.DB.batch(statements);
      committed = true;
      throw new Error("injected_ack_loss");
    });
    testEnv.DB = {
      ...testEnv.DB,
      prepare(sql: string) {
        if (committed) throw new Error("injected_readback_loss");
        return env.DB.prepare(sql);
      },
    } as D1Database;
    const instance = new ControlDO(state, testEnv);
    await expect(instance.resumeAdmission(epoch)).rejects.toThrow("injected_readback_loss");
    expect(await instance.status()).toMatchObject({ maintenance: true });
  });
  expect(await env.DB.prepare("SELECT maintenance FROM control").first("maintenance")).toBe(0);
  await evictDurableObject(control());
  expect(await control().resumeAdmission(epoch)).toMatchObject({
    maintenance: false,
    gcPaused: true,
  });
});

for (const kind of ["reservation", "permit", "bootstrap"] as const) {
  it(`atomically rejects a new ${kind} after all audit pages have passed`, async () => {
    await audited();
    const id = crypto.randomUUID();
    await runInDurableObject(control(), async (_instance, state) => {
      const instance = new ControlDO(
        state,
        withBatch(async (statements) => {
          if (kind === "reservation")
            await env.DB.prepare(
              "INSERT INTO reservations(id,owner_id,bytes,state,expires_at,epoch) VALUES(?,?,1,'reserved',?,?)",
            )
              .bind(id, f.ids.user, Date.now() + 60000, epoch)
              .run();
          else if (kind === "permit")
            await env.DB.prepare("INSERT INTO permits VALUES(?,?,?,?,'open')")
              .bind(id, f.ids.space, epoch, Date.now() + 60000)
              .run();
          else await env.DB.prepare("UPDATE control SET bootstrap_sub='wrong-admin'").run();
          return env.DB.batch(statements);
        }),
      );
      await expect(instance.resumeAdmission(epoch)).rejects.toThrow();
      expect(await instance.status()).toMatchObject({ maintenance: true });
    });
    expect(await env.DB.prepare("SELECT maintenance FROM control").first("maintenance")).toBe(1);
    if (kind === "reservation")
      await env.DB.prepare("UPDATE reservations SET state='released' WHERE id=?").bind(id).run();
    if (kind === "bootstrap")
      await env.DB.prepare("UPDATE control SET bootstrap_sub=?").bind(f.ids.user).run();
    await control().quiesce(epoch);
  });
}

for (const operation of ["resumeAdmission", "resumeGarbageCollection"] as const) {
  it(`a newer stop defeats delayed ${operation} dispatch`, async () => {
    await audited();
    if (operation === "resumeGarbageCollection") await control().resumeAdmission(epoch);
    await runInDurableObject(control(), async (instance, state) => {
      const entered = deferred();
      const release = deferred();
      const delayed = new ControlDO(
        state,
        withBatch(async (statements) => {
          entered.resolve();
          await release.promise;
          return env.DB.batch(statements);
        }),
      );
      const result = delayed[operation](epoch).then(
        () => "opened",
        () => "rejected",
      );
      await entered.promise;
      await instance.quiesce(epoch);
      release.resolve();
      expect(await result).toBe("rejected");
      expect(await instance.status()).toMatchObject({ maintenance: true });
      expect(await env.DB.prepare("SELECT maintenance,gc_paused FROM control").first()).toEqual({
        maintenance: 1,
        gc_paused: 1,
      });
    });
  });
}

it("a newer stop defeats an opening whose committed acknowledgement arrives late", async () => {
  await audited();
  await runInDurableObject(control(), async (instance, state) => {
    const entered = deferred();
    const release = deferred();
    const delayed = new ControlDO(
      state,
      withBatch(async (statements) => {
        const value = await env.DB.batch(statements);
        entered.resolve();
        await release.promise;
        return value;
      }),
    );
    const result = delayed.resumeAdmission(epoch).then(
      () => "opened",
      () => "rejected",
    );
    await entered.promise;
    await instance.quiesce(epoch);
    release.resolve();
    expect(await result).toBe("rejected");
    expect(await instance.status()).toMatchObject({ maintenance: true });
  });
});

it("a delayed old stop cannot revoke new permits or overwrite a later successful resume", async () => {
  await audited();
  await control().resumeAdmission(epoch);
  await runInDurableObject(control(), async (instance, state) => {
    const entered = deferred();
    const release = deferred();
    const delayed = new ControlDO(
      state,
      withBatch(async (statements) => {
        entered.resolve();
        await release.promise;
        return env.DB.batch(statements);
      }),
    );
    const result = delayed.quiesce(epoch).then(
      () => "stopped",
      () => "rejected",
    );
    await entered.promise;
    await instance.quiesce(epoch);
    await audited(instance);
    await instance.resumeAdmission(epoch);
    const id = crypto.randomUUID();
    await env.DB.prepare("INSERT INTO permits VALUES(?,?,?,?,'open')")
      .bind(id, f.ids.space, epoch, Date.now() + 60000)
      .run();
    release.resolve();
    expect(await result).toBe("rejected");
    expect(await instance.status()).toMatchObject({ maintenance: false });
    expect(
      await env.DB.prepare("SELECT state FROM permits WHERE permit_id=?").bind(id).first("state"),
    ).toBe("open");
  });
});

it("does not return an obsolete open status after a stop interleaves with its mirror read", async () => {
  await audited();
  await control().resumeAdmission(epoch);
  await runInDurableObject(control(), async (instance, state) => {
    const entered = deferred();
    const release = deferred();
    const db = {
      prepare(sql: string) {
        return {
          bind(...values: unknown[]) {
            return {
              async first() {
                const row = await env.DB.prepare(sql)
                  .bind(...values)
                  .first();
                entered.resolve();
                await release.promise;
                return row;
              },
            };
          },
        };
      },
    } as unknown as D1Database;
    const delayed = new ControlDO(state, { ...env, DB: db });
    const result = delayed.status().then(
      () => "open",
      () => "rejected",
    );
    await entered.promise;
    await instance.quiesce(epoch);
    release.resolve();
    expect(await result).toBe("rejected");
  });
});

it("retains an interrupted repair hold across eviction, and a new epoch requires a new audit", async () => {
  await audited();
  await runInDurableObject(control(), async (_instance, state) => {
    state.storage.sql.exec(
      "INSERT INTO control_maintenance_tasks VALUES('interrupted-repair',?)",
      epoch,
    );
  });
  await evictDurableObject(control());
  await runInDurableObject(control(), async (instance) => {
    await expect(instance.resumeAdmission(epoch)).rejects.toThrow("recovery_maintenance_active");
    expect(await instance.bumpEpoch(epoch, "operator")).toMatchObject({
      epoch: epoch + 1,
      maintenance: true,
    });
    epoch++;
    await expect(instance.resumeAdmission(epoch)).rejects.toThrow("recovery_audit_incomplete");
  });
});

it("closes active service on epoch rotation and rejects an old expected epoch", async () => {
  await audited();
  await control().resumeAdmission(epoch);
  await control().resumeGarbageCollection(epoch);
  const old = epoch;
  expect(await control().bumpEpoch(old, "credential_rotation")).toEqual({
    epoch: old + 1,
    maintenance: true,
    gcPaused: true,
  });
  epoch++;
  await runInDurableObject(control(), async (instance) => {
    await expect(instance.resumeAdmission(old)).rejects.toThrow("admission_epoch_conflict");
    await expect(instance.resumeAdmission(epoch)).rejects.toThrow("recovery_audit_incomplete");
  });
});

it("concurrent resume requests use one persisted transition and converge on one open mirror", async () => {
  await audited();
  await runInDurableObject(control(), async (instance, state) => {
    const before = state.storage.sql
      .exec<{ revision: number }>("SELECT revision FROM control_admission")
      .one().revision;
    const results = await Promise.allSettled([
      instance.resumeAdmission(epoch),
      instance.resumeAdmission(epoch),
    ]);
    expect(results.some((result) => result.status === "fulfilled")).toBe(true);
    expect(await instance.status()).toMatchObject({ maintenance: false, gcPaused: true });
    expect(
      state.storage.sql.exec<{ revision: number }>("SELECT revision FROM control_admission").one()
        .revision,
    ).toBe(before + 1);
  });
});

it("blocks resume during an actual repair RPC and invalidates concurrent audit pages on completion", async () => {
  await runInDurableObject(control(), async (instance, state) => {
    const entered = deferred();
    const release = deferred();
    const delayed = new ControlDO(state, {
      ...env,
      BLOBS: {
        head: env.BLOBS.head.bind(env.BLOBS),
        async list(options: R2ListOptions) {
          entered.resolve();
          await release.promise;
          return env.BLOBS.list(options);
        },
      } as R2Bucket,
    });
    const repair = delayed.inventoryOrphanObjects(epoch);
    await entered.promise;
    try {
      await expect(audited(instance)).rejects.toThrow("recovery_final_fence_pending");
      await expect(instance.resumeAdmission(epoch)).rejects.toThrow("recovery_maintenance_active");
    } finally {
      release.resolve();
    }
    await repair;
    await expect(instance.resumeAdmission(epoch)).rejects.toThrow("recovery_audit_incomplete");
    await audited(instance);
    expect(await instance.resumeAdmission(epoch)).toMatchObject({ maintenance: false });
  });
});

it("a delayed duplicate epoch publication cannot close a subsequently resumed epoch", async () => {
  await runInDurableObject(control(), async (instance, state) => {
    const entered = deferred();
    const release = deferred();
    const delayed = new ControlDO(
      state,
      withBatch(async (statements) => {
        entered.resolve();
        await release.promise;
        return env.DB.batch(statements);
      }),
    );
    const result = delayed.bumpEpoch(epoch, "operator").then(
      () => "published",
      () => "rejected",
    );
    await entered.promise;
    try {
      const recovered = await instance.recover();
      epoch = recovered.epoch;
      await instance.failStaleOutbox(epoch);
      await audited(instance);
      await instance.resumeAdmission(epoch);
    } finally {
      release.resolve();
    }
    expect(await result).toBe("rejected");
    expect(await instance.status()).toMatchObject({ epoch, maintenance: false });
  });
});

it("full ControlDO storage loss allocates a fresh epoch and never trusts the old open D1 flags", async () => {
  await audited();
  await control().resumeAdmission(epoch);
  const old = epoch;
  await runInDurableObject(control(), async (_instance, state) => {
    await state.storage.deleteAll();
  });
  await evictDurableObject(control());
  await runInDurableObject(control(), async (instance) => {
    await expect(instance.status()).rejects.toThrow("control_not_ready");
    expect(await instance.recover()).toEqual({ epoch: old + 1, maintenance: true, gcPaused: true });
    epoch++;
    await expect(instance.resumeAdmission(epoch)).rejects.toThrow("recovery_audit_incomplete");
  });
});
