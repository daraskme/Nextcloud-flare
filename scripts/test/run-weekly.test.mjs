import { createHash, generateKeyPairSync } from "node:crypto";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { runWeeklyCli, weeklyBackupConfig } from "../../ops/backup/run-weekly.mjs";

let root, env, storageFactory, runtimeFactory, runner, calls;
const posixIt = it.skipIf(process.platform === "win32");
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "ncf-run-weekly-"));
  for (const name of ["state", "work", "mount", "mount/archives"])
    await mkdir(join(root, name), { mode: 0o700 });
  const publicKeyFile = join(root, "admin-public.json");
  const { publicKey } = generateKeyPairSync("rsa", { modulusLength: 3072 });
  const spki = publicKey.export({ type: "spki", format: "der" });
  const recipient = {
    spki: spki.toString("base64url"),
    fingerprint: createHash("sha256").update(spki).digest("base64url"),
  };
  await writeFile(
    publicKeyFile,
    JSON.stringify({ version: 1, accountId: "admin_fixture", recipient }),
    { mode: 0o600 },
  );
  env = {
    NCF_BACKUP_STATE_ROOT: join(root, "state"),
    NCF_BACKUP_WORK_ROOT: join(root, "work"),
    NCF_BACKUP_EXTERNAL_ROOT: join(root, "mount/archives"),
    NCF_BACKUP_MOUNT_POINT: join(root, "mount"),
    NCF_BACKUP_VOLUME_UUID: "ABCD-1234",
    NCF_BACKUP_PUBLIC_KEY_FILE: publicKeyFile,
    NCF_BACKUP_ACCOUNT_ID: "admin_fixture",
  };
  calls = [];
  storageFactory = vi.fn((config) => ({
    verifyStorage: vi.fn(async (path) => {
      calls.push(["local-storage", path]);
    }),
    publishArchive: vi.fn(),
    verifyArchive: vi.fn(),
  }));
  runtimeFactory = vi.fn((config) => {
    calls.push(["runtime-configured", Boolean(config.env), config.workRoot]);
    return {
      verifyStorage: config.verifyStorage,
      verifyArchive: config.verifyArchive,
      publishArchive: config.publishArchive,
    };
  });
  runner = vi.fn(async (options) => {
    calls.push(["runner", options.stateRoot]);
    return { phase: "completed" };
  });
});
afterEach(async () => rm(root, { recursive: true, force: true }));
const invoke = (mode) => runWeeklyCli({ mode, env, storageFactory, runtimeFactory, runner });

posixIt(
  "preflights private paths, pinned admin public key and mount without running a backup",
  async () => {
    expect(await invoke("check")).toEqual({ status: "ready" });
    expect(storageFactory).toHaveBeenCalledWith({
      mountPoint: env.NCF_BACKUP_MOUNT_POINT,
      volumeUuid: env.NCF_BACKUP_VOLUME_UUID,
      backupRoot: env.NCF_BACKUP_EXTERNAL_ROOT,
      publicKeyFile: env.NCF_BACKUP_PUBLIC_KEY_FILE,
      accountId: env.NCF_BACKUP_ACCOUNT_ID,
    });
    expect(calls).toEqual([
      ["runtime-configured", true, env.NCF_BACKUP_WORK_ROOT],
      ["local-storage", env.NCF_BACKUP_EXTERNAL_ROOT],
    ]);
    expect(runner).not.toHaveBeenCalled();
  },
);

posixIt(
  "runs only after local preflight and passes the existing runtime to the durable runner",
  async () => {
    expect(await invoke("run")).toEqual({ status: "completed" });
    expect(calls).toEqual([
      ["runtime-configured", true, env.NCF_BACKUP_WORK_ROOT],
      ["runner", env.NCF_BACKUP_STATE_ROOT],
    ]);
    expect(runner.mock.calls[0][0]).toMatchObject({
      stateRoot: env.NCF_BACKUP_STATE_ROOT,
      workRoot: env.NCF_BACKUP_WORK_ROOT,
      backupRoot: env.NCF_BACKUP_EXTERNAL_ROOT,
    });
    expect(runner.mock.calls[0][0].runtime.verifyArchive).toBe(
      storageFactory.mock.results[0].value.verifyArchive,
    );
  },
);

posixIt(
  "rejects wrong public identity, insecure key mode, external internal path and missing config before runtime",
  async () => {
    await expect(invoke("unknown")).rejects.toThrow("backup_weekly_unconfigured");
    env.NCF_BACKUP_ACCOUNT_ID = "other_admin";
    await expect(invoke("check")).rejects.toThrow("backup_archive_public_key_invalid");
    env.NCF_BACKUP_ACCOUNT_ID = "admin_fixture";
    await chmod(env.NCF_BACKUP_PUBLIC_KEY_FILE, 0o644);
    await expect(invoke("check")).rejects.toThrow("backup_archive_public_key_invalid");
    await chmod(env.NCF_BACKUP_PUBLIC_KEY_FILE, 0o600);
    env.NCF_BACKUP_WORK_ROOT = env.NCF_BACKUP_EXTERNAL_ROOT;
    expect(() => weeklyBackupConfig(env)).toThrow("backup_weekly_unconfigured");
    env.NCF_BACKUP_WORK_ROOT = join(root, "work");
    delete env.NCF_BACKUP_MOUNT_POINT;
    expect(() => weeklyBackupConfig(env)).toThrow("backup_weekly_unconfigured");
    expect(runtimeFactory).not.toHaveBeenCalled();
    expect(runner).not.toHaveBeenCalled();
  },
);

it.skipIf(process.platform !== "win32")(
  "Windows path configuration fails closed before runtime construction",
  () => {
    env.NCF_BACKUP_STATE_ROOT = env.NCF_BACKUP_EXTERNAL_ROOT;
    expect(() => weeklyBackupConfig(env)).toThrow("backup_weekly_unconfigured");
    expect(runtimeFactory).not.toHaveBeenCalled();
  },
);
