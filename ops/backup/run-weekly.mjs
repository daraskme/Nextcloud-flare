import { createHash, createPublicKey } from "node:crypto";
import { lstat, readFile, realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { runStagingWeeklyBackup } from "../staging/weekly-backup-runner.mjs";
import { createWeeklyBackupRuntime } from "../staging/weekly-backup-runtime.mjs";
import { createArchiveStorage } from "./archive-storage.mjs";

const ID = /^[A-Za-z0-9_-]{1,128}$/;
const SAFE_ERROR = /^(?:backup|staging_backup)_[a-z0-9_]+$/;
const B64 = /^[A-Za-z0-9_-]+$/;
function fail(code = "backup_weekly_unconfigured") {
  throw new Error(code);
}
function absolutePath(value) {
  if (!value || !isAbsolute(value) || resolve(value) !== value) fail();
  return value;
}
function childOf(parent, child) {
  const diff = relative(parent, child);
  return diff === "" || (!diff.startsWith("..") && !isAbsolute(diff));
}
async function privateDirectory(path) {
  const info = await lstat(path).catch(() => fail("backup_weekly_directory_unavailable"));
  if (
    !info.isDirectory() ||
    info.isSymbolicLink() ||
    (info.mode & 0o077) !== 0 ||
    (await realpath(path)) !== path
  )
    fail("backup_weekly_directory_not_private");
}
function strictBase64Url(value, min, max) {
  if (typeof value !== "string" || !B64.test(value)) fail("backup_archive_public_key_invalid");
  const bytes = Buffer.from(value, "base64url");
  if (bytes.length < min || bytes.length > max || bytes.toString("base64url") !== value)
    fail("backup_archive_public_key_invalid");
  return bytes;
}
async function publicRecipient(path, accountId) {
  const info = await lstat(path).catch(() => fail("backup_archive_public_key_invalid"));
  if (
    !info.isFile() ||
    info.isSymbolicLink() ||
    (info.mode & 0o077) !== 0 ||
    info.size > 16_384 ||
    (await realpath(path)) !== path
  )
    fail("backup_archive_public_key_invalid");
  let parsed;
  try {
    parsed = JSON.parse(await readFile(path, "utf8"));
  } catch {
    fail("backup_archive_public_key_invalid");
  }
  if (
    !parsed ||
    Object.keys(parsed).sort().join() !== "accountId,recipient,version" ||
    parsed.version !== 1 ||
    parsed.accountId !== accountId ||
    !parsed.recipient ||
    Object.keys(parsed.recipient).sort().join() !== "fingerprint,spki"
  )
    fail("backup_archive_public_key_invalid");
  const spki = strictBase64Url(parsed.recipient.spki, 300, 800);
  const fingerprint = strictBase64Url(parsed.recipient.fingerprint, 32, 32);
  if (!createHash("sha256").update(spki).digest().equals(fingerprint))
    fail("backup_archive_public_key_invalid");
  try {
    const key = createPublicKey({ key: spki, type: "spki", format: "der" });
    if (key.asymmetricKeyType !== "rsa" || key.asymmetricKeyDetails?.modulusLength !== 3072)
      fail("backup_archive_public_key_invalid");
  } catch {
    fail("backup_archive_public_key_invalid");
  }
}

export function weeklyBackupConfig(env = process.env) {
  const stateRoot = absolutePath(env.NCF_BACKUP_STATE_ROOT);
  const workRoot = absolutePath(env.NCF_BACKUP_WORK_ROOT);
  const backupRoot = absolutePath(env.NCF_BACKUP_EXTERNAL_ROOT);
  const mountPoint = absolutePath(env.NCF_BACKUP_MOUNT_POINT);
  const publicKeyFile = absolutePath(env.NCF_BACKUP_PUBLIC_KEY_FILE);
  const accountId = env.NCF_BACKUP_ACCOUNT_ID;
  const volumeUuid = env.NCF_BACKUP_VOLUME_UUID;
  if (
    !ID.test(accountId ?? "") ||
    !volumeUuid ||
    !/^[A-Za-z0-9-]{4,128}$/.test(volumeUuid) ||
    !childOf(mountPoint, backupRoot) ||
    mountPoint === backupRoot ||
    stateRoot === workRoot ||
    childOf(stateRoot, workRoot) ||
    childOf(workRoot, stateRoot) ||
    childOf(mountPoint, publicKeyFile) ||
    [stateRoot, workRoot].some(
      (path) => childOf(backupRoot, path) || childOf(path, backupRoot) || childOf(mountPoint, path),
    )
  )
    fail();
  return {
    stateRoot,
    workRoot,
    backupRoot,
    storage: {
      mountPoint,
      volumeUuid,
      backupRoot,
      publicKeyFile,
      accountId,
    },
  };
}

/** `--check` touches only the local mounted volume; `--run` enters the durable remote workflow. */
export async function runWeeklyCli({
  mode,
  env = process.env,
  storageFactory = createArchiveStorage,
  runtimeFactory = createWeeklyBackupRuntime,
  runner = runStagingWeeklyBackup,
}) {
  if (mode !== "check" && mode !== "run") fail();
  const configuration = weeklyBackupConfig(env);
  await privateDirectory(configuration.stateRoot);
  await privateDirectory(configuration.workRoot);
  await publicRecipient(configuration.storage.publicKeyFile, configuration.storage.accountId);
  const storage = storageFactory(configuration.storage);
  const runtime = runtimeFactory({ env, workRoot: configuration.workRoot, ...storage });
  if (mode === "check") {
    await storage.verifyStorage(configuration.backupRoot);
    return { status: "ready" };
  }
  const state = await runner({
    stateRoot: configuration.stateRoot,
    workRoot: configuration.workRoot,
    backupRoot: configuration.backupRoot,
    runtime,
  });
  return { status: state.phase === "completed" ? "completed" : "incomplete" };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const mode =
    process.argv.length === 3 && process.argv[2] === "--check"
      ? "check"
      : process.argv.length === 3 && process.argv[2] === "--run"
        ? "run"
        : null;
  if (!mode) {
    process.stderr.write("backup_weekly_usage\n");
    process.exitCode = 2;
  } else {
    try {
      const result = await runWeeklyCli({ mode });
      process.stdout.write(`backup_weekly_${result.status}\n`);
    } catch (error) {
      const code =
        error instanceof Error && SAFE_ERROR.test(error.message)
          ? error.message
          : "backup_weekly_failed";
      process.stderr.write(`${code}\n`);
      process.exitCode = 1;
    }
  }
}
