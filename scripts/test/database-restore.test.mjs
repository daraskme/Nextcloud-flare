import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { BACKUP_MAX_AGE_MS } from "../../packages/shared/src/backupRetention.ts";
import { digest, manifestKey, partKey } from "../backup/objectStore.mjs";
import { publishGeneration } from "../backup/publication.mjs";
import {
  restoreControlCalls,
  restoreOperatorConfig,
  restoreOperatorControl,
} from "../restore/control.mjs";
import { restoreStatus, verifyRestoreSelection } from "../restore/verify.mjs";
import { fixtureGeneration } from "./fixtures/backup.mjs";

let directory, artifact, source, selected, objects, store, control, publication, id;
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "restore-operator-test-"));
  artifact = await fixtureGeneration(join(directory, "generations"));
  objects = new Map();
  store = {
    get: vi.fn(async (key) => objects.get(key) ?? null),
    put: vi.fn(async (key, value) => {
      objects.set(key, Buffer.from(value));
      return true;
    }),
  };
  publication = await publishGeneration({ directory: artifact.directory, store });
  store.get.mockClear();
  store.put.mockClear();
  id = randomUUID();
  source = {
    kind: "logical",
    id: artifact.manifest.generation.id,
    epoch: 1,
    manifestSha256: publication.sha256,
  };
  selected = { id, epoch: 2, source, state: "preparing", createdAt: Date.now() };
  control = {
    inspect: vi.fn(async () => structuredClone(selected)),
    verify: vi.fn(async () => page()),
    attest: vi.fn(async () => ({
      id,
      epoch: 2,
      manifestSha256: source.manifestSha256,
      state: "sql_verified",
      validator: "logical-sql-v1",
      verifiedAt: Date.now(),
      expiresAt: page().expiresAt,
    })),
    cancel: vi.fn(),
    prepare: vi.fn(),
  };
});
afterEach(async () => {
  vi.restoreAllMocks();
  await rm(directory, { recursive: true, force: true });
});
function page(extra = {}) {
  return {
    id,
    epoch: 2,
    manifestSha256: source.manifestSha256,
    state: "parts_verified",
    partsVerified: 1,
    partsTotal: 1,
    observedAt: Date.now(),
    expiresAt: artifact.manifest.generation.createdAt + BACKUP_MAX_AGE_MS,
    ...extra,
  };
}
const verify = (extra = {}) => verifyRestoreSelection({ epoch: 2, id, control, store, ...extra });
function changePublication(change) {
  const found = JSON.parse(objects.get(manifestKey(source.id)));
  change(found);
  const bytes = Buffer.from(JSON.stringify(found));
  source.manifestSha256 = digest(bytes);
  objects.set(manifestKey(source.id), bytes);
}

it("downloads the pinned source, verifies actual SQL and records its hash only after success", async () => {
  const events = [];
  const result = await verify({ progress: (event) => events.push(event.stage) });
  expect(result).toMatchObject({
    id,
    epoch: 2,
    source,
    state: "sql_verified",
    complete: true,
    tables: 67,
    bytes: artifact.manifest.data.bytes,
    schemaSha256: artifact.manifest.schema.sha256,
    dataSha256: artifact.manifest.data.sha256,
  });
  expect(events).toEqual(["source_part_verified", "part_downloaded", "isolated_sql_verified"]);
  expect(control.attest).toHaveBeenCalledExactlyOnceWith(2, id, publication.sha256);
  expect(store.put).not.toHaveBeenCalled();
  expect(control.prepare).not.toHaveBeenCalled();
  expect(control.cancel).not.toHaveBeenCalled();
});

it("bounds one command to 100 server pages and resumes the existing cursor on the next command", async () => {
  let cursor = 0;
  control.verify.mockImplementation(async () =>
    page({
      state: "verifying",
      partsVerified: ++cursor,
      partsTotal: 102,
    }),
  );
  expect(await verify()).toEqual({
    id,
    epoch: 2,
    state: "verifying",
    complete: false,
    partsVerified: 100,
    partsTotal: 102,
  });
  expect(store.get).not.toHaveBeenCalled();
  expect(control.attest).not.toHaveBeenCalled();
  expect(await verify({ maxSteps: 1 })).toMatchObject({
    state: "verifying",
    partsVerified: 101,
    partsTotal: 102,
  });
  expect(control.verify).toHaveBeenCalledTimes(101);
  expect(control.attest).not.toHaveBeenCalled();
});

it.each([
  "missing manifest",
  "hash",
  "part",
  "schema",
  "table",
  "unsafe SQL",
  "source epoch",
  "expiry",
])("does not attest or cancel a source with invalid %s", async (kind) => {
  if (kind === "missing manifest") objects.delete(manifestKey(source.id));
  if (kind === "hash") source.manifestSha256 = "0".repeat(64);
  if (kind === "part")
    objects.set(
      [...objects.keys()].find((key) => key !== manifestKey(source.id)),
      Buffer.from("corrupt"),
    );
  if (kind === "schema")
    changePublication((p) => {
      p.manifest.schema.migrations[0].sha256 = "0".repeat(64);
    });
  if (kind === "table")
    changePublication((p) => {
      p.manifest.tables[0].rows++;
    });
  if (kind === "source epoch") source.epoch = 2;
  if (kind === "expiry")
    control.verify.mockResolvedValue(page({ expiresAt: page().expiresAt + 1 }));
  if (kind === "unsafe SQL")
    changePublication((p) => {
      const bytes = Buffer.from("DROP TABLE users;"),
        hash = digest(bytes);
      p.manifest.data = { file: "data.sql", bytes: bytes.length, sha256: hash };
      p.parts = [{ bytes: bytes.length, sha256: hash }];
      objects.set(partKey(source.id, 0, hash), bytes);
    });
  await expect(verify()).rejects.toThrow();
  expect(control.attest).not.toHaveBeenCalled();
  expect(control.cancel).not.toHaveBeenCalled();
  expect(store.put).not.toHaveBeenCalled();
});

it.each(["epoch", "id", "hash", "counts", "time", "state", "no progress"])(
  "rejects an invalid server verification %s before downloading or attesting",
  async (kind) => {
    const first = page({ state: "verifying", partsVerified: 1, partsTotal: 3 });
    const next = { ...first, partsVerified: 2 };
    if (kind === "epoch") next.epoch++;
    if (kind === "id") next.id = randomUUID();
    if (kind === "hash") next.manifestSha256 = "0".repeat(64);
    if (kind === "counts") next.partsTotal++;
    if (kind === "time") next.observedAt--;
    if (kind === "state") next.state = "parts_verified";
    if (kind === "no progress") next.partsVerified--;
    control.verify.mockResolvedValueOnce(first).mockResolvedValueOnce(next);
    await expect(verify()).rejects.toThrow("database_restore_invalid_progress");
    expect(store.get).not.toHaveBeenCalled();
    expect(control.attest).not.toHaveBeenCalled();
    expect(control.cancel).not.toHaveBeenCalled();
  },
);

it("refuses a cancelled request before storage reads", async () => {
  selected.state = "cancelled";
  await expect(verify()).rejects.toThrow("database_restore_not_preparing");
  expect(store.get).not.toHaveBeenCalled();
  expect(control.verify).not.toHaveBeenCalled();
});

it("can inspect existing Time Travel preparation but never treats its bookmark as logical SQL", async () => {
  selected.source = { kind: "time_travel", bookmark: "opaque-bookmark" };
  expect(restoreStatus(selected, 2, id)).toEqual(selected);
  await expect(verify()).rejects.toThrow("database_restore_source_unavailable");
  expect(control.verify).not.toHaveBeenCalled();
  expect(store.get).not.toHaveBeenCalled();
  expect(control.attest).not.toHaveBeenCalled();
});

it("keeps a cancellation or expiry during SQL validation authoritative at the final attestation", async () => {
  control.attest.mockRejectedValue(new Error("database_restore_not_preparing"));
  await expect(verify()).rejects.toThrow("database_restore_not_preparing");
  expect(control.attest).toHaveBeenCalledTimes(1);
  expect(control.cancel).not.toHaveBeenCalled();
});

it("revalidates SQL after an unknown attestation outcome before resending the same identity", async () => {
  control.attest.mockRejectedValueOnce(new Error("database_restore_operator_timeout"));
  await expect(verify()).rejects.toThrow("database_restore_operator_timeout");
  store.get.mockClear();
  expect((await verify()).complete).toBe(true);
  expect(store.get).toHaveBeenCalledWith(manifestKey(source.id), expect.any(Number));
  expect(control.attest.mock.calls).toEqual([
    [2, id, source.manifestSha256],
    [2, id, source.manifestSha256],
  ]);
  expect(control.cancel).not.toHaveBeenCalled();
});

it.each(["hash", "time", "expiry", "validator"])(
  "rejects an invalid attestation %s response",
  async (kind) => {
    control.attest.mockImplementation(async () => {
      const value = {
        id,
        epoch: 2,
        manifestSha256: source.manifestSha256,
        state: "sql_verified",
        validator: "logical-sql-v1",
        verifiedAt: Date.now(),
        expiresAt: page().expiresAt,
      };
      if (kind === "hash") value.manifestSha256 = "0".repeat(64);
      if (kind === "time") value.verifiedAt = 0;
      if (kind === "expiry") value.expiresAt++;
      if (kind === "validator") value.validator = "unknown";
      return value;
    });
    await expect(verify()).rejects.toThrow("database_restore_invalid_attestation");
    expect(control.cancel).not.toHaveBeenCalled();
  },
);

it.each([
  { service: "https://invalid.example", environment: "development" },
  { service: "worker", environment: "unknown" },
  { service: "worker", environment: "development", entrypoint: "BackupOperator" },
  { service: "worker", environment: "development", accountId: "a".repeat(32) },
])("rejects ambiguous local restore capabilities: %j", (input) => {
  expect(() => restoreOperatorConfig(input, "local")).toThrow(
    "database_restore_operator_unconfigured",
  );
});
it("requires a separate entrypoint, purpose and explicit account for remote restore access", () => {
  expect(() =>
    restoreOperatorConfig({ service: "worker", environment: "production" }, "remote"),
  ).toThrow();
  const config = restoreOperatorConfig(
    { service: "worker", environment: "production", accountId: "a".repeat(32) },
    "remote",
  );
  expect(config.services).toEqual([
    {
      binding: "RESTORE_CONTROL",
      service: "worker",
      entrypoint: "DatabaseRestoreOperator",
      remote: true,
      props: { purpose: "database-restore-v1", environment: "production" },
    },
  ]);
});
it("loads only the explicit restore capability and removes its temporary local config", async () => {
  const path = join(directory, "operator.json"),
    dispose = vi.fn();
  await writeFile(path, JSON.stringify({ service: "worker", environment: "development" }));
  let saved;
  const client = await restoreOperatorControl(path, "local", async (options) => {
    saved = options;
    expect(options).toMatchObject({ remoteBindings: false, persist: false, envFiles: [] });
    const config = JSON.parse(await readFile(options.configPath, "utf8"));
    expect(config.services).toHaveLength(1);
    expect(config.d1_databases).toBeUndefined();
    return { env: { RESTORE_CONTROL: control }, dispose };
  });
  expect(await client.inspect(2, id)).toEqual(selected);
  await client.dispose();
  expect(dispose).toHaveBeenCalledTimes(1);
  await expect(readFile(saved.configPath)).rejects.toMatchObject({ code: "ENOENT" });
});
it("redacts provider errors without retry or cancellation", async () => {
  const prepare = vi.fn().mockRejectedValue(new Error("https://signed.invalid/?secret=canary"));
  await expect(restoreControlCalls({ prepare }).prepare(2, id, source)).rejects.toThrow(
    /^database_restore_operator_unavailable$/,
  );
  expect(prepare).toHaveBeenCalledTimes(1);
});
it("treats an RPC timeout as unknown and consumes the late rejection", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  try {
    let fail;
    const prepare = vi.fn(
      () =>
        new Promise((_, reject) => {
          fail = reject;
        }),
    );
    const assertion = expect(
      restoreControlCalls({ prepare }, 100).prepare(2, id, source),
    ).rejects.toThrow("database_restore_operator_timeout");
    await vi.advanceTimersByTimeAsync(100);
    await assertion;
    fail(new Error("late provider canary"));
    await Promise.resolve();
    expect(prepare).toHaveBeenCalledTimes(1);
  } finally {
    vi.useRealTimers();
  }
});
it("rejects destructive or ambiguous CLI arguments before opening a capability", async () => {
  const exec = promisify(execFile);
  for (const args of [
    ["restore", "--remote"],
    ["prepare", "--local", "--remote"],
    ["verify", "--sql", "canary"],
  ]) {
    await expect(
      exec(process.execPath, ["scripts/database-restore.mjs", ...args]),
    ).rejects.toMatchObject({ code: 1, stderr: expect.not.stringContaining("canary") });
  }
});
