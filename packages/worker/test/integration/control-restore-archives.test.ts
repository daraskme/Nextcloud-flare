import { applyD1Migrations, evictDurableObject, runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { GC_GRACE_MS } from "../../src/db/gcGrace";
import { ControlDO } from "../../src/do/ControlDO";
import { prepareArchiveDerivative, storeArchiveDerivative } from "../../src/jobs/archiveDerivative";
import { trackedR2Write } from "../../src/services/r2Write";
import { auditOwnerLedger } from "../../src/services/refs";
import { archiveStorageFixture } from "../fixtures/archiveDerivative";
import { davBucket } from "../fixtures/davPut";
import { restoredDatabaseFixture } from "../fixtures/restoredDatabase";

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
  await env.DB.prepare("UPDATE archive_derivative_cleanup SET next_at=? WHERE settled_at IS NULL")
    .bind(Date.now() + 86400000)
    .run();
  restored = await restoredDatabaseFixture();
});
afterEach(() => vi.restoreAllMocks());

async function fixture() {
  const f = await archiveStorageFixture();
  const claim = await prepareArchiveDerivative(f.app, f.grant, f.output!);
  await env.DB.prepare(
    "UPDATE control SET bootstrap_done_at=1,bootstrap_iss='https://access.invalid',bootstrap_sub=?",
  )
    .bind(f.ids.user)
    .run();
  const row = () =>
    env.DB.prepare("SELECT * FROM archive_derivative_cleanup WHERE archive_id=?")
      .bind(f.grant.id)
      .first<Record<string, unknown>>();
  const due = () =>
    env.DB.prepare(
      "UPDATE archive_derivative_cleanup SET next_at=0,claim_deadline=0 WHERE archive_id=? AND settled_at IS NULL",
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

it("releases a restored archive reservation through real stopped admission, then passes the full audit", async () => {
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
    image_reserved_bytes: f.output!.bytes.length,
  });
  const head = vi.fn((key: string) => env.BLOBS.head(key)),
    put = vi.fn();
  expect(
    (await restored.domain("archives", 20, { BLOBS: davBucket({ head, put }) })).repair,
  ).toEqual({
    kind: "archives",
    pending: false,
    cleanup: { inspected: 1, retired: 1, settled: 1, held: 0, r2Calls: 1 },
  });
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
  expect((await restored.domain("archives")).repair).toMatchObject({
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
      kind: "archive.put",
      key: f.claim.key,
      archive: {
        archiveId: f.grant.id,
        attemptId: f.claim.attemptId,
        claimToken: f.grant.claimToken,
        expiresAt: f.grant.expiresAt,
      },
    },
    () => env.BLOBS.put(f.claim.key, f.output!.bytes, { sha256: f.output!.sha256 }),
    f.grant.expiresAt,
  );
  await f.adopt();
  const before = await auditOwnerLedger(env.DB, f.ids.user),
    at = Date.now(),
    put = vi.fn();
  expect(
    (await restored.domain("archives", 1, { BLOBS: davBucket({ put }) })).repair,
  ).toMatchObject({
    pending: false,
    cleanup: { inspected: 1, settled: 1, r2Calls: 1 },
  });
  expect(put).not.toHaveBeenCalled();
  expect(await auditOwnerLedger(env.DB, f.ids.user)).toMatchObject({
    image_reserved_bytes: 0,
    physical_bytes: before!.physical_bytes + f.output!.bytes.length,
  });
  const gc = await env.DB.prepare("SELECT state,not_before FROM gc_candidates WHERE blob_id=?")
    .bind(f.claim.blobId)
    .first<{ state: string; not_before: number }>();
  expect(gc!.state).toBe("candidate");
  expect(gc!.not_before).toBeGreaterThanOrEqual(at + GC_GRACE_MS);
  expect(await env.BLOBS.head(f.claim.key)).not.toBeNull();
});

it("keeps a healthy published derivative across restore without reporting an archive hold", async () => {
  const f = await fixture();
  await storeArchiveDerivative(f.app, f.claim, f.output!);
  await f.adopt();
  const head = vi.fn();
  expect(
    (await restored.domain("archives", 20, { BLOBS: davBucket({ head }) })).repair,
  ).toMatchObject({
    pending: false,
    cleanup: { settled: 0, retired: 0, r2Calls: 0 },
  });
  expect(head).not.toHaveBeenCalled();
  expect(await f.cleanupRow()).toMatchObject({ retired_at: null, settled_at: null });
  expect(
    await env.DB.prepare("SELECT state FROM derivative_results WHERE id=?")
      .bind(f.claim.blobId)
      .first(),
  ).toMatchObject({ state: "ready" });
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
        const seal = instance.sealArchiveDerivative.bind(instance);
        instance.sealArchiveDerivative = async (epoch, id) => {
          const result = await seal(epoch, id);
          await instance.quiesce(epoch);
          return result;
        };
      }
      await expect(
        instance.repairDatabaseRestoreDomain(restored.epoch, restored.id, "archives"),
      ).rejects.toThrow(/recovery_conflict/);
      expect(head).toHaveBeenCalledTimes(when === "after_head" ? 1 : 0);
    });
    expect(await f.cleanupRow()).toMatchObject({ settled_at: null });
    expect(await auditOwnerLedger(env.DB, f.ids.user)).toMatchObject({
      image_reserved_bytes: f.output!.bytes.length,
    });
    await f.due();
    expect((await restored.domain("archives")).repair).toMatchObject({ cleanup: { settled: 1 } });
  },
);
