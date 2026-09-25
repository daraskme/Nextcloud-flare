import { applyD1Migrations, evictDurableObject, runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterEach, beforeAll, expect, it } from "vitest";
import {
  BACKUP_CHUNK_BYTES,
  type BackupGeneration,
  backupManifestKey,
  backupPartKey,
} from "../../../shared/src/backupPublication";
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
  await env.DB.exec("DROP TRIGGER IF EXISTS test_completion_failure");
  await runInDurableObject(control(), async (instance, state) => {
    const row = state.storage.sql
      .exec<{ id: string }>("SELECT id FROM control_backup WHERE phase<>'released'")
      .toArray()[0];
    if (!row) return;
    const p = state.storage.sql
      .exec<{ hash: string; phase: string }>(
        "SELECT hash,phase FROM control_backup_publication WHERE id=?",
        row.id,
      )
      .toArray()[0];
    if (p?.phase === "completing") await instance.completeBackup(epoch, row.id, p.hash);
    else await instance.cancelBackup(epoch, row.id);
  });
});
const rejects = (call: (instance: ControlDO) => Promise<unknown>) =>
  runInDurableObject(control(), async (instance) => {
    await expect(call(instance)).rejects.toThrow();
  });
async function stage(chunks = [new TextEncoder().encode("SQL fixture")]) {
  const id = crypto.randomUUID();
  await control().beginBackup(epoch, id);
  const generation = (await env.DB.prepare(
    "SELECT id,epoch,barrier_token AS token,created_at AS createdAt,watermark FROM backup_runs WHERE id=?",
  )
    .bind(id)
    .first<BackupGeneration>())!;
  const publication = await publicationFixture(generation, chunks);
  for (const [i, bytes] of chunks.entries())
    await env.BACKUPS.put(backupPartKey(id, i, publication.parts[i]!.sha256), bytes);
  const bytes = new TextEncoder().encode(JSON.stringify(publication)),
    hash = await sha256(bytes);
  await env.BACKUPS.put(backupManifestKey(id), bytes);
  return { id, hash, publication, bytes };
}
const frozen = async () =>
  expect(await env.DB.prepare("SELECT backup_frozen FROM control").first("backup_frozen")).toBe(1);
const row = (id: string) =>
  env.DB.prepare(
    "SELECT state,manifest_key,manifest_sha256,released_at,completed_at FROM backup_runs WHERE id=?",
  )
    .bind(id)
    .first();
const gate = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { resolve, promise };
};

it("commits the exact R2 receipt and release in one batch, preserving closed policy and replaying after eviction", async () => {
  const { id, hash } = await stage();
  const result = await control().completeBackup(epoch, id, hash);
  expect(result).toEqual({
    id,
    epoch,
    state: "completed",
    manifestSha256: hash,
    partsVerified: 1,
    partsTotal: 1,
  });
  expect(await row(id)).toEqual({
    state: "completed",
    manifest_key: backupManifestKey(id),
    manifest_sha256: hash,
    released_at: expect.any(Number),
    completed_at: expect.any(Number),
  });
  expect(await control().status()).toEqual({ epoch, maintenance: true, gcPaused: true });
  expect(await env.DB.prepare("SELECT backup_frozen,backup_token FROM control").first()).toEqual({
    backup_frozen: 0,
    backup_token: null,
  });
  await evictDurableObject(control());
  expect(await control().completeBackup(epoch, id, hash)).toEqual(result);
  await expect(
    env.DB.prepare("UPDATE backup_runs SET manifest_sha256=? WHERE id=?")
      .bind("0".repeat(64), id)
      .run(),
  ).rejects.toThrow();
});
it("verifies one bounded part per call, keeps the source frozen between calls and survives eviction", async () => {
  const { id, hash } = await stage([new Uint8Array(BACKUP_CHUNK_BYTES), new Uint8Array([1, 2, 3])]);
  expect(await control().completeBackup(epoch, id, hash)).toMatchObject({
    state: "verifying",
    partsVerified: 1,
    partsTotal: 2,
  });
  await frozen();
  expect(await row(id)).toMatchObject({ state: "exporting", manifest_key: null });
  await evictDurableObject(control());
  expect(await control().completeBackup(epoch, id, hash)).toMatchObject({
    state: "completed",
    partsVerified: 2,
    partsTotal: 2,
  });
});
it.each([
  "missing-manifest",
  "manifest-hash",
  "generation",
  "part-missing",
  "part-bytes",
  "table-set",
])("retains freeze and no completion after %s failure", async (kind) => {
  const { id, hash, publication } = await stage();
  let pinned = hash;
  if (kind === "missing-manifest") await env.BACKUPS.delete(backupManifestKey(id));
  if (kind === "manifest-hash") pinned = "0".repeat(64);
  if (kind === "generation" || kind === "table-set") {
    if (kind === "generation") publication.manifest.generation.token = crypto.randomUUID();
    else publication.manifest.tables.pop();
    const bytes = new TextEncoder().encode(JSON.stringify(publication));
    pinned = await sha256(bytes);
    await env.BACKUPS.put(backupManifestKey(id), bytes);
  }
  const key = backupPartKey(id, 0, publication.parts[0]!.sha256);
  if (kind === "part-missing") await env.BACKUPS.delete(key);
  if (kind === "part-bytes") await env.BACKUPS.put(key, "bad");
  await rejects((instance) => instance.completeBackup(epoch, id, pinned));
  await frozen();
  expect(await row(id)).toMatchObject({
    state: "exporting",
    completed_at: null,
    manifest_key: null,
  });
  await control().cancelBackup(epoch, id);
});
it("pins a single hash across overlapping first verification calls", async () => {
  const { id, hash } = await stage();
  await runInDurableObject(control(), async (instance, state) => {
    const results = await Promise.allSettled([
      instance.completeBackup(epoch, id, hash),
      instance.completeBackup(epoch, id, "0".repeat(64)),
    ]);
    expect(results.some((r) => r.status === "rejected")).toBe(true);
    const pinned = state.storage.sql
      .exec<{ hash: string }>("SELECT hash FROM control_backup_publication")
      .one().hash;
    if (pinned === hash)
      expect(await row(id)).toMatchObject({ state: "completed", manifest_sha256: hash });
    else {
      expect(pinned).toBe("0".repeat(64));
      await expect(instance.completeBackup(epoch, id, hash)).rejects.toThrow(
        "backup_publication_conflict",
      );
      await frozen();
    }
  });
});
it("never skips a part when two verification pages overlap", async () => {
  const { id, hash } = await stage([new Uint8Array(BACKUP_CHUNK_BYTES), new Uint8Array([3])]);
  const results = await runInDurableObject(control(), (instance) =>
    Promise.allSettled([
      instance.completeBackup(epoch, id, hash),
      instance.completeBackup(epoch, id, hash),
    ]),
  );
  expect(results.some((r) => r.status === "fulfilled")).toBe(true);
  const result = await control().completeBackup(epoch, id, hash);
  expect(result).toMatchObject({ state: "completed", partsVerified: 2 });
  expect(await row(id)).toMatchObject({ state: "completed", manifest_sha256: hash });
});
it("rolls the thaw back on D1 failure, blocks conflicting release and completes after eviction", async () => {
  const { id, hash } = await stage();
  await env.DB.exec(
    "CREATE TRIGGER test_completion_failure BEFORE UPDATE OF released_at ON backup_runs BEGIN SELECT RAISE(ABORT,'test_failure'); END",
  );
  await rejects((instance) => instance.completeBackup(epoch, id, hash));
  await frozen();
  expect(await row(id)).toMatchObject({ state: "exporting", manifest_key: null });
  await rejects((instance) => instance.releaseBackup(epoch, id));
  await rejects((instance) => instance.cancelBackup(epoch, id));
  await env.DB.exec("DROP TRIGGER test_completion_failure");
  await evictDurableObject(control());
  expect((await control().completeBackup(epoch, id, hash)).state).toBe("completed");
});
it("reconciles a lost D1 completion acknowledgement without repeating or replacing the receipt", async () => {
  const { id, hash } = await stage();
  let fired = false;
  await runInDurableObject(control(), async (_, state) => {
    const db = injectBatch(
      (sql) => sql.includes("SET backup_token=NULL"),
      async () => {
        fired = true;
        throw new Error("lost_ack");
      },
      true,
    );
    expect(
      (await new ControlDO(state, { ...env, DB: db }).completeBackup(epoch, id, hash)).state,
    ).toBe("completed");
  });
  expect(fired).toBe(true);
  const before = await row(id);
  await evictDurableObject(control());
  await control().completeBackup(epoch, id, hash);
  expect(await row(id)).toEqual(before);
});
it("retains completion intent when the commit and primary readback both lose their replies", async () => {
  const { id, hash } = await stage();
  await runInDurableObject(control(), async (_, state) => {
    let lost = false;
    const base = injectBatch(
      (sql) => sql.includes("SET backup_token=NULL"),
      async () => {
        lost = true;
        throw new Error("lost_ack");
      },
      true,
    );
    const db = {
      ...base,
      prepare(sql: string) {
        if (lost) throw new Error("primary_unavailable");
        return base.prepare(sql);
      },
    } as D1Database;
    await expect(
      new ControlDO(state, { ...env, DB: db }).completeBackup(epoch, id, hash),
    ).rejects.toThrow();
    expect(
      state.storage.sql.exec<{ phase: string }>("SELECT phase FROM control_backup").one().phase,
    ).toBe("releasing");
  });
  expect(await row(id)).toMatchObject({ state: "completed", manifest_sha256: hash });
  await evictDurableObject(control());
  expect((await control().completeBackup(epoch, id, hash)).state).toBe("completed");
});
it("a delayed duplicate completion cannot thaw or overwrite the next generation", async () => {
  const { id, hash } = await stage(),
    entered = gate(),
    resume = gate(),
    next = crypto.randomUUID();
  await runInDurableObject(control(), async (instance, state) => {
    const db = injectBatch(
      (sql) => sql.includes("SET backup_token=NULL"),
      async () => {
        entered.resolve();
        await resume.promise;
      },
      false,
    );
    const pending = new ControlDO(state, { ...env, DB: db }).completeBackup(epoch, id, hash).then(
      (value) => ({ value }),
      (error) => ({ error }),
    );
    await entered.promise;
    try {
      await instance.completeBackup(epoch, id, hash);
      await instance.beginBackup(epoch, next);
    } finally {
      resume.resolve();
    }
    expect(await pending).toHaveProperty("error");
  });
  expect(await row(id)).toMatchObject({ state: "completed", manifest_sha256: hash });
  await frozen();
  expect(await row(next)).toMatchObject({ state: "exporting", manifest_key: null });
});
it("a delayed R2 read cannot complete a cancelled generation or thaw its successor", async () => {
  const { id, hash } = await stage(),
    entered = gate(),
    resume = gate(),
    next = crypto.randomUUID();
  await runInDurableObject(control(), async (instance, state) => {
    const bucket = new Proxy(env.BACKUPS, {
      get(target, key) {
        if (key === "get")
          return async (key: string) => {
            const value = await target.get(key);
            entered.resolve();
            await resume.promise;
            return value;
          };
        const value = Reflect.get(target, key);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const pending = new ControlDO(state, { ...env, BACKUPS: bucket })
      .completeBackup(epoch, id, hash)
      .then(
        (value) => ({ value }),
        (error) => ({ error }),
      );
    await entered.promise;
    try {
      await instance.cancelBackup(epoch, id);
      await instance.beginBackup(epoch, next);
    } finally {
      resume.resolve();
    }
    expect(await pending).toHaveProperty("error");
  });
  await frozen();
  expect(await row(id)).toMatchObject({ state: "failed", manifest_key: null });
  expect(await row(next)).toMatchObject({ state: "exporting", manifest_key: null });
  await control().cancelBackup(epoch, next);
});
it("rejects a completed generation's late call after a new generation starts", async () => {
  const { id, hash } = await stage();
  await control().completeBackup(epoch, id, hash);
  const next = crypto.randomUUID();
  await control().beginBackup(epoch, next);
  await rejects((instance) => instance.completeBackup(epoch, id, hash));
  await frozen();
  await control().cancelBackup(epoch, next);
});
it("does not upgrade an explicit unverified release into a completed generation", async () => {
  const { id, hash } = await stage();
  await control().releaseBackup(epoch, id);
  await rejects((instance) => instance.completeBackup(epoch, id, hash));
  expect(await row(id)).toMatchObject({ state: "exporting", manifest_key: null });
});
