import { applyD1Migrations } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeAll, beforeEach, expect, it } from "vitest";
import { atomicBatch } from "../../src/db/primary";
import type { Env } from "../../src/env";
import worker from "../../src/index";
import {
  collectOrphanObjects,
  ORPHAN_GRACE_MS,
  scanOrphanObjects,
} from "../../src/jobs/orphanInventory";
import { auditOwnerLedger } from "../../src/services/refs";
import { foundationFixture } from "../fixtures/foundation";
import { acquireGlobalMutation, mutationEnv } from "../fixtures/mutationAdmission";
import {
  orphanBucket as bucket,
  orphanFixture as fixture,
  trackOrphan as track,
} from "../fixtures/orphanInventory";
import { injectBatch } from "../fixtures/uploadEnv";

beforeAll(async () => applyD1Migrations(env.DB, env.TEST_MIGRATIONS));
beforeEach(async () => {
  await env.DB.prepare("UPDATE control SET epoch=1,maintenance=0,gc_paused=0").run();
  await env.DB.prepare(
    "UPDATE r2_inventory_scan SET epoch=1,cursor='',lease_token=NULL,lease_expires_at=NULL,next_scan_at=0,last_token=NULL,pages=0",
  ).run();
  await env.DB.prepare("UPDATE orphan_objects SET next_check_at=9999999999999").run();
});

type Fixture = Awaited<ReturnType<typeof fixture>>;
const row = (f: Fixture) =>
  env.DB.prepare("SELECT * FROM orphan_objects WHERE r2_key=?")
    .bind(f.key)
    .first<Record<string, unknown>>();
const physical = (f: Fixture) =>
  env.DB.prepare("SELECT physical_bytes FROM users WHERE id=?")
    .bind(f.ids.user)
    .first<number>("physical_bytes");
async function rescan(f: Fixture, db = env.DB) {
  await env.DB.prepare("UPDATE r2_inventory_scan SET next_scan_at=0").run();
  return scanOrphanObjects(mutationEnv(db), f.bucket, 1);
}

it("quarantines unknown objects, charges physical capacity once, and preserves the first discovery", async () => {
  const f = await fixture();
  expect(await scanOrphanObjects(mutationEnv(), f.bucket, 1)).toMatchObject({
    claimed: true,
    examined: 1,
    observed: 1,
    completed: true,
    r2Calls: 2,
  });
  const first = await row(f);
  expect(first).toMatchObject({
    state: "quarantined",
    bytes: 3,
    owner_id: f.ids.user,
    claim_token: null,
  });
  expect(await physical(f)).toBe(3);
  expect(await auditOwnerLedger(env.DB, f.ids.user)).toMatchObject({
    physical_bytes: 3,
    observed_physical_bytes: 3,
  });
  expect(await scanOrphanObjects(mutationEnv(), f.bucket, 1)).toMatchObject({ claimed: false });
  await rescan(f);
  expect((await row(f))?.first_seen_at).toBe(first?.first_seen_at);
  expect(await physical(f)).toBe(3);
  expect(await collectOrphanObjects(mutationEnv(), env.BLOBS, 1)).toMatchObject({
    claimed: 0,
    r2Calls: 0,
  });
  expect(
    await env.DB.prepare("SELECT id FROM blobs WHERE r2_key=?").bind(f.key).first(),
  ).toBeNull();
});

it("does not classify an existing blob as an orphan or duplicate its charge", async () => {
  const f = await fixture();
  await env.DB.prepare(
    "INSERT INTO blobs(id,owner_id,r2_key,size,content_etag,state,created_at) VALUES(?,?,?,3,'etag','staging',1)",
  )
    .bind(crypto.randomUUID(), f.ids.user, f.key)
    .run();
  expect(await scanOrphanObjects(mutationEnv(), f.bucket, 1)).toMatchObject({
    observed: 0,
    r2Calls: 1,
  });
  expect(await row(f)).toBeNull();
  expect(await physical(f)).toBe(0);
});

it("persists keyset progress page by page and begins a new pass after completion", async () => {
  const f = await fixture();
  await env.BLOBS.put(`u/${f.ids.user}/b/z-last`, "defg");
  expect(await scanOrphanObjects(mutationEnv(), f.bucket, 1, { limit: 1 })).toMatchObject({
    examined: 1,
    advanced: true,
    completed: false,
  });
  expect(await env.DB.prepare("SELECT cursor,pages FROM r2_inventory_scan").first()).toMatchObject({
    pages: 1,
  });
  expect(await scanOrphanObjects(mutationEnv(), f.bucket, 1, { limit: 1 })).toMatchObject({
    examined: 1,
    advanced: true,
    completed: true,
  });
  expect(await physical(f)).toBe(7);
  await rescan(f);
  expect(await physical(f)).toBe(7);
  expect(await env.DB.prepare("SELECT cursor,pages FROM r2_inventory_scan").first()).toMatchObject({
    cursor: "",
    pages: 3,
  });
});

it("keeps a failed page cursor and resumes without losing or double charging its observations", async () => {
  const f = await fixture();
  const last = `u/${f.ids.user}/b/z-last`;
  await env.BLOBS.put(last, "defg");
  const broken = bucket({
    list: f.bucket.list.bind(f.bucket),
    head: async (key) => {
      if (key === last) throw new Error("head_failed");
      return env.BLOBS.head(key);
    },
  });
  await expect(scanOrphanObjects(mutationEnv(), broken, 1)).rejects.toThrow("head_failed");
  expect(
    await env.DB.prepare("SELECT cursor,lease_token,pages FROM r2_inventory_scan").first(),
  ).toEqual({ cursor: "", lease_token: null, pages: 0 });
  expect(await physical(f)).toBe(3);
  expect(await scanOrphanObjects(mutationEnv(), f.bucket, 1)).toMatchObject({ completed: true });
  expect(await physical(f)).toBe(7);
});

it.each(["claim", "observation", "cursor"])(
  "recovers a lost %s acknowledgement without forgetting the page",
  async (phase) => {
    const f = await fixture();
    const db = injectBatch(
      (sql) =>
        phase === "claim"
          ? sql.includes("lease_token=?,lease_expires_at")
          : phase === "observation"
            ? sql.startsWith("INSERT INTO orphan_objects")
            : sql.includes("last_token=?,pages=pages+1"),
      async () => {
        throw new Error("ack_lost");
      },
      true,
    );
    if (phase === "observation") {
      await expect(scanOrphanObjects(mutationEnv(db), f.bucket, 1)).rejects.toThrow("ack_lost");
      expect(
        await env.DB.prepare("SELECT cursor,pages FROM r2_inventory_scan").first(),
      ).toMatchObject({ cursor: "", pages: 0 });
      expect(await scanOrphanObjects(mutationEnv(), f.bucket, 1)).toMatchObject({
        completed: true,
      });
    } else
      expect(await scanOrphanObjects(mutationEnv(db), f.bucket, 1)).toMatchObject({
        completed: true,
      });
    expect(await physical(f)).toBe(3);
  },
);

it("serializes concurrent scans without blocking the first scan's external HEAD", async () => {
  const f = await fixture();
  let competing;
  const intercepted = bucket({
    list: f.bucket.list.bind(f.bucket),
    head: async (key) => {
      competing = await scanOrphanObjects(mutationEnv(), f.bucket, 1);
      return env.BLOBS.head(key);
    },
  });
  expect(await scanOrphanObjects(mutationEnv(), intercepted, 1)).toMatchObject({ observed: 1 });
  expect(competing).toMatchObject({ claimed: false, r2Calls: 0 });
});

it.each(["epoch", "token", "lease", "maintenance"])(
  "rejects a late HEAD after the scan %s changes",
  async (change) => {
    const f = await fixture();
    const intercepted = bucket({
      list: f.bucket.list.bind(f.bucket),
      head: async (key) => {
        if (change === "epoch") await env.DB.prepare("UPDATE control SET epoch=2").run();
        if (change === "token")
          await env.DB.prepare("UPDATE r2_inventory_scan SET lease_token='replacement'").run();
        if (change === "lease")
          await env.DB.prepare("UPDATE r2_inventory_scan SET lease_expires_at=1").run();
        if (change === "maintenance")
          await env.DB.prepare("UPDATE control SET maintenance=1").run();
        return env.BLOBS.head(key);
      },
    });
    await expect(scanOrphanObjects(mutationEnv(), intercepted, 1)).rejects.toThrow();
    expect(await row(f)).toBeNull();
    expect(await physical(f)).toBe(0);
  },
);

it("lets a normal blob registration win the race before the quarantine batch", async () => {
  const f = await fixture();
  const db = injectBatch(
    (sql) => sql.startsWith("INSERT INTO orphan_objects"),
    async () => {
      await env.DB.prepare(
        "INSERT INTO blobs(id,owner_id,r2_key,size,content_etag,state,created_at) VALUES(?,?,?,3,'etag','staging',1)",
      )
        .bind(crypto.randomUUID(), f.ids.user, f.key)
        .run();
    },
    false,
  );
  expect(await scanOrphanObjects(mutationEnv(db), f.bucket, 1)).toMatchObject({ observed: 0 });
  expect(await row(f)).toBeNull();
});

it("blocks later namespace registration and key reuse even after confirmed removal", async () => {
  const f = await fixture();
  await track(f);
  const insert = () =>
    env.DB.prepare(
      "INSERT INTO blobs(id,owner_id,r2_key,size,content_etag,state,created_at) VALUES(?,?,?,3,'etag','staging',1)",
    )
      .bind(crypto.randomUUID(), f.ids.user, f.key)
      .run();
  await expect(insert()).rejects.toThrow(/orphan_key_quarantined/);
  await collectOrphanObjects(mutationEnv(), env.BLOBS, 1);
  await expect(insert()).rejects.toThrow(/orphan_key_quarantined/);
  await expect(
    env.DB.prepare("DELETE FROM orphan_objects WHERE r2_key=?").bind(f.key).run(),
  ).rejects.toThrow(/tombstone/);
});

it("counts replacement bytes and restarts grace using version even when ETag and size are unchanged", async () => {
  const f = await fixture();
  await track(f);
  await env.BLOBS.put(f.key, "abc");
  await rescan(f);
  expect((await row(f))?.r2_version).not.toBe(f.object.version);
  expect((await row(f))?.first_seen_at).toBeGreaterThan(Date.now() - 5000);
  expect(await collectOrphanObjects(mutationEnv(), env.BLOBS, 1)).toMatchObject({ claimed: 0 });
  await env.BLOBS.put(f.key, "longer");
  await rescan(f);
  expect(await physical(f)).toBe(6);
  expect(await auditOwnerLedger(env.DB, f.ids.user)).toMatchObject({ observed_physical_bytes: 6 });
});

it("records missing owners and charges their actual bytes if the owner is restored later", async () => {
  const f = await fixture();
  const owner = crypto.randomUUID();
  const key = `u/${owner}/b/lost`;
  await env.BLOBS.put(key, "four");
  const scoped = bucket({
    list: (options) => env.BLOBS.list({ ...options, prefix: `u/${owner}/` }),
  });
  expect(await scanOrphanObjects(mutationEnv(), scoped, 1)).toMatchObject({ observed: 1 });
  expect(
    await env.DB.prepare("SELECT owner_id FROM orphan_objects WHERE r2_key=?").bind(key).first(),
  ).toEqual({ owner_id: null });
  await env.DB.prepare(
    "INSERT INTO users(id,access_iss,access_sub,email,role,quota_bytes,created_at) VALUES(?,'https://access.invalid',?,'restored@test','member',100,1)",
  )
    .bind(owner, owner)
    .run();
  expect(await auditOwnerLedger(env.DB, owner)).toMatchObject({
    physical_bytes: 4,
    observed_physical_bytes: 4,
  });
  expect(await physical(f)).toBe(0);
});

it("quarantines malformed keys without deleting them", async () => {
  const f = await fixture();
  const key = `u/${f.ids.user}/foreign/data`;
  await env.BLOBS.put(key, "x");
  await scanOrphanObjects(mutationEnv(), f.bucket, 1);
  expect(
    await env.DB.prepare("SELECT owner_key,blob_key FROM orphan_objects WHERE r2_key=?")
      .bind(key)
      .first(),
  ).toEqual({ owner_key: null, blob_key: null });
  expect(await collectOrphanObjects(mutationEnv(), env.BLOBS, 1)).toMatchObject({ claimed: 0 });
  expect(await env.BLOBS.head(key)).not.toBeNull();
});

it("collects only after 35 days and releases physical capacity only after confirmed absence", async () => {
  const f = await fixture();
  await track(f, ORPHAN_GRACE_MS - 10000);
  expect(await collectOrphanObjects(mutationEnv(), env.BLOBS, 1)).toMatchObject({
    claimed: 0,
    r2Calls: 0,
  });
  const due = await fixture();
  await track(due);
  expect(await collectOrphanObjects(mutationEnv(), env.BLOBS, 1)).toMatchObject({
    claimed: 1,
    deleted: 1,
    r2Calls: 3,
  });
  expect(await row(due)).toMatchObject({ state: "deleted", claim_token: null });
  expect(await physical(due)).toBe(0);
  expect(await env.BLOBS.head(due.key)).toBeNull();
  expect(await collectOrphanObjects(mutationEnv(), env.BLOBS, 1)).toMatchObject({ claimed: 0 });
});

it("settles a physically absent object without issuing delete", async () => {
  const f = await fixture();
  await track(f);
  await env.BLOBS.delete(f.key);
  expect(await collectOrphanObjects(mutationEnv(), env.BLOBS, 1)).toMatchObject({
    deleted: 1,
    r2Calls: 1,
  });
  expect(await physical(f)).toBe(0);
});

it("renews grace instead of deleting a replacement discovered immediately before GC", async () => {
  const f = await fixture();
  await track(f);
  await env.BLOBS.put(f.key, "replacement");
  expect(await collectOrphanObjects(mutationEnv(), env.BLOBS, 1)).toMatchObject({
    changed: 1,
    deleted: 0,
    r2Calls: 1,
  });
  expect(await row(f)).toMatchObject({ state: "deleting", bytes: 11, claim_token: null });
  expect(await physical(f)).toBe(11);
  expect(await collectOrphanObjects(mutationEnv(), env.BLOBS, 1)).toMatchObject({ claimed: 0 });
  expect(await env.BLOBS.head(f.key)).not.toBeNull();
});

it.each(["maintenance", "gc_paused", "epoch"])(
  "honors the %s gate before collection",
  async (gate) => {
    const f = await fixture();
    await track(f);
    await env.DB.prepare(`UPDATE control SET ${gate}=?`)
      .bind(gate === "epoch" ? 2 : 1)
      .run();
    expect(await collectOrphanObjects(mutationEnv(), env.BLOBS, 1)).toMatchObject({
      claimed: 0,
      r2Calls: 0,
    });
    expect(await physical(f)).toBe(3);
  },
);

it("rechecks GC pause between HEAD and irreversible deletion", async () => {
  const f = await fixture();
  await track(f);
  let deletes = 0;
  const interrupted = bucket({
    head: async (key) => {
      await env.DB.prepare("UPDATE control SET gc_paused=1").run();
      return env.BLOBS.head(key);
    },
    delete: async () => {
      deletes++;
    },
  });
  expect(await collectOrphanObjects(mutationEnv(), interrupted, 1)).toMatchObject({
    retried: 1,
    r2Calls: 1,
  });
  expect(deletes).toBe(0);
  expect(await physical(f)).toBe(3);
});

it("recovers unknown delete responses and terminal D1 acknowledgements without double refunds", async () => {
  const f = await fixture();
  await track(f);
  const interrupted = bucket({
    delete: async (key) => {
      await env.BLOBS.delete(key);
      throw new Error("delete_reply_lost");
    },
  });
  const db = injectBatch(
    (sql) => sql.includes("SET state='deleted',removed_at"),
    async () => {
      throw new Error("ack_lost");
    },
    true,
  );
  expect(await collectOrphanObjects(mutationEnv(db), interrupted, 1)).toMatchObject({ deleted: 1 });
  expect(await physical(f)).toBe(0);
  expect(await collectOrphanObjects(mutationEnv(), env.BLOBS, 1)).toMatchObject({ claimed: 0 });
});

it("retains capacity when HEAD after deletion is unknown, then reconciles on the next lease", async () => {
  const f = await fixture();
  await track(f);
  let heads = 0;
  const interrupted = bucket({
    head: async (key) => {
      if (++heads === 2) throw new Error("head_reply_lost");
      return env.BLOBS.head(key);
    },
  });
  expect(await collectOrphanObjects(mutationEnv(), interrupted, 1)).toMatchObject({
    retried: 1,
    deleted: 0,
  });
  expect(await physical(f)).toBe(3);
  await env.DB.prepare(
    "UPDATE orphan_objects SET claim_expires_at=1,next_check_at=0 WHERE r2_key=?",
  )
    .bind(f.key)
    .run();
  expect(await collectOrphanObjects(mutationEnv(), env.BLOBS, 1)).toMatchObject({
    deleted: 1,
    r2Calls: 1,
  });
  expect(await physical(f)).toBe(0);
});

it("keeps the old worker from finalizing after its GC lease is replaced", async () => {
  const f = await fixture();
  await track(f);
  let heads = 0;
  const interrupted = bucket({
    head: async (key) => {
      if (++heads === 2)
        await env.DB.prepare("UPDATE orphan_objects SET claim_token='new-worker' WHERE r2_key=?")
          .bind(key)
          .run();
      return env.BLOBS.head(key);
    },
  });
  expect(await collectOrphanObjects(mutationEnv(), interrupted, 1)).toMatchObject({
    retried: 1,
    deleted: 0,
  });
  expect(await physical(f)).toBe(3);
  expect(await row(f)).toMatchObject({ claim_token: "new-worker", state: "deleting" });
});

it("serializes concurrent GC claims and skips inventory updates while the object is claimed", async () => {
  const f = await fixture();
  await track(f);
  let once = false;
  const interrupted = bucket({
    head: async (key) => {
      if (!once) {
        once = true;
        expect(await collectOrphanObjects(mutationEnv(), env.BLOBS, 1)).toMatchObject({
          claimed: 0,
        });
        expect(await rescan(f)).toMatchObject({ observed: 0 });
      }
      return env.BLOBS.head(key);
    },
  });
  expect(await collectOrphanObjects(mutationEnv(), interrupted, 1)).toMatchObject({ deleted: 1 });
  expect(await physical(f)).toBe(0);
});

it.each([0, 101, 1.5, NaN])("rejects invalid bounded page/collection limits %s", async (limit) => {
  await expect(scanOrphanObjects(mutationEnv(), env.BLOBS, 1, { limit })).rejects.toThrow(
    "invalid_orphan_limit",
  );
  await expect(collectOrphanObjects(mutationEnv(), env.BLOBS, 1, { limit })).rejects.toThrow(
    "invalid_orphan_limit",
  );
});

it("does not advance an overflowing or stalled R2 page", async () => {
  const f = await fixture();
  const overflow = bucket({
    list: async () => ({ objects: [f.object, f.object], truncated: false, delimitedPrefixes: [] }),
  });
  await expect(scanOrphanObjects(mutationEnv(), overflow, 1, { limit: 1 })).rejects.toThrow(
    "invalid_orphan_inventory_page",
  );
  const stalled = bucket({
    list: async () => ({ objects: [], truncated: true, cursor: "", delimitedPrefixes: [] }),
  });
  await expect(scanOrphanObjects(mutationEnv(), stalled, 1)).rejects.toThrow(
    "invalid_orphan_inventory_page",
  );
  expect(await env.DB.prepare("SELECT cursor,pages FROM r2_inventory_scan").first()).toMatchObject({
    cursor: "",
    pages: 0,
  });
});

it("does not dispatch R2 when the cleanup counter acknowledgement is lost", async () => {
  const f = await fixture();
  await track(f);
  const db = injectBatch(
    (sql) => sql.includes("SET r2_calls=r2_calls+1"),
    async () => {
      throw new Error("charge_reply_lost");
    },
    true,
  );
  const noIO = bucket({
    head: async () => {
      throw new Error("must_not_dispatch");
    },
  });
  expect(await collectOrphanObjects(mutationEnv(db), noIO, 1)).toMatchObject({
    retried: 1,
    r2Calls: 0,
  });
  expect(await row(f)).toMatchObject({ r2_calls: 1, state: "deleting" });
  expect(await physical(f)).toBe(3);
});

it("keeps settlement pending when its final batch is unavailable and later refunds only once", async () => {
  const f = await fixture();
  await track(f);
  const db = injectBatch(
    (sql) => sql.includes("SET state='deleted',removed_at"),
    async () => {
      throw new Error("database_unavailable");
    },
    false,
  );
  expect(await collectOrphanObjects(mutationEnv(db), env.BLOBS, 1)).toMatchObject({
    retried: 1,
    deleted: 0,
  });
  expect(await physical(f)).toBe(3);
  expect(await env.BLOBS.head(f.key)).toBeNull();
  await env.DB.prepare(
    "UPDATE orphan_objects SET claim_expires_at=1,next_check_at=0 WHERE r2_key=?",
  )
    .bind(f.key)
    .run();
  expect(await collectOrphanObjects(mutationEnv(), env.BLOBS, 1)).toMatchObject({ deleted: 1 });
  expect(await physical(f)).toBe(0);
});

it("restarts from the beginning under a new epoch even if the old scan still held a lease", async () => {
  const f = await fixture();
  await env.DB.prepare("UPDATE control SET epoch=2").run();
  await env.DB.prepare(
    "UPDATE r2_inventory_scan SET cursor='old-epoch-cursor',lease_token='old',lease_expires_at=9999999999999,next_scan_at=9999999999999",
  ).run();
  const scoped = bucket({
    list: async (options) => {
      expect(options?.cursor).toBeUndefined();
      return f.bucket.list(options);
    },
  });
  expect(await scanOrphanObjects(mutationEnv(), scoped, 2)).toMatchObject({
    completed: true,
    observed: 1,
  });
  expect(await row(f)).toMatchObject({ epoch: 2 });
});

it("re-quarantines and charges an externally recreated deleted key with a fresh grace", async () => {
  const f = await fixture();
  await track(f);
  expect(await collectOrphanObjects(mutationEnv(), env.BLOBS, 1)).toMatchObject({ deleted: 1 });
  await env.BLOBS.put(f.key, "restored");
  await rescan(f);
  expect(await row(f)).toMatchObject({ state: "quarantined", bytes: 8, removed_at: null });
  expect(await physical(f)).toBe(8);
  expect(await collectOrphanObjects(mutationEnv(), env.BLOBS, 1)).toMatchObject({ claimed: 0 });
});

it("ignores an object that disappeared after listing without prematurely refunding its old observation", async () => {
  const f = await fixture();
  await track(f);
  const scoped = bucket({
    list: f.bucket.list.bind(f.bucket),
    head: async (key) => {
      await env.BLOBS.delete(key);
      return null;
    },
  });
  expect(await scanOrphanObjects(mutationEnv(), scoped, 1)).toMatchObject({
    completed: true,
    observed: 0,
  });
  expect(await physical(f)).toBe(3);
  expect(await collectOrphanObjects(mutationEnv(), env.BLOBS, 1)).toMatchObject({ deleted: 1 });
  expect(await physical(f)).toBe(0);
});

it("runs inventory and orphan GC through Cron only under both admission and GC gates", async () => {
  const f = await fixture();
  await track(f);
  let maintenance = true;
  let gcPaused = true;
  const runtime = {
    ...env,
    BLOBS: f.bucket,
    CONTROL: {
      idFromName: () => "singleton",
      get: () => ({
        status: async () => ({ epoch: 1, maintenance, gcPaused }),
        acquireGlobalMutation,
      }),
    },
  } as unknown as Env;
  await worker.scheduled({} as ScheduledController, runtime);
  expect(await row(f)).toMatchObject({ r2_calls: 0 });
  maintenance = false;
  await env.DB.prepare("UPDATE control SET gc_paused=1").run();
  await worker.scheduled({} as ScheduledController, runtime);
  expect(await env.DB.prepare("SELECT pages FROM r2_inventory_scan").first("pages")).toBe(1);
  expect(await row(f)).toMatchObject({ state: "quarantined", r2_calls: 0 });
  gcPaused = false;
  await env.DB.prepare("UPDATE control SET gc_paused=0").run();
  await worker.scheduled({} as ScheduledController, runtime);
  expect(await row(f)).toMatchObject({ state: "deleted", r2_calls: 3 });
  expect(await physical(f)).toBe(0);
});

it.each(["replacement", "removal"])(
  "rejects a stale scan HEAD after concurrent GC observes %s",
  async (change) => {
    const f = await fixture();
    await track(f);
    const scoped = bucket({
      list: f.bucket.list.bind(f.bucket),
      head: async (key) => {
        const stale = await env.BLOBS.head(key);
        if (change === "replacement") await env.BLOBS.put(key, "new-larger-object");
        expect(await collectOrphanObjects(mutationEnv(), env.BLOBS, 1)).toMatchObject(
          change === "replacement" ? { changed: 1 } : { deleted: 1 },
        );
        return stale;
      },
    });
    expect(await scanOrphanObjects(mutationEnv(), scoped, 1)).toMatchObject({
      observed: 0,
      completed: true,
    });
    expect(await physical(f)).toBe(change === "replacement" ? 17 : 0);
    expect(await row(f)).toMatchObject(
      change === "replacement" ? { state: "deleting", bytes: 17 } : { state: "deleted" },
    );
  },
);
