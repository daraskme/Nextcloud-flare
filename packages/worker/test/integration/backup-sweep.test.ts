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
    state.storage.sql.exec("DELETE FROM control_backup_sweep");
  });
  await env.DB.prepare("DELETE FROM backup_runs").run();
});
async function seed({
  count = 1,
  createdAt = 1,
  generationEpoch = 1,
  mismatch = false,
  id = crypto.randomUUID(),
} = {}) {
  const token = crypto.randomUUID();
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

const idFor = (n: number) => `00000000-0000-0000-0000-${String(n).padStart(12, "0")}`;
it("persists a planned round across eviction and replays completed steps without starting a new round", async () => {
  const plan = await control().sweepBackups(epoch);
  expect(plan).toMatchObject({ state: "running", through: null, scanned: 0 });
  await evictDurableObject(control());
  expect(await control().sweepBackups(epoch)).toEqual(plan);
  const done = await control().sweepBackups(epoch, plan.round);
  expect(done.state).toBe("completed");
  await evictDurableObject(control());
  expect(await control().sweepBackups(epoch, plan.round)).toEqual(done);
  expect((await control().sweepBackups(epoch)).round).not.toBe(plan.round);
});
it("scans at most 100 receipts per step and leaves incomplete generations untouched", async () => {
  for (let start = 0; start < 205; start += 50)
    await env.DB.batch(
      Array.from({ length: Math.min(50, 205 - start) }, (_, n) =>
        env.DB.prepare(
          "INSERT INTO backup_runs(id,epoch,state,created_at) VALUES(?,1,'pending',1)",
        ).bind(idFor(start + n + 1)),
      ),
    );
  const plan = await control().sweepBackups(epoch);
  expect(await control().sweepBackups(epoch, plan.round)).toMatchObject({
    state: "running",
    scanned: 100,
    after: idFor(100),
  });
  await evictDurableObject(control());
  expect((await control().sweepBackups(epoch)).round).toBe(plan.round);
  expect(await control().sweepBackups(epoch, plan.round)).toMatchObject({
    state: "running",
    scanned: 200,
  });
  expect(await control().sweepBackups(epoch, plan.round)).toMatchObject({
    state: "completed",
    scanned: 205,
    absent: 0,
    errors: 0,
  });
});
it("advances past 100 already-absent receipts instead of starving later expired objects", async () => {
  for (let start = 0; start < 100; start += 50)
    await env.DB.batch(
      Array.from({ length: 50 }, (_, n) => {
        const id = idFor(start + n + 1);
        return env.DB.prepare(`INSERT INTO backup_runs(id,epoch,state,created_at,completed_at,released_at,barrier_token,manifest_key,manifest_sha256)
        VALUES(?,1,'completed',1,2,2,?,?,?)`).bind(
          id,
          crypto.randomUUID(),
          backupManifestKey(id),
          "a".repeat(64),
        );
      }),
    );
  const last = await seed({ id: idFor(101) });
  const plan = await control().sweepBackups(epoch);
  for (let n = 0; n < 100; n++) await control().sweepBackups(epoch, plan.round);
  await evictDurableObject(control());
  expect(await control().sweepBackups(epoch)).toMatchObject({
    round: plan.round,
    after: idFor(100),
    state: "running",
  });
  expect(await control().sweepBackups(epoch, plan.round)).toMatchObject({
    state: "completed",
    absent: 101,
    scanned: 101,
  });
  expect(await env.BACKUPS.head(backupManifestKey(last.id))).toBeNull();
});
it("keeps a partially pruned generation at the cursor across eviction", async () => {
  const item = await seed({ count: 22 }),
    plan = await control().sweepBackups(epoch);
  expect(await control().sweepBackups(epoch, plan.round)).toMatchObject({
    state: "running",
    after: null,
    scanned: 0,
    absent: 0,
  });
  expect((await env.BACKUPS.list({ prefix: item.prefix })).objects).toHaveLength(3);
  await evictDurableObject(control());
  expect((await control().sweepBackups(epoch)).round).toBe(plan.round);
  expect(await control().sweepBackups(epoch, plan.round)).toMatchObject({
    state: "completed",
    after: item.id,
    scanned: 1,
    absent: 1,
  });
});
it("defers a corrupt generation, visits later keys and persists the warning across eviction", async () => {
  const bad = await seed({ id: idFor(1) }),
    good = await seed({ id: idFor(2) });
  await env.BACKUPS.put(backupManifestKey(bad.id), "corrupt");
  const plan = await control().sweepBackups(epoch);
  const result = await control().sweepBackups(epoch, plan.round);
  expect(result).toMatchObject({
    state: "running",
    errors: 1,
    after: bad.id,
    lastError: { id: bad.id, code: "backup_publication_hash_mismatch" },
  });
  await evictDurableObject(control());
  expect(await control().sweepBackups(epoch)).toEqual(result);
  expect(await control().sweepBackups(epoch, plan.round)).toMatchObject({
    state: "completed",
    errors: 1,
    absent: 1,
    scanned: 2,
  });
  expect(await env.BACKUPS.head(bad.keys[0]!)).not.toBeNull();
  expect(await env.BACKUPS.head(good.keys[0]!)).toBeNull();
});
it("keeps the same candidate after an ambiguous DELETE, then reconciles actual R2 absence", async () => {
  const item = await seed(),
    plan = await control().sweepBackups(epoch);
  await runInDurableObject(control(), async (_, state) => {
    const instance = new ControlDO(state, {
      ...env,
      BACKUPS: bucket({
        delete: async (key) => {
          await env.BACKUPS.delete(key);
          throw new Error("unknown_delete");
        },
      }),
    });
    await expect(instance.sweepBackups(epoch, plan.round)).rejects.toThrow("unknown_delete");
  });
  await evictDurableObject(control());
  expect(await control().sweepBackups(epoch)).toEqual(plan);
  expect(await control().sweepBackups(epoch, plan.round)).toMatchObject({
    state: "completed",
    absent: 1,
  });
  expect(await env.BACKUPS.head(backupManifestKey(item.id))).toBeNull();
});
it("defers keys beyond the fixed round ceiling until the next round", async () => {
  await seed({ id: idFor(1) });
  const plan = await control().sweepBackups(epoch),
    later = await seed({ id: idFor(2) });
  expect(await control().sweepBackups(epoch, plan.round)).toMatchObject({
    state: "completed",
    scanned: 1,
  });
  expect(await env.BACKUPS.head(later.keys[0]!)).not.toBeNull();
  const next = await control().sweepBackups(epoch);
  expect(next.through).toBe(later.id);
  await control().sweepBackups(epoch, next.round);
  expect((await control().sweepBackups(epoch, next.round)).state).toBe("completed");
  expect(await env.BACKUPS.head(later.keys[0]!)).toBeNull();
});
it("fixes expiry at the round's server start time and excludes the exact 35-day boundary", async () => {
  const now = Date.now(),
    item = await seed({ createdAt: now - BACKUP_MAX_AGE_MS });
  const clock = vi.spyOn(Date, "now").mockReturnValue(now);
  const plan = await control().sweepBackups(epoch);
  clock.mockReturnValue(now + 2);
  expect(await control().sweepBackups(epoch, plan.round)).toMatchObject({
    state: "completed",
    absent: 0,
  });
  expect(await env.BACKUPS.head(item.keys[0]!)).not.toBeNull();
  const next = await control().sweepBackups(epoch);
  expect((await control().sweepBackups(epoch, next.round)).absent).toBe(1);
});
it("rejects stale epochs and unknown rounds without changing the current plan", async () => {
  const plan = await control().sweepBackups(epoch);
  await runInDurableObject(control(), async (instance) => {
    await expect(instance.sweepBackups(1)).rejects.toThrow("invalid_backup_request");
    await expect(instance.sweepBackups(epoch, crypto.randomUUID())).rejects.toThrow(
      "backup_sweep_changed",
    );
  });
  expect(await control().sweepBackups(epoch)).toEqual(plan);
});
it("rejects a backup barrier and resumes the same round after cancellation", async () => {
  await seed();
  const plan = await control().sweepBackups(epoch),
    backup = crypto.randomUUID();
  await control().beginBackup(epoch, backup);
  await runInDurableObject(control(), async (instance) => {
    await expect(instance.sweepBackups(epoch)).rejects.toThrow("backup_active");
    await expect(instance.sweepBackups(epoch, plan.round)).rejects.toThrow("backup_active");
  });
  await control().cancelBackup(epoch, backup);
  expect((await control().sweepBackups(epoch)).round).toBe(plan.round);
  expect((await control().sweepBackups(epoch, plan.round)).state).toBe("completed");
});
it("shares the prune exclusion with manual calls while a sweep is waiting for R2", async () => {
  const item = await seed(),
    plan = await control().sweepBackups(epoch),
    entered = gate(),
    resume = gate();
  await runInDurableObject(control(), async (_, state) => {
    const get = async (key: string) => {
      entered.resolve();
      await resume.promise;
      return env.BACKUPS.get(key);
    };
    const instance = new ControlDO(state, {
      ...env,
      BACKUPS: bucket({ get: get as R2Bucket["get"] }),
    });
    const pending = instance.sweepBackups(epoch, plan.round);
    await entered.promise;
    await expect(instance.sweepBackups(epoch)).rejects.toThrow("backup_prune_busy");
    await expect(instance.pruneBackup(epoch, item.id)).rejects.toThrow("backup_prune_busy");
    resume.resolve();
    expect((await pending).state).toBe("completed");
  });
});
it("includes scan latency in the fixed deletion deadline", async () => {
  await seed();
  const plan = await control().sweepBackups(epoch);
  await runInDurableObject(control(), async (_, state) => {
    const get = vi.fn(),
      instance = new ControlDO(state, {
        ...env,
        BACKUPS: bucket({ get }),
        DB: injectBatch(
          (sql) => sql.includes("WHERE id>? AND id<=?"),
          async () => {
            vi.spyOn(Date, "now").mockReturnValue(Date.now() + 26000);
          },
          true,
        ),
      });
    await expect(instance.sweepBackups(epoch, plan.round)).rejects.toThrow("backup_prune_deadline");
    expect(get).not.toHaveBeenCalled();
  });
  vi.restoreAllMocks();
  expect(await control().sweepBackups(epoch)).toEqual(plan);
});
it("does not record a deferred error if the D1 epoch changes during manifest lookup", async () => {
  await seed();
  const plan = await control().sweepBackups(epoch);
  await runInDurableObject(control(), async (_, state) => {
    const get = async (key: string) => {
      await env.DB.prepare("UPDATE control SET epoch=epoch+1").run();
      await env.BACKUPS.put(key, "corrupt");
      return env.BACKUPS.get(key);
    };
    const instance = new ControlDO(state, {
      ...env,
      BACKUPS: bucket({ get: get as R2Bucket["get"] }),
    });
    try {
      await expect(instance.sweepBackups(epoch, plan.round)).rejects.toThrow(
        "backup_mirror_conflict",
      );
    } finally {
      await env.DB.prepare("UPDATE control SET epoch=?").bind(epoch).run();
    }
  });
  expect(await control().sweepBackups(epoch)).toEqual(plan);
});
