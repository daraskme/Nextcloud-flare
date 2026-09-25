import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { controlCalls, operatorConfig, operatorControl } from "../backup/control.mjs";
import { restoreGeneration } from "../backup/generation.mjs";
import { manifestKey } from "../backup/objectStore.mjs";
import { runBackup, runDailyBackup } from "../backup/operator.mjs";
import { publishGeneration } from "../backup/publication.mjs";
import { fixtureGeneration } from "./fixtures/backup.mjs";

let directory, artifact, id, control, store, objects, receipt, db, source;
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "backup-operator-test-"));
  artifact = await fixtureGeneration(join(directory, "generations"));
  id = artifact.manifest.generation.id;
  objects = new Map();
  store = {
    get: vi.fn(async (key) => objects.get(key) ?? null),
    put: vi.fn(async (key, bytes) => {
      if (objects.has(key)) return false;
      objects.set(key, Buffer.from(bytes));
      return true;
    }),
  };
  receipt = {
    id,
    epoch: 1,
    state: "exporting",
    releasedAt: null,
    completedAt: null,
    manifestKey: null,
    manifestSha256: null,
  };
  let partsVerified = 0;
  control = {
    receipt: vi.fn(async () => receipt),
    begin: vi.fn(async () => ({ id, epoch: 1, state: "frozen" })),
    cancel: vi.fn(),
    complete: vi.fn(async (epoch, generation, hash) => {
      const publication = JSON.parse(objects.get(manifestKey(id)));
      partsVerified = Math.min(partsVerified + 1, publication.parts.length);
      const state = partsVerified === publication.parts.length ? "completed" : "verifying";
      if (state === "completed")
        receipt = {
          ...receipt,
          state,
          manifestKey: manifestKey(id),
          manifestSha256: hash,
          releasedAt: Date.now(),
          completedAt: Date.now(),
        };
      return {
        id: generation,
        epoch,
        state,
        manifestSha256: hash,
        partsVerified,
        partsTotal: publication.parts.length,
      };
    }),
  };
  const target = join(directory, "source.sqlite");
  await restoreGeneration({ directory: artifact.directory, target });
  db = new DatabaseSync(target);
  source = {
    query: vi.fn(async (sql) =>
      sql === "SELECT name FROM d1_migrations ORDER BY id"
        ? artifact.manifest.schema.migrations.map(({ name }) => ({ name }))
        : db.prepare(sql).all(),
    ),
    export: vi.fn(async (path) =>
      writeFile(path, await readFile(join(artifact.directory, "data.sql"))),
    ),
  };
});
afterEach(async () => {
  db?.close();
  await rm(directory, { recursive: true, force: true });
});
const run = (extra = {}) =>
  runBackup({
    directory: join(directory, "generations"),
    id,
    epoch: 1,
    source,
    store,
    control,
    ...extra,
  });

function dailyPlan() {
  const createdAt = artifact.manifest.generation.createdAt;
  return {
    id,
    epoch: 1,
    scheduledAt: createdAt,
    observedAt: Date.now(),
    ...(receipt?.state === "completed"
      ? {
          state: "completed",
          createdAt,
          completedAt: receipt.completedAt,
          manifestSha256: receipt.manifestSha256,
        }
      : { state: "run" }),
  };
}
const daily = (extra = {}) =>
  runDailyBackup({
    directory: join(directory, "generations"),
    epoch: 1,
    source,
    store,
    control,
    ...extra,
  });

it("uses the durable daily identity and verifies all stored data before skipping the same day", async () => {
  control.daily = vi.fn(async () => dailyPlan());
  const first = await daily({ directory: join(directory, "daily") });
  expect(first).toMatchObject({ id, daily: true, skipped: false, state: "completed" });
  expect(control.begin).toHaveBeenCalledExactlyOnceWith(1, id);
  expect(source.export).toHaveBeenCalledTimes(1);
  store.get.mockClear();
  store.put.mockClear();
  control.complete.mockClear();
  const next = await daily({ directory: join(directory, "different-runner") });
  expect(next).toMatchObject({
    id,
    daily: true,
    skipped: true,
    manifestSha256: first.manifestSha256,
  });
  expect(next.bytes).toBeGreaterThan(0);
  expect(store.get).toHaveBeenCalledWith(manifestKey(id), expect.any(Number));
  expect(store.get.mock.calls.some(([key]) => key !== manifestKey(id))).toBe(true);
  expect(store.put).not.toHaveBeenCalled();
  expect(control.complete).not.toHaveBeenCalled();
  expect(control.begin).toHaveBeenCalledTimes(1);
  expect(control.cancel).not.toHaveBeenCalled();
});
it.each(["missing manifest", "missing part", "corrupt part"])(
  "rejects a completed daily generation with %s",
  async (kind) => {
    control.daily = vi.fn(async () => dailyPlan());
    await daily();
    const key =
      kind === "missing manifest"
        ? manifestKey(id)
        : [...objects.keys()].find((key) => key !== manifestKey(id));
    if (kind === "corrupt part") objects.set(key, Buffer.from("changed"));
    else objects.delete(key);
    await expect(daily()).rejects.toThrow();
    expect(control.begin).not.toHaveBeenCalled();
    expect(control.cancel).not.toHaveBeenCalled();
  },
);
it.each(["epoch", "state", "time", "scheduled", "id"])(
  "rejects an invalid daily %s plan before starting a generation",
  async (kind) => {
    const plan = dailyPlan();
    if (kind === "epoch") plan.epoch++;
    if (kind === "state") plan.state = "unknown";
    if (kind === "time") plan.observedAt = plan.scheduledAt - 1;
    if (kind === "scheduled") plan.scheduledAt = -1;
    if (kind === "id") plan.id = "invalid";
    control.daily = vi.fn(async () => plan);
    await expect(daily()).rejects.toThrow();
    expect(control.begin).not.toHaveBeenCalled();
    expect(control.receipt).not.toHaveBeenCalled();
    expect(store.put).not.toHaveBeenCalled();
    expect(control.cancel).not.toHaveBeenCalled();
  },
);
it.each(["hash", "completion", "future", "different day", "capture identity"])(
  "rejects a completed daily plan with mismatched %s",
  async (kind) => {
    await run();
    const plan = dailyPlan();
    if (kind === "hash") plan.manifestSha256 = "0".repeat(64);
    if (kind === "completion") plan.completedAt--;
    if (kind === "future") plan.createdAt = plan.observedAt + 1;
    if (kind === "different day") plan.observedAt += 86400000;
    if (kind === "capture identity") plan.createdAt--;
    control.daily = vi.fn(async () => plan);
    await expect(daily()).rejects.toThrow();
    expect(control.begin).not.toHaveBeenCalled();
    expect(control.cancel).not.toHaveBeenCalled();
  },
);
it("keeps a lost daily-planning acknowledgement uncertain without starting or cancelling", async () => {
  control.daily = vi.fn().mockRejectedValue(new Error("backup_operator_timeout"));
  await expect(daily()).rejects.toThrow("backup_operator_timeout");
  expect(control.begin).not.toHaveBeenCalled();
  expect(control.cancel).not.toHaveBeenCalled();
  expect(store.put).not.toHaveBeenCalled();
});
it("recovers published data after local disk loss without repeating begin or export", async () => {
  const saved = await publishGeneration({ directory: artifact.directory, store });
  await rm(artifact.directory, { recursive: true });
  const result = await run();
  expect(result).toMatchObject({ state: "completed", manifestSha256: saved.sha256 });
  expect(control.begin).not.toHaveBeenCalled();
  expect(source.export).not.toHaveBeenCalled();
  expect(control.cancel).not.toHaveBeenCalled();
  expect(JSON.parse(await readFile(join(artifact.directory, "manifest.json"), "utf8"))).toEqual(
    saved.manifest,
  );
});
it("refuses corrupt published data after local disk loss without re-capture or cancellation", async () => {
  await publishGeneration({ directory: artifact.directory, store });
  await rm(artifact.directory, { recursive: true });
  const key = [...objects.keys()].find((key) => key !== manifestKey(id));
  objects.set(key, Buffer.from("corrupt"));
  await expect(run()).rejects.toThrow();
  expect(control.begin).not.toHaveBeenCalled();
  expect(source.export).not.toHaveBeenCalled();
  expect(control.complete).not.toHaveBeenCalled();
  expect(control.cancel).not.toHaveBeenCalled();
});

it("resumes a verified artifact without re-beginning, publishes and confirms completion", async () => {
  const result = await run();
  expect(result.state).toBe("completed");
  expect(result.manifestSha256).toBe(receipt.manifestSha256);
  expect(control.begin).not.toHaveBeenCalled();
  expect(source.export).not.toHaveBeenCalled();
  expect(control.cancel).not.toHaveBeenCalled();
  expect(control.complete).toHaveBeenCalledTimes(1);
});
it("starts a fresh generation before extraction and retains it when export fails, then retries the same identity", async () => {
  const exportFile = source.export;
  source.export = vi
    .fn()
    .mockRejectedValueOnce(new Error("backup_export_unavailable"))
    .mockImplementation(exportFile);
  const options = { directory: join(directory, "new-generations") };
  await expect(run(options)).rejects.toThrow("backup_export_unavailable");
  expect(control.complete).not.toHaveBeenCalled();
  expect(control.cancel).not.toHaveBeenCalled();
  expect((await run(options)).state).toBe("completed");
  expect(control.begin).toHaveBeenNthCalledWith(2, 1, id);
});
it("does not extract or automatically cancel after an unknown begin result", async () => {
  control.begin.mockRejectedValue(new Error("backup_operator_timeout"));
  await expect(run({ directory: join(directory, "new") })).rejects.toThrow(
    "backup_operator_timeout",
  );
  expect(source.export).not.toHaveBeenCalled();
  expect(control.cancel).not.toHaveBeenCalled();
});
it("reconciles ControlDO after D1 committed but its completion acknowledgement was lost", async () => {
  const complete = control.complete;
  control.complete = vi.fn(async (...args) => {
    await complete(...args);
    throw new Error("backup_operator_timeout");
  });
  await expect(run()).rejects.toThrow("backup_operator_timeout");
  expect(receipt.state).toBe("completed");
  store.get.mockClear();
  control.complete = complete;
  expect((await run()).state).toBe("completed");
  expect(complete).toHaveBeenCalledTimes(2);
  expect(store.get).not.toHaveBeenCalled();
});
it("does not report success from a D1 receipt while ControlDO reconciliation still fails", async () => {
  await run();
  control.complete.mockRejectedValue(new Error("backup_operator_unavailable"));
  await expect(run()).rejects.toThrow("backup_operator_unavailable");
});
it("keeps partial publication after failure and does not complete until retry verifies it", async () => {
  store.put.mockRejectedValueOnce(new Error("offline"));
  await expect(run()).rejects.toThrow("backup_store_write_unknown");
  expect(control.complete).not.toHaveBeenCalled();
  expect(control.cancel).not.toHaveBeenCalled();
  expect((await run()).state).toBe("completed");
});
it("does not attest a changed SQL artifact", async () => {
  await writeFile(join(artifact.directory, "data.sql"), "INSERT INTO users(id) VALUES('invalid');");
  await expect(run()).rejects.toThrow();
  expect(store.put).not.toHaveBeenCalled();
  expect(control.complete).not.toHaveBeenCalled();
});
it.each(["failed", "released", "unrecognized", "identity"])(
  "rejects %s generation state without storage writes",
  async (kind) => {
    if (kind === "failed") receipt.state = "failed";
    if (kind === "released") receipt.releasedAt = 1;
    if (kind === "unrecognized") receipt = null;
    if (kind === "identity") receipt.epoch = 2;
    await expect(run()).rejects.toThrow();
    expect(store.put).not.toHaveBeenCalled();
    expect(control.begin).not.toHaveBeenCalled();
    expect(control.complete).not.toHaveBeenCalled();
  },
);
it.each(["hash", "count", "stalled"])("rejects %s completion replies", async (kind) => {
  const complete = control.complete;
  control.complete = vi.fn(async (...args) => {
    const result = await complete(...args);
    if (kind === "hash") result.manifestSha256 = "0".repeat(64);
    if (kind === "count") result.partsTotal++;
    if (kind === "stalled") Object.assign(result, { state: "verifying", partsVerified: 0 });
    return result;
  });
  await expect(run()).rejects.toThrow();
  expect(control.cancel).not.toHaveBeenCalled();
});
it("requires a matching final D1 receipt", async () => {
  control.receipt.mockImplementationOnce(async () => receipt).mockResolvedValue(null);
  await expect(run()).rejects.toThrow("backup_invalid_receipt");
});
// Windows CI needs >5s for fixture export and repeated full-SQL verification.
// This runner allowance does not change the operator's RPC or storage deadlines.
it("continues bounded completion pages for a SQL export larger than one R2 part", async () => {
  artifact = await fixtureGeneration(join(directory, "large"), 9);
  id = artifact.manifest.generation.id;
  receipt.id = id;
  const result = await run({ directory: join(directory, "large") });
  expect(result.state).toBe("completed");
  expect(control.complete).toHaveBeenCalledTimes(2);
}, 20_000);

it.each([
  { service: ["worker"], environment: "development" },
  { service: "https://evil.invalid", environment: "development" },
  { service: "worker", environment: "wrong" },
  { service: "worker", environment: "development", bindings: ["DB"] },
  { service: "worker", environment: "development", accountId: "a".repeat(32) },
])("rejects ambiguous local operator descriptors: %j", (input) => {
  expect(() => operatorConfig(input, "local")).toThrow("backup_operator_unconfigured");
});
it("requires an explicit account for remote capability access", () => {
  expect(() =>
    operatorConfig({ service: "worker", environment: "production" }, "remote"),
  ).toThrow();
  const config = operatorConfig(
    { service: "worker", environment: "production", accountId: "a".repeat(32) },
    "remote",
  );
  expect(config.services[0]).toMatchObject({
    entrypoint: "BackupOperator",
    remote: true,
    props: { purpose: "logical-backup-v1", environment: "production" },
  });
});
it("loads only the explicit service capability, forbids remote bindings locally and disposes temporary config", async () => {
  const path = join(directory, "operator.json");
  await writeFile(path, JSON.stringify({ service: "worker", environment: "development" }));
  let saved;
  const dispose = vi.fn();
  const client = await operatorControl(path, "local", async (options) => {
    saved = options;
    expect(options).toMatchObject({ remoteBindings: false, persist: false, envFiles: [] });
    const config = JSON.parse(await readFile(options.configPath, "utf8"));
    expect(config.services).toHaveLength(1);
    expect(config.d1_databases).toBeUndefined();
    return { env: { BACKUP_CONTROL: control }, dispose };
  });
  expect(await client.receipt(1, id)).toEqual(receipt);
  await client.dispose();
  expect(dispose).toHaveBeenCalledTimes(1);
  await expect(readFile(saved.configPath)).rejects.toMatchObject({ code: "ENOENT" });
});
it("redacts provider errors and does not retry the RPC", async () => {
  const begin = vi.fn().mockRejectedValue(new Error("https://signed.invalid/?secret=canary"));
  await expect(controlCalls({ begin }).begin(1, id)).rejects.toThrow(
    /^backup_operator_unavailable$/,
  );
  expect(begin).toHaveBeenCalledTimes(1);
});
it("times out an uncertain RPC without cancellation and consumes its late rejection", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  try {
    let entered, fail;
    const started = new Promise((resolve) => {
      entered = resolve;
    });
    const begin = vi.fn(() => {
      entered();
      return new Promise((_, reject) => {
        fail = reject;
      });
    });
    const rejected = expect(controlCalls({ begin }, 100).begin(1, id)).rejects.toThrow(
      "backup_operator_timeout",
    );
    await started;
    await vi.advanceTimersByTimeAsync(100);
    await rejected;
    fail(new Error("late provider canary"));
    await Promise.resolve();
    expect(begin).toHaveBeenCalledTimes(1);
  } finally {
    vi.useRealTimers();
  }
});
