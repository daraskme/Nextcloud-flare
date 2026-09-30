import { applyD1Migrations, evictDurableObject, runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { base64url } from "jose";
import { afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { handleNodeMutationHttp } from "../../src/api/nodeMutations";
import { CsrfTokens, csrfKeyRing } from "../../src/auth/csrf";
import { atomicBatch } from "../../src/db/primary";
import { assertRestorePause } from "../../src/db/restorePause";
import { CONTROL_NAME, ControlDO } from "../../src/do/ControlDO";
import { EPOCH_PREFIX } from "../../src/do/epochHistory";
import { LockDO } from "../../src/do/LockDO";
import type { Env } from "../../src/env";
import { drainRestoreBlobGarbageCollection, runGarbageCollection } from "../../src/jobs/gc";
import { createFolder } from "../../src/services/createFolder";
import { restoreTrash } from "../../src/services/restoreTrash";
import { trashNode } from "../../src/services/trashNode";
import { foundationFixture } from "../fixtures/foundation";
import { injectBatch } from "../fixtures/uploadEnv";

const control = () => env.CONTROL.get(env.CONTROL.idFromName(CONTROL_NAME));
const op = () => `op_${crypto.randomUUID().replaceAll("-", "").repeat(2)}`;
const f = foundationFixture(crypto.randomUUID(), Date.now() - 1000);
let epoch = 2;
const principal = () => ({
  kind: "user" as const,
  user_id: f.ids.user,
  credential_id: f.ids.credential,
  epoch,
});
const withBatch = (batch: (statements: D1PreparedStatement[]) => Promise<D1Result[]>): Env => ({
  ...env,
  DB: { prepare: env.DB.prepare.bind(env.DB), batch } as D1Database,
});

beforeAll(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
  await env.BACKUPS.put(
    `${EPOCH_PREFIX}1.json`,
    JSON.stringify({ epoch: 1, at: 1, reason: "operator" }),
  );
  await control().recover();
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
async function reopen(
  instance: Pick<
    ControlDO,
    "beginRecoveryAudit" | "nextRecoveryAuditPage" | "resumeAdmission" | "resumeGarbageCollection"
  > = control(),
) {
  await instance.beginRecoveryAudit(epoch);
  let audited = false;
  for (let i = 0; i < 30 && !audited; i++)
    audited = (await instance.nextRecoveryAuditPage(epoch, 20)).completed;
  expect(audited).toBe(true);
  await instance.resumeAdmission(epoch);
  await instance.resumeGarbageCollection(epoch);
}
beforeEach(async () => {
  epoch = (await control().recover()).epoch;
  await control().failStaleOutbox(epoch);
  await reopen();
});
afterEach(async () => {
  epoch = (await control().recover()).epoch;
  await control().quiesce(epoch);
  await env.DB.prepare("UPDATE gc_candidates SET claim_expires_at=0 WHERE state='deleting'").run();
  await control().drainBlobGarbageCollection(epoch, 20);
});

async function garbage(state: "candidate" | "deleting" = "deleting", expires = 0) {
  const g = foundationFixture(crypto.randomUUID(), Date.now() - 1000);
  await atomicBatch(env.DB, g.statements);
  const key = `u/${g.ids.user}/b/${g.ids.blob}`,
    object = (await env.BLOBS.put(key, "abc"))!;
  await atomicBatch(env.DB, [
    {
      sql: "INSERT INTO blob_storage(blob_id,bytes,r2_etag,observed_at) VALUES(?,3,?,1)",
      values: [g.ids.blob, object.etag],
    },
    { sql: "UPDATE nodes SET current_blob_id=NULL WHERE id=?", values: [g.ids.file] },
    {
      sql: "UPDATE blobs SET state=? WHERE id=?",
      values: [state === "deleting" ? "deleting" : "gc_candidate", g.ids.blob],
    },
    {
      sql: "INSERT INTO gc_candidates(blob_id,state,not_before,claim_token,claim_expires_at,claim_epoch) VALUES(?,?,0,?,?,?)",
      values: [
        g.ids.blob,
        state,
        state === "deleting" ? crypto.randomUUID() : null,
        state === "deleting" ? expires : null,
        state === "deleting" ? epoch : null,
      ],
    },
  ]);
  return { ...g, key };
}
async function trashed() {
  const folder = await createFolder(env, {
    principal: principal(),
    idempotencyKey: crypto.randomUUID(),
    spaceId: f.ids.space,
    parentId: f.ids.root,
    name: crypto.randomUUID(),
    lockTokens: [],
  });
  if (folder.kind !== "terminal" || folder.operation.state !== "committed")
    throw new Error("folder_failed");
  const nodeId = (folder.operation.result as { nodeId: string }).nodeId;
  const result = await trashNode(env, {
    principal: principal(),
    requestId: crypto.randomUUID(),
    nodeId,
    spaceId: f.ids.space,
    lockTokens: [],
  });
  if (result.kind !== "terminal" || result.operation.state !== "committed")
    throw new Error("trash_failed");
  return {
    nodeId,
    request: {
      principal: principal(),
      requestId: crypto.randomUUID(),
      spaceId: f.ids.space,
      trashOpId: result.operation.id,
      destinationParentId: f.ids.root,
      lockTokens: [],
    },
  };
}

it("restores through real ControlDO/LockDO while GC is enabled and returns to the running policy", async () => {
  const target = await trashed();
  const result = await restoreTrash(env, target.request);
  expect(result).toMatchObject({ kind: "terminal", operation: { state: "committed" } });
  expect(await control().status()).toMatchObject({ maintenance: false, gcPaused: false });
  expect(
    await env.DB.prepare("SELECT gc_hold_token FROM control").first("gc_hold_token"),
  ).toBeNull();
  expect(
    await env.DB.prepare("SELECT deleted_at FROM nodes WHERE id=?")
      .bind(target.nodeId)
      .first("deleted_at"),
  ).toBeNull();
  expect(await restoreTrash(env, target.request)).toMatchObject({
    kind: "terminal",
    operation: { state: "committed" },
  });
});

it("waits for existing delete leases, drains only irreversible objects, and preserves new candidates", async () => {
  const active = await garbage("deleting", Date.now() + 60_000),
    candidate = await garbage("candidate");
  const id = op(),
    paused = await control().acquireRestorePause(epoch, id);
  expect(paused.ready).toBe(false);
  expect(await env.BLOBS.head(active.key)).not.toBeNull();
  expect(await runGarbageCollection(env, env.BLOBS, epoch)).toMatchObject({ claimed: 0 });
  await env.DB.prepare("UPDATE gc_candidates SET claim_expires_at=0 WHERE blob_id=?")
    .bind(active.ids.blob)
    .run();
  const ready = await control().acquireRestorePause(epoch, id);
  expect(ready).toMatchObject({ token: paused.token, ready: true });
  expect(await env.BLOBS.head(active.key)).toBeNull();
  expect(await env.BLOBS.head(candidate.key)).not.toBeNull();
  expect(
    await env.DB.prepare("SELECT physical_bytes FROM users WHERE id=?")
      .bind(active.ids.user)
      .first("physical_bytes"),
  ).toBe(0);
  await control().releaseRestorePause(epoch, paused.token);
  // Keep this unclaimed candidate out of unrelated later normal-GC tests.
  await env.DB.prepare("UPDATE gc_candidates SET not_before=9999999999999 WHERE blob_id=?")
    .bind(candidate.ids.blob)
    .run();
});

it("preserves an operator pause, blocks a competing restore and refuses explicit GC resume while held", async () => {
  const held = await control().acquireRestorePause(epoch, op());
  await control().pauseGarbageCollection(epoch);
  await runInDurableObject(control(), async (instance) => {
    await expect(instance.resumeGarbageCollection(epoch)).rejects.toThrow("gc_restore_busy");
    await expect(instance.acquireRestorePause(epoch, op())).rejects.toThrow("gc_restore_busy");
  });
  await control().releaseRestorePause(epoch, held.token);
  expect(await control().status()).toMatchObject({ gcPaused: true, maintenance: false });
  await control().resumeGarbageCollection(epoch);
  expect(await control().status()).toMatchObject({ gcPaused: false });
});

it("keeps an initially paused operator policy and an evicted restore's identity", async () => {
  await control().pauseGarbageCollection(epoch);
  const id = op(),
    held = await control().acquireRestorePause(epoch, id);
  await evictDurableObject(control());
  expect(await control().acquireRestorePause(epoch, id)).toEqual(held);
  await control().releaseRestorePause(epoch, held.token);
  expect(await control().status()).toMatchObject({ gcPaused: true });
});

for (const method of ["acquire", "release"] as const)
  for (const committed of [false, true]) {
    it(`reconciles ${method} ${committed ? "after" : "before"} a lost D1 commit response across eviction`, async () => {
      const id = op();
      const held = method === "release" ? await control().acquireRestorePause(epoch, id) : null;
      await runInDurableObject(control(), async (_, state) => {
        const proxy = new ControlDO(
          state,
          withBatch(async (statements) => {
            if (committed) await env.DB.batch(statements);
            throw new Error("injected_ack_loss");
          }),
        );
        const action = () =>
          held
            ? proxy.releaseRestorePause(epoch, held.token)
            : proxy.acquireRestorePause(epoch, id);
        if (committed) await action();
        else await expect(action()).rejects.toThrow("injected_ack_loss");
      });
      await evictDurableObject(control());
      if (held) {
        await runInDurableObject(control(), (instance) => instance.alarm());
        expect(await control().status()).toMatchObject({ gcPaused: false });
      } else {
        const next = await control().acquireRestorePause(epoch, id);
        expect(next.ready).toBe(true);
        await control().releaseRestorePause(epoch, next.token);
      }
    });
  }

it("retains a committed pause after readback loss and lets the durable alarm reconcile it", async () => {
  const id = op();
  await runInDurableObject(control(), async (_, state) => {
    let committed = false;
    const proxy = withBatch(async (statements) => {
      await env.DB.batch(statements);
      committed = true;
      throw new Error("ack_loss");
    });
    proxy.DB = {
      ...proxy.DB,
      prepare(sql: string) {
        if (committed) throw new Error("readback_loss");
        return env.DB.prepare(sql);
      },
    } as D1Database;
    const instance = new ControlDO(state, proxy);
    await expect(instance.acquireRestorePause(epoch, id)).rejects.toThrow("readback_loss");
    expect(await instance.status()).toMatchObject({ maintenance: true });
  });
  await evictDurableObject(control());
  await runInDurableObject(control(), (instance) => instance.alarm());
  const restored = await control().acquireRestorePause(epoch, id);
  expect(restored.ready).toBe(true);
  await control().releaseRestorePause(epoch, restored.token);
});

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
const bucketWith = (overrides: Partial<R2Bucket>) =>
  ({
    delete: env.BLOBS.delete.bind(env.BLOBS),
    head: env.BLOBS.head.bind(env.BLOBS),
    ...overrides,
  }) as R2Bucket;

for (const action of ["acquire", "release"] as const)
  for (const committed of [false, true])
    it(`a fresh stop and new pause defeat a delayed ${action} ${committed ? "acknowledgement" : "dispatch"}`, async () => {
      const held = action === "release" ? await control().acquireRestorePause(epoch, op()) : null;
      await runInDurableObject(control(), async (instance, state) => {
        const entered = deferred(),
          release = deferred();
        const delayed = new ControlDO(
          state,
          withBatch(async (statements) => {
            const receipt = committed ? await env.DB.batch(statements) : null;
            entered.resolve();
            await release.promise;
            return receipt ?? env.DB.batch(statements);
          }),
        );
        const pending = (
          held
            ? delayed.releaseRestorePause(epoch, held.token)
            : delayed.acquireRestorePause(epoch, op())
        ).then(
          () => "accepted",
          () => "rejected",
        );
        await entered.promise;
        try {
          await instance.quiesce(epoch);
          await reopen(instance);
          const next = await instance.acquireRestorePause(epoch, op());
          release.resolve();
          expect(await pending).toBe("rejected");
          expect(
            await env.DB.prepare("SELECT gc_hold_token FROM control").first("gc_hold_token"),
          ).toBe(next.token);
          expect(await instance.status()).toMatchObject({ maintenance: false, gcPaused: true });
          await instance.releaseRestorePause(epoch, next.token);
        } finally {
          release.resolve();
          await pending;
        }
      });
    });

it("a release with lost acknowledgement and readback resumes from its durable alarm", async () => {
  const held = await control().acquireRestorePause(epoch, op());
  await runInDurableObject(control(), async (_, state) => {
    let committed = false;
    const proxy = withBatch(async (statements) => {
      await env.DB.batch(statements);
      committed = true;
      throw new Error("ack_loss");
    });
    proxy.DB = {
      ...proxy.DB,
      prepare(sql: string) {
        if (committed) throw new Error("readback_loss");
        return env.DB.prepare(sql);
      },
    } as D1Database;
    const instance = new ControlDO(state, proxy);
    await expect(instance.releaseRestorePause(epoch, held.token)).rejects.toThrow("readback_loss");
    expect(await instance.status()).toMatchObject({ maintenance: true });
  });
  await evictDurableObject(control());
  await runInDurableObject(control(), (instance) => instance.alarm());
  expect(await control().status()).toMatchObject({ maintenance: false, gcPaused: false });
});

it("the alarm releases a completed operation when its caller disappears before cleanup", async () => {
  const target = await trashed();
  const result = await restoreTrash(env, target.request);
  if (result.kind !== "terminal") throw new Error("missing_terminal");
  await control().acquireRestorePause(epoch, result.operation.id);
  await evictDurableObject(control());
  await runInDurableObject(control(), (instance) => instance.alarm());
  expect(await control().status()).toMatchObject({ gcPaused: false });
});

it("fences the permit grant if the restore's pause is replaced after LockDO authorization", async () => {
  const target = await trashed(),
    id = op();
  const held = await control().acquireRestorePause(epoch, id);
  let changed = false,
    nextToken: string | undefined;
  const app = {
    ...env,
    DB: injectBatch(
      (sql) => sql.includes("INSERT INTO permits"),
      async () => {
        changed = true;
        await control().releaseRestorePause(epoch, held.token);
        nextToken = (await control().acquireRestorePause(epoch, op())).token;
      },
      false,
    ),
  };
  await runInDurableObject(env.LOCKS.get(env.LOCKS.idFromName(f.ids.space)), async (_, state) => {
    await expect(
      new LockDO(state, app).acquireRestore({
        gcPause: held,
        requestId: id,
        principal: principal(),
        spaceId: f.ids.space,
        parentId: f.ids.root,
        trashOpId: target.request.trashOpId,
        rootNodeId: target.nodeId,
        lockTokens: [],
      }),
    ).rejects.toThrow();
  });
  expect(changed).toBe(true);
  expect(
    await env.DB.prepare("SELECT 1 FROM permits WHERE permit_id=?").bind(`p:${id}`).first(),
  ).toBeNull();
  await control().releaseRestorePause(epoch, nextToken!);
});

it("waits for an old in-flight delete and settles its immutable key only once after lease expiry", async () => {
  const pending = await garbage("candidate");
  const entered = deferred(),
    release = deferred();
  const head = vi.fn(env.BLOBS.head.bind(env.BLOBS));
  const old = runGarbageCollection(
    env,
    bucketWith({
      head,
      delete: async (key) => {
        entered.resolve();
        await release.promise;
        await env.BLOBS.delete(key);
      },
    }),
    epoch,
    { maxBlobs: 1 },
  );
  await entered.promise;
  try {
    const id = op(),
      held = await control().acquireRestorePause(epoch, id);
    expect(held.ready).toBe(false);
    await env.DB.prepare("UPDATE gc_candidates SET claim_expires_at=0 WHERE blob_id=?")
      .bind(pending.ids.blob)
      .run();
    expect(await control().acquireRestorePause(epoch, id)).toMatchObject({
      ready: true,
      token: held.token,
    });
    await control().releaseRestorePause(epoch, held.token);
    release.resolve();
    expect(await old).toMatchObject({ deleted: 0, retried: 1, r2Calls: 1 });
    expect(head).not.toHaveBeenCalled();
    expect(
      await env.DB.prepare("SELECT physical_bytes FROM users WHERE id=?")
        .bind(pending.ids.user)
        .first("physical_bytes"),
    ).toBe(0);
    expect(
      await env.DB.prepare("SELECT r2_calls,state FROM gc_candidates WHERE blob_id=?")
        .bind(pending.ids.blob)
        .first(),
    ).toEqual({ r2_calls: 3, state: "deleted" });
  } finally {
    release.resolve();
    await old;
  }
});

it("expires abandoned windows before resuming GC and rejects their proof under a new pause", async () => {
  const held = await control().acquireRestorePause(epoch, op());
  await runInDurableObject(control(), async (instance, state) => {
    state.storage.sql.exec("UPDATE control_gc_policy SET hold_expires_at=1");
    await env.DB.prepare("UPDATE control SET gc_hold_expires_at=1").run();
    await expect(
      atomicBatch(env.DB, [assertRestorePause({ ...held, expiresAt: 1 }, held.operationId)]),
    ).rejects.toThrow();
    await instance.alarm();
  });
  expect(await control().status()).toMatchObject({ gcPaused: false });
  const next = await control().acquireRestorePause(epoch, op());
  await expect(atomicBatch(env.DB, [assertRestorePause(held, held.operationId)])).rejects.toThrow();
  await atomicBatch(env.DB, [assertRestorePause(next, next.operationId)]);
  await control().releaseRestorePause(epoch, held.token);
  expect(await control().status()).toMatchObject({ gcPaused: true });
  await control().releaseRestorePause(epoch, next.token);
});

it.each(["replaced", "expired"])(
  "rejects a %s pause inside the atomic restore batch",
  async (mode) => {
    const target = await trashed();
    let changed = false;
    let nextToken: string | undefined;
    const result = await restoreTrash(
      {
        ...env,
        DB: injectBatch(
          (sql) => sql.includes("UPDATE trash_ops SET state='restoring'"),
          async () => {
            changed = true;
            if (mode === "replaced") {
              const token = (await env.DB.prepare(
                "SELECT gc_hold_token FROM control",
              ).first<string>("gc_hold_token"))!;
              await control().releaseRestorePause(epoch, token);
              nextToken = (await control().acquireRestorePause(epoch, op())).token;
            } else {
              await runInDurableObject(control(), async (_, state) => {
                state.storage.sql.exec("UPDATE control_gc_policy SET hold_expires_at=1");
                await env.DB.prepare("UPDATE control SET gc_hold_expires_at=1").run();
              });
            }
          },
          false,
        ),
      },
      target.request,
    );
    expect(changed).toBe(true);
    expect(result).toMatchObject({ kind: "terminal", operation: { state: "failed" } });
    expect(
      await env.DB.prepare("SELECT deleted_at FROM nodes WHERE id=?")
        .bind(target.nodeId)
        .first("deleted_at"),
    ).not.toBeNull();
    expect(
      await env.DB.prepare("SELECT state FROM trash_ops WHERE op_id=?")
        .bind(target.request.trashOpId)
        .first("state"),
    ).toBe("trashed");
    if (nextToken) {
      // The old request's finally must not release the new operation's pause.
      expect(await env.DB.prepare("SELECT gc_hold_token FROM control").first("gc_hold_token")).toBe(
        nextToken,
      );
      await control().releaseRestorePause(epoch, nextToken);
    }
  },
);

it("pause-bound GC refuses a stale capability after release even if another restore is paused", async () => {
  const held = await control().acquireRestorePause(epoch, op());
  const pending = await garbage();
  await control().releaseRestorePause(epoch, held.token);
  const next = await runInDurableObject(control(), async (_, state) => {
    // Acquire without the RPC's drain so the stale collector is tested against a live object.
    const { ControlAdmission } = await import("../../src/do/controlAdmission");
    return new ControlAdmission(
      state.storage,
      env.DB,
      () => epoch,
      () => {},
    ).acquireRestorePause(epoch, op());
  });
  expect(await drainRestoreBlobGarbageCollection(env, env.BLOBS, held)).toMatchObject({
    claimed: 0,
  });
  expect(await env.BLOBS.head(pending.key)).not.toBeNull();
  expect(await drainRestoreBlobGarbageCollection(env, env.BLOBS, next)).toMatchObject({
    deleted: 1,
  });
  await control().releaseRestorePause(epoch, next.token);
});

it("returns retryable HTTP quiescence without losing the original restore intent", async () => {
  const target = await trashed(),
    pending = await garbage("deleting", Date.now() + 60_000);
  const app = { ...env, APP_ORIGIN: "https://app.invalid" };
  const secret = base64url.encode(crypto.getRandomValues(new Uint8Array(32)));
  const ring = await csrfKeyRing("test", { test: secret });
  const csrf = new CsrfTokens(ring, ring, app.APP_ORIGIN);
  const issued = await csrf.issue(
    env.DB,
    new Request(`${app.APP_ORIGIN}/api/v1/csrf`, {
      method: "POST",
      headers: { "Sec-Fetch-Site": "same-origin" },
    }),
    { kind: "access", credentialId: f.ids.credential, epoch },
  );
  const send = () =>
    handleNodeMutationHttp(
      new Request(`${app.APP_ORIGIN}/api/v1/trash/${target.request.trashOpId}/restore`, {
        method: "POST",
        headers: {
          Origin: app.APP_ORIGIN,
          "Sec-Fetch-Site": "same-origin",
          "Content-Type": "application/json",
          "X-CSRF-Token": issued.token,
          "Idempotency-Key": target.request.requestId,
        },
        body: JSON.stringify({ spaceId: f.ids.space, destinationParentId: f.ids.root }),
      }),
      app,
      principal(),
      csrf,
    );
  const waiting = await send();
  expect(waiting.status).toBe(503);
  expect(waiting.headers.get("Retry-After")).toBe("5");
  expect(await waiting.json()).toMatchObject({ title: "gc_quiescing" });
  expect(await control().status()).toMatchObject({ maintenance: false, gcPaused: true });
  await env.DB.prepare("UPDATE gc_candidates SET claim_expires_at=0 WHERE blob_id=?")
    .bind(pending.ids.blob)
    .run();
  const done = await send();
  expect(done.status).toBe(200);
  const operation = await done.json();
  expect(operation).toMatchObject({ state: "committed", result: { nodeId: target.nodeId } });
  expect(await (await send()).json()).toEqual(operation);
  expect(await control().status()).toMatchObject({ gcPaused: false });
});

it("retries a commit-unknown restore with the same operation after its first pause was released", async () => {
  const target = await trashed();
  const db = injectBatch(
    (sql) => sql.includes("UPDATE trash_ops SET state='restoring'"),
    async () => {
      throw new Error("lost_transport");
    },
    false,
  );
  const uncertain = await restoreTrash({ ...env, DB: db }, target.request);
  expect(uncertain.kind).toBe("commit_unknown");
  expect(await control().status()).toMatchObject({ gcPaused: false });
  const result = await restoreTrash(env, target.request);
  expect(result).toMatchObject({ kind: "terminal", operation: { state: "committed" } });
  if (uncertain.kind === "commit_unknown" && result.kind === "terminal")
    expect(result.operation.id).toBe(uncertain.operationId);
  expect(await control().status()).toMatchObject({ gcPaused: false });
});

it("a new epoch and total DO storage loss both invalidate the old restore proof", async () => {
  const first = await control().acquireRestorePause(epoch, op());
  epoch = (await control().bumpEpoch(epoch, "operator")).epoch;
  await expect(
    atomicBatch(env.DB, [assertRestorePause(first, first.operationId)]),
  ).rejects.toThrow();
  await control().failStaleOutbox(epoch);
  await reopen();
  const second = await control().acquireRestorePause(epoch, op());
  await runInDurableObject(control(), async (_, state) => {
    await state.storage.deleteAll();
  });
  await evictDurableObject(control());
  epoch = (await control().recover()).epoch;
  expect(epoch).toBeGreaterThan(second.epoch);
  expect(await control().status()).toMatchObject({ maintenance: true, gcPaused: true });
  await expect(
    atomicBatch(env.DB, [assertRestorePause(second, second.operationId)]),
  ).rejects.toThrow();
  expect(
    await env.DB.prepare("SELECT gc_hold_token,gc_operator_paused FROM control").first(),
  ).toEqual({ gc_hold_token: null, gc_operator_paused: 1 });
});

function failingControlDatabase(all: boolean): Env {
  return {
    ...env,
    DB: {
      prepare(sql: string) {
        if (all || sql.includes("FROM operations WHERE op_id=? AND epoch=?"))
          throw new Error("persistent_d1_failure");
        return env.DB.prepare(sql);
      },
      batch: env.DB.batch.bind(env.DB),
    } as D1Database,
  };
}

it.each([false, true])(
  "stops after six durable alarm failures even across eviction (D1 entirely unavailable=%s)",
  async (all) => {
    await control().acquireRestorePause(epoch, op());
    for (let attempt = 1; attempt <= 6; attempt++) {
      if (attempt === 4) await evictDurableObject(control());
      await runInDurableObject(control(), async (_, state) => {
        const failed = new ControlDO(state, failingControlDatabase(all));
        await failed.alarm();
        expect(
          state.storage.sql
            .exec<{ failures: number }>("SELECT failures FROM control_alarm_failures")
            .one().failures,
        ).toBe(attempt);
      });
      expect(await control().status()).toMatchObject({
        maintenance: attempt === 6,
        gcPaused: true,
      });
    }
    expect(await env.DB.prepare("SELECT maintenance FROM control").first("maintenance")).toBe(
      all ? 0 : 1,
    );
    // A pending close blocks new admission locally even if D1 could not be reached.
    // Repeated alarm delivery does not repeat external failures indefinitely.
    await runInDurableObject(control(), async (_, state) => {
      const db = failingControlDatabase(true);
      const prepare = vi.spyOn(db.DB, "prepare");
      await new ControlDO(state, db).alarm();
      expect(prepare).not.toHaveBeenCalled();
    });
    await evictDurableObject(control());
    await control().quiesce(epoch);
    expect(await env.DB.prepare("SELECT maintenance,gc_hold_token FROM control").first()).toEqual({
      maintenance: 1,
      gc_hold_token: null,
    });
  },
);

it("a successful alarm resets only that transition's consecutive failures", async () => {
  await control().acquireRestorePause(epoch, op());
  await runInDurableObject(control(), async (instance, state) => {
    const failed = new ControlDO(state, failingControlDatabase(false));
    for (let i = 0; i < 5; i++) await failed.alarm();
    await instance.alarm();
    expect(state.storage.sql.exec("SELECT 1 FROM control_alarm_failures").toArray()).toEqual([]);
    for (let i = 0; i < 5; i++) await failed.alarm();
    expect(await instance.status()).toMatchObject({ maintenance: false });
    await failed.alarm();
    expect(await instance.status()).toMatchObject({ maintenance: true });
  });
});

it.each(["new_hold", "operator_pause"])(
  "a delayed sixth failure preserves cleanup after %s",
  async (mode) => {
    const held = await control().acquireRestorePause(epoch, op());
    await runInDurableObject(control(), async (instance, state) => {
      const failed = new ControlDO(state, failingControlDatabase(false));
      for (let i = 0; i < 5; i++) await failed.alarm();
      await state.storage.deleteAlarm(); // Model consumption of the alarm now being delivered.
      const entered = deferred(),
        release = deferred();
      const app = withBatch(env.DB.batch.bind(env.DB));
      app.DB = {
        ...app.DB,
        prepare(sql: string) {
          const statement = env.DB.prepare(sql);
          if (!sql.includes("FROM operations WHERE op_id=? AND epoch=?")) return statement;
          return {
            bind: () => ({
              first: async () => {
                entered.resolve();
                await release.promise;
                throw new Error("delayed_readback_failure");
              },
            }),
          } as unknown as D1PreparedStatement;
        },
      } as D1Database;
      const pending = new ControlDO(state, app).alarm();
      await entered.promise;
      try {
        let nextToken = held.token;
        if (mode === "new_hold") {
          await instance.quiesce(epoch);
          await reopen(instance);
          nextToken = (await instance.acquireRestorePause(epoch, op())).token;
        } else await instance.pauseGarbageCollection(epoch);
        release.resolve();
        await pending;
        expect(await instance.status()).toMatchObject({ maintenance: false, gcPaused: true });
        expect(await state.storage.getAlarm()).not.toBeNull();
        expect(
          await env.DB.prepare("SELECT gc_hold_token FROM control").first("gc_hold_token"),
        ).toBe(nextToken);
        await instance.releaseRestorePause(epoch, nextToken);
      } finally {
        release.resolve();
        await pending;
      }
    });
  },
);
