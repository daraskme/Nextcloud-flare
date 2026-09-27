import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { RESTORE_BACKUPS_PROBE_KEY as KEY } from "../../packages/shared/src/restoreBackups.ts";
import { S3BackupStore } from "../backup/objectStore.mjs";
import { verifyRestoreBackups } from "../restore/backups.mjs";
import { verifyRestoreBindings } from "../restore/bindings.mjs";
import { restoreControlCalls } from "../restore/control.mjs";
import { freezeRestoreDatabase } from "../restore/freeze.mjs";
import { restoreD1Reader } from "../restore/target.mjs";

let directory, id, c, target, source, reader, control, store, probe, blobs, backups;
const account = "a".repeat(32),
  value = "e".repeat(64),
  execute = promisify(execFile);
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "restore-backups-test-"));
  id = randomUUID();
  target = { mode: "remote", databaseId: randomUUID(), accountId: account };
  source = { accountId: account, bucket: "test-backups", jurisdiction: "default" };
  const issuedAt = Date.now();
  c = {
    id,
    epoch: 2,
    target,
    state: "d1_challenge",
    challengeId: randomUUID(),
    revision: 4,
    token: randomUUID(),
    issuedAt,
    expiresAt: issuedAt + 300000,
  };
  probe = {
    id,
    epoch: 2,
    target,
    source,
    state: "backups_challenge",
    challengeId: c.challengeId,
    revision: c.revision,
    attemptId: randomUUID(),
    issuedAt,
    expiresAt: issuedAt + 60000,
  };
  backups = {
    ...probe,
    state: "backups_verified",
    validator: "backups-binding-v1",
    verifiedAt: issuedAt,
  };
  delete backups.issuedAt;
  blobs = {
    ...backups,
    source: { ...source, bucket: "test-blobs" },
    state: "blobs_verified",
    validator: "r2-binding-v1",
    attemptId: randomUUID(),
    expiresAt: c.expiresAt,
  };
  reader = {
    target,
    backupsTarget: source,
    blobsTarget: blobs.source,
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
  store = {
    source: { account, bucket: source.bucket, jurisdiction: source.jurisdiction },
    readRestoreProbe: vi.fn(async () => Buffer.from(value)),
  };
  control = {
    inspect: vi.fn(async () => ({
      id,
      epoch: 2,
      state: "preparing",
      createdAt: issuedAt,
      source: { kind: "time_travel", bookmark: "opaque" },
    })),
    challengeD1: vi.fn(async () => structuredClone(c)),
    attestD1: vi.fn(async () => ({ ...blobs, state: "d1_verified", validator: "d1-mirror-v1" })),
    challengeBackups: vi.fn(async () => structuredClone(probe)),
    attestBackups: vi.fn(async () => structuredClone(backups)),
    verifyBlobs: vi.fn(async () => structuredClone(blobs)),
    verifyBindings: vi.fn(async () => ({
      id,
      epoch: 2,
      target,
      state: "bindings_verified",
      validator: "restore-bindings-v1",
      challengeId: c.challengeId,
      revision: c.revision,
      blobs: summary(blobs),
      backups: summary(backups),
      verifiedAt: issuedAt,
      expiresAt: probe.expiresAt,
    })),
    freeze: vi.fn(async () => ({
      id,
      epoch: 2,
      state: "frozen",
      createdAt: issuedAt,
      source: { kind: "time_travel", bookmark: "opaque" },
      targets: { target, blobs: blobs.source, backups: source },
      validator: "d1-write-freeze-v1",
      startedAt: issuedAt,
      frozenAt: issuedAt,
      token: "must-not-print",
      proof_json: "must-not-print",
    })),
    cancel: vi.fn(),
  };
});
afterEach(async () => {
  vi.restoreAllMocks();
  await rm(directory, { recursive: true, force: true });
});
const options = () => ({ epoch: 2, id, reader, control, store });
const verify = () => verifyRestoreBackups(options());
const summary = (p) => ({
  source: p.source,
  attemptId: p.attemptId,
  verifiedAt: p.verifiedAt,
  expiresAt: p.expiresAt,
});

it("reads the hidden nonce through S3 after D1 verification and filters the final output", async () => {
  control.attestBackups.mockResolvedValue({
    ...backups,
    nonce: value,
    token: c.token,
    credentials: "hidden",
  });
  expect(await verify()).toEqual(backups);
  expect(control.challengeBackups).toHaveBeenCalledExactlyOnceWith(2, id, c, source);
  expect(control.attestBackups).toHaveBeenCalledExactlyOnceWith(2, id, c, probe.attemptId, value);
  expect(control.attestD1.mock.invocationCallOrder[0]).toBeLessThan(
    control.challengeBackups.mock.invocationCallOrder[0],
  );
  expect(control.challengeBackups.mock.invocationCallOrder[0]).toBeLessThan(
    store.readRestoreProbe.mock.invocationCallOrder[0],
  );
  expect(control.cancel).not.toHaveBeenCalled();
});

it("verifies all three bindings with exactly one challenge and a final current-attempt check", async () => {
  const result = await verifyRestoreBindings(options());
  expect(result).toMatchObject({
    state: "bindings_verified",
    blobs: summary(blobs),
    backups: summary(backups),
  });
  expect(control.challengeD1).toHaveBeenCalledOnce();
  expect(control.verifyBlobs).toHaveBeenCalledExactlyOnceWith(2, id, c, blobs.source);
  expect(control.challengeBackups).toHaveBeenCalledExactlyOnceWith(2, id, c, source);
  expect(control.verifyBindings).toHaveBeenCalledExactlyOnceWith(
    2,
    id,
    c,
    blobs.attemptId,
    backups.attemptId,
  );
  expect(control.attestBackups.mock.invocationCallOrder[0]).toBeLessThan(
    control.verifyBindings.mock.invocationCallOrder[0],
  );
  expect(result).not.toHaveProperty("token");
});

it.each(["account", "bucket", "jurisdiction", "local", "same-bucket"])(
  "rejects mismatched %s before RPC",
  async (kind) => {
    if (kind === "local") reader.target = { mode: "local", databaseId: target.databaseId };
    else if (kind === "same-bucket") reader.blobsTarget = source;
    else
      store.source[kind] =
        kind === "account" ? "b".repeat(32) : kind === "bucket" ? "other-bucket" : "eu";
    await expect(verifyRestoreBindings(options())).rejects.toThrow(/database_restore_/);
    expect(control.inspect).not.toHaveBeenCalled();
    expect(store.readRestoreProbe).not.toHaveBeenCalled();
  },
);

it.each([1, 2, 3, 4])(
  "rejects configuration replacement at boundary %i without automatic cancellation",
  async (nth) => {
    let calls = 0;
    reader.assertUnchanged.mockImplementation(async () => {
      if (++calls === nth) throw new Error("database_restore_target_config_changed");
    });
    await expect(verify()).rejects.toThrow(/config_changed/);
    expect(control.attestBackups).toHaveBeenCalledTimes(nth === 4 ? 1 : 0);
    expect(control.cancel).not.toHaveBeenCalled();
  },
);

it.each([
  { state: "issued" },
  { attemptId: "bad" },
  { expiresAt: 0 },
  { issuedAt: 0 },
  { challengeId: randomUUID() },
  { revision: 1 },
])("rejects an invalid challenge %j before S3", async (change) => {
  control.challengeBackups.mockResolvedValue({ ...probe, ...change });
  await expect(verify()).rejects.toThrow(/invalid_backups_challenge/);
  expect(store.readRestoreProbe).not.toHaveBeenCalled();
});

it.each([null, Buffer.alloc(0), Buffer.alloc(65), Buffer.from("g".repeat(64))])(
  "rejects an invalid probe body %j",
  async (body) => {
    store.readRestoreProbe.mockResolvedValue(body);
    await expect(verify()).rejects.toThrow(/backups_mismatch/);
    expect(control.attestBackups).not.toHaveBeenCalled();
  },
);

it.each([
  { state: "issued" },
  { validator: "wrong" },
  { attemptId: randomUUID() },
  { verifiedAt: 0 },
  { expiresAt: 0 },
  { source: { accountId: account, bucket: "other-bucket", jurisdiction: "default" } },
])("rejects mismatched confirmation %j", async (change) => {
  control.attestBackups.mockResolvedValue({ ...backups, ...change });
  await expect(verify()).rejects.toThrow(/invalid_backups_proof/);
});

it("does not accept old attempts or partial completion as combined success", async () => {
  const good = await control.verifyBindings();
  control.verifyBindings.mockResolvedValue({
    ...good,
    backups: { ...good.backups, attemptId: randomUUID() },
  });
  await expect(verifyRestoreBindings(options())).rejects.toThrow(/invalid_bindings_proof/);
  control.attestBackups.mockRejectedValue(new Error("database_restore_backups_expired"));
  control.verifyBindings.mockClear();
  await expect(verifyRestoreBindings(options())).rejects.toThrow(/backups_expired/);
  expect(control.verifyBindings).not.toHaveBeenCalled();
});

it("restarts from a fresh challenge after an unknown attestation response", async () => {
  control.attestBackups.mockRejectedValueOnce(new Error("database_restore_operator_timeout"));
  await expect(verify()).rejects.toThrow(/operator_timeout/);
  c.challengeId = randomUUID();
  probe.challengeId = c.challengeId;
  backups.challengeId = c.challengeId;
  blobs.challengeId = c.challengeId;
  probe.attemptId = randomUUID();
  backups.attemptId = probe.attemptId;
  expect(await verify()).toMatchObject({ challengeId: c.challengeId, attemptId: probe.attemptId });
  expect(reader.readMirror).toHaveBeenCalledTimes(2);
  expect(store.readRestoreProbe).toHaveBeenCalledTimes(2);
});

it("freezes only after all fresh binding checks and redacts the returned barrier", async () => {
  const result = await freezeRestoreDatabase(options());
  expect(result).toMatchObject({ state: "frozen", validator: "d1-write-freeze-v1" });
  expect(result).not.toHaveProperty("token");
  expect(result).not.toHaveProperty("proof_json");
  expect(control.freeze).toHaveBeenCalledExactlyOnceWith(
    2,
    id,
    { target, blobs: blobs.source, backups: source },
    { challenge: c, blobsAttempt: blobs.attemptId, backupsAttempt: backups.attemptId },
  );
  expect(control.verifyBindings.mock.invocationCallOrder[0]).toBeLessThan(
    control.freeze.mock.invocationCallOrder[0],
  );
  expect(control.challengeD1).toHaveBeenCalledOnce();
});

it.each(["freezing", "frozen"])(
  "reconciles %s with the saved identity without creating new probes",
  async (state) => {
    const selected = await control.inspect();
    control.inspect.mockResolvedValue({ ...selected, state });
    expect(await freezeRestoreDatabase(options())).toMatchObject({ state: "frozen" });
    expect(control.freeze).toHaveBeenCalledExactlyOnceWith(
      2,
      id,
      { target, blobs: blobs.source, backups: source },
      undefined,
    );
    expect(control.challengeD1).not.toHaveBeenCalled();
    expect(store.readRestoreProbe).not.toHaveBeenCalled();
  },
);

it.each(["cancelled", "cancelling"])("refuses freeze while %s", async (state) => {
  control.inspect.mockResolvedValue({ ...(await control.inspect()), state });
  await expect(freezeRestoreDatabase(options())).rejects.toThrow(/freeze_conflict/);
  expect(control.freeze).not.toHaveBeenCalled();
});

it.each([
  { state: "freezing" },
  { validator: "other" },
  { frozenAt: 0 },
  { startedAt: 0 },
  { source: { kind: "time_travel", bookmark: "different" } },
])(
  "rejects invalid freeze output %j without cancelling a possibly committed barrier",
  async (change) => {
    control.freeze.mockResolvedValue({ ...(await control.freeze()), ...change });
    await expect(freezeRestoreDatabase(options())).rejects.toThrow(/invalid_freeze_proof/);
    expect(control.cancel).not.toHaveBeenCalled();
  },
);

it.each(["before", "after"])(
  "detects config changes %s freezing without automatic thaw",
  async (when) => {
    reader.assertUnchanged.mockImplementation(async () => {
      if (
        (when === "before" && control.verifyBindings.mock.calls.length) ||
        (when === "after" && control.freeze.mock.calls.length)
      )
        throw new Error("database_restore_target_config_changed");
    });
    await expect(freezeRestoreDatabase(options())).rejects.toThrow(/config_changed/);
    expect(control.freeze).toHaveBeenCalledTimes(when === "before" ? 0 : 1);
    expect(control.cancel).not.toHaveBeenCalled();
  },
);

async function configuration(change = () => {}) {
  const config = join(directory, "wrangler.json"),
    operatorConfig = join(directory, "operator.json");
  const value = {
    name: "restore-test",
    compatibility_date: "2026-08-15",
    account_id: account,
    vars: { ENVIRONMENT: "development" },
    d1_databases: [{ binding: "DB", database_name: "fixture", database_id: target.databaseId }],
    r2_buckets: [
      { binding: "BLOBS", bucket_name: "test-blobs" },
      { binding: "BACKUPS", bucket_name: "test-backups" },
    ],
  };
  change(value);
  await writeFile(config, JSON.stringify(value));
  await writeFile(
    operatorConfig,
    JSON.stringify({ service: value.name, environment: "development", accountId: account }),
  );
  return { config, operatorConfig, mode: "remote", backups: true, blobs: true };
}

it("pins both R2 targets while keeping the independent D1 query configuration minimal", async () => {
  const config = await configuration();
  const run = vi.fn(async (_node, args) => {
    const query = JSON.parse(await readFile(args[args.indexOf("--config") + 1], "utf8"));
    expect(query).not.toHaveProperty("r2_buckets");
    expect(query).not.toHaveProperty("vars");
    return { stdout: JSON.stringify([{ success: true, results: [] }]) };
  });
  const pinned = await restoreD1Reader(config, run);
  try {
    expect(pinned.backupsTarget).toEqual(source);
    expect(pinned.blobsTarget).toEqual(blobs.source);
    await pinned.readMirror();
    await writeFile(config.config, "{}");
    await expect(pinned.assertUnchanged()).rejects.toThrow(/config_changed/);
  } finally {
    await pinned.dispose();
  }
});

it.each(["missing", "duplicate", "same-bucket", "jurisdiction"])(
  "rejects unsafe BACKUPS config %s before proxy construction",
  async (kind) => {
    const config = await configuration((v) => {
      if (kind === "missing") v.r2_buckets.pop();
      if (kind === "duplicate")
        v.r2_buckets.push({ binding: "BACKUPS", bucket_name: "other-bucket" });
      if (kind === "same-bucket") v.r2_buckets[1].bucket_name = "test-blobs";
      if (kind === "jurisdiction") v.r2_buckets[1].jurisdiction = "unknown";
    });
    await expect(restoreD1Reader(config)).rejects.toThrow();
  },
);

const s3Env = {
  R2_BACKUP_ACCOUNT_ID: account,
  R2_BACKUP_BUCKET: "test-backups",
  R2_BACKUP_ACCESS_KEY_ID: "b".repeat(32),
  R2_BACKUP_SECRET_ACCESS_KEY: "c".repeat(64),
};
it("adds only a signed fixed-key GET, keeping backup PUT and general GET key restrictions", async () => {
  const transport = vi.fn(async (request) => {
    expect(request.method).toBe("GET");
    expect(request.url).toBe(`https://${account}.r2.cloudflarestorage.com/test-backups/${KEY}`);
    expect(request.headers.get("authorization")).toMatch(/^AWS4-HMAC-SHA256 /);
    return new Response(value);
  });
  const s3 = new S3BackupStore(s3Env, { fetch: transport, timeoutMs: 1000 });
  expect(await s3.readRestoreProbe()).toEqual(Buffer.from(value));
  expect(() => s3.put(KEY, Buffer.from(value))).toThrow(/invalid_object_key/);
  await expect(s3.get(KEY, 64)).rejects.toThrow(/invalid_object_key/);
  expect(transport).toHaveBeenCalledOnce();
});

it.each(["redirect", "oversize", "http", "timeout"])(
  "bounds probe S3 reads on %s",
  async (kind) => {
    const s3 = new S3BackupStore(s3Env, {
      timeoutMs: 5,
      fetch: async () => {
        if (kind === "timeout") return new Promise(() => {});
        return kind === "redirect"
          ? new Response(null, { status: 302 })
          : kind === "http"
            ? new Response(null, { status: 403 })
            : new Response("a".repeat(65));
      },
    });
    await expect(s3.readRestoreProbe()).rejects.toThrow(/backup_store_|backup_object_size/);
  },
);

it("redacts and bounds backup verification and freeze RPCs", async () => {
  for (const method of ["challengeBackups", "attestBackups", "verifyBindings", "freeze"]) {
    await expect(
      restoreControlCalls({
        [method]: async () => {
          throw new Error("hidden secret");
        },
      })[method](),
    ).rejects.toThrow(/^database_restore_operator_unavailable$/);
    await expect(
      restoreControlCalls({ [method]: () => new Promise(() => {}) }, 5)[method](),
    ).rejects.toThrow(/operator_timeout/);
  }
});

it.each(["verify-backups", "verify-bindings", "freeze"])(
  "requires explicit remote and target configuration for %s",
  async (command) => {
    for (const args of [
      ["--local", "--config", "missing"],
      ["--remote"],
      ["--remote", "--config", "missing", "--timestamp", "2026-09-01T00:00:00.000Z"],
    ]) {
      await expect(
        execute(
          process.execPath,
          [
            "scripts/database-restore.mjs",
            command,
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
    }
  },
);
