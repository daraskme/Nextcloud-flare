import { applyD1Migrations, evictDurableObject, runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { atomicBatch } from "../../src/db/primary";
import { insertR2Write, type R2WriteGrant } from "../../src/db/r2Write";
import { ControlDO } from "../../src/do/ControlDO";
import { ORPHAN_GRACE_MS } from "../../src/jobs/orphanInventory";
import { gcFixture } from "../fixtures/gc";
import { orphanBucket, orphanFixture, trackOrphan } from "../fixtures/orphanInventory";
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
  // Retire only this file's synthetic previous fixtures; production never bypasses GC.
  await env.DB.prepare("DELETE FROM gc_candidates").run();
  await env.DB.prepare(`UPDATE orphan_objects SET state='deleted',removed_at=last_seen_at,
    claim_token=NULL,claim_expires_at=NULL WHERE state<>'deleted'`).run();
  await env.DB.prepare(`UPDATE r2_inventory_scan SET cursor='',lease_token=NULL,
    lease_expires_at=NULL,next_scan_at=0`).run();
  await env.DB.prepare(`UPDATE control SET bootstrap_done_at=1,
    bootstrap_iss=(SELECT access_iss FROM users WHERE role='app_admin' LIMIT 1),
    bootstrap_sub=(SELECT access_sub FROM users WHERE role='app_admin' LIMIT 1)
    WHERE EXISTS(SELECT 1 FROM users WHERE role='app_admin')`).run();
  restored = await restoredDatabaseFixture();
});
afterEach(() => vi.restoreAllMocks());
const physical = (user: string) =>
  env.DB.prepare("SELECT physical_bytes FROM users WHERE id=?")
    .bind(user)
    .first<number>("physical_bytes");
const orphanRow = (key: string) =>
  env.DB.prepare("SELECT * FROM orphan_objects WHERE r2_key=?").bind(key).first();
const scan = () => env.DB.prepare("SELECT * FROM r2_inventory_scan").first();
const expire = async (kind: "blob-gc" | "orphan-gc", key: string) => {
  if (kind === "blob-gc")
    await env.DB.prepare(
      "UPDATE gc_candidates SET claim_expires_at=0 WHERE blob_id=(SELECT id FROM blobs WHERE r2_key=?)",
    )
      .bind(key)
      .run();
  else
    await env.DB.prepare(
      "UPDATE orphan_objects SET claim_expires_at=0,next_check_at=0 WHERE r2_key=?",
    )
      .bind(key)
      .run();
};
async function orphan(state = "deleting", age = ORPHAN_GRACE_MS + 2000) {
  const f = await orphanFixture();
  await trackOrphan(f, age);
  if (state === "deleting")
    await env.DB.prepare(
      "UPDATE orphan_objects SET state='deleting',claim_token=?,claim_expires_at=0 WHERE r2_key=?",
    )
      .bind(crypto.randomUUID(), f.key)
      .run();
  return f;
}
const fixture = (kind: "blob-gc" | "orphan-gc") => (kind === "blob-gc" ? gcFixture() : orphan());

it("drains restored blob deletions once and preserves candidates, pins and unexpired claims", async () => {
  const f = await gcFixture(),
    waiting = await gcFixture("candidate"),
    pinned = await gcFixture(),
    leased = await gcFixture();
  await env.DB.prepare("UPDATE gc_candidates SET pinned_by='keep' WHERE blob_id=?")
    .bind(pinned.ids.blob)
    .run();
  await env.DB.prepare("UPDATE gc_candidates SET claim_expires_at=? WHERE blob_id=?")
    .bind(Date.now() + 60000, leased.ids.blob)
    .run();
  await restored.adopted();
  expect((await restored.domain("blob-gc")).repair).toMatchObject({
    pending: true,
    cleanup: { claimed: 1, deleted: 1, r2Calls: 2 },
  });
  expect(await physical(f.ids.user)).toBe(0);
  expect(await env.BLOBS.head(f.key)).toBeNull();
  for (const kept of [waiting, pinned, leased]) {
    expect(await physical(kept.ids.user)).toBe(3);
    expect(await env.BLOBS.head(kept.key)).not.toBeNull();
  }
  await evictDurableObject(restored.control);
  expect((await restored.domain("blob-gc")).repair).toMatchObject({
    pending: true,
    cleanup: { claimed: 0 },
  });
  expect(await restored.control.recover()).toMatchObject({ maintenance: true, gcPaused: true });
});

it("drains only aged orphan deletions and retains quarantine and young deletion capacity", async () => {
  const f = await orphan(),
    waiting = await orphan("quarantined"),
    young = await orphan("deleting", 1000);
  await restored.adopted();
  expect((await restored.domain("orphan-gc")).repair).toMatchObject({
    pending: true,
    cleanup: { claimed: 1, deleted: 1, changed: 0, r2Calls: 3 },
  });
  expect(await physical(f.ids.user)).toBe(0);
  expect(await physical(waiting.ids.user)).toBe(3);
  expect(await physical(young.ids.user)).toBe(3);
  expect(await orphanRow(waiting.key)).toMatchObject({ state: "quarantined" });
  expect((await restored.domain("orphan-gc")).repair).toMatchObject({
    pending: true,
    cleanup: { claimed: 0 },
  });
});

it("restarts orphan grace and updates capacity if the observed object was replaced", async () => {
  const f = await orphan();
  await env.BLOBS.put(f.key, "replacement");
  await restored.adopted();
  expect((await restored.domain("orphan-gc")).repair).toMatchObject({
    pending: true,
    cleanup: { changed: 1, deleted: 0, r2Calls: 1 },
  });
  expect(await physical(f.ids.user)).toBe(11);
  expect(await orphanRow(f.key)).toMatchObject({ state: "deleting", bytes: 11, claim_token: null });
  expect((await restored.domain("orphan-gc")).repair).toMatchObject({
    pending: true,
    cleanup: { claimed: 0 },
  });
});

it.each(["blob-gc", "orphan-gc"] as const)(
  "keeps %s bytes after an unknown delete and refuses another pass",
  async (kind) => {
    const f = await fixture(kind);
    await restored.adopted();
    const remove = vi.fn(async (key: string) => {
      await env.BLOBS.delete(key);
      throw new Error("lost_ack");
    });
    try {
      expect(
        (await restored.domain(kind, 1, { BLOBS: orphanBucket({ delete: remove }) })).repair,
      ).toMatchObject({ pending: true, cleanup: { deleted: 0, retried: 1 } });
      await expire(kind, f.key);
      await expect(restored.domain(kind, 1)).rejects.toThrow(/unsettled|preflight_pending/);
      expect(remove).toHaveBeenCalledTimes(1);
      expect(await physical(f.ids.user)).toBe(3);
    } finally {
      // Only fixture cleanup: the local native delete above has actually ended.
      await env.DB.prepare(
        "UPDATE r2_write_attempts SET state='succeeded',finished_at=MAX(started_at,strftime('%s','now')*1000) WHERE r2_key=? AND state='pending'",
      )
        .bind(f.key)
        .run();
    }
  },
);

it.each(["blob-gc", "orphan-gc"] as const)(
  "settles %s after a final D1 acknowledgement is lost",
  async (kind) => {
    const f = await fixture(kind);
    await restored.adopted();
    const db = injectBatch(
      (sql) =>
        sql.startsWith(
          kind === "blob-gc"
            ? "UPDATE blobs SET state='deleted'"
            : "UPDATE orphan_objects SET state='deleted'",
        ),
      async () => {
        throw new Error("lost_ack");
      },
      true,
    );
    expect((await restored.domain(kind, 1, { DB: db })).repair).toMatchObject({
      pending: false,
      cleanup: { deleted: 1 },
    });
    expect(await physical(f.ids.user)).toBe(0);
    expect((await restored.domain(kind, 1)).repair).toMatchObject({
      pending: false,
      cleanup: { claimed: 0 },
    });
  },
);

it.each([
  ["blob-gc", "before_dispatch"],
  ["blob-gc", "after_native"],
  ["orphan-gc", "before_dispatch"],
  ["orphan-gc", "after_native"],
] as const)("rejects stale %s %s while retaining the exact native outcome", async (kind, when) => {
  const f = await fixture(kind);
  await restored.adopted();
  await runInDurableObject(restored.control, async (_, state) => {
    let instance: ControlDO;
    const remove = vi.fn(async (key: string) => {
      await env.BLOBS.delete(key);
      if (when === "after_native") await instance.quiesce(restored.epoch + 1);
    });
    instance = new ControlDO(state, {
      ...env,
      BLOBS: orphanBucket({ delete: remove }),
      RESTORE_WRITE_ENABLED: "true",
    });
    if (when === "before_dispatch") {
      const begin = instance.beginR2Write.bind(instance);
      instance.beginR2Write = async (input) => {
        const grant = await begin(input);
        await instance.quiesce(restored.epoch + 1);
        return grant;
      };
    }
    await expect(
      instance.repairDatabaseRestoreDomain(restored.epoch, restored.id, kind, 1),
    ).rejects.toThrow(/recovery_conflict/);
    expect(remove).toHaveBeenCalledTimes(when === "after_native" ? 1 : 0);
    expect(
      state.storage.sql.exec("SELECT 1 FROM control_r2_write_receipts").toArray(),
    ).toHaveLength(0);
  });
  expect(
    await env.DB.prepare("SELECT state FROM r2_write_attempts WHERE r2_key=?")
      .bind(f.key)
      .first("state"),
  ).toBe(when === "after_native" ? "succeeded" : "not_started");
  expect(await physical(f.ids.user)).toBe(3);
  await expire(kind, f.key);
  expect((await restored.domain(kind, 1)).repair).toMatchObject({
    pending: false,
    cleanup: { deleted: 1 },
  });
  expect(await physical(f.ids.user)).toBe(0);
});

it("records one orphan page, persists its cursor across eviction, and charges HEAD facts without deletion", async () => {
  const f = await orphanFixture();
  await env.BLOBS.put(`u/${f.ids.user}/b/second`, "xyz");
  await restored.adopted();
  expect((await restored.domain("orphan-inventory", 1, { BLOBS: f.bucket })).repair).toMatchObject({
    pending: true,
    inventory: {
      claimed: true,
      examined: 1,
      observed: 1,
      advanced: true,
      completed: false,
      r2Calls: 2,
    },
  });
  expect(await physical(f.ids.user)).toBe(3);
  const first = await scan();
  expect(first?.cursor).not.toBe("");
  await evictDurableObject(restored.control);
  expect((await restored.domain("orphan-inventory", 1, { BLOBS: f.bucket })).repair).toMatchObject({
    pending: false,
    inventory: { examined: 1, observed: 1, completed: true },
  });
  expect(await physical(f.ids.user)).toBe(6);
  expect(await env.BLOBS.head(f.key)).not.toBeNull();
  expect(await orphanRow(f.key)).toMatchObject({ state: "quarantined", claim_token: null });
  expect((await restored.domain("orphan-gc")).repair).toMatchObject({
    pending: false,
    cleanup: { claimed: 0 },
  });
});

it("retains an inventory cursor and charge when HEAD fails partway through a page", async () => {
  const f = await orphanFixture();
  await env.BLOBS.put(`u/${f.ids.user}/b/second`, "xyz");
  await restored.adopted();
  let heads = 0;
  await expect(
    restored.domain("orphan-inventory", 2, {
      BLOBS: orphanBucket({
        list: (options) => f.bucket.list(options),
        head: async (key) => {
          if (++heads === 2) throw new Error("head_unavailable");
          return env.BLOBS.head(key);
        },
      }),
    }),
  ).rejects.toThrow(/head_unavailable/);
  expect(await scan()).toMatchObject({ cursor: "", lease_token: null });
  expect(await physical(f.ids.user)).toBe(3);
  expect((await restored.domain("orphan-inventory", 2, { BLOBS: f.bucket })).repair).toMatchObject({
    pending: false,
    inventory: { completed: true },
  });
  expect(await physical(f.ids.user)).toBe(6);
});

it.each(["list", "head"] as const)(
  "does not apply inventory observations after its stop changes during %s",
  async (method) => {
    const f = await orphanFixture();
    await restored.adopted();
    await runInDurableObject(restored.control, async (_, state) => {
      let instance: ControlDO;
      const bucket = orphanBucket({
        list: async (options) => {
          const page = await f.bucket.list(options);
          if (method === "list") await instance.quiesce(restored.epoch + 1);
          return page;
        },
        head: async (key) => {
          const object = await env.BLOBS.head(key);
          if (method === "head") await instance.quiesce(restored.epoch + 1);
          return object;
        },
      });
      instance = new ControlDO(state, { ...env, BLOBS: bucket, RESTORE_WRITE_ENABLED: "true" });
      await expect(
        instance.repairDatabaseRestoreDomain(restored.epoch, restored.id, "orphan-inventory", 1),
      ).rejects.toThrow(/recovery_conflict/);
    });
    expect(await physical(f.ids.user)).toBe(0);
    expect(await orphanRow(f.key)).toBeNull();
    expect(await scan()).toMatchObject({ cursor: "" });
  },
);

it.each(["blob-gc", "orphan-gc", "orphan-inventory"] as const)(
  "blocks %s before any native work when D1 contains a pending attempt",
  async (kind) => {
    await restored.adopted();
    const startedAt = Date.now();
    const grant: R2WriteGrant = {
      id: crypto.randomUUID(),
      token: crypto.randomUUID(),
      epoch: restored.epoch + 1,
      ownerId: "fixture",
      kind: "manifest.delete",
      key: `target-sets/${crypto.randomUUID()}`,
      startedAt,
      deadline: startedAt + 5000,
    };
    await atomicBatch(env.DB, [insertR2Write(grant, "pending")]);
    const list = vi.fn(),
      head = vi.fn(),
      remove = vi.fn();
    try {
      await expect(
        restored.domain(kind, 1, { BLOBS: orphanBucket({ list, head, delete: remove }) }),
      ).rejects.toThrow(/preflight_pending/);
      for (const native of [list, head, remove]) expect(native).not.toHaveBeenCalled();
    } finally {
      await env.DB.prepare(
        "UPDATE r2_write_attempts SET state='not_started',finished_at=MAX(started_at,strftime('%s','now')*1000) WHERE id=?",
      )
        .bind(grant.id)
        .run();
    }
  },
);
