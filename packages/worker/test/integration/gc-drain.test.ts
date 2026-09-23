import { applyD1Migrations, runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeAll, beforeEach, expect, it, vi } from "vitest";
import { atomicBatch } from "../../src/db/primary";
import { CONTROL_NAME } from "../../src/do/ControlDO";
import { EPOCH_PREFIX } from "../../src/do/epochHistory";
import { drainStoppedBlobGarbageCollection, runGarbageCollection } from "../../src/jobs/gc";
import {
  drainStoppedOrphanGarbageCollection,
  ORPHAN_GRACE_MS,
} from "../../src/jobs/orphanInventory";
import { foundationFixture } from "../fixtures/foundation";
import { injectBatch } from "../fixtures/uploadEnv";

const control = () => env.CONTROL.get(env.CONTROL.idFromName(CONTROL_NAME));
const drain = (db = env.DB, bucket = env.BLOBS) =>
  drainStoppedBlobGarbageCollection(db, bucket, 2, { maxBlobs: 1 });
const orphans = (bucket = env.BLOBS) =>
  drainStoppedOrphanGarbageCollection(env.DB, bucket, 2, { limit: 1 });
const bucketWith = (overrides: Partial<R2Bucket>): R2Bucket =>
  new Proxy(env.BLOBS, {
    get(target, key) {
      const value = Reflect.get(overrides, key) ?? Reflect.get(target, key);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });

beforeAll(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
  await env.BACKUPS.put(
    `${EPOCH_PREFIX}1.json`,
    JSON.stringify({ epoch: 1, at: 1, reason: "operator" }),
  );
  expect(await control().recover()).toMatchObject({ epoch: 2 });
});
beforeEach(async () => {
  await env.DB.prepare("UPDATE control SET epoch=2,maintenance=1,gc_paused=1").run();
  await env.DB.prepare(
    "UPDATE gc_candidates SET claim_expires_at=9999999999999 WHERE state='deleting'",
  ).run();
  await env.DB.prepare(
    "UPDATE gc_candidates SET not_before=9999999999999 WHERE state='candidate'",
  ).run();
  await env.DB.prepare("UPDATE orphan_objects SET next_check_at=9999999999999").run();
});

async function fixture(state: "candidate" | "deleting" = "deleting") {
  const f = foundationFixture(crypto.randomUUID(), Date.now() - 1000);
  await atomicBatch(env.DB, f.statements);
  const key = `u/${f.ids.user}/b/${f.ids.blob}`;
  const object = (await env.BLOBS.put(key, "abc"))!;
  await atomicBatch(env.DB, [
    {
      sql: "INSERT INTO blob_storage(blob_id,bytes,r2_etag,observed_at) VALUES(?,3,?,1)",
      values: [f.ids.blob, object.etag],
    },
    { sql: "UPDATE nodes SET current_blob_id=NULL WHERE id=?", values: [f.ids.file] },
    {
      sql: "UPDATE blobs SET state=? WHERE id=?",
      values: [state === "deleting" ? "deleting" : "gc_candidate", f.ids.blob],
    },
    {
      sql: "INSERT INTO gc_candidates(blob_id,state,not_before,claim_token,claim_expires_at) VALUES(?,?,0,?,?)",
      values: [
        f.ids.blob,
        state,
        state === "deleting" ? crypto.randomUUID() : null,
        state === "deleting" ? 0 : null,
      ],
    },
  ]);
  return { ...f, key };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
const row = (f: Fixture) =>
  env.DB.prepare("SELECT * FROM gc_candidates WHERE blob_id=?")
    .bind(f.ids.blob)
    .first<Record<string, unknown>>();
const physical = (f: Fixture) =>
  env.DB.prepare("SELECT physical_bytes FROM users WHERE id=?")
    .bind(f.ids.user)
    .first<number>("physical_bytes");
const expire = (f: Fixture) =>
  env.DB.prepare("UPDATE gc_candidates SET claim_expires_at=0 WHERE blob_id=?")
    .bind(f.ids.blob)
    .run();

async function orphan(
  state: "quarantined" | "deleting" = "deleting",
  age = ORPHAN_GRACE_MS + 1000,
) {
  const f = await fixture("candidate");
  const key = `u/${f.ids.user}/b/orphan`;
  const object = (await env.BLOBS.put(key, "xyz"))!;
  const seen = Date.now() - age;
  await env.DB.prepare(`INSERT INTO orphan_objects(r2_key,owner_key,blob_key,owner_id,bytes,r2_etag,r2_version,
    uploaded_at,first_seen_at,last_seen_at,epoch,state,claim_token,claim_expires_at)
    VALUES(?,?,'orphan',?,3,?,?,?,?,?,1,?,?,?)`)
    .bind(
      key,
      f.ids.user,
      f.ids.user,
      object.etag,
      object.version,
      object.uploaded.getTime(),
      seen,
      seen,
      state,
      state === "deleting" ? crypto.randomUUID() : null,
      state === "deleting" ? 0 : null,
    )
    .run();
  return { ...f, orphanKey: key };
}

it("drains an old deletion, releases physical bytes once and leaves new candidates paused", async () => {
  const waiting = await fixture("candidate");
  const f = await fixture();
  expect(await runGarbageCollection(env.DB, env.BLOBS, 2)).toMatchObject({ claimed: 0 });
  expect(await drain()).toEqual({ claimed: 1, deleted: 1, retried: 0, r2Calls: 2 });
  expect(await physical(f)).toBe(0);
  expect(await row(f)).toMatchObject({
    state: "deleted",
    claim_token: null,
    claim_epoch: null,
    r2_calls: 2,
  });
  expect(await env.BLOBS.head(f.key)).toBeNull();
  expect(await physical(waiting)).toBe(3);
  expect((await row(waiting))!.state).toBe("candidate");
  expect(await drain()).toMatchObject({ claimed: 0 });
  await expect(
    env.DB.prepare("UPDATE gc_candidates SET r2_calls=0 WHERE blob_id=?").bind(f.ids.blob).run(),
  ).rejects.toThrow();
});

it("does not take an unexpired claim or a materialized pin", async () => {
  const f = await fixture();
  await env.DB.prepare("UPDATE gc_candidates SET claim_expires_at=? WHERE blob_id=?")
    .bind(Date.now() + 60000, f.ids.blob)
    .run();
  expect(await drain()).toMatchObject({ claimed: 0 });
  await expire(f);
  await env.DB.prepare("UPDATE gc_candidates SET pinned_by='hold' WHERE blob_id=?")
    .bind(f.ids.blob)
    .run();
  expect(await drain()).toMatchObject({ claimed: 0 });
  expect(await physical(f)).toBe(3);
});

it.each(["maintenance", "gc_paused", "epoch", "lease", "pin"])(
  "rechecks %s after a claim before dispatch",
  async (field) => {
    const f = await fixture();
    const remove = vi.fn(env.BLOBS.delete.bind(env.BLOBS));
    const db = injectBatch(
      (sql) => sql.includes("UPDATE gc_candidates SET claim_token="),
      async () => {
        if (field === "lease") await expire(f);
        else if (field === "pin")
          await env.DB.prepare("UPDATE gc_candidates SET pinned_by='hold' WHERE blob_id=?")
            .bind(f.ids.blob)
            .run();
        else await env.DB.prepare(`UPDATE control SET ${field}=${field === "epoch" ? 3 : 0}`).run();
      },
      true,
    );
    expect(await drain(db, bucketWith({ delete: remove }))).toMatchObject({
      claimed: 1,
      deleted: 0,
      retried: 1,
      r2Calls: 0,
    });
    expect(remove).not.toHaveBeenCalled();
    expect(await physical(f)).toBe(3);
  },
);

it("requires both stopped flags and the current epoch for either drain", async () => {
  await fixture();
  await orphan();
  for (const [maintenance, paused] of [
    [0, 0],
    [0, 1],
    [1, 0],
  ]) {
    await env.DB.prepare("UPDATE control SET maintenance=?,gc_paused=?")
      .bind(maintenance, paused)
      .run();
    expect(await drain()).toMatchObject({ claimed: 0 });
    expect(await orphans()).toMatchObject({ claimed: 0 });
  }
  await env.DB.prepare("UPDATE control SET maintenance=1,gc_paused=1").run();
  expect(await drainStoppedBlobGarbageCollection(env.DB, env.BLOBS, 1)).toMatchObject({
    claimed: 0,
  });
  expect(await drainStoppedOrphanGarbageCollection(env.DB, env.BLOBS, 1)).toMatchObject({
    claimed: 0,
  });
});

it("does not dispatch HEAD or settle after an epoch change during deletion", async () => {
  const f = await fixture();
  const head = vi.fn(env.BLOBS.head.bind(env.BLOBS));
  expect(
    await drain(
      env.DB,
      bucketWith({
        head,
        delete: async (key) => {
          await env.BLOBS.delete(key);
          await env.DB.prepare("UPDATE control SET epoch=3").run();
        },
      }),
    ),
  ).toMatchObject({ deleted: 0, retried: 1, r2Calls: 1 });
  expect(head).not.toHaveBeenCalled();
  expect(await physical(f)).toBe(3);
  await expire(f);
  expect(
    await drainStoppedBlobGarbageCollection(env.DB, env.BLOBS, 3, { maxBlobs: 1 }),
  ).toMatchObject({ deleted: 1 });
  expect(await physical(f)).toBe(0);
});

it.each(["lease", "token", "maintenance"])(
  "rejects stale HEAD settlement after %s changes",
  async (field) => {
    const f = await fixture();
    expect(
      await drain(
        env.DB,
        bucketWith({
          head: async (key) => {
            const object = await env.BLOBS.head(key);
            if (field === "lease") await expire(f);
            else if (field === "token")
              await env.DB.prepare("UPDATE gc_candidates SET claim_token=? WHERE blob_id=?")
                .bind(crypto.randomUUID(), f.ids.blob)
                .run();
            else await env.DB.prepare("UPDATE control SET maintenance=0").run();
            return object;
          },
        }),
      ),
    ).toMatchObject({ deleted: 0, retried: 1, r2Calls: 2 });
    expect(await physical(f)).toBe(3);
    expect((await row(f))!.state).toBe("deleting");
  },
);

it.each([true, false])(
  "handles final batch acknowledgement loss/rollback (committed=%s)",
  async (committed) => {
    const f = await fixture();
    const db = injectBatch(
      (sql) => sql.includes("UPDATE blobs SET state='deleted'"),
      async () => {
        throw new Error("d1_unavailable");
      },
      committed,
    );
    expect(await drain(db)).toMatchObject({
      deleted: committed ? 1 : 0,
      retried: committed ? 0 : 1,
    });
    expect(await physical(f)).toBe(committed ? 0 : 3);
    if (!committed) {
      await expire(f);
      expect(await drain()).toMatchObject({ deleted: 1 });
      expect(await physical(f)).toBe(0);
    }
  },
);

it("recovers a claim acknowledgement loss but never dispatches on an unknown counter result", async () => {
  const f = await fixture();
  const lost = async () => {
    throw new Error("lost_ack");
  };
  expect(
    await drain(
      injectBatch((sql) => sql.includes("UPDATE gc_candidates SET claim_token="), lost, true),
    ),
  ).toMatchObject({ deleted: 1 });
  expect(await physical(f)).toBe(0);
  const g = await fixture();
  const remove = vi.fn(env.BLOBS.delete.bind(env.BLOBS));
  expect(
    await drain(
      injectBatch((sql) => sql.includes("SET r2_calls=r2_calls+1"), lost, true),
      bucketWith({ delete: remove }),
    ),
  ).toMatchObject({ deleted: 0, r2Calls: 0, retried: 1 });
  expect(remove).not.toHaveBeenCalled();
  expect(await row(g)).toMatchObject({ r2_calls: 1, state: "deleting" });
  expect(await physical(g)).toBe(3);
});

it("resolves lost R2 delete responses only through a confirmed HEAD", async () => {
  const f = await fixture();
  expect(
    await drain(
      env.DB,
      bucketWith({
        delete: async (key) => {
          await env.BLOBS.delete(key);
          throw new Error("lost_r2_ack");
        },
      }),
    ),
  ).toMatchObject({ deleted: 1, r2Calls: 2 });
  expect(await physical(f)).toBe(0);
  const g = await fixture();
  expect(
    await drain(
      env.DB,
      bucketWith({
        head: async () => {
          throw new Error("head_unavailable");
        },
      }),
    ),
  ).toMatchObject({ deleted: 0, retried: 1 });
  expect(await physical(g)).toBe(3);
});

it("serializes claims and fences an older deletion when a later lease has completed", async () => {
  const f = await fixture();
  let entered!: () => void;
  let release!: () => void;
  const pending = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const old = drain(
    env.DB,
    bucketWith({
      delete: async (key) => {
        entered();
        await held;
        await env.BLOBS.delete(key);
      },
    }),
  );
  await pending;
  expect(await drain()).toMatchObject({ claimed: 0 });
  await expire(f);
  expect(await drain()).toMatchObject({ deleted: 1 });
  const saved = await row(f);
  release();
  expect(await old).toMatchObject({ deleted: 0, retried: 1, r2Calls: 1 });
  expect(await row(f)).toEqual(saved);
  expect(await physical(f)).toBe(0);
});

it("keeps the active GC stopped if maintenance begins after its claim", async () => {
  const f = await fixture("candidate");
  await env.DB.prepare("UPDATE control SET maintenance=0,gc_paused=0").run();
  const db = injectBatch(
    (sql) => sql.includes("UPDATE gc_candidates SET state='deleting'"),
    async () => {
      await env.DB.prepare("UPDATE control SET maintenance=1,gc_paused=1").run();
    },
    true,
  );
  expect(await runGarbageCollection(db, env.BLOBS, 2, { maxBlobs: 1 })).toMatchObject({
    claimed: 1,
    deleted: 0,
    r2Calls: 0,
  });
  expect(await env.BLOBS.head(f.key)).not.toBeNull();
  await expire(f);
  expect(await drain()).toMatchObject({ deleted: 1 });
});

it("drains only an old orphan deletion and preserves quarantined objects and their grace", async () => {
  const waiting = await orphan("quarantined");
  const young = await orphan("deleting", 1000);
  const f = await orphan();
  expect(await orphans()).toMatchObject({ claimed: 1, deleted: 1, r2Calls: 3 });
  expect(await env.BLOBS.head(f.orphanKey)).toBeNull();
  expect(await physical(f)).toBe(3);
  expect(await env.BLOBS.head(waiting.orphanKey)).not.toBeNull();
  expect(await env.BLOBS.head(young.orphanKey)).not.toBeNull();
  expect(await orphans()).toMatchObject({ claimed: 0 });
});

it("keeps replacement orphan bytes and restarts grace during stopped GC", async () => {
  const f = await orphan();
  await env.BLOBS.put(f.orphanKey, "replacement");
  expect(await orphans()).toMatchObject({ changed: 1, deleted: 0, r2Calls: 1 });
  expect(await physical(f)).toBe(14);
  expect(await orphans()).toMatchObject({ claimed: 0 });
  expect(await env.BLOBS.head(f.orphanKey)).toMatchObject({ size: 11 });
});

it("checks the stopped orphan gate before deletion and keeps capacity on a stale HEAD", async () => {
  const f = await orphan();
  const remove = vi.fn(env.BLOBS.delete.bind(env.BLOBS));
  expect(
    await orphans(
      bucketWith({
        delete: remove,
        head: async (key) => {
          const object = await env.BLOBS.head(key);
          await env.DB.prepare("UPDATE control SET gc_paused=0").run();
          return object;
        },
      }),
    ),
  ).toMatchObject({ deleted: 0, retried: 1, r2Calls: 1 });
  expect(remove).not.toHaveBeenCalled();
  expect(await physical(f)).toBe(6);
});

it("validates drain limits before touching R2", async () => {
  for (const limit of [0, -1, 21, 1.5, Number.NaN]) {
    await expect(
      drainStoppedBlobGarbageCollection(env.DB, env.BLOBS, 2, { maxBlobs: limit }),
    ).rejects.toThrow("invalid_gc_limit");
    await expect(
      drainStoppedOrphanGarbageCollection(env.DB, env.BLOBS, 2, { limit }),
    ).rejects.toThrow("invalid_orphan_limit");
  }
});

it("connects both drains to the real ControlDO while keeping admission closed and restarting audits", async () => {
  const f = await fixture();
  const g = await orphan();
  await env.DB.prepare(
    "UPDATE control SET bootstrap_done_at=1,bootstrap_iss='https://access.invalid',bootstrap_sub=?",
  )
    .bind(f.ids.user)
    .run();
  await runInDurableObject(control(), async (instance) => {
    await instance.beginRecoveryAudit(2);
    await expect(instance.nextRecoveryAuditPage(2, 20)).rejects.toThrow("recovery_not_quiesced");
    const blobs = await instance.drainBlobGarbageCollection(2, 1);
    expect(blobs).toMatchObject({
      cleanup: { deleted: 1 },
      audit: { stage: "users", pages: 0, completed: false },
    });
    const result = await instance.drainOrphanGarbageCollection(2, 1);
    expect(result).toMatchObject({
      cleanup: { deleted: 1 },
      audit: { stage: "users", pages: 0, completed: false },
    });
    expect(await instance.status()).toMatchObject({ epoch: 2, maintenance: true, gcPaused: true });
    await expect(instance.drainBlobGarbageCollection(1)).rejects.toThrow();
    await expect(instance.drainOrphanGarbageCollection(1)).rejects.toThrow();
  });
  expect(await physical(f)).toBe(0);
  expect(await physical(g)).toBe(3);
});
