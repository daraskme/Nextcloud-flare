import { applyD1Migrations, evictDurableObject, runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterEach, beforeAll, expect, it, vi } from "vitest";
import {
  type BackupGeneration,
  backupManifestKey,
  backupPartKey,
} from "../../../shared/src/backupPublication";
import { sha256 } from "../../src/backup/publication";
import { CONTROL_NAME, ControlDO } from "../../src/do/ControlDO";
import { publicationFixture } from "../fixtures/backupPublication";
import { injectBatch } from "../fixtures/uploadEnv";

const control = () => env.CONTROL.get(env.CONTROL.idFromName(CONTROL_NAME));
const epoch = 2,
  day = 86400000;
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
      .exec<{ id: string; epoch: number }>(
        "SELECT id,epoch FROM control_backup WHERE phase<>'released'",
      )
      .toArray()[0];
    if (active) {
      const p = state.storage.sql
        .exec<{ hash: string; phase: string }>(
          "SELECT hash,phase FROM control_backup_publication WHERE id=?",
          active.id,
        )
        .toArray()[0];
      if (p?.phase === "completing") await instance.completeBackup(active.epoch, active.id, p.hash);
      else await instance.cancelBackup(active.epoch, active.id);
    }
    state.storage.sql.exec("DELETE FROM control_backup_daily");
  });
});
async function finish(id: string) {
  await control().beginBackup(epoch, id);
  const generation = (await env.DB.prepare(
    "SELECT id,epoch,barrier_token AS token,created_at AS createdAt,watermark FROM backup_runs WHERE id=?",
  )
    .bind(id)
    .first<BackupGeneration>())!;
  const data = new TextEncoder().encode("daily publication fixture");
  const publication = await publicationFixture(generation, [data]);
  const bytes = new TextEncoder().encode(JSON.stringify(publication)),
    hash = await sha256(bytes);
  await env.BACKUPS.put(backupPartKey(id, 0, publication.parts[0]!.sha256), data);
  await env.BACKUPS.put(backupManifestKey(id), bytes);
  expect((await control().completeBackup(epoch, id, hash)).state).toBe("completed");
  return { generation, hash };
}
function gate() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { resolve, promise };
}

it("persists the server daily identity before begin and recovers it after eviction", async () => {
  const first = await control().planDailyBackup(epoch);
  expect(first).toMatchObject({ epoch, state: "run" });
  expect(await env.DB.prepare("SELECT COUNT(*) n FROM backup_runs").first("n")).toBe(0);
  expect(await env.DB.prepare("SELECT backup_frozen FROM control").first("backup_frozen")).toBe(0);
  await evictDurableObject(control());
  expect(await control().planDailyBackup(epoch)).toMatchObject({
    id: first.id,
    scheduledAt: first.scheduledAt,
    state: "run",
  });
});
it("retains an unstarted identity across UTC midnight instead of manufacturing a past snapshot", async () => {
  const first = await control().planDailyBackup(epoch);
  vi.spyOn(Date, "now").mockReturnValue((Math.floor(first.observedAt / day) + 2) * day + 1);
  const second = await control().planDailyBackup(epoch);
  expect(second).toMatchObject({ id: first.id, scheduledAt: first.scheduledAt, state: "run" });
  expect(second.observedAt).toBeGreaterThan(first.observedAt + day);
});
it("skips only a completed capture from the same UTC day and schedules the next day after eviction", async () => {
  const first = await control().planDailyBackup(epoch);
  const { generation, hash } = await finish(first.id);
  expect(await control().planDailyBackup(epoch)).toMatchObject({
    id: first.id,
    state: "completed",
    createdAt: generation.createdAt,
    manifestSha256: hash,
  });
  await evictDurableObject(control());
  expect((await control().planDailyBackup(epoch)).id).toBe(first.id);
  vi.spyOn(Date, "now").mockReturnValue((Math.floor(generation.createdAt / day) + 1) * day);
  const next = await control().planDailyBackup(epoch);
  expect(next.state).toBe("run");
  expect(next.id).not.toBe(first.id);
  expect(
    await env.DB.prepare("SELECT state FROM backup_runs WHERE id=?").bind(first.id).first("state"),
  ).toBe("completed");
});
it("resumes an active generation across midnight and uses capture day even if completion was delayed", async () => {
  const yesterday = (Math.floor(Date.now() / day) - 1) * day;
  vi.spyOn(Date, "now").mockReturnValue(yesterday);
  const first = await control().planDailyBackup(epoch);
  await control().beginBackup(epoch, first.id);
  vi.restoreAllMocks();
  expect(await control().planDailyBackup(epoch)).toMatchObject({ id: first.id, state: "run" });
  const { generation } = await finish(first.id);
  expect(generation.createdAt).toBe(yesterday);
  const next = await control().planDailyBackup(epoch);
  expect(next.state).toBe("run");
  expect(next.id).not.toBe(first.id);
});
it("keeps the identity when preparing fails before any D1 receipt exists", async () => {
  const first = await control().planDailyBackup(epoch);
  await runInDurableObject(control(), async (_, state) => {
    const failed = new ControlDO(state, {
      ...env,
      DB: injectBatch(
        (sql) => sql.includes("INSERT INTO backup_runs(id"),
        async () => {
          throw new Error("db_unavailable");
        },
        false,
      ),
    });
    await expect(failed.beginBackup(epoch, first.id)).rejects.toThrow();
  });
  expect(
    await env.DB.prepare("SELECT id FROM backup_runs WHERE id=?").bind(first.id).first(),
  ).toBeNull();
  await evictDurableObject(control());
  expect(await control().planDailyBackup(epoch)).toMatchObject({ id: first.id, state: "run" });
  expect((await control().beginBackup(epoch, first.id)).state).toBe("frozen");
});
it("does not adopt or cancel a manually started generation", async () => {
  const manual = crypto.randomUUID();
  await control().beginBackup(epoch, manual);
  await runInDurableObject(control(), async (instance) => {
    await expect(instance.planDailyBackup(epoch)).rejects.toThrow("backup_active");
  });
  expect(
    await env.DB.prepare("SELECT state FROM backup_runs WHERE id=?").bind(manual).first("state"),
  ).toBe("exporting");
  expect(await env.DB.prepare("SELECT backup_frozen FROM control").first("backup_frozen")).toBe(1);
});
it("retries a proven cancelled daily generation with a new identity while retaining its failed receipt", async () => {
  const first = await control().planDailyBackup(epoch);
  await control().beginBackup(epoch, first.id);
  await control().cancelBackup(epoch, first.id);
  const next = await control().planDailyBackup(epoch);
  expect(next.id).not.toBe(first.id);
  expect(next.state).toBe("run");
  expect(
    await env.DB.prepare("SELECT state FROM backup_runs WHERE id=?").bind(first.id).first("state"),
  ).toBe("failed");
});
it("does not replace a generation released without a completion receipt", async () => {
  const first = await control().planDailyBackup(epoch);
  await control().beginBackup(epoch, first.id);
  await control().releaseBackup(epoch, first.id);
  await runInDurableObject(control(), async (instance) => {
    await expect(instance.planDailyBackup(epoch)).rejects.toThrow("backup_daily_recovery_required");
  });
});
it("rejects a server clock rollback without changing the plan", async () => {
  const first = await control().planDailyBackup(epoch);
  vi.spyOn(Date, "now").mockReturnValue(first.scheduledAt - 1);
  await runInDurableObject(control(), async (instance) => {
    await expect(instance.planDailyBackup(epoch)).rejects.toThrow("backup_clock_conflict");
  });
  vi.restoreAllMocks();
  expect((await control().planDailyBackup(epoch)).id).toBe(first.id);
});
it("cannot overwrite a concurrently assigned daily identity after its D1 read returns", async () => {
  const entered = gate(),
    resume = gate();
  await runInDurableObject(control(), async (instance, state) => {
    const delayed = new ControlDO(state, {
      ...env,
      DB: injectBatch(
        (sql) => sql.includes("FROM backup_runs WHERE id=?"),
        async () => {
          entered.resolve();
          await resume.promise;
        },
        true,
      ),
    });
    const pending = delayed.planDailyBackup(epoch).then(
      (value) => ({ value }),
      (error) => ({ error }),
    );
    await entered.promise;
    let winner;
    try {
      winner = await instance.planDailyBackup(epoch);
    } finally {
      resume.resolve();
    }
    expect(await pending).toHaveProperty("error");
    expect((await instance.planDailyBackup(epoch)).id).toBe(winner!.id);
  });
});
it("rechecks manual backup ownership after the inventory read yields", async () => {
  const entered = gate(),
    resume = gate(),
    manual = crypto.randomUUID();
  await runInDurableObject(control(), async (instance, state) => {
    const delayed = new ControlDO(state, {
      ...env,
      DB: injectBatch(
        (sql) => sql.includes("FROM backup_runs WHERE id=?"),
        async () => {
          entered.resolve();
          await resume.promise;
        },
        true,
      ),
    });
    const pending = delayed.planDailyBackup(epoch).then(
      (value) => ({ value }),
      (error) => ({ error }),
    );
    await entered.promise;
    try {
      await instance.beginBackup(epoch, manual);
    } finally {
      resume.resolve();
    }
    expect(await pending).toHaveProperty("error");
    expect(state.storage.sql.exec("SELECT * FROM control_backup_daily").toArray()).toEqual([]);
  });
});
it.each([0, 1, 3, 1.5, NaN])("rejects an invalid/stale daily epoch %s", async (value) => {
  await runInDurableObject(control(), async (instance, state) => {
    await expect(instance.planDailyBackup(value)).rejects.toThrow();
    expect(state.storage.sql.exec("SELECT * FROM control_backup_daily").toArray()).toEqual([]);
  });
});
it("can replace an unstarted plan after a proven epoch change, and fences the old start", async () => {
  const first = await control().planDailyBackup(epoch);
  const recovered = await control().bumpEpoch(epoch, "operator");
  expect(recovered.epoch).toBe(epoch + 1);
  const next = await control().planDailyBackup(epoch + 1);
  expect(next.id).not.toBe(first.id);
  await runInDurableObject(control(), async (instance) => {
    await expect(instance.beginBackup(epoch, first.id)).rejects.toThrow("invalid_backup_request");
  });
});
