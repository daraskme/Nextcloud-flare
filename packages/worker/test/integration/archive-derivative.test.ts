import { applyD1Migrations, evictDurableObject, runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { archiveOriginalFromGrant } from "../../src/db/archiveDerivative";
import { GC_GRACE_MS } from "../../src/db/gcGrace";
import { CONTROL_NAME } from "../../src/do/controlName";
import {
  archiveClaimFromRow,
  prepareArchiveDerivative,
  publishArchiveDerivative,
  storeArchiveDerivative,
} from "../../src/jobs/archiveDerivative";
import { maintainArchiveDerivatives } from "../../src/jobs/archiveDerivativeCleanup";
import { runGarbageCollection } from "../../src/jobs/gc";
import { decodeArchiveIndex } from "../../src/media/archive/codec";
import { auditOwnerLedger } from "../../src/services/refs";
import { archiveStorageFixture } from "../fixtures/archiveDerivative";
import { davBucket } from "../fixtures/davPut";
import { expireGcGrace } from "../fixtures/gc";
import { clearEndedR2TestWrites, mutationEnv, r2WriteFixture } from "../fixtures/mutationAdmission";
import { injectBatch } from "../fixtures/uploadEnv";

const control = () => env.CONTROL.get(env.CONTROL.idFromName(CONTROL_NAME));
beforeAll(() => applyD1Migrations(env.DB, env.TEST_MIGRATIONS));
beforeEach(async () => {
  await env.DB.prepare(
    "UPDATE control SET backup_token=NULL,backup_frozen=0,restore_freeze_token=NULL",
  ).run();
  await clearEndedR2TestWrites();
  await env.DB.prepare("UPDATE control SET epoch=1,maintenance=0,gc_paused=0").run();
  await env.DB.prepare("UPDATE mutation_admissions SET state='closed' WHERE state='active'").run();
  await env.DB.prepare("UPDATE archive_derivative_cleanup SET next_at=? WHERE settled_at IS NULL")
    .bind(Date.now() + 86400000)
    .run();
  await runInDurableObject(control(), (_, state) => state.storage.deleteAll());
  await evictDurableObject(control());
});
afterEach(() => vi.restoreAllMocks());

it("stores one immutable index, charges physical bytes and reuses a published receipt", async () => {
  const f = await archiveStorageFixture(),
    before = await auditOwnerLedger(env.DB, f.ids.user);
  const c = await prepareArchiveDerivative(f.app, f.grant, f.output!);
  const saved = await storeArchiveDerivative(f.app, c, f.output!);
  const object = await env.BLOBS.get(saved.key);
  const index = await decodeArchiveIndex(
    new Uint8Array(await object!.arrayBuffer()),
    archiveOriginalFromGrant(f.grant),
    saved.sha256,
  );
  expect(index.entries).toHaveLength(1);
  expect(await f.row()).toMatchObject({ state: "published" });
  expect(await auditOwnerLedger(env.DB, f.ids.user)).toMatchObject({
    used_bytes: before!.used_bytes,
    reserved_bytes: 0,
    image_reserved_bytes: 0,
    physical_bytes: before!.physical_bytes + f.output!.bytes.length,
    incorrect_refs: 0,
  });
  const put = vi.fn(),
    current = archiveClaimFromRow((await f.row())!);
  expect(
    await storeArchiveDerivative({ ...f.app, BLOBS: davBucket({ put }) }, current, f.output!),
  ).toEqual(saved);
  expect(put).not.toHaveBeenCalled();
  expect(
    await env.DB.prepare(
      "SELECT COUNT(*) n FROM r2_write_attempts WHERE kind='archive.put' AND r2_key=?",
    )
      .bind(saved.key)
      .first<number>("n"),
  ).toBe(1);
  await expect(
    env.DB.prepare("DELETE FROM r2_write_attempts WHERE r2_key=?").bind(saved.key).run(),
  ).rejects.toThrow("archive_native_receipt_held");
});

it("rejects modified index bytes before allocation or PUT", async () => {
  const f = await archiveStorageFixture(),
    bytes = f.output!.bytes.slice();
  bytes[20] = bytes[20]! ^ 1;
  await expect(prepareArchiveDerivative(f.app, f.grant, { ...f.output!, bytes })).rejects.toThrow(
    "checksum_mismatch",
  );
  expect(await f.row()).toBeNull();
});

it("checks physical quota before native storage", async () => {
  const f = await archiveStorageFixture();
  await env.DB.prepare("UPDATE users SET quota_bytes=used_bytes WHERE id=?").bind(f.ids.user).run();
  await expect(prepareArchiveDerivative(f.app, f.grant, f.output!)).rejects.toThrow();
  expect(await f.row()).toBeNull();
});

it.each(["credential", "parent", "claim", "epoch", "hidden"])(
  "refuses publication after %s changes while retaining actual stored bytes",
  async (change) => {
    const f = await archiveStorageFixture(),
      c = await prepareArchiveDerivative(f.app, f.grant, f.output!);
    const bucket = davBucket({
      put: async (key, bytes, options) => {
        const object = await env.BLOBS.put(key, bytes, options);
        if (change === "credential")
          await env.DB.prepare("UPDATE app_passwords SET revoked_at=? WHERE user_id=?")
            .bind(Date.now(), f.ids.user)
            .run();
        if (change === "parent")
          await env.DB.prepare("UPDATE nodes SET parent_id=? WHERE id=?")
            .bind(f.ids.root, f.node.id)
            .run();
        if (change === "claim")
          await env.DB.prepare("UPDATE outbox SET claim_token=? WHERE outbox_id=?")
            .bind(crypto.randomUUID(), f.outboxId)
            .run();
        if (change === "epoch")
          await env.DB.prepare("UPDATE control SET epoch=2,maintenance=1,gc_paused=1").run();
        if (change === "hidden")
          await env.DB.prepare("UPDATE nodes SET hidden=1 WHERE id=?").bind(f.ids.folder).run();
        return object;
      },
    });
    await expect(
      storeArchiveDerivative({ ...f.app, BLOBS: bucket }, c, f.output!),
    ).rejects.toThrow();
    expect(await f.row()).toMatchObject({ state: "stored" });
    expect(
      await env.DB.prepare("SELECT state FROM derivative_results WHERE id=?")
        .bind(c.blobId)
        .first(),
    ).toEqual({ state: "running" });
    expect(await auditOwnerLedger(env.DB, f.ids.user)).toMatchObject({
      image_reserved_bytes: f.output!.bytes.length,
      incorrect_refs: 0,
    });
  },
);

it.each(["size", "checksum"])(
  "accounts for a wrong native %s but never publishes it",
  async (change) => {
    const f = await archiveStorageFixture(),
      c = await prepareArchiveDerivative(f.app, f.grant, f.output!),
      bytes =
        change === "size" ? new Uint8Array(f.output!.bytes.length + 10) : f.output!.bytes.slice();
    bytes[0] = bytes[0]! ^ 1;
    const bucket = davBucket({
      put: async (key) => {
        const result = await env.BLOBS.put(key, bytes, {
          sha256: await crypto.subtle.digest("SHA-256", bytes),
          onlyIf: { etagDoesNotMatch: "*" },
        });
        if (!result) throw new Error("fixture_collision");
        return result;
      },
    });
    const before = await auditOwnerLedger(env.DB, f.ids.user);
    await expect(
      storeArchiveDerivative({ ...f.app, BLOBS: bucket }, c, f.output!),
    ).rejects.toThrow();
    expect((await auditOwnerLedger(env.DB, f.ids.user))!.physical_bytes).toBe(
      before!.physical_bytes + bytes.length,
    );
    expect(await f.row()).toMatchObject({ state: "stored" });
  },
);

it("recovers a lost prepare ACK without sending the native PUT", async () => {
  const f = await archiveStorageFixture(),
    db = injectBatch(
      (sql) => sql.includes("INSERT INTO archive_derivative_objects"),
      async () => {
        throw new Error("lost_prepare_ack");
      },
      true,
    );
  await expect(
    prepareArchiveDerivative({ ...f.app, DB: db }, f.grant, f.output!),
  ).rejects.toThrow();
  expect(await f.row()).toMatchObject({ state: "prepared" });
  expect(
    await env.DB.prepare("SELECT 1 FROM r2_write_attempts WHERE kind='archive.put' AND owner_id=?")
      .bind(f.ids.user)
      .first(),
  ).toBeNull();
  const c = await prepareArchiveDerivative(f.app, f.grant, f.output!);
  await storeArchiveDerivative(f.app, c, f.output!);
  expect(await f.row()).toMatchObject({ state: "published" });
});

it("allows a fresh claim to publish stored bytes after the previous publication failed", async () => {
  const f = await archiveStorageFixture(),
    c = await prepareArchiveDerivative(f.app, f.grant, f.output!);
  const db = injectBatch(
    (sql) => sql.includes("UPDATE archive_derivative_objects SET state='published'"),
    async () => {
      throw new Error("publication_failed");
    },
    false,
  );
  await expect(storeArchiveDerivative({ ...f.app, DB: db }, c, f.output!)).rejects.toThrow();
  const token = crypto.randomUUID(),
    deadline = Date.now() + 25000;
  await env.DB.prepare("UPDATE outbox SET claim_token=?,claim_expires_at=? WHERE outbox_id=?")
    .bind(token, deadline + 1000, f.outboxId)
    .run();
  const put = vi.fn();
  await publishArchiveDerivative(
    { ...f.app, BLOBS: davBucket({ put }) },
    archiveClaimFromRow((await f.row())!),
    { claimToken: token, expiresAt: deadline },
  );
  expect(await f.row()).toMatchObject({ state: "published" });
  expect(put).not.toHaveBeenCalled();
});

it("refuses publication when independent completion history is missing", async () => {
  const f = await archiveStorageFixture(),
    c = await prepareArchiveDerivative(f.app, f.grant, f.output!);
  await storeArchiveDerivative(f.app, c, f.output!);
  await runInDurableObject(control(), (_, state) => state.storage.deleteAll());
  await evictDurableObject(control());
  await expect(
    publishArchiveDerivative(f.app, archiveClaimFromRow((await f.row())!), {
      claimToken: f.grant.claimToken,
      expiresAt: f.grant.expiresAt,
    }),
  ).rejects.toThrow();
});

it("seals an expired, unwritten index and refunds only after an absent HEAD", async () => {
  const f = await archiveStorageFixture(),
    c = await prepareArchiveDerivative(f.app, f.grant, f.output!);
  await env.DB.prepare("UPDATE control SET epoch=2,maintenance=1,gc_paused=1").run();
  await env.DB.prepare("UPDATE archive_derivative_cleanup SET next_at=0 WHERE archive_id=?")
    .bind(f.grant.id)
    .run();
  const head = vi.fn(env.BLOBS.head.bind(env.BLOBS)),
    app = { ...mutationEnv(), BLOBS: davBucket({ head }) };
  expect(await maintainArchiveDerivatives(app, 2, { archiveId: f.grant.id })).toMatchObject({
    settled: 1,
    retired: 1,
    r2Calls: 1,
  });
  expect(head).toHaveBeenCalledWith(c.key);
  expect(await auditOwnerLedger(env.DB, f.ids.user)).toMatchObject({
    image_reserved_bytes: 0,
    incorrect_refs: 0,
  });
  expect(await env.DB.prepare("SELECT state FROM blobs WHERE id=?").bind(c.blobId).first()).toEqual(
    { state: "deleted" },
  );
});

it("keeps rejected stored bytes charged until the full backup grace and physical GC", async () => {
  const f = await archiveStorageFixture(),
    c = await prepareArchiveDerivative(f.app, f.grant, f.output!);
  const db = injectBatch(
    (sql) => sql.includes("UPDATE archive_derivative_objects SET state='published'"),
    async () => {
      throw new Error("interrupted");
    },
    false,
  );
  await expect(storeArchiveDerivative({ ...f.app, DB: db }, c, f.output!)).rejects.toThrow();
  const before = await auditOwnerLedger(env.DB, f.ids.user);
  await env.DB.prepare("UPDATE control SET epoch=2,maintenance=1,gc_paused=1").run();
  await env.DB.prepare("UPDATE archive_derivative_cleanup SET next_at=0 WHERE archive_id=?")
    .bind(f.grant.id)
    .run();
  const now = Date.now(),
    head = vi.fn();
  expect(
    await maintainArchiveDerivatives({ ...f.app, BLOBS: davBucket({ head }) }, 2, {
      archiveId: f.grant.id,
    }),
  ).toMatchObject({ settled: 1, r2Calls: 0 });
  expect(head).not.toHaveBeenCalled();
  expect(await auditOwnerLedger(env.DB, f.ids.user)).toMatchObject({
    image_reserved_bytes: 0,
    physical_bytes: before!.physical_bytes,
    incorrect_refs: 0,
  });
  expect(
    await env.DB.prepare("SELECT not_before FROM gc_candidates WHERE blob_id=?")
      .bind(c.blobId)
      .first<number>("not_before"),
  ).toBeGreaterThanOrEqual(now + GC_GRACE_MS);
  await env.DB.prepare("UPDATE control SET maintenance=0,gc_paused=0").run();
  expect(await runGarbageCollection(f.app, env.BLOBS, 2, { maxBlobs: 1 })).toMatchObject({
    deleted: 0,
  });
  await expireGcGrace(c.blobId, now);
  expect(await runGarbageCollection(f.app, env.BLOBS, 2, { maxBlobs: 1 })).toMatchObject({
    deleted: 1,
  });
  expect(await env.BLOBS.head(c.key)).toBeNull();
  expect(await auditOwnerLedger(env.DB, f.ids.user)).toMatchObject({
    physical_bytes: before!.physical_bytes - f.output!.bytes.length,
    incorrect_refs: 0,
  });
});

it("retains published indices across epoch changes while their original is live", async () => {
  const f = await archiveStorageFixture(),
    c = await prepareArchiveDerivative(f.app, f.grant, f.output!);
  await storeArchiveDerivative(f.app, c, f.output!);
  await env.DB.prepare("UPDATE control SET epoch=2,maintenance=1,gc_paused=1").run();
  await env.DB.prepare("UPDATE archive_derivative_cleanup SET next_at=0 WHERE archive_id=?")
    .bind(f.grant.id)
    .run();
  const head = vi.fn();
  expect(
    await maintainArchiveDerivatives({ ...f.app, BLOBS: davBucket({ head }) }, 2, {
      archiveId: f.grant.id,
    }),
  ).toMatchObject({ retired: 0, settled: 0, r2Calls: 0 });
  expect(head).not.toHaveBeenCalled();
  expect(await f.row()).toMatchObject({ state: "published" });
});

it("retires a published index after the original reaches irreversible deletion", async () => {
  const f = await archiveStorageFixture(),
    c = await prepareArchiveDerivative(f.app, f.grant, f.output!);
  await storeArchiveDerivative(f.app, c, f.output!);
  await env.DB.prepare("UPDATE nodes SET current_blob_id=? WHERE id=?")
    .bind(f.ids.blob, f.node.id)
    .run();
  await env.DB.prepare("UPDATE blobs SET state='deleted' WHERE id=?").bind(f.node.blob).run();
  expect(await maintainArchiveDerivatives(f.app, 1, { archiveId: f.grant.id })).toMatchObject({
    retired: 1,
    settled: 1,
    r2Calls: 0,
  });
  expect(
    await env.DB.prepare("SELECT state,error_code FROM derivative_results WHERE id=?")
      .bind(c.blobId)
      .first(),
  ).toEqual({ state: "failed", error_code: "archive_retired" });
});

it("retains independent uncertainty after D1 loses the pending write receipt", async () => {
  const f = await archiveStorageFixture(),
    c = await prepareArchiveDerivative(f.app, f.grant, f.output!);
  await expect(
    storeArchiveDerivative(
      {
        ...f.app,
        BLOBS: davBucket({
          put: async () => {
            throw new Error("unknown");
          },
        }),
      },
      c,
      f.output!,
    ),
  ).rejects.toThrow();
  const triggers = await env.DB.prepare(
    "SELECT name,sql FROM sqlite_schema WHERE type='trigger' AND tbl_name='r2_write_attempts'",
  ).all<{ name: string; sql: string }>();
  // Isolated test-only D1 rollback; keep independent DO history intact.
  await env.DB.batch([
    ...triggers.results.map((t) => env.DB.prepare(`DROP TRIGGER ${t.name}`)),
    env.DB.prepare("DELETE FROM r2_write_attempts WHERE r2_key=?").bind(c.key),
    ...triggers.results.map((t) => env.DB.prepare(t.sql)),
  ]);
  await env.DB.prepare("UPDATE control SET epoch=2,maintenance=1,gc_paused=1").run();
  await env.DB.prepare("UPDATE archive_derivative_cleanup SET next_at=0 WHERE archive_id=?")
    .bind(f.grant.id)
    .run();
  const head = vi.fn();
  expect(
    await maintainArchiveDerivatives({ ...f.app, BLOBS: davBucket({ head }) }, 2, {
      archiveId: f.grant.id,
    }),
  ).toMatchObject({ held: 1, settled: 0 });
  expect(head).not.toHaveBeenCalled();
  expect(await auditOwnerLedger(env.DB, f.ids.user)).toMatchObject({
    image_reserved_bytes: f.output!.bytes.length,
  });
});

it("keeps the independent retirement seal after eviction and D1 rollback", async () => {
  const f = await archiveStorageFixture(),
    c = await prepareArchiveDerivative(f.app, f.grant, f.output!);
  // Retire without settling so only the D1 retirement row needs rolling back.
  await env.DB.prepare("UPDATE control SET epoch=2,maintenance=1,gc_paused=1").run();
  await env.DB.prepare("UPDATE archive_derivative_cleanup SET next_at=0 WHERE archive_id=?")
    .bind(f.grant.id)
    .run();
  await maintainArchiveDerivatives(
    {
      ...f.app,
      BLOBS: davBucket({
        head: async () => {
          throw new Error("unavailable");
        },
      }),
    },
    2,
    { archiveId: f.grant.id },
  );
  const triggers = await env.DB.prepare(
    "SELECT name,sql FROM sqlite_schema WHERE type='trigger' AND tbl_name='archive_derivative_cleanup'",
  ).all<{ name: string; sql: string }>();
  await env.DB.batch([
    ...triggers.results.map((t) => env.DB.prepare(`DROP TRIGGER ${t.name}`)),
    env.DB.prepare(
      "UPDATE archive_derivative_cleanup SET retired_at=NULL,retired_epoch=NULL,reason=NULL,seal_token=NULL WHERE archive_id=?",
    ).bind(f.grant.id),
    ...triggers.results.map((t) => env.DB.prepare(t.sql)),
    env.DB.prepare("UPDATE derivative_results SET state='running',error_code=NULL WHERE id=?").bind(
      c.blobId,
    ),
    env.DB.prepare("UPDATE control SET epoch=1,maintenance=0,gc_paused=0"),
  ]);
  await evictDurableObject(control());
  await expect(
    r2WriteFixture().beginR2Write({
      id: crypto.randomUUID(),
      epoch: 1,
      ownerId: f.ids.user,
      kind: "archive.put",
      key: c.key,
      deadline: Date.now() + 5000,
      archive: {
        archiveId: f.grant.id,
        attemptId: c.attemptId,
        claimToken: f.grant.claimToken,
        expiresAt: f.grant.expiresAt,
      },
    }),
  ).rejects.toThrow("archive_derivative_retired");
});

it("retains reservations and pins when native PUT completion is unknown", async () => {
  const f = await archiveStorageFixture(),
    c = await prepareArchiveDerivative(f.app, f.grant, f.output!),
    put = vi.fn(async () => {
      throw new Error("network_lost");
    });
  await expect(
    storeArchiveDerivative({ ...f.app, BLOBS: davBucket({ put }) }, c, f.output!),
  ).rejects.toThrow();
  await expect(
    storeArchiveDerivative({ ...f.app, BLOBS: davBucket({ put }) }, c, f.output!),
  ).rejects.toThrow();
  expect(put).toHaveBeenCalledOnce();
  await env.DB.prepare("UPDATE control SET epoch=2,maintenance=1,gc_paused=1").run();
  await env.DB.prepare("UPDATE archive_derivative_cleanup SET next_at=0 WHERE archive_id=?")
    .bind(f.grant.id)
    .run();
  expect(
    await maintainArchiveDerivatives(mutationEnv(), 2, { archiveId: f.grant.id }),
  ).toMatchObject({ held: 1, settled: 0, r2Calls: 0 });
  expect(await auditOwnerLedger(env.DB, f.ids.user)).toMatchObject({
    image_reserved_bytes: f.output!.bytes.length,
    incorrect_refs: 0,
  });
});
