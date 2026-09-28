import { applyD1Migrations, evictDurableObject, runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { GC_GRACE_MS } from "../../src/db/gcGrace";
import { ControlImageDerivatives } from "../../src/do/controlImageDerivatives";
import { CONTROL_NAME } from "../../src/do/controlName";
import worker from "../../src/index";
import { runGarbageCollection } from "../../src/jobs/gc";
import { prepareImageDerivative, storeImageDerivative } from "../../src/jobs/imageDerivative";
import {
  IMAGE_CLEANUP_CRON,
  maintainImageDerivatives,
} from "../../src/jobs/imageDerivativeCleanup";
import { trackedR2Write } from "../../src/services/r2Write";
import { auditOwnerLedger } from "../../src/services/refs";
import { davBucket } from "../fixtures/davPut";
import { expireGcGrace } from "../fixtures/gc";
import { imageDerivativeFixture } from "../fixtures/imageDerivative";
import {
  acquireGlobalMutation,
  clearEndedR2TestWrites,
  mutationEnv,
  r2WriteFixture,
} from "../fixtures/mutationAdmission";
import { injectBatch } from "../fixtures/uploadEnv";

const control = () => env.CONTROL.get(env.CONTROL.idFromName(CONTROL_NAME));
beforeAll(() => applyD1Migrations(env.DB, env.TEST_MIGRATIONS));
beforeEach(async () => {
  await clearEndedR2TestWrites();
  await env.DB.prepare(
    "UPDATE control SET epoch=1,maintenance=0,gc_paused=0,backup_token=NULL,backup_frozen=0,restore_freeze_token=NULL",
  ).run();
  await env.DB.prepare("UPDATE mutation_admissions SET state='closed' WHERE state='active'").run();
  await env.DB.prepare("UPDATE image_derivative_cleanup SET next_at=? WHERE settled_at IS NULL")
    .bind(Date.now() + 86400000)
    .run();
  await runInDurableObject(control(), (_, state) => state.storage.deleteAll());
  await evictDurableObject(control());
});
afterEach(() => vi.restoreAllMocks());
function cleanupEnv(db = env.DB) {
  const app = mutationEnv(db),
    base = app.CONTROL.get(app.CONTROL.idFromName(CONTROL_NAME));
  return {
    ...app,
    CONTROL: {
      idFromName: app.CONTROL.idFromName.bind(app.CONTROL),
      get: () => ({
        ...base,
        sealImageDerivative: async (epoch: number, id: string) => {
          const result = await runInDurableObject(control(), async (_, state) => {
            const seals = new ControlImageDerivatives(
              state.storage,
              db,
              () => {},
              () =>
                acquireGlobalMutation({
                  permitId: `global:images.cleanup-seal:${crypto.randomUUID()}`,
                  epoch,
                  deadline: Date.now() + 5000,
                }),
            );
            try {
              return { ok: true as const, value: await seals.seal(epoch, id) };
            } catch (error) {
              return { ok: false as const, error: String(error) };
            }
          });
          if (!result.ok) throw new Error(result.error);
          return result.value;
        },
      }),
    } as unknown as typeof env.CONTROL,
  };
}
async function fixture() {
  const f = await imageDerivativeFixture();
  const claim = await prepareImageDerivative(f.app, f.grant.id, f.output);
  const row = () =>
    env.DB.prepare("SELECT * FROM image_derivative_cleanup WHERE image_id=?")
      .bind(f.grant.id)
      .first<Record<string, unknown>>();
  const due = () =>
    env.DB.prepare(
      "UPDATE image_derivative_cleanup SET next_at=0 WHERE image_id=? AND settled_at IS NULL",
    )
      .bind(f.grant.id)
      .run();
  const stop = async () => {
    await env.DB.prepare("UPDATE control SET epoch=2,maintenance=1,gc_paused=1").run();
    await due();
  };
  const run = (app = cleanupEnv()) => maintainImageDerivatives(app, 2, { imageId: f.grant.id });
  return { ...f, claim, row, due, stop, run };
}
it("seals an expired never-dispatched generation and releases only after an actual absent HEAD", async () => {
  const f = await fixture(),
    before = await auditOwnerLedger(env.DB, f.ids.user);
  await f.stop();
  const head = vi.fn((key: string) => env.BLOBS.head(key)),
    put = vi.fn();
  expect(await f.run({ ...cleanupEnv(), BLOBS: davBucket({ head, put }) })).toMatchObject({
    settled: 1,
    r2Calls: 1,
  });
  expect(head).toHaveBeenCalledTimes(1);
  expect(put).not.toHaveBeenCalled();
  expect(await f.row()).toMatchObject({ disposition: "absent", head_calls: 1 });
  expect(await auditOwnerLedger(env.DB, f.ids.user)).toMatchObject({
    image_reserved_bytes: 0,
    physical_bytes: before!.physical_bytes,
    incorrect_refs: 0,
  });
  expect(
    await env.DB.prepare("SELECT state,ref_count FROM blobs WHERE id=?")
      .bind(f.claim.blobId)
      .first(),
  ).toEqual({ state: "deleted", ref_count: 0 });
  expect(await f.run()).toMatchObject({ inspected: 0 });
});
it("keeps a stored rejected output charged and gives it the full backup grace before GC", async () => {
  const f = await fixture();
  await expect(
    storeImageDerivative(
      {
        ...f.app,
        BLOBS: davBucket({
          put: async (...args: Parameters<R2Bucket["put"]>) => {
            const object = await env.BLOBS.put(...args);
            await env.DB.prepare("UPDATE app_passwords SET revoked_at=? WHERE id=?")
              .bind(Date.now(), f.input.principal.credential_id.slice(3))
              .run();
            return object;
          },
        }),
      },
      f.grant.id,
      f.output,
    ),
  ).rejects.toThrow();
  const before = await auditOwnerLedger(env.DB, f.ids.user);
  await f.stop();
  const now = Date.now(),
    head = vi.fn();
  expect(await f.run({ ...cleanupEnv(), BLOBS: davBucket({ head }) })).toMatchObject({
    settled: 1,
    r2Calls: 0,
  });
  expect(head).not.toHaveBeenCalled();
  expect(await auditOwnerLedger(env.DB, f.ids.user)).toMatchObject({
    image_reserved_bytes: 0,
    physical_bytes: before!.physical_bytes,
    incorrect_refs: 0,
  });
  const gc = await env.DB.prepare("SELECT state,not_before FROM gc_candidates WHERE blob_id=?")
    .bind(f.claim.blobId)
    .first<{ state: string; not_before: number }>();
  expect(gc!.state).toBe("candidate");
  expect(gc!.not_before).toBeGreaterThanOrEqual(now + GC_GRACE_MS);
  expect(await env.BLOBS.head(f.claim.key)).not.toBeNull();
  await env.DB.prepare("UPDATE control SET maintenance=0,gc_paused=0").run();
  expect(await runGarbageCollection(cleanupEnv(), env.BLOBS, 2, { maxBlobs: 1 })).toMatchObject({
    deleted: 0,
  });
  await expireGcGrace(f.claim.blobId, now);
  expect(await runGarbageCollection(cleanupEnv(), env.BLOBS, 2, { maxBlobs: 1 })).toMatchObject({
    deleted: 1,
  });
  expect(await env.BLOBS.head(f.claim.key)).toBeNull();
  expect(await auditOwnerLedger(env.DB, f.ids.user)).toMatchObject({
    physical_bytes: before!.physical_bytes - f.output.bytes.length,
    incorrect_refs: 0,
  });
});
it("recovers a missing physical observation after a proven write, without another PUT", async () => {
  const f = await fixture();
  // Dispatch through the actual tracked native ledger, deliberately omitting only the storage observation.
  await trackedR2Write(
    f.app,
    {
      epoch: 1,
      ownerId: f.ids.user,
      kind: "image.put",
      key: f.claim.key,
      image: {
        imageId: f.grant.id,
        attemptId: f.claim.attemptId,
        claimToken: f.grant.claimToken,
        expiresAt: f.grant.expiresAt,
      },
    },
    () => env.BLOBS.put(f.claim.key, f.output.bytes, { sha256: f.output.sha256 }),
    f.grant.expiresAt,
  );
  await f.stop();
  const put = vi.fn();
  expect(await f.run({ ...cleanupEnv(), BLOBS: davBucket({ put }) })).toMatchObject({
    settled: 1,
    r2Calls: 1,
  });
  expect(put).not.toHaveBeenCalled();
  expect(await auditOwnerLedger(env.DB, f.ids.user)).toMatchObject({
    image_reserved_bytes: 0,
    physical_bytes: 99 + f.output.bytes.length,
    incorrect_refs: 0,
  });
});
it("does not use a present HEAD or expiry to settle an unknown native PUT", async () => {
  const f = await fixture();
  await expect(
    storeImageDerivative(
      {
        ...f.app,
        BLOBS: davBucket({
          put: async (...args: Parameters<R2Bucket["put"]>) => {
            await env.BLOBS.put(...args);
            throw new Error("native reply lost");
          },
        }),
      },
      f.grant.id,
      f.output,
    ),
  ).rejects.toThrow();
  await f.stop();
  const head = vi.fn();
  expect(await f.run({ ...cleanupEnv(), BLOBS: davBucket({ head }) })).toMatchObject({
    settled: 0,
    held: 1,
    r2Calls: 0,
  });
  expect(head).not.toHaveBeenCalled();
  expect(await f.row()).toMatchObject({ seal_token: null, settled_at: null });
  expect(await auditOwnerLedger(env.DB, f.ids.user)).toMatchObject({
    image_reserved_bytes: f.output.bytes.length,
  });
});
it("keeps the independent pending writer even if D1 lost its native row", async () => {
  const f = await fixture();
  await expect(
    storeImageDerivative(
      {
        ...f.app,
        BLOBS: davBucket({
          put: async () => {
            throw new Error("unknown");
          },
        }),
      },
      f.grant.id,
      f.output,
    ),
  ).rejects.toThrow();
  const triggers = await env.DB.prepare(
    "SELECT name,sql FROM sqlite_schema WHERE type='trigger' AND tbl_name='r2_write_attempts'",
  ).all<{ name: string; sql: string }>();
  // Simulate only a past D1 snapshot; the independent DO receipt remains untouched.
  await env.DB.batch([
    ...triggers.results.map((t) => env.DB.prepare(`DROP TRIGGER ${t.name}`)),
    env.DB.prepare("DELETE FROM r2_write_attempts WHERE r2_key=?").bind(f.claim.key),
    ...triggers.results.map((t) => env.DB.prepare(t.sql)),
  ]);
  await f.stop();
  const head = vi.fn();
  expect(await f.run({ ...cleanupEnv(), BLOBS: davBucket({ head }) })).toMatchObject({
    held: 1,
    settled: 0,
  });
  expect(head).not.toHaveBeenCalled();
  expect(await f.row()).toMatchObject({ seal_token: null });
});
it("retains holds when independent image history has been lost", async () => {
  const f = await fixture();
  await runInDurableObject(control(), (_, state) => state.storage.deleteAll());
  await evictDurableObject(control());
  await f.stop();
  const head = vi.fn();
  expect(await f.run({ ...cleanupEnv(), BLOBS: davBucket({ head }) })).toMatchObject({
    held: 1,
    settled: 0,
  });
  expect(head).not.toHaveBeenCalled();
});
it.each(["seal", "head", "settle"])(
  "handles a lost %s transaction response without unbudgeted I/O or double release",
  async (kind) => {
    const f = await fixture();
    await f.stop();
    const db = injectBatch(
      (sql) =>
        sql.includes(
          kind === "seal"
            ? "SET seal_token=?"
            : kind === "head"
              ? "head_calls=head_calls+1"
              : "SET disposition=?",
        ),
      async () => {
        throw new Error("ACK lost");
      },
      true,
    );
    const head = vi.fn((key: string) => env.BLOBS.head(key));
    const result = await f.run({ ...cleanupEnv(db), BLOBS: davBucket({ head }) });
    if (kind === "head") {
      expect(result.settled).toBe(0);
      expect(head).not.toHaveBeenCalled();
      expect(await f.row()).toMatchObject({ head_calls: 1, settled_at: null });
    } else {
      expect(result.settled).toBe(1);
      expect(head).toHaveBeenCalledTimes(1);
      expect(await auditOwnerLedger(env.DB, f.ids.user)).toMatchObject({ image_reserved_bytes: 0 });
    }
  },
);
it("leaves a readable generation pinned even when its original generation claim expires", async () => {
  const f = await fixture();
  await storeImageDerivative(f.app, f.grant.id, f.output);
  expect(await f.row()).toMatchObject({ next_at: Number.MAX_SAFE_INTEGER });
  await f.stop();
  const head = vi.fn();
  expect(await f.run({ ...cleanupEnv(), BLOBS: davBucket({ head }) })).toMatchObject({
    inspected: 1,
    retired: 0,
    settled: 0,
  });
  expect(head).not.toHaveBeenCalled();
  expect(await f.saved()).toMatchObject({ state: "ready" });
  expect(await f.row()).toMatchObject({ retired_at: null });
});
it("retires a published generation only after its source enters irreversible deletion", async () => {
  const f = await fixture();
  await storeImageDerivative(f.app, f.grant.id, f.output);
  await env.DB.prepare("UPDATE nodes SET current_blob_id=? WHERE id=?")
    .bind(f.ids.blob, f.node.id)
    .run();
  await f.stop();
  expect(await f.run()).toMatchObject({ retired: 0 });
  await env.DB.prepare("UPDATE blobs SET state='deleted' WHERE id=?").bind(f.node.blob).run();
  expect((await f.row())!.next_at).toBeLessThanOrEqual(Date.now());
  expect(await f.run()).toMatchObject({ settled: 1 });
  expect(await f.saved()).toMatchObject({ state: "failed", error_code: "image_retired" });
});
it("caps lifetime HEAD calls and retains capacity on failures", async () => {
  const f = await fixture();
  await f.stop();
  const head = vi.fn(async () => {
    throw new Error("R2 unavailable");
  });
  expect(await f.run({ ...cleanupEnv(), BLOBS: davBucket({ head }) })).toMatchObject({
    held: 1,
    r2Calls: 1,
  });
  for (let n = 1; n < 64; n++)
    await env.DB.prepare(
      "UPDATE image_derivative_cleanup SET head_calls=head_calls+1 WHERE image_id=?",
    )
      .bind(f.grant.id)
      .run();
  await f.due();
  expect(await f.run({ ...cleanupEnv(), BLOBS: davBucket({ head }) })).toMatchObject({
    held: 1,
    r2Calls: 0,
  });
  expect(head).toHaveBeenCalledTimes(1);
  expect(await auditOwnerLedger(env.DB, f.ids.user)).toMatchObject({
    image_reserved_bytes: f.output.bytes.length,
  });
});
it("keeps a seal across eviction and refuses a fresh writer after D1 loses the retirement", async () => {
  const f = await fixture();
  await f.stop();
  await f.run();
  const triggers = await env.DB.prepare(
    "SELECT name,sql FROM sqlite_schema WHERE type='trigger' AND tbl_name='image_derivative_cleanup'",
  ).all<{ name: string; sql: string }>();
  await env.DB.batch([
    ...triggers.results.map((t) => env.DB.prepare(`DROP TRIGGER ${t.name}`)),
    env.DB.prepare(
      "UPDATE image_derivative_cleanup SET retired_at=NULL,retired_epoch=NULL,reason=NULL,seal_token=NULL,disposition=NULL,settled_at=NULL WHERE image_id=?",
    ).bind(f.grant.id),
    ...triggers.results.map((t) => env.DB.prepare(t.sql)),
  ]);
  await evictDurableObject(control());
  await expect(
    r2WriteFixture().beginR2Write({
      id: crypto.randomUUID(),
      epoch: 1,
      ownerId: f.ids.user,
      kind: "image.put",
      key: f.claim.key,
      deadline: Date.now() + 5000,
      image: {
        imageId: f.grant.id,
        attemptId: f.claim.attemptId,
        claimToken: f.grant.claimToken,
        expiresAt: f.grant.expiresAt,
      },
    }),
  ).rejects.toThrow("image_derivative_retired");
});
it("routes the dedicated Cron to bounded cleanup without other background work", async () => {
  const f = await fixture();
  await storeImageDerivative(f.app, f.grant.id, f.output);
  await env.DB.prepare("UPDATE nodes SET current_blob_id=? WHERE id=?")
    .bind(f.ids.blob, f.node.id)
    .run();
  await env.DB.prepare("UPDATE blobs SET state='deleted' WHERE id=?").bind(f.node.blob).run();
  await f.due();
  const app = cleanupEnv(),
    send = vi.fn(),
    list = vi.fn();
  await worker.scheduled({ cron: IMAGE_CLEANUP_CRON } as ScheduledController, {
    ...app,
    JOBS: { send } as unknown as typeof env.JOBS,
    BLOBS: davBucket({ list }),
  });
  expect(await f.row()).toMatchObject({ disposition: "stored" });
  expect(send).not.toHaveBeenCalled();
  expect(list).not.toHaveBeenCalled();
});
it("never settles a late HEAD response after the claim was replaced", async () => {
  const f = await fixture();
  await f.stop();
  const head = vi.fn(async () => {
    await env.DB.prepare("UPDATE image_derivative_cleanup SET claim_token=? WHERE image_id=?")
      .bind(crypto.randomUUID(), f.grant.id)
      .run();
    return null;
  });
  expect(await f.run({ ...cleanupEnv(), BLOBS: davBucket({ head }) })).toMatchObject({
    held: 1,
    settled: 0,
    r2Calls: 1,
  });
  expect(await f.row()).toMatchObject({ settled_at: null, head_calls: 1 });
  expect(await auditOwnerLedger(env.DB, f.ids.user)).toMatchObject({
    image_reserved_bytes: f.output.bytes.length,
  });
});
it("permits only one HEAD for concurrent cleanup of the same output", async () => {
  const f = await fixture();
  await f.stop();
  const head = vi.fn((key: string) => env.BLOBS.head(key)),
    app = { ...cleanupEnv(), BLOBS: davBucket({ head }) };
  await Promise.allSettled([f.run(app), f.run(app)]);
  expect(head).toHaveBeenCalledTimes(1);
  expect(await f.row()).toMatchObject({ disposition: "absent", head_calls: 1 });
});
it("blocks cleanup during restore freeze without releasing its reservation", async () => {
  const f = await fixture();
  await f.stop();
  await env.DB.prepare("UPDATE control SET restore_freeze_token=?").bind(crypto.randomUUID()).run();
  const head = vi.fn();
  await expect(f.run({ ...cleanupEnv(), BLOBS: davBucket({ head }) })).rejects.toThrow();
  expect(head).not.toHaveBeenCalled();
  expect(await auditOwnerLedger(env.DB, f.ids.user)).toMatchObject({
    image_reserved_bytes: f.output.bytes.length,
  });
  await env.DB.prepare("UPDATE control SET restore_freeze_token=NULL").run();
});
it("seals and settles through the actual ControlDO RPC and shared admission", async () => {
  const f = await fixture();
  await f.stop();
  await env.DB.prepare("UPDATE control SET maintenance=0,gc_paused=0").run();
  const mirror = (await env.DB.prepare(
    "SELECT admission_revision,admission_token,gc_paused,gc_operator_paused,gc_hold_token,gc_hold_operation,gc_hold_expires_at FROM control WHERE singleton=1",
  ).first<Record<string, string | number | null>>())!;
  await runInDurableObject(control(), (_, state) => {
    state.storage.sql.exec("UPDATE control_state SET phase='ready',epoch=2 WHERE singleton=1");
    state.storage.sql.exec(
      "UPDATE control_admission SET epoch=2,revision=?,token=?,phase='open',gc_paused=? WHERE singleton=1",
      mirror.admission_revision!,
      mirror.admission_token!,
      mirror.gc_paused!,
    );
    state.storage.sql.exec(
      "UPDATE control_gc_policy SET epoch=2,operator_paused=?,hold_token=?,hold_operation=?,hold_expires_at=?,prior_gc_paused=? WHERE singleton=1",
      mirror.gc_operator_paused!,
      mirror.gc_hold_token!,
      mirror.gc_hold_operation!,
      mirror.gc_hold_expires_at!,
      mirror.gc_paused!,
    );
  });
  expect(await maintainImageDerivatives(env, 2, { imageId: f.grant.id })).toMatchObject({
    settled: 1,
    r2Calls: 1,
  });
  expect(await f.row()).toMatchObject({ disposition: "absent" });
});
it("advances past a held generation and obeys the requested per-invocation bound", async () => {
  const a = await fixture(),
    b = await fixture();
  await a.stop();
  await b.due();
  const head = vi.fn(async (key: string) => {
    if (key === a.claim.key) throw new Error("unavailable");
    return env.BLOBS.head(key);
  });
  const app = { ...cleanupEnv(), BLOBS: davBucket({ head }) };
  expect(await maintainImageDerivatives(app, 2, { limit: 1 })).toMatchObject({ inspected: 1 });
  expect(await maintainImageDerivatives(app, 2, { limit: 1 })).toMatchObject({ inspected: 1 });
  expect(await a.row()).toMatchObject({ settled_at: null, head_calls: 1 });
  expect(await b.row()).toMatchObject({ disposition: "absent", head_calls: 1 });
});
