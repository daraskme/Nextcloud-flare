import { applyD1Migrations, evictDurableObject, runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterEach, beforeAll, expect, it } from "vitest";
import {
  BACKUP_CHUNK_BYTES,
  type BackupGeneration,
  backupManifestKey,
  backupPartKey,
} from "../../../shared/src/backupPublication";
import type { BackupPublicationWrite } from "../../../shared/src/backupPublicationWrite";
import { sha256 } from "../../src/backup/publication";
import { exportTables } from "../../src/db/schemaContract";
import { CONTROL_NAME, ControlDO } from "../../src/do/ControlDO";
import { publicationFixture } from "../fixtures/backupPublication";

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
  await runInDurableObject(control(), async (instance, state) => {
    // Test-only teardown: synthetic grants have no outstanding native operation.
    const pending = state.storage.sql
      .exec<{ attemptId: string; id: string; epoch: number; token: string }>(
        `SELECT attempt_id AS attemptId,generation_id AS id,epoch,settlement_token AS token
        FROM control_backup_writes WHERE state='pending'`,
      )
      .toArray();
    for (const grant of pending)
      await instance.finishBackupPublicationWrite(epoch, grant.id, grant);
    const row = state.storage.sql
      .exec<{ id: string }>("SELECT id FROM control_backup WHERE phase<>'released'")
      .toArray()[0];
    if (row) await instance.cancelBackup(epoch, row.id);
  });
});
async function stage() {
  const id = crypto.randomUUID();
  await control().beginBackup(epoch, id);
  const generation = (await env.DB.prepare(
    "SELECT id,epoch,barrier_token AS token,created_at AS createdAt,watermark FROM backup_runs WHERE id=?",
  )
    .bind(id)
    .first<BackupGeneration>())!;
  const payload = new TextEncoder().encode("frozen SQL fixture");
  const hash = await sha256(payload);
  const request: BackupPublicationWrite = {
    attemptId: crypto.randomUUID(),
    generation,
    key: backupPartKey(id, 0, hash),
    bytes: payload.length,
    sha256: hash,
  };
  return { id, request, payload };
}
async function snapshot() {
  return (
    await env.DB.batch(
      exportTables.map((table) => env.DB.prepare(`SELECT * FROM "${table}" ORDER BY 1`)),
    )
  ).map((result) => result.results);
}
const rejects = (call: (instance: ControlDO) => Promise<unknown>, code: string) =>
  runInDurableObject(control(), async (instance) => {
    await expect(call(instance)).rejects.toThrow(code);
  });
const frozen = async () =>
  expect(await env.DB.prepare("SELECT backup_frozen FROM control").first("backup_frozen")).toBe(1);

it("persists grants without changing any frozen D1 table and settles only the exact receipt", async () => {
  const { id, request, payload } = await stage(),
    before = await snapshot();
  const grant = await control().grantBackupPublicationWrite(epoch, id, request);
  expect(grant).toEqual({ attemptId: request.attemptId, id, epoch, token: expect.any(String) });
  await evictDurableObject(control());
  await rejects(
    (instance) =>
      instance.finishBackupPublicationWrite(epoch, id, { ...grant, token: crypto.randomUUID() }),
    "backup_publication_write_conflict",
  );
  await rejects(
    (instance) => instance.cancelBackup(epoch, id),
    "backup_publication_write_unsettled",
  );
  await env.BACKUPS.put(request.key, payload);
  expect(await control().finishBackupPublicationWrite(epoch, id, grant)).toEqual({
    state: "ended",
  });
  await evictDurableObject(control());
  expect(await control().finishBackupPublicationWrite(epoch, id, grant)).toEqual({
    state: "ended",
  });
  expect(await snapshot()).toEqual(before);
  await rejects(
    (instance) => instance.grantBackupPublicationWrite(epoch, id, request),
    "backup_publication_write_replayed",
  );
  expect((await control().cancelBackup(epoch, id)).state).toBe("released");
});

it("retains an unknown PUT across exact readback and eviction, blocking all release and replay paths", async () => {
  const { id, request, payload } = await stage();
  const grant = await control().grantBackupPublicationWrite(epoch, id, request);
  await env.BACKUPS.put(request.key, payload);
  expect(await (await env.BACKUPS.get(request.key))!.text()).toBe(
    new TextDecoder().decode(payload),
  );
  await evictDurableObject(control());
  for (const call of [
    (instance: ControlDO) => instance.completeBackup(epoch, id, "0".repeat(64)),
    (instance: ControlDO) => instance.releaseBackup(epoch, id),
    (instance: ControlDO) => instance.cancelBackup(epoch, id),
    (instance: ControlDO) => instance.beginBackup(epoch, id),
    (instance: ControlDO) => instance.beginBackup(epoch, crypto.randomUUID()),
    (instance: ControlDO) => instance.grantBackupPublicationWrite(epoch, id, request),
    (instance: ControlDO) =>
      instance.grantBackupPublicationWrite(epoch, id, {
        ...request,
        attemptId: crypto.randomUUID(),
      }),
  ])
    await rejects(call, "backup_publication_write_unsettled");
  await frozen();
  await control().finishBackupPublicationWrite(epoch, id, grant);
});

it("completes a manifest only after its native PUT receipt is ended", async () => {
  const { id, request, payload } = await stage();
  const partGrant = await control().grantBackupPublicationWrite(epoch, id, request);
  await env.BACKUPS.put(request.key, payload);
  await control().finishBackupPublicationWrite(epoch, id, partGrant);
  const publication = await publicationFixture(request.generation, [payload]);
  const bytes = new TextEncoder().encode(JSON.stringify(publication)),
    hash = await sha256(bytes);
  const grant = await control().grantBackupPublicationWrite(epoch, id, {
    ...request,
    attemptId: crypto.randomUUID(),
    key: backupManifestKey(id),
    bytes: bytes.length,
    sha256: hash,
  });
  await env.BACKUPS.put(backupManifestKey(id), bytes);
  await rejects(
    (instance) => instance.completeBackup(epoch, id, hash),
    "backup_publication_write_unsettled",
  );
  await control().finishBackupPublicationWrite(epoch, id, grant);
  expect((await control().completeBackup(epoch, id, hash)).state).toBe("completed");
  expect(await control().finishBackupPublicationWrite(epoch, id, grant)).toEqual({
    state: "ended",
  });
});

it("keeps a lost grant response pending and never reissues it", async () => {
  const { id, request } = await stage();
  await runInDurableObject(control(), async (instance) => {
    const lost = async () => {
      await instance.grantBackupPublicationWrite(epoch, id, request);
      throw new Error("lost_ack");
    };
    await expect(lost()).rejects.toThrow("lost_ack");
  });
  await evictDurableObject(control());
  await rejects(
    (instance) => instance.grantBackupPublicationWrite(epoch, id, request),
    "backup_publication_write_unsettled",
  );
  await rejects(
    (instance) => instance.releaseBackup(epoch, id),
    "backup_publication_write_unsettled",
  );
  await frozen();
});

it("serializes concurrent grants and rejects a previous generation's settlement", async () => {
  const { id, request } = await stage();
  await runInDurableObject(control(), async (instance, state) => {
    const results = await Promise.allSettled([
      instance.grantBackupPublicationWrite(epoch, id, request),
      instance.grantBackupPublicationWrite(epoch, id, {
        ...request,
        attemptId: crypto.randomUUID(),
      }),
    ]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(
      state.storage.sql.exec("SELECT 1 FROM control_backup_writes WHERE state='pending'").toArray(),
    ).toHaveLength(1);
    const result = results.find((result) => result.status === "fulfilled")!;
    if (result.status !== "fulfilled") throw new Error("missing_grant");
    await instance.finishBackupPublicationWrite(epoch, id, result.value);
    await instance.cancelBackup(epoch, id);
    const next = crypto.randomUUID();
    await instance.beginBackup(epoch, next);
    expect(state.storage.sql.exec("SELECT 1 FROM control_backup_writes").toArray()).toHaveLength(0);
    await expect(instance.finishBackupPublicationWrite(epoch, id, result.value)).rejects.toThrow(
      "backup_publication_write_conflict",
    );
  });
});

it.each([
  "key",
  "part-index",
  "part-hash",
  "bytes",
  "size",
  "epoch",
  "token",
  "createdAt",
  "watermark",
  "extra",
])("rejects a publication write with invalid %s before recording any grant", async (kind) => {
  const { id, request } = await stage();
  if (kind === "key") request.key = backupManifestKey(crypto.randomUUID());
  if (kind === "part-index") request.key = request.key.replace("000000-", "131072-");
  if (kind === "part-hash") request.sha256 = "0".repeat(64);
  if (kind === "bytes") request.bytes = 0;
  if (kind === "size") request.bytes = BACKUP_CHUNK_BYTES + 1;
  if (kind === "epoch") request.generation.epoch++;
  if (kind === "token") request.generation.token = crypto.randomUUID();
  if (kind === "createdAt") request.generation.createdAt++;
  if (kind === "watermark") request.generation.watermark = "different";
  if (kind === "extra") Object.assign(request, { owner: "somebody" });
  await rejects((instance) => instance.grantBackupPublicationWrite(epoch, id, request), "backup_");
  await runInDurableObject(control(), (_, state) => {
    expect(state.storage.sql.exec("SELECT 1 FROM control_backup_writes").toArray()).toHaveLength(0);
  });
});

function delayedPrepared(effect: () => Promise<void>): D1Database {
  let delayed = false;
  return {
    prepare(sql: string) {
      const statement = env.DB.prepare(sql);
      if (!sql.startsWith("SELECT b.watermark")) return statement;
      const wrap = (statement: D1PreparedStatement): D1PreparedStatement =>
        new Proxy(statement, {
          get(target, key) {
            if (key === "bind") return (...values: unknown[]) => wrap(target.bind(...values));
            if (key === "first")
              return async () => {
                const result = await target.first();
                if (!delayed) {
                  delayed = true;
                  await effect();
                }
                return result;
              };
            const value = Reflect.get(target, key, target);
            return typeof value === "function" ? value.bind(target) : value;
          },
        });
      return wrap(statement);
    },
    batch: (statements: D1PreparedStatement[]) => env.DB.batch(statements),
  } as D1Database;
}

it.each(["release", "complete"])(
  "rejects a delayed grant after %s pins the generation",
  async (kind) => {
    const { id, request } = await stage();
    await runInDurableObject(control(), async (instance, state) => {
      const db = delayedPrepared(async () => {
        if (kind === "release") await instance.cancelBackup(epoch, id);
        else
          await expect(instance.completeBackup(epoch, id, "0".repeat(64))).rejects.toThrow(
            "backup_publication_unavailable",
          );
      });
      const delayed = new ControlDO(state, { ...env, DB: db });
      await expect(delayed.grantBackupPublicationWrite(epoch, id, request)).rejects.toThrow(
        kind === "release" ? "backup_conflict" : "backup_completion_in_progress",
      );
      expect(state.storage.sql.exec("SELECT 1 FROM control_backup_writes").toArray()).toHaveLength(
        0,
      );
    });
  },
);

it("rechecks pending writes after completion's D1 read before pinning its hash", async () => {
  const { id, request } = await stage();
  await runInDurableObject(control(), async (instance, state) => {
    const db = delayedPrepared(async () => {
      await instance.grantBackupPublicationWrite(epoch, id, request);
    });
    await expect(
      new ControlDO(state, { ...env, DB: db }).completeBackup(epoch, id, "0".repeat(64)),
    ).rejects.toThrow("backup_publication_write_unsettled");
    expect(
      state.storage.sql.exec("SELECT 1 FROM control_backup_publication WHERE id=?", id).toArray(),
    ).toHaveLength(0);
  });
  await frozen();
});
