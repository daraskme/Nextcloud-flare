import { applyD1Migrations, evictDurableObject, runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { RESTORE_DOMAIN_KINDS } from "../../../shared/src/restoreDomain";
import { atomicBatch } from "../../src/db/primary";
import { insertR2Write, type R2WriteGrant } from "../../src/db/r2Write";
import { ControlDO } from "../../src/do/ControlDO";
import { KdfSettlements } from "../../src/do/kdfSettlements";
import { foundationFixture } from "../fixtures/foundation";
import { rollbackNativeReceipt } from "../fixtures/nativeRollback";
import { recoveryRepairFixture } from "../fixtures/recoveryRepair";
import { restoredDatabaseFixture } from "../fixtures/restoredDatabase";
import { multipartCleanupFixture, singleCleanupFixture } from "../fixtures/uploadCleanup";
import { injectBatch } from "../fixtures/uploadEnv";

let restored: Awaited<ReturnType<typeof restoredDatabaseFixture>>;
beforeAll(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
  await env.BACKUPS.put(
    "sys/epoch/1.json",
    JSON.stringify({ epoch: 1, at: 1, reason: "operator" }),
  );
});
beforeEach(async () => {
  await env.DB.prepare("UPDATE control SET restore_freeze_token=NULL").run();
  // D1 persists per file. Remove only this file's completed/synthetic domain fixtures.
  await atomicBatch(env.DB, [
    { sql: "DELETE FROM upload_parts" },
    { sql: "DELETE FROM gc_candidates" },
    { sql: "DELETE FROM uploads" },
    { sql: "UPDATE reservations SET state='released' WHERE state='reserved'" },
    { sql: "DELETE FROM reservations" },
    { sql: "DELETE FROM outbox" },
    { sql: "DELETE FROM operation_steps" },
    { sql: "DELETE FROM operations" },
    { sql: "DELETE FROM permits" },
  ]);
  restored = await restoredDatabaseFixture();
});
afterEach(() => vi.restoreAllMocks());
const bootstrap = async (user: string) =>
  env.DB.prepare(
    "UPDATE control SET bootstrap_done_at=1,bootstrap_iss='https://access.invalid',bootstrap_sub=?",
  )
    .bind(user)
    .run();
const counters = (user: string) =>
  env.DB.prepare("SELECT reserved_bytes,physical_bytes FROM users WHERE id=?").bind(user).first();
const due = (id: string) =>
  env.DB.prepare("UPDATE uploads SET cleanup_next_at=0,cleanup_lease_expires_at=0 WHERE id=?")
    .bind(id)
    .run();
const upload = (id: string) => env.DB.prepare("SELECT * FROM uploads WHERE id=?").bind(id).first();
const blobBucket = (overrides: Partial<R2Bucket> = {}) =>
  ({
    head: env.BLOBS.head.bind(env.BLOBS),
    resumeMultipartUpload: env.BLOBS.resumeMultipartUpload.bind(env.BLOBS),
    ...overrides,
  }) as R2Bucket;
const abortHandle = (
  key: string,
  uploadId: string,
  abort: () => Promise<void>,
): R2MultipartUpload => {
  const handle = env.BLOBS.resumeMultipartUpload(key, uploadId);
  return {
    key,
    uploadId,
    abort,
    uploadPart: handle.uploadPart.bind(handle),
    complete: handle.complete.bind(handle),
  };
};

it.each(RESTORE_DOMAIN_KINDS)(
  "runs an empty %s pass but invalidates a complete recovery audit",
  async (kind) => {
    await restored.adopted();
    for (let n = 0; n < 30; n++)
      if (
        (await restored.control.auditDatabaseRestoreRecovery(restored.epoch, restored.id, 20)).audit
          .completed
      )
        break;
    expect((await restored.domain(kind)).repair).toMatchObject({ kind, pending: false });
    await runInDurableObject(restored.control, async (_, state) => {
      const instance = new ControlDO(state, { ...env, RESTORE_WRITE_ENABLED: "true" });
      await expect(
        instance.releaseDatabaseRestoreRecovery(restored.epoch, restored.id),
      ).rejects.toThrow(/audit_incomplete/);
    });
    expect((await restored.control.recover()).maintenance).toBe(true);
  },
);

it("requires adoption, write enablement, the same request and a bounded supported kind", async () => {
  await expect(restored.domain("single")).rejects.toThrow(/recovery_unavailable/);
  await restored.adopted();
  await runInDurableObject(restored.control, async (instance, state) => {
    await expect(
      instance.repairDatabaseRestoreDomain(restored.epoch, restored.id, "single"),
    ).rejects.toThrow(/write_disabled/);
    const enabled = new ControlDO(state, { ...env, RESTORE_WRITE_ENABLED: "true" });
    await expect(
      enabled.repairDatabaseRestoreDomain(restored.epoch, crypto.randomUUID(), "single"),
    ).rejects.toThrow();
    await expect(
      enabled.repairDatabaseRestoreDomain(restored.epoch, restored.id, "unknown" as never),
    ).rejects.toThrow(/invalid_repair_kind/);
    await expect(
      enabled.repairDatabaseRestoreDomain(restored.epoch, restored.id, "single", 21),
    ).rejects.toThrow(/invalid_recovery_limit/);
  });
  for (let n = 0; n < 30; n++)
    if (
      (await restored.control.auditDatabaseRestoreRecovery(restored.epoch, restored.id, 20)).audit
        .completed
    )
      break;
  await runInDurableObject(restored.control, async (_, state) => {
    const enabled = new ControlDO(state, { ...env, RESTORE_WRITE_ENABLED: "true" });
    await enabled.releaseDatabaseRestoreRecovery(restored.epoch, restored.id);
    await expect(
      enabled.repairDatabaseRestoreDomain(restored.epoch, restored.id, "single"),
    ).rejects.toThrow(/recovery_released/);
  });
});

it.each(["absent", "present", "unexpired"])(
  "repairs a restored single upload while preserving its storage and expiry fences: %s",
  async (mode) => {
    const f = await singleCleanupFixture("receiving", mode !== "unexpired");
    await bootstrap(f.ids.user);
    if (mode === "present") await env.BLOBS.put(f.key, "abc", { customMetadata: f.metadata });
    await restored.adopted();
    const head = vi.fn(env.BLOBS.head.bind(env.BLOBS));
    expect(
      (await restored.domain("single", 20, { BLOBS: blobBucket({ head }) })).repair,
    ).toMatchObject({
      pending: mode !== "absent",
      cleanup: {
        claimed: mode === "unexpired" ? 0 : 1,
        absent: mode === "absent" ? 1 : 0,
        queued: mode === "present" ? 1 : 0,
      },
    });
    expect(head).toHaveBeenCalledTimes(mode === "unexpired" ? 0 : 1);
    expect(await counters(f.ids.user)).toMatchObject({
      reserved_bytes: mode === "unexpired" ? 3 : 0,
    });
    if (mode === "present") {
      expect(await env.BLOBS.head(f.key)).not.toBeNull();
      expect(
        await env.DB.prepare("SELECT state FROM gc_candidates WHERE blob_id=?")
          .bind(f.blob)
          .first("state"),
      ).toBe("candidate");
    }
  },
);

it("releases only stale unattached reservations while retaining upload capacity", async () => {
  const f = await singleCleanupFixture("failed"),
    standalone = crypto.randomUUID();
  await bootstrap(f.ids.user);
  await env.DB.prepare(
    "INSERT INTO reservations(id,owner_id,bytes,state,expires_at,epoch) VALUES(?,?,7,'reserved',?,1)",
  )
    .bind(standalone, f.ids.user, Date.now() + 60000)
    .run();
  await restored.adopted();
  expect((await restored.domain("reservations")).repair).toEqual({
    kind: "reservations",
    released: 1,
    pending: true,
  });
  expect(await counters(f.ids.user)).toMatchObject({ reserved_bytes: 3 });
});

it.each([false, true])(
  "retires only a supported old outbox event, preserving other work: %s",
  async (unsupported) => {
    const actor = foundationFixture(crypto.randomUUID(), Date.now() - 1000);
    await atomicBatch(env.DB, actor.statements);
    await bootstrap(actor.ids.user);
    const f = await recoveryRepairFixture("outbox-fail", actor);
    if (unsupported)
      await env.DB.prepare(
        "INSERT INTO outbox(outbox_id,op_id,kind,payload_ref,state,epoch,created_at,updated_at) VALUES(?,?,'fixture.unsupported',?,'pending',1,1,1)",
      )
        .bind(crypto.randomUUID(), f.opId, f.ids.folder)
        .run();
    await restored.adopted();
    expect((await restored.domain("outbox")).repair).toEqual({
      kind: "outbox",
      failed: 1,
      pending: unsupported,
    });
    expect(await f.read()).toBe("failed");
    expect(
      await env.DB.prepare(
        "SELECT state FROM operations WHERE op_id=(SELECT op_id FROM outbox WHERE outbox_id=?)",
      )
        .bind(f.id)
        .first("state"),
    ).toBe("committed");
  },
);

it.each(["normal", "ack", "rollback", "changed_deadline"])(
  "repairs an actual abort whose closure write failed without aborting again: %s",
  async (mode) => {
    const f = await multipartCleanupFixture();
    await bootstrap(f.ids.user);
    await f.multipart!.uploadPart(1, new TextEncoder().encode("abc"));
    await restored.adopted();
    const abort = vi.fn(() => f.multipart!.abort());
    const bucket = blobBucket({
      resumeMultipartUpload: (key, uploadId) => abortHandle(key, uploadId, abort),
    });
    const db = injectBatch(
      (sql) => sql.startsWith("UPDATE uploads SET multipart_cleanup_closed='aborted'"),
      async () => {
        throw new Error("closure_write_failed");
      },
      false,
    );
    expect(
      (await restored.domain("multipart", 20, { DB: db, BLOBS: bucket })).repair,
    ).toMatchObject({
      pending: true,
      cleanup: { claimed: 1, retried: 1, r2Calls: 1 },
    });
    expect(await upload(f.id)).toMatchObject({
      multipart_cleanup_closed: null,
      cleanup_pending: 1,
    });
    expect(await counters(f.ids.user)).toMatchObject({ reserved_bytes: 3 });
    await due(f.id);
    await evictDurableObject(restored.control);
    if (mode === "changed_deadline") {
      const receipt = await env.DB.prepare(
        "SELECT id,dispatch_before FROM r2_write_attempts WHERE r2_key=? AND kind='multipart.abort'",
      )
        .bind(f.key)
        .first<{ id: string; dispatch_before: number }>();
      await rollbackNativeReceipt(env.DB, "r2_write_attempts", receipt!.id, {
        dispatch_before: receipt!.dispatch_before - 1,
      });
      await env.DB.prepare(
        "UPDATE r2_write_attempts SET state='succeeded',finished_at=MAX(started_at,strftime('%s','now')*1000) WHERE id=?",
      )
        .bind(receipt!.id)
        .run();
      expect((await restored.domain("multipart", 20, { BLOBS: bucket })).repair).toMatchObject({
        held: 1,
        pending: true,
        cleanup: { r2Calls: 0 },
      });
      expect(await counters(f.ids.user)).toMatchObject({ reserved_bytes: 3 });
      expect(abort).toHaveBeenCalledTimes(1);
      return;
    }
    const retryDb = ["ack", "rollback"].includes(mode)
      ? injectBatch(
          (sql) => sql.startsWith("UPDATE uploads SET multipart_cleanup_closed='aborted'"),
          async () => {
            throw new Error("closure_repair_lost");
          },
          mode === "ack",
        )
      : env.DB;
    if (mode === "rollback") {
      await expect(
        restored.domain("multipart", 20, { DB: retryDb, BLOBS: bucket }),
      ).rejects.toThrow(/close_unconfirmed/);
      expect(await counters(f.ids.user)).toMatchObject({ reserved_bytes: 3 });
    }
    expect(
      (
        await restored.domain("multipart", 20, {
          DB: mode === "ack" ? retryDb : env.DB,
          BLOBS: bucket,
        })
      ).repair,
    ).toMatchObject({
      pending: false,
      held: 0,
      cleanup: { absent: 1, retried: 0, r2Calls: 1 },
    });
    expect(abort).toHaveBeenCalledTimes(1);
    expect(await counters(f.ids.user)).toMatchObject({ reserved_bytes: 0 });
  },
);

async function stoppedMultipart(f: Awaited<ReturnType<typeof multipartCleanupFixture>>) {
  const token = crypto.randomUUID();
  await atomicBatch(env.DB, [
    {
      sql: "UPDATE uploads SET state='failed',accept_parts=0,in_flight=0,cleanup_pending=1,multipart_cleanup_started_at=strftime('%s','now')*1000,cleanup_token=?,cleanup_lease_expires_at=0,cleanup_next_at=0 WHERE id=?",
      values: [token, f.id],
    },
    { sql: "UPDATE blobs SET state='orphan' WHERE id=?", values: [f.blob] },
  ]);
  return token;
}
it("starts a new abort only after the old exact grant is proved not dispatched", async () => {
  const f = await multipartCleanupFixture();
  await bootstrap(f.ids.user);
  const token = await stoppedMultipart(f);
  await restored.adopted();
  await env.DB.prepare(
    "UPDATE uploads SET cleanup_lease_expires_at=strftime('%s','now')*1000+60000 WHERE id=?",
  )
    .bind(f.id)
    .run();
  const grant = await restored.control.beginR2Write({
    id: crypto.randomUUID(),
    epoch: restored.epoch + 1,
    ownerId: f.ids.user,
    kind: "multipart.abort",
    key: f.key,
    deadline: Date.now() + 5000,
    abort: {
      source: "cleanup",
      uploadId: f.id,
      sourceEpoch: 1,
      r2UploadId: f.multipart!.uploadId,
      attemptId: token,
      maintenance: true,
    },
  });
  await restored.control.finishR2Write(grant, "not_started");
  await due(f.id);
  expect((await restored.domain("multipart")).repair).toMatchObject({
    pending: false,
    held: 0,
    cleanup: { absent: 1, r2Calls: 2 },
  });
  expect(
    await env.DB.prepare("SELECT state FROM r2_write_attempts WHERE id=?")
      .bind(grant.id)
      .first("state"),
  ).toBe("not_started");
});

it.each(["before_dispatch", "after_native"])(
  "stops stale repair work but records exact non-dispatch or late native success: %s",
  async (when) => {
    const f = await multipartCleanupFixture();
    await bootstrap(f.ids.user);
    await restored.adopted();
    await runInDurableObject(restored.control, async (_, state) => {
      let instance: ControlDO;
      const abort = vi.fn(async () => {
        await f.multipart!.abort();
        if (when === "after_native") await instance.quiesce(restored.epoch + 1);
      });
      const bucket = blobBucket({
        resumeMultipartUpload: (key, uploadId) => abortHandle(key, uploadId, abort),
      });
      instance = new ControlDO(state, { ...env, BLOBS: bucket, RESTORE_WRITE_ENABLED: "true" });
      if (when === "before_dispatch") {
        const begin = instance.beginR2Write.bind(instance);
        instance.beginR2Write = async (input) => {
          const grant = await begin(input);
          await instance.quiesce(restored.epoch + 1);
          return grant;
        };
      }
      await expect(
        instance.repairDatabaseRestoreDomain(restored.epoch, restored.id, "multipart"),
      ).rejects.toThrow(/recovery_conflict/);
      expect(abort).toHaveBeenCalledTimes(when === "after_native" ? 1 : 0);
      expect(
        state.storage.sql.exec("SELECT 1 FROM control_r2_write_receipts").toArray(),
      ).toHaveLength(0);
    });
    expect(
      await env.DB.prepare(
        "SELECT state FROM r2_write_attempts WHERE r2_key=? AND kind='multipart.abort'",
      )
        .bind(f.key)
        .first("state"),
    ).toBe(when === "after_native" ? "succeeded" : "not_started");
    expect(await counters(f.ids.user)).toMatchObject({ reserved_bytes: 3 });
    await due(f.id);
    expect((await restored.domain("multipart")).repair).toMatchObject({
      pending: false,
      cleanup: { absent: 1, r2Calls: when === "after_native" ? 1 : 2 },
    });
  },
);
it("holds a DB-only abort assertion, preserves its old token, and advances to another upload", async () => {
  const held = await multipartCleanupFixture(),
    next = await multipartCleanupFixture();
  await bootstrap(held.ids.user);
  const token = await stoppedMultipart(held);
  await env.DB.prepare("UPDATE uploads SET cleanup_next_at=1 WHERE id=?").bind(next.id).run();
  await restored.adopted();
  const grant: R2WriteGrant = {
    id: crypto.randomUUID(),
    token: crypto.randomUUID(),
    epoch: restored.epoch + 1,
    ownerId: held.ids.user,
    kind: "multipart.abort",
    key: held.key,
    startedAt: Date.now(),
    deadline: Date.now() + 5000,
    abort: {
      source: "cleanup",
      uploadId: held.id,
      sourceEpoch: 1,
      r2UploadId: held.multipart!.uploadId,
      attemptId: token,
      maintenance: true,
    },
  };
  // D1 alone is deliberately not a native proof; no abort was sent for this assertion.
  await atomicBatch(env.DB, [insertR2Write(grant, "succeeded")]);
  expect((await restored.domain("multipart", 1)).repair).toMatchObject({
    held: 1,
    pending: true,
    cleanup: { claimed: 0, r2Calls: 0 },
  });
  expect(await upload(held.id)).toMatchObject({
    cleanup_token: token,
    multipart_cleanup_closed: null,
  });
  expect((await restored.domain("multipart", 1)).repair).toMatchObject({
    held: 0,
    pending: true,
    cleanup: { absent: 1 },
  });
  expect(await counters(held.ids.user)).toMatchObject({ reserved_bytes: 3 });
  expect(await counters(next.ids.user)).toMatchObject({ reserved_bytes: 0 });
  await held.multipart!.abort();
});

it("keeps an unidentified multipart handle and its reservation pending after an absent HEAD", async () => {
  const f = await multipartCleanupFixture({ known: false });
  await bootstrap(f.ids.user);
  await restored.adopted();
  expect((await restored.domain("multipart")).repair).toMatchObject({
    pending: true,
    cleanup: { retried: 1, r2Calls: 1 },
  });
  await due(f.id);
  expect((await restored.domain("multipart")).repair).toMatchObject({
    pending: true,
    held: 1,
    cleanup: { claimed: 0, r2Calls: 0 },
  });
  expect(await counters(f.ids.user)).toMatchObject({ reserved_bytes: 3 });
});

it.each(["d1", "kdf", "r2"])(
  "refuses domain repair before native holds are resolved: %s",
  async (where) => {
    await restored.adopted();
    const grant: R2WriteGrant = {
      id: crypto.randomUUID(),
      token: crypto.randomUUID(),
      epoch: restored.epoch + 1,
      ownerId: "fixture",
      kind: "manifest.delete",
      key: `target-sets/${crypto.randomUUID()}`,
      startedAt: Date.now(),
      deadline: Date.now() + 5000,
    };
    if (where === "d1") await atomicBatch(env.DB, [insertR2Write(grant, "pending")]);
    else
      await runInDurableObject(restored.control, async (_, state) => {
        if (where === "kdf")
          new KdfSettlements(state.storage.sql, env.DB).reserve({
            id: grant.id,
            token: grant.token,
            epoch: 1,
            deadline: 1,
          });
        else
          state.storage.sql.exec(
            "INSERT INTO control_r2_write_receipts VALUES(?,?,?,'pending')",
            grant.id,
            grant.token,
            JSON.stringify(grant),
          );
      });
    try {
      await expect(restored.domain("single")).rejects.toThrow(/preflight_pending|unsettled/);
    } finally {
      // Synthetic dispatch row only; this fixture did not send native I/O.
      if (where === "d1")
        await env.DB.prepare(
          "UPDATE r2_write_attempts SET state='not_started',finished_at=MAX(started_at,strftime('%s','now')*1000) WHERE id=?",
        )
          .bind(grant.id)
          .run();
    }
  },
);
