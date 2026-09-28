import { applyD1Migrations, evictDurableObject, runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { GC_GRACE_MS } from "../../src/db/gcGrace";
import { ControlDO } from "../../src/do/ControlDO";
import { prepareImageDerivative, storeImageDerivative } from "../../src/jobs/imageDerivative";
import { trackedR2Write } from "../../src/services/r2Write";
import { auditOwnerLedger } from "../../src/services/refs";
import { davBucket } from "../fixtures/davPut";
import { imageDerivativeFixture } from "../fixtures/imageDerivative";
import { restoredDatabaseFixture } from "../fixtures/restoredDatabase";
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
  await env.DB.prepare("UPDATE mutation_admissions SET state='closed' WHERE state='active'").run();
  // No Queue is dispatched by these fixtures. Remove their synthetic active notification state
  // before the next test's real restore preflight (which correctly refuses unfinished outbox work).
  await env.DB.prepare(
    "UPDATE outbox SET state='failed',dispatch_token=NULL,dispatch_expires_at=NULL,claim_token=NULL,claim_expires_at=NULL WHERE state IN ('pending','dispatching','sent')",
  ).run();
  // Each test adds its own generation. Retain earlier immutable evidence, outside the due page.
  await env.DB.prepare("UPDATE image_derivative_cleanup SET next_at=? WHERE settled_at IS NULL")
    .bind(Date.now() + 86400000)
    .run();
  restored = await restoredDatabaseFixture();
});
afterEach(() => vi.restoreAllMocks());

async function fixture() {
  const f = await imageDerivativeFixture();
  const claim = await prepareImageDerivative(f.app, f.grant.id, f.output);
  await env.DB.prepare(
    "UPDATE control SET bootstrap_done_at=1,bootstrap_iss='https://access.invalid',bootstrap_sub=?",
  )
    .bind(f.ids.user)
    .run();
  const row = () =>
    env.DB.prepare("SELECT * FROM image_derivative_cleanup WHERE image_id=?")
      .bind(f.grant.id)
      .first<Record<string, unknown>>();
  const due = () =>
    env.DB.prepare(
      "UPDATE image_derivative_cleanup SET next_at=0,claim_deadline=0 WHERE image_id=? AND settled_at IS NULL",
    )
      .bind(f.grant.id)
      .run();
  const adopt = async () => {
    await env.DB.prepare("UPDATE outbox SET claim_expires_at=0 WHERE outbox_id=?")
      .bind(f.grant.outboxId)
      .run();
    await restored.adopted();
    await due();
  };
  return { ...f, claim, cleanupRow: row, due, adopt };
}

it("releases a restored image reservation through real stopped admission, then passes the full audit", async () => {
  const f = await fixture();
  // The general namespace fixture includes a second ordinary file; give its audit real storage evidence.
  const key = `u/${f.ids.user}/b/${f.ids.blob}`;
  const object = (await env.BLOBS.put(key, "abc"))!;
  await env.DB.prepare(
    "INSERT INTO blob_storage(blob_id,bytes,r2_etag,observed_at) VALUES(?,3,?,?)",
  )
    .bind(f.ids.blob, object.etag, Date.now())
    .run();
  await f.adopt();
  expect((await restored.domain("reservations")).repair).toMatchObject({
    released: 0,
    pending: true,
  });
  expect(await auditOwnerLedger(env.DB, f.ids.user)).toMatchObject({
    image_reserved_bytes: f.output.bytes.length,
  });
  const head = vi.fn((key: string) => env.BLOBS.head(key)),
    put = vi.fn();
  expect((await restored.domain("images", 20, { BLOBS: davBucket({ head, put }) })).repair).toEqual(
    {
      kind: "images",
      pending: false,
      cleanup: { inspected: 1, retired: 1, settled: 1, held: 0, r2Calls: 1 },
    },
  );
  expect(head).toHaveBeenCalledExactlyOnceWith(f.claim.key);
  expect(put).not.toHaveBeenCalled();
  expect(await f.cleanupRow()).toMatchObject({ disposition: "absent" });
  expect(await auditOwnerLedger(env.DB, f.ids.user)).toMatchObject({
    image_reserved_bytes: 0,
    incorrect_refs: 0,
  });
  await restored.domain("outbox");
  let complete = false;
  for (let n = 0; n < 30; n++) {
    const result = await restored.control.auditDatabaseRestoreRecovery(
      restored.epoch,
      restored.id,
      20,
    );
    if (result.audit.completed) {
      complete = true;
      break;
    }
  }
  expect(complete).toBe(true);
  expect((await restored.control.recover()).maintenance).toBe(true);
  await evictDurableObject(restored.control);
  expect((await restored.domain("images")).repair).toMatchObject({
    pending: false,
    cleanup: { inspected: 0 },
  });
});

it("accounts a proven stored output and preserves its full GC grace without replaying the PUT", async () => {
  const f = await fixture();
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
  await f.adopt();
  const before = await auditOwnerLedger(env.DB, f.ids.user),
    at = Date.now(),
    put = vi.fn();
  expect((await restored.domain("images", 1, { BLOBS: davBucket({ put }) })).repair).toMatchObject({
    pending: false,
    cleanup: { inspected: 1, settled: 1, r2Calls: 1 },
  });
  expect(put).not.toHaveBeenCalled();
  expect(await auditOwnerLedger(env.DB, f.ids.user)).toMatchObject({
    image_reserved_bytes: 0,
    physical_bytes: before!.physical_bytes + f.output.bytes.length,
  });
  const gc = await env.DB.prepare("SELECT state,not_before FROM gc_candidates WHERE blob_id=?")
    .bind(f.claim.blobId)
    .first<{ state: string; not_before: number }>();
  expect(gc!.state).toBe("candidate");
  expect(gc!.not_before).toBeGreaterThanOrEqual(at + GC_GRACE_MS);
  expect(await env.BLOBS.head(f.claim.key)).not.toBeNull();
});

it("keeps a healthy published derivative across restore without reporting an image hold", async () => {
  const f = await fixture();
  await storeImageDerivative(f.app, f.grant.id, f.output);
  await f.adopt();
  const head = vi.fn();
  expect(
    (await restored.domain("images", 20, { BLOBS: davBucket({ head }) })).repair,
  ).toMatchObject({
    pending: false,
    cleanup: { settled: 0, retired: 0, r2Calls: 0 },
  });
  expect(head).not.toHaveBeenCalled();
  expect(await f.cleanupRow()).toMatchObject({ retired_at: null, settled_at: null });
  expect(await f.saved()).toMatchObject({ state: "ready" });
});

it("keeps delayed candidates pending and obeys a one-image operator limit", async () => {
  const a = await fixture(),
    b = await fixture();
  await a.adopt();
  await b.due();
  expect((await restored.domain("images", 1)).repair).toMatchObject({
    pending: true,
    cleanup: { inspected: 1, settled: 1 },
  });
  await env.DB.prepare("UPDATE image_derivative_cleanup SET next_at=? WHERE settled_at IS NULL")
    .bind(Date.now() + 60000)
    .run();
  expect((await restored.domain("images", 1)).repair).toMatchObject({
    pending: true,
    cleanup: { inspected: 0 },
  });
  await a.due();
  await b.due();
  expect((await restored.domain("images", 1)).repair).toMatchObject({
    pending: false,
    cleanup: { inspected: 1, settled: 1 },
  });
});

it("recovers a lost settlement acknowledgement and never releases or observes twice", async () => {
  const f = await fixture();
  await f.adopt();
  const db = injectBatch(
    (sql) => sql.includes("SET disposition=?"),
    async () => {
      throw new Error("ACK lost");
    },
    true,
  );
  const head = vi.fn((key: string) => env.BLOBS.head(key));
  expect(
    (await restored.domain("images", 1, { DB: db, BLOBS: davBucket({ head }) })).repair,
  ).toMatchObject({
    pending: false,
    cleanup: { settled: 1, r2Calls: 1 },
  });
  expect((await restored.domain("images")).repair).toMatchObject({ cleanup: { inspected: 0 } });
  expect(head).toHaveBeenCalledTimes(1);
  expect(await auditOwnerLedger(env.DB, f.ids.user)).toMatchObject({
    image_reserved_bytes: 0,
    incorrect_refs: 0,
  });
});

it("caps the default twenty-item operator request at eight image candidates", async () => {
  const images = [];
  for (let n = 0; n < 9; n++) images.push(await fixture());
  await images[0]!.adopt();
  for (const f of images) await f.due();
  let settled = 0,
    completed = false;
  for (let n = 0; n < 9; n++) {
    const { repair } = await restored.domain("images");
    if (!("cleanup" in repair) || !("inspected" in repair.cleanup))
      throw new Error("fixture_result");
    expect(repair.cleanup.inspected).toBeLessThanOrEqual(8);
    expect(repair.cleanup.held).toBe(0);
    settled += repair.cleanup.settled;
    if (n === 0) expect(repair.pending).toBe(true);
    if (!repair.pending) {
      completed = true;
      break;
    }
  }
  expect(completed).toBe(true);
  expect(settled).toBe(9);
});

it.each(["before_head", "after_head"])(
  "retains capacity if the restore stop changes %s",
  async (when) => {
    const f = await fixture();
    await f.adopt();
    await runInDurableObject(restored.control, async (_, state) => {
      let instance: ControlDO;
      const head = vi.fn(async (key: string) => {
        const object = await env.BLOBS.head(key);
        await instance.quiesce(restored.epoch + 1);
        return object;
      });
      instance = new ControlDO(state, {
        ...env,
        BLOBS: davBucket({ head }),
        RESTORE_WRITE_ENABLED: "true",
      });
      if (when === "before_head") {
        const seal = instance.sealImageDerivative.bind(instance);
        instance.sealImageDerivative = async (epoch, id) => {
          const result = await seal(epoch, id);
          await instance.quiesce(epoch);
          return result;
        };
      }
      await expect(
        instance.repairDatabaseRestoreDomain(restored.epoch, restored.id, "images"),
      ).rejects.toThrow(/recovery_conflict/);
      expect(head).toHaveBeenCalledTimes(when === "after_head" ? 1 : 0);
    });
    expect(await f.cleanupRow()).toMatchObject({ settled_at: null });
    expect(await auditOwnerLedger(env.DB, f.ids.user)).toMatchObject({
      image_reserved_bytes: f.output.bytes.length,
    });
    await f.due();
    expect((await restored.domain("images")).repair).toMatchObject({ cleanup: { settled: 1 } });
  },
);

it("fences the settlement batch against a changed D1 stop revision", async () => {
  const f = await fixture();
  await f.adopt();
  let stop: { admission_revision: number; admission_token: string } | null = null;
  const db = injectBatch(
    (sql) => sql.includes("SET disposition=?"),
    async () => {
      stop = await env.DB.prepare("SELECT admission_revision,admission_token FROM control").first();
      await env.DB.prepare(
        "UPDATE control SET admission_revision=admission_revision+1,admission_token=?",
      )
        .bind(crypto.randomUUID())
        .run();
    },
    false,
  );
  await expect(restored.domain("images", 1, { DB: db })).rejects.toThrow(
    /recovery_conflict|mirror_conflict/,
  );
  expect(await f.cleanupRow()).toMatchObject({ settled_at: null, head_calls: 1 });
  expect(await auditOwnerLedger(env.DB, f.ids.user)).toMatchObject({
    image_reserved_bytes: f.output.bytes.length,
  });
  // Undo only this test's synthetic mirror corruption before checking a new request.
  expect(stop).not.toBeNull();
  await env.DB.prepare("UPDATE control SET admission_revision=?,admission_token=?")
    .bind(stop!.admission_revision, stop!.admission_token)
    .run();
  await f.due();
  expect((await restored.domain("images")).repair).toMatchObject({ cleanup: { settled: 1 } });
});

it("keeps an image pending when the independent Images history is missing", async () => {
  const f = await fixture();
  await f.adopt();
  // Simulate loss of only this historical DO row, preserving the active restore protocol and guards.
  await runInDurableObject(restored.control, (_, state) => {
    const sql = state.storage.sql;
    const trigger = sql
      .exec<{ sql: string }>("SELECT sql FROM sqlite_master WHERE name='control_image_keep'")
      .toArray()[0]!.sql;
    state.storage.transactionSync(() => {
      sql.exec("DROP TRIGGER control_image_keep");
      sql.exec("DELETE FROM control_image_transforms WHERE id=?", f.grant.id);
      sql.exec(trigger);
    });
  });
  const head = vi.fn();
  expect((await restored.domain("images", 1, { BLOBS: davBucket({ head }) })).repair).toMatchObject(
    {
      pending: true,
      cleanup: { inspected: 1, held: 1, settled: 0, r2Calls: 0 },
    },
  );
  expect(head).not.toHaveBeenCalled();
  expect(await auditOwnerLedger(env.DB, f.ids.user)).toMatchObject({
    image_reserved_bytes: f.output.bytes.length,
  });
});
