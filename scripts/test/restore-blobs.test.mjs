import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { restoreBlobsTarget } from "../../packages/shared/src/restoreBlobs.ts";
import { RESTORE_D1_WINDOW_MS } from "../../packages/shared/src/restoreTarget.ts";
import { verifyRestoreBlobs } from "../restore/blobs.mjs";
import { restoreControlCalls } from "../restore/control.mjs";
import { restoreD1Reader } from "../restore/target.mjs";

const execute = promisify(execFile);
let directory, id, target, source, c, selected, control, reader;
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "restore-blobs-test-"));
  id = randomUUID();
  target = { mode: "remote", databaseId: randomUUID(), accountId: "a".repeat(32) };
  source = { accountId: target.accountId, bucket: "test-blobs", jurisdiction: "default" };
  const issuedAt = Date.now();
  c = {
    id,
    epoch: 2,
    target,
    state: "d1_challenge",
    challengeId: randomUUID(),
    revision: 12,
    token: randomUUID(),
    issuedAt,
    expiresAt: issuedAt + RESTORE_D1_WINDOW_MS,
  };
  selected = {
    id,
    epoch: 2,
    source: { kind: "time_travel", bookmark: "opaque" },
    state: "preparing",
    createdAt: issuedAt,
  };
  control = {
    inspect: vi.fn(async () => structuredClone(selected)),
    challengeD1: vi.fn(async () => structuredClone(c)),
    attestD1: vi.fn(async () => ({ ...proof(), state: "d1_verified", validator: "d1-mirror-v1" })),
    verifyBlobs: vi.fn(async () => proof()),
    cancel: vi.fn(),
  };
  reader = {
    target,
    blobsTarget: source,
    assertUnchanged: vi.fn(async () => {}),
    readMirror: vi.fn(async () => [
      {
        epoch: 2,
        maintenance: 1,
        gc_paused: 1,
        admission_revision: c.revision,
        admission_token: c.token,
        backup_frozen: 0,
        backup_token: null,
      },
    ]),
  };
});
afterEach(async () => {
  vi.restoreAllMocks();
  await rm(directory, { recursive: true, force: true });
});
const verify = () => verifyRestoreBlobs({ epoch: 2, id, control, reader });
function proof() {
  return {
    id,
    epoch: 2,
    target,
    source,
    state: "blobs_verified",
    validator: "r2-binding-v1",
    challengeId: c.challengeId,
    attemptId: randomUUID(),
    revision: c.revision,
    verifiedAt: c.issuedAt,
    expiresAt: c.expiresAt,
  };
}

it("requires fresh D1 verification before the server probe and strips secrets from output", async () => {
  const saved = proof();
  control.verifyBlobs.mockResolvedValue({
    ...saved,
    token: c.token,
    nonce: "hidden",
    credentials: "hidden",
  });
  expect(await verify()).toEqual(saved);
  expect(control.verifyBlobs).toHaveBeenCalledExactlyOnceWith(2, id, c, source);
  expect(control.attestD1.mock.invocationCallOrder[0]).toBeLessThan(
    control.verifyBlobs.mock.invocationCallOrder[0],
  );
  expect(reader.assertUnchanged).toHaveBeenCalledTimes(3);
  expect(control.cancel).not.toHaveBeenCalled();
});

it("accepts both logical and Time Travel requests without claiming SQL or bookmark verification", async () => {
  selected.source = { kind: "logical", id: randomUUID(), epoch: 1, manifestSha256: "a".repeat(64) };
  expect(await verify()).toMatchObject({ state: "blobs_verified" });
});

it.each(["local", "account", "cancelled", "mirror", "D1 proof"])(
  "rejects invalid %s before the probe",
  async (kind) => {
    if (kind === "local") reader.target = { mode: "local", databaseId: target.databaseId };
    if (kind === "account") reader.blobsTarget = { ...source, accountId: "b".repeat(32) };
    if (kind === "cancelled") selected.state = "cancelled";
    if (kind === "mirror") reader.readMirror.mockResolvedValue([]);
    if (kind === "D1 proof") control.attestD1.mockResolvedValue({});
    await expect(verify()).rejects.toThrow(/database_restore_/);
    expect(control.verifyBlobs).not.toHaveBeenCalled();
    expect(control.cancel).not.toHaveBeenCalled();
  },
);

it.each([1, 2, 3])("rejects changed configuration at boundary %i", async (nth) => {
  let calls = 0;
  reader.assertUnchanged.mockImplementation(async () => {
    if (++calls === nth) throw new Error("database_restore_target_config_changed");
  });
  await expect(verify()).rejects.toThrow(/target_config_changed/);
  expect(control.verifyBlobs).toHaveBeenCalledTimes(nth === 3 ? 1 : 0);
  expect(control.cancel).not.toHaveBeenCalled();
});

it("re-verifies D1 and probes again after an uncertain response", async () => {
  control.verifyBlobs.mockRejectedValueOnce(new Error("database_restore_operator_timeout"));
  await expect(verify()).rejects.toThrow(/operator_timeout/);
  c.challengeId = randomUUID();
  c.token = randomUUID();
  expect(await verify()).toMatchObject({ challengeId: c.challengeId });
  expect(reader.readMirror).toHaveBeenCalledTimes(2);
  expect(control.verifyBlobs).toHaveBeenCalledTimes(2);
});

it.each([
  { id: "wrong" },
  { epoch: 1 },
  { target: { mode: "local", databaseId: randomUUID() } },
  { source: { accountId: "a".repeat(32), bucket: "other-bucket", jurisdiction: "default" } },
  { state: "preparing" },
  { validator: "other" },
  { attemptId: "bad" },
  { challengeId: randomUUID() },
  { revision: 1 },
  { verifiedAt: 0 },
  { expiresAt: 0 },
])("rejects mismatched probe response %j", async (change) => {
  control.verifyBlobs.mockResolvedValue({ ...proof(), ...change });
  await expect(verify()).rejects.toThrow(/invalid_blobs_proof/);
});

it.each([
  null,
  [],
  {},
  { accountId: "bad", bucket: "test", jurisdiction: "default" },
  { accountId: "a".repeat(32), bucket: "../other", jurisdiction: "default" },
  { accountId: "a".repeat(32), bucket: "test", jurisdiction: "unknown" },
  {
    accountId: "a".repeat(32),
    bucket: "test",
    jurisdiction: "default",
    endpoint: "https://untrusted.invalid",
  },
])("rejects unsafe or incomplete target %j", (value) => {
  expect(() => restoreBlobsTarget(value)).toThrow(/invalid_blobs_target/);
});

async function configuration(change = () => {}) {
  const config = join(directory, "wrangler.json"),
    operatorConfig = join(directory, "operator.json");
  const value = {
    name: "restore-test",
    compatibility_date: "2026-08-15",
    vars: { ENVIRONMENT: "development" },
    account_id: target.accountId,
    d1_databases: [{ binding: "DB", database_name: "fixture", database_id: target.databaseId }],
    r2_buckets: [{ binding: "BLOBS", bucket_name: "test-blobs" }],
  };
  change(value);
  await writeFile(config, JSON.stringify(value));
  await writeFile(
    operatorConfig,
    JSON.stringify({
      service: "restore-test",
      environment: "development",
      accountId: target.accountId,
    }),
  );
  return { config, operatorConfig, mode: "remote", blobs: true };
}

it.each(["default", "eu", "us", "fedramp"])(
  "pins the configured BLOBS bucket and %s jurisdiction without copying bindings or secrets",
  async (jurisdiction) => {
    const options = await configuration((value) => {
      value.r2_buckets[0].jurisdiction = jurisdiction;
    });
    const run = vi.fn(async (_node, args) => {
      const queryConfig = JSON.parse(await readFile(args[args.indexOf("--config") + 1], "utf8"));
      expect(queryConfig).not.toHaveProperty("r2_buckets");
      expect(queryConfig).not.toHaveProperty("vars");
      return { stdout: JSON.stringify([{ success: true, results: [] }]) };
    });
    const pinned = await restoreD1Reader(options, run);
    try {
      expect(pinned.blobsTarget).toEqual({ ...source, jurisdiction });
      await pinned.assertUnchanged();
      await pinned.readMirror();
      await writeFile(options.config, "{}");
      await expect(pinned.assertUnchanged()).rejects.toThrow(/target_config_changed/);
    } finally {
      await pinned.dispose();
    }
  },
);

it.each(["missing", "wrong", "duplicate"])(
  "rejects a %s BLOBS binding before RPC",
  async (kind) => {
    const options = await configuration((value) => {
      if (kind === "missing") value.r2_buckets = [];
      if (kind === "wrong") value.r2_buckets[0].binding = "BACKUPS";
      if (kind === "duplicate")
        value.r2_buckets.push({ ...value.r2_buckets[0], bucket_name: "other" });
    });
    await expect(restoreD1Reader(options)).rejects.toThrow();
  },
);

it("redacts private RPC errors and keeps unknown outcomes bounded", async () => {
  const binding = {
    verifyBlobs: vi.fn(async () => {
      throw new Error("private-key-secret");
    }),
  };
  await expect(restoreControlCalls(binding).verifyBlobs(2, id, c, source)).rejects.toThrow(
    /^database_restore_operator_unavailable$/,
  );
  binding.verifyBlobs.mockImplementation(() => new Promise(() => {}));
  await expect(restoreControlCalls(binding, 5).verifyBlobs(2, id, c, source)).rejects.toThrow(
    /operator_timeout/,
  );
});

it.each([
  ["--local", "--config", "missing"],
  ["--remote"],
  ["--remote", "--config", "missing", "--timestamp", "2026-09-01T00:00:00.000Z"],
])("rejects invalid verify-blobs CLI input before loading credentials: %j", async (...args) => {
  await expect(
    execute(
      process.execPath,
      [
        "scripts/database-restore.mjs",
        "verify-blobs",
        ...args,
        "--operator-config",
        "must-not-open.json",
        "--epoch",
        "2",
        "--id",
        id,
      ],
      { timeout: 10000 },
    ),
  ).rejects.toMatchObject({
    code: 1,
    stderr: expect.stringMatching(/^database_restore_invalid_arguments:/),
  });
});
