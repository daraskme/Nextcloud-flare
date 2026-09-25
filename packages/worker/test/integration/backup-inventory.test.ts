import { applyD1Migrations, evictDurableObject, runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterEach, beforeAll, expect, it, vi } from "vitest";
import { backupManifestKey } from "../../../shared/src/backupPublication";
import type { BackupInventoryCursor } from "../../../shared/src/backupRetention";
import { CONTROL_NAME, ControlDO } from "../../src/do/ControlDO";
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
    const row = state.storage.sql
      .exec<{ id: string; epoch: number }>(
        "SELECT id,epoch FROM control_backup WHERE phase<>'released'",
      )
      .toArray()[0];
    if (row) await instance.cancelBackup(row.epoch, row.id);
  });
  await env.DB.prepare("DELETE FROM backup_runs").run();
});
async function seed(n: number) {
  const ids = Array.from(
    { length: n },
    (_, i) => `00000000-0000-0000-0000-${String(i).padStart(12, "0")}`,
  );
  for (let start = 0; start < ids.length; start += 50)
    await env.DB.batch(
      ids.slice(start, start + 50).map((id) =>
        env.DB.prepare(
          `INSERT INTO backup_runs(id,epoch,state,created_at,completed_at,released_at,barrier_token,manifest_key,manifest_sha256)
    VALUES(?,1,'completed',1,2,2,?,?,?)`,
        ).bind(id, crypto.randomUUID(), backupManifestKey(id), "a".repeat(64)),
      ),
    );
  return ids;
}
const rejects = (cursor: unknown) =>
  runInDurableObject(control(), async (instance) => {
    await expect(
      instance.inspectBackupInventory(epoch, cursor as BackupInventoryCursor),
    ).rejects.toThrow();
  });

it("inspects an empty source without creating a backup, changing admission or planning a daily identity", async () => {
  const before = await control().status();
  const result = await control().inspectBackupInventory(epoch);
  expect(result).toMatchObject({
    epoch,
    rows: [],
    next: null,
    active: null,
    snapshot: { token: null, phase: null },
  });
  expect(result.observedAt).toBeGreaterThanOrEqual(result.snapshot.at);
  expect(await control().status()).toEqual(before);
  await runInDurableObject(control(), (_, state) => {
    expect(state.storage.sql.exec("SELECT * FROM control_backup_daily").toArray()).toEqual([]);
  });
});
it("paginates every receipt with the primary-key cursor, including old epochs and equal creation times", async () => {
  const ids = await seed(205);
  const first = await control().inspectBackupInventory(epoch);
  expect(first.rows).toHaveLength(100);
  expect(first.next).toEqual({ ...first.snapshot, after: ids[99] });
  await evictDurableObject(control());
  const second = await control().inspectBackupInventory(epoch, first.next!);
  const third = await control().inspectBackupInventory(epoch, second.next!);
  expect(second.rows).toHaveLength(100);
  expect(third.rows).toHaveLength(5);
  expect(third.next).toBeNull();
  expect([...first.rows, ...second.rows, ...third.rows].map((r) => r.id)).toEqual(ids);
  const final = await control().inspectBackupInventory(epoch, {
    ...first.snapshot,
    after: ids.at(-1)!,
  });
  expect(final.rows).toEqual([]);
  expect(final.snapshot).toEqual(first.snapshot);
  expect(final.observedAt).toBeGreaterThanOrEqual(first.observedAt);
});
it("reports an active preparing intent before a D1 receipt exists", async () => {
  const id = crypto.randomUUID();
  await runInDurableObject(control(), async (_, state) => {
    const failed = new ControlDO(state, {
      ...env,
      DB: injectBatch(
        (sql) => sql.includes("INSERT INTO backup_runs(id"),
        async () => {
          throw new Error("offline");
        },
        false,
      ),
    });
    await expect(failed.beginBackup(epoch, id)).rejects.toThrow();
  });
  const result = await control().inspectBackupInventory(epoch);
  expect(result.rows).toEqual([]);
  expect(result.active).toMatchObject({ id, epoch, phase: "preparing" });
});
it("reports a frozen generation without releasing the write barrier", async () => {
  const id = crypto.randomUUID();
  await control().beginBackup(epoch, id);
  const result = await control().inspectBackupInventory(epoch);
  expect(result.active).toMatchObject({ id, epoch, phase: "frozen" });
  expect(result.rows).toMatchObject([{ id, state: "exporting" }]);
  expect(await env.DB.prepare("SELECT backup_frozen FROM control").first("backup_frozen")).toBe(1);
});
it("invalidates a scan after another generation changes the durable backup authority", async () => {
  const first = await control().inspectBackupInventory(epoch);
  await control().beginBackup(epoch, crypto.randomUUID());
  await rejects({ ...first.snapshot, after: null });
});
it("rechecks authority after its D1 inventory read yields", async () => {
  let resume!: () => void, entered!: () => void;
  const pause = new Promise<void>((r) => {
      resume = r;
    }),
    ready = new Promise<void>((r) => {
      entered = r;
    });
  await runInDurableObject(control(), async (instance, state) => {
    const delayed = new ControlDO(state, {
      ...env,
      DB: injectBatch(
        (sql) => sql.includes("FROM backup_runs WHERE id>"),
        async () => {
          entered();
          await pause;
        },
        true,
      ),
    });
    const pending = delayed.inspectBackupInventory(epoch).then(
      (value) => ({ value }),
      (error) => ({ error }),
    );
    await ready;
    try {
      await instance.beginBackup(epoch, crypto.randomUUID());
    } finally {
      resume();
    }
    expect(await pending).toHaveProperty("error");
  });
});
it.each(["after", "negative", "future", "missing", "null", "token", "phase", "extra"])(
  "rejects invalid %s inventory cursors",
  async (kind) => {
    const first = await control().inspectBackupInventory(epoch);
    const cursor: Record<string, unknown> = { ...first.snapshot, after: null };
    if (kind === "after") cursor.after = "not-a-generation";
    if (kind === "negative") cursor.at = -1;
    if (kind === "future") cursor.at = Date.now() + 86400000;
    if (kind === "missing") delete cursor.at;
    if (kind === "null") cursor.at = null;
    if (kind === "token") cursor.token = crypto.randomUUID();
    if (kind === "phase") cursor.phase = "unknown";
    if (kind === "extra") cursor.limit = 100000;
    await rejects(cursor);
  },
);
it("rejects server clock rollback during a scan", async () => {
  const first = await control().inspectBackupInventory(epoch);
  vi.spyOn(Date, "now").mockReturnValue(first.snapshot.at - 1);
  await rejects({ ...first.snapshot, after: null });
});
it.each(["epoch", "freeze", "token"])(
  "refuses inconsistent D1 %s inventory mirrors",
  async (kind) => {
    await runInDurableObject(control(), async (_, state) => {
      const db = {
        prepare: env.DB.prepare.bind(env.DB),
        async batch(statements: D1PreparedStatement[]) {
          const result = await env.DB.batch<Record<string, unknown>>(statements);
          const mirror = result[0]!.results[0]!;
          if (kind === "epoch") mirror.epoch = epoch + 1;
          if (kind === "freeze") mirror.backup_frozen = 1;
          if (kind === "token") mirror.backup_token = crypto.randomUUID();
          return result;
        },
      } as D1Database;
      await expect(
        new ControlDO(state, { ...env, DB: db }).inspectBackupInventory(epoch),
      ).rejects.toThrow("backup_mirror_conflict");
    });
  },
);
it.each([0, 1, 3, 1.5, NaN])("rejects invalid or stale inventory epoch %s", async (value) => {
  await runInDurableObject(control(), async (instance) => {
    await expect(instance.inspectBackupInventory(value)).rejects.toThrow();
  });
});
