import { applyD1Migrations, evictDurableObject, runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterEach, beforeAll, expect, it, vi } from "vitest";
import {
  BACKUP_CHUNK_BYTES,
  backupManifestKey,
  backupPartKey,
} from "../../../shared/src/backupPublication";
import { BACKUP_MAX_AGE_MS } from "../../../shared/src/backupRetention";
import { sha256 } from "../../src/backup/publication";
import { CONTROL_NAME, ControlDO } from "../../src/do/ControlDO";
import { publicationFixture } from "../fixtures/backupPublication";
import { injectBatch } from "../fixtures/uploadEnv";

const control = () => env.CONTROL.get(env.CONTROL.idFromName(CONTROL_NAME));
const epoch = 2;
beforeAll(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
  await env.BACKUPS.put(
    "sys/epoch/1.json",
    JSON.stringify({ epoch: 1, at: 1, reason: "operator" }),
  );
  expect((await control().recover()).epoch).toBe(epoch);
});
afterEach(async () => {
  vi.restoreAllMocks();
  await runInDurableObject(control(), async (instance, state) => {
    const active = state.storage.sql
      .exec<{ id: string }>("SELECT id FROM control_backup WHERE phase<>'released'")
      .toArray()[0];
    if (active) await instance.cancelBackup(epoch, active.id);
  });
});
async function seed({ count = 1, createdAt = 1, generationEpoch = 1, mismatch = false } = {}) {
  const id = crypto.randomUUID(),
    token = crypto.randomUUID();
  const publication = await publicationFixture({
    id,
    epoch: generationEpoch,
    token,
    createdAt,
    watermark: null,
  });
  const part = publication.parts[0]!;
  // Pruning validates keys against the attested manifest, never loads SQL part bodies.
  publication.parts = Array.from({ length: count }, (_, i) => ({
    ...part,
    bytes: i === count - 1 ? 1 : BACKUP_CHUNK_BYTES,
  }));
  publication.manifest.data.bytes = (count - 1) * BACKUP_CHUNK_BYTES + 1;
  if (mismatch) publication.manifest.generation.token = crypto.randomUUID();
  const bytes = new TextEncoder().encode(JSON.stringify(publication)),
    hash = await sha256(bytes);
  const keys = publication.parts.map((p, i) => backupPartKey(id, i, p.sha256));
  for (const key of keys) await env.BACKUPS.put(key, "x");
  await env.BACKUPS.put(backupManifestKey(id), bytes);
  await env.DB.prepare(`INSERT INTO backup_runs(id,epoch,state,created_at,completed_at,released_at,barrier_token,manifest_key,manifest_sha256)
    VALUES(?,?,'completed',?,?,?,?,?,?)`)
    .bind(id, generationEpoch, createdAt, createdAt, createdAt, token, backupManifestKey(id), hash)
    .run();
  return { id, keys, hash, bytes, prefix: `sys/backups/v1/${id}/` };
}
function bucket(overrides: Partial<R2Bucket>): R2Bucket {
  return new Proxy(env.BACKUPS, {
    get(target, key) {
      const value = overrides[key as keyof R2Bucket] ?? Reflect.get(target, key);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}
function gate() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { resolve, promise };
}
const rejects = (id: string, message: string, requestedEpoch = epoch) =>
  runInDurableObject(control(), async (instance) => {
    await expect(instance.pruneBackup(requestedEpoch, id)).rejects.toThrow(message);
  });

it("removes an expired old-epoch generation, preserves its receipt and unrelated objects, and replays after eviction", async () => {
  const item = await seed(),
    fresh = await seed({ createdAt: Date.now() });
  const before = await control().status();
  expect(await control().pruneBackup(epoch, item.id)).toMatchObject({
    id: item.id,
    epoch,
    generationEpoch: 1,
    state: "absent",
    deletedObjects: 2,
    manifestSha256: item.hash,
  });
  expect((await env.BACKUPS.list({ prefix: item.prefix })).objects).toHaveLength(0);
  expect(await env.BACKUPS.head(backupManifestKey(fresh.id))).not.toBeNull();
  expect(await env.BACKUPS.head("sys/epoch/1.json")).not.toBeNull();
  expect(
    await env.DB.prepare("SELECT state FROM backup_runs WHERE id=?").bind(item.id).first("state"),
  ).toBe("completed");
  expect(await control().status()).toEqual(before);
  await evictDurableObject(control());
  expect(await control().pruneBackup(epoch, item.id)).toMatchObject({
    state: "absent",
    deletedObjects: 0,
  });
});
it("bounds each batch to twenty parts and retains the manifest until the final batch", async () => {
  const item = await seed({ count: 22 });
  expect(await control().pruneBackup(epoch, item.id)).toMatchObject({
    state: "pending",
    deletedObjects: 20,
  });
  expect(await env.BACKUPS.head(backupManifestKey(item.id))).not.toBeNull();
  expect((await env.BACKUPS.list({ prefix: item.prefix })).objects).toHaveLength(3);
  await evictDurableObject(control());
  expect(await control().pruneBackup(epoch, item.id)).toMatchObject({
    state: "absent",
    deletedObjects: 3,
  });
});
it.each([0, BACKUP_MAX_AGE_MS, BACKUP_MAX_AGE_MS - 1])(
  "rejects a generation aged %i ms before R2 I/O",
  async (age) => {
    const now = Date.now(),
      item = await seed({ createdAt: now - age });
    vi.spyOn(Date, "now").mockReturnValue(now);
    await runInDurableObject(control(), async (_, state) => {
      const get = vi.fn();
      const instance = new ControlDO(state, { ...env, BACKUPS: bucket({ get }) });
      await expect(instance.pruneBackup(epoch, item.id)).rejects.toThrow("backup_not_expired");
      expect(get).not.toHaveBeenCalled();
    });
  },
);
it("accepts strictly more than 35 days even when fewer than five backups exist", async () => {
  const now = Date.now(),
    item = await seed({ createdAt: now - BACKUP_MAX_AGE_MS - 1 });
  vi.spyOn(Date, "now").mockReturnValue(now);
  expect((await control().pruneBackup(epoch, item.id)).state).toBe("absent");
});
it.each(["pending", "exporting", "failed"])(
  "rejects %s records without touching stored objects",
  async (state) => {
    const id = crypto.randomUUID(),
      key = backupManifestKey(id);
    await env.DB.prepare("INSERT INTO backup_runs(id,epoch,state,created_at) VALUES(?,1,?,1)")
      .bind(id, state)
      .run();
    await env.BACKUPS.put(key, "unverified");
    await rejects(id, "backup_invalid_receipt");
    expect(await env.BACKUPS.head(key)).not.toBeNull();
  },
);
it("rejects missing receipts and stale caller epochs", async () => {
  await rejects(crypto.randomUUID(), "backup_invalid_receipt");
  const item = await seed();
  await rejects(item.id, "invalid_backup_request", 1);
  expect(await env.BACKUPS.head(item.keys[0]!)).not.toBeNull();
});
it("rejects a modified manifest before deleting any part", async () => {
  const item = await seed();
  await env.BACKUPS.put(backupManifestKey(item.id), "modified");
  await rejects(item.id, "backup_publication_hash_mismatch");
  expect(await env.BACKUPS.head(item.keys[0]!)).not.toBeNull();
});
it("rejects a hash-matching manifest with the wrong generation token", async () => {
  const item = await seed({ mismatch: true });
  await rejects(item.id, "backup_generation_conflict");
  expect(await env.BACKUPS.head(item.keys[0]!)).not.toBeNull();
});
it("refuses to infer keys when the manifest is missing but objects remain", async () => {
  const item = await seed();
  await env.BACKUPS.delete(backupManifestKey(item.id));
  await rejects(item.id, "backup_manifest_missing_with_objects");
  expect(await env.BACKUPS.head(item.keys[0]!)).not.toBeNull();
});
it.each(["extra.txt", `parts/000000-${"0".repeat(64)}.bin`])(
  "preserves unexpected generation objects: %s",
  async (suffix) => {
    const item = await seed();
    await env.BACKUPS.put(item.prefix + suffix, "foreign");
    await rejects(item.id, "backup_unexpected_object");
    expect(await env.BACKUPS.head(item.prefix + suffix)).not.toBeNull();
    expect(await env.BACKUPS.head(item.keys[0]!)).not.toBeNull();
  },
);
it.each(["parts", "manifest"])("resumes after the %s DELETE response is lost", async (stage) => {
  const item = await seed();
  await runInDurableObject(control(), async (_, state) => {
    const remove = vi.fn(async (key: string | string[]) => {
      await env.BACKUPS.delete(key);
      if (Array.isArray(key) === (stage === "parts")) throw new Error("lost_delete_ack");
    });
    const instance = new ControlDO(state, { ...env, BACKUPS: bucket({ delete: remove }) });
    await expect(instance.pruneBackup(epoch, item.id)).rejects.toThrow("lost_delete_ack");
    expect(remove).toHaveBeenCalledTimes(stage === "parts" ? 1 : 2);
  });
  await evictDurableObject(control());
  expect((await control().pruneBackup(epoch, item.id)).state).toBe("absent");
});
it("retains the manifest if DELETE acknowledges but a part is still present", async () => {
  const item = await seed();
  await runInDurableObject(control(), async (_, state) => {
    const instance = new ControlDO(state, { ...env, BACKUPS: bucket({ delete: async () => {} }) });
    expect((await instance.pruneBackup(epoch, item.id)).state).toBe("pending");
  });
  expect(await env.BACKUPS.head(backupManifestKey(item.id))).not.toBeNull();
});
it("blocks overlapping prune calls and rechecks the backup barrier after delayed manifest I/O", async () => {
  const item = await seed(),
    entered = gate(),
    resume = gate();
  await runInDurableObject(control(), async (instance, state) => {
    const remove = vi.fn(),
      get = vi.fn(async (key: string) => {
        entered.resolve();
        await resume.promise;
        return env.BACKUPS.get(key);
      });
    const delayed = new ControlDO(state, {
      ...env,
      BACKUPS: bucket({ get: get as R2Bucket["get"], delete: remove }),
    });
    const pending = expect(delayed.pruneBackup(epoch, item.id)).rejects.toThrow("backup_conflict");
    await entered.promise;
    await expect(delayed.pruneBackup(epoch, item.id)).rejects.toThrow("backup_prune_busy");
    await instance.beginBackup(epoch, crypto.randomUUID());
    resume.resolve();
    await pending;
    expect(remove).not.toHaveBeenCalled();
  });
});
it("rejects pruning while a backup is frozen", async () => {
  const item = await seed();
  await control().beginBackup(epoch, crypto.randomUUID());
  await rejects(item.id, "backup_active");
  expect(await env.BACKUPS.head(item.keys[0]!)).not.toBeNull();
});
it("rechecks the D1 epoch immediately before dispatching deletion", async () => {
  const item = await seed();
  await runInDurableObject(control(), async (_, state) => {
    let lists = 0;
    const remove = vi.fn(),
      list = async (options?: R2ListOptions) => {
        const page = await env.BACKUPS.list(options);
        if (++lists === 1) await env.DB.prepare("UPDATE control SET epoch=epoch+1").run();
        return page;
      };
    const instance = new ControlDO(state, { ...env, BACKUPS: bucket({ list, delete: remove }) });
    try {
      await expect(instance.pruneBackup(epoch, item.id)).rejects.toThrow("backup_mirror_conflict");
    } finally {
      await env.DB.prepare("UPDATE control SET epoch=?").bind(epoch).run();
    }
    expect(remove).not.toHaveBeenCalled();
  });
});
it("does not dispatch R2 after a D1 read consumes the fixed start deadline", async () => {
  const item = await seed();
  await runInDurableObject(control(), async (_, state) => {
    const get = vi.fn();
    const instance = new ControlDO(state, {
      ...env,
      BACKUPS: bucket({ get }),
      DB: injectBatch(
        (sql) => sql.includes("FROM backup_runs WHERE id=?"),
        async () => {
          vi.spyOn(Date, "now").mockReturnValue(Date.now() + 26000);
        },
        true,
      ),
    });
    await expect(instance.pruneBackup(epoch, item.id)).rejects.toThrow("backup_prune_deadline");
    expect(get).not.toHaveBeenCalled();
  });
});

it("does not dispatch deletion if the completed receipt disappears during listing", async () => {
  const item = await seed();
  await runInDurableObject(control(), async (_, state) => {
    const remove = vi.fn(),
      list = async (options?: R2ListOptions) => {
        const page = await env.BACKUPS.list(options);
        await env.DB.prepare("DELETE FROM backup_runs WHERE id=?").bind(item.id).run();
        return page;
      };
    const instance = new ControlDO(state, { ...env, BACKUPS: bucket({ list, delete: remove }) });
    await expect(instance.pruneBackup(epoch, item.id)).rejects.toThrow("backup_invalid_receipt");
    expect(remove).not.toHaveBeenCalled();
  });
});
it.each(["outside_prefix", "truncated_empty"])(
  "rejects an inconsistent R2 listing: %s",
  async (kind) => {
    const item = await seed();
    await runInDurableObject(control(), async (_, state) => {
      const remove = vi.fn(),
        list = async (options?: R2ListOptions) => {
          const page = await env.BACKUPS.list(options);
          return kind === "outside_prefix"
            ? {
                ...page,
                objects: [{ ...page.objects[0]!, key: "sys/epoch/1.json", writeHttpMetadata() {} }],
              }
            : { ...page, objects: [], truncated: true as const, cursor: "cursor" };
        };
      const instance = new ControlDO(state, { ...env, BACKUPS: bucket({ list, delete: remove }) });
      await expect(instance.pruneBackup(epoch, item.id)).rejects.toThrow("backup_invalid_listing");
      expect(remove).not.toHaveBeenCalled();
    });
  },
);
it("does not delete the manifest after a timed-out part delete eventually finishes", async () => {
  const item = await seed(),
    entered = gate(),
    resume = gate(),
    finished = gate();
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  try {
    await runInDurableObject(control(), async (_, state) => {
      const remove = vi.fn(async (key: string | string[]) => {
        entered.resolve();
        await resume.promise;
        await env.BACKUPS.delete(key);
        finished.resolve();
      });
      const instance = new ControlDO(state, { ...env, BACKUPS: bucket({ delete: remove }) });
      const pending = expect(instance.pruneBackup(epoch, item.id)).rejects.toThrow(
        "backup_prune_timeout",
      );
      await entered.promise;
      await vi.advanceTimersByTimeAsync(10000);
      await pending;
      resume.resolve();
      await finished.promise;
      expect(remove).toHaveBeenCalledTimes(1);
      expect(await env.BACKUPS.head(backupManifestKey(item.id))).not.toBeNull();
    });
  } finally {
    resume.resolve();
    vi.useRealTimers();
  }
  expect((await control().pruneBackup(epoch, item.id)).state).toBe("absent");
});
