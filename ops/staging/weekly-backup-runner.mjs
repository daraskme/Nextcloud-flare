import { randomUUID } from "node:crypto";
import { lstat, mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { join, resolve } from "node:path";

export const PHASES = Object.freeze([
  "created",
  "begin_deployed",
  "frozen",
  "captured",
  "published",
  "restored",
  "audited",
  "complete_deployed",
  "receipt_completed",
  "bridge_deleted",
  "archive_verified",
  "completed",
]);
const UUID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;
const SHA256 = /^[a-f0-9]{64}$/;
const WEEK = /^\d{4}-\d{2}-\d{2}$/;
const SAFE_ERROR = /^(?:backup|staging_backup)_[a-z0-9_]+$/;

function validate(state) {
  if (
    state?.version !== 1 ||
    !WEEK.test(state.week ?? "") ||
    !UUID.test(state.id ?? "") ||
    (!(state.epoch === null && state.phase === "created") &&
      (!Number.isSafeInteger(state.epoch) || state.epoch < 1)) ||
    !PHASES.includes(state.phase) ||
    (PHASES.indexOf(state.phase) >= PHASES.indexOf("published") &&
      !SHA256.test(state.manifestSha256 ?? "")) ||
    (state.manifestSha256 !== undefined && !SHA256.test(state.manifestSha256)) ||
    (PHASES.indexOf(state.phase) >= PHASES.indexOf("archive_verified") &&
      (!SHA256.test(state.archiveSha256 ?? "") ||
        !Number.isSafeInteger(state.archiveBytes) ||
        state.archiveBytes < 1)) ||
    (state.lastError !== undefined &&
      (!SAFE_ERROR.test(state.lastError?.code ?? "") ||
        !Number.isSafeInteger(Date.parse(state.lastError.at))))
  )
    throw new Error("backup_weekly_invalid_state");
  return state;
}

async function privateDirectory(path) {
  await mkdir(path, { recursive: true, mode: 0o700 });
  const info = await lstat(path);
  if (!info.isDirectory() || (info.mode & 0o077) !== 0)
    throw new Error("backup_weekly_directory_not_private");
}

/** The scheduled Sunday in Japan, so retries in the same week reuse the same generation. */
export function japaneseBackupWeek(date) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-CA", {
      timeZone: "Asia/Tokyo",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      weekday: "short",
    })
      .formatToParts(date)
      .map(({ type, value }) => [type, value]),
  );
  const weekday = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(parts.weekday);
  if (weekday < 0) throw new Error("backup_weekly_invalid_clock");
  const local = new Date(Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day)));
  local.setUTCDate(local.getUTCDate() - weekday);
  return local.toISOString().slice(0, 10);
}

async function save(path, state) {
  validate(state);
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    const handle = await open(temporary, "wx", 0o600);
    try {
      await handle.writeFile(`${JSON.stringify(state, null, 2)}\n`);
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(temporary, path);
    const directory = await open(resolve(path, ".."), "r");
    try {
      await directory.sync();
    } finally {
      await directory.close();
    }
  } finally {
    await rm(temporary, { force: true });
  }
}

function safeError(error) {
  const message = error instanceof Error ? error.message : "";
  return SAFE_ERROR.test(message) ? message : "backup_weekly_failed";
}

/** Run one durable weekly generation. The caller must serialize invocations. */
export async function runStagingWeeklyBackup({
  stateRoot,
  workRoot,
  backupRoot,
  runtime,
  now = () => new Date(),
}) {
  if (!stateRoot || !workRoot || !backupRoot || !runtime)
    throw new Error("backup_weekly_unconfigured");
  const externalPath = resolve(backupRoot);
  if (
    [stateRoot, workRoot].some((path) => {
      const internal = resolve(path);
      return internal === externalPath || internal.startsWith(`${externalPath}/`);
    })
  )
    throw new Error("backup_weekly_unconfigured");
  await privateDirectory(stateRoot);
  const statePath = join(stateRoot, "state.json");
  const week = japaneseBackupWeek(now());
  let state;
  try {
    const info = await lstat(statePath);
    if (!info.isFile() || (info.mode & 0o077) !== 0 || info.size > 4096)
      throw new Error("backup_weekly_invalid_state");
    state = validate(JSON.parse(await readFile(statePath, "utf8")));
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
    state = {
      version: 1,
      week,
      id: randomUUID(),
      epoch: null,
      phase: "created",
      updatedAt: now().toISOString(),
    };
    await save(statePath, state);
  }
  // An unfinished prior week always resumes before another generation can start.
  if (state.phase === "completed" && state.week !== week) {
    if (state.week > week) throw new Error("backup_weekly_clock_rollback");
    await save(join(stateRoot, `${state.week}-${state.id}.json`), state);
    state = {
      version: 1,
      week,
      id: randomUUID(),
      epoch: null,
      phase: "created",
      updatedAt: now().toISOString(),
    };
    await save(statePath, state);
  }
  // Do not create a missing external mount: a local fallback could fill the system disk.
  // Persist the failed weekly attempt internally so monitoring can alert immediately.
  try {
    await runtime.verifyStorage(backupRoot);
    const external = await lstat(backupRoot);
    if (!external.isDirectory()) throw new Error("backup_weekly_storage_unavailable");
  } catch (error) {
    const code =
      error instanceof Error &&
      ["backup_weekly_storage_read_only", "backup_volume_read_only"].includes(error.message)
        ? "backup_weekly_storage_read_only"
        : "backup_weekly_storage_unavailable";
    state = {
      ...state,
      lastError: { code, at: now().toISOString() },
      updatedAt: now().toISOString(),
    };
    await save(statePath, state);
    throw new Error(code);
  }
  if (state.phase === "completed") {
    if (state.lastError?.code.startsWith("backup_weekly_storage_")) {
      state = { ...state, updatedAt: now().toISOString() };
      delete state.lastError;
      await save(statePath, state);
    }
    return state;
  }
  await privateDirectory(workRoot);
  const runDirectory = join(workRoot, state.id);
  await privateDirectory(runDirectory);
  const advance = async (phase, extra = {}) => {
    state = { ...state, ...extra, phase, updatedAt: now().toISOString() };
    delete state.lastError;
    await save(statePath, state);
  };
  try {
    if (state.phase === "created" && state.epoch === null) {
      const epoch = await runtime.currentEpoch();
      if (!Number.isSafeInteger(epoch) || epoch < 1) throw new Error("backup_epoch_invalid");
      state = { ...state, epoch, updatedAt: now().toISOString() };
      delete state.lastError;
      await save(statePath, state);
    }
    if (state.phase === "created") {
      await runtime.deployBegin(state);
      await advance("begin_deployed");
    }
    if (state.phase === "begin_deployed") {
      await runtime.waitFrozen(state);
      await advance("frozen");
    }
    if (state.phase === "frozen") {
      await runtime.capture(state, runDirectory);
      await advance("captured");
    }
    if (state.phase === "captured") {
      const sha256 = await runtime.publish(state, runDirectory);
      if (!SHA256.test(sha256 ?? "")) throw new Error("backup_weekly_invalid_publication");
      await advance("published", { manifestSha256: sha256 });
    }
    if (state.phase === "published") {
      await runtime.restore(state, runDirectory);
      await advance("restored");
    }
    if (state.phase === "restored") {
      await runtime.audit(state, runDirectory);
      await advance("audited");
    }
    if (state.phase === "audited") {
      await runtime.deployComplete(state);
      await advance("complete_deployed");
    }
    if (state.phase === "complete_deployed") {
      await runtime.waitCompleted(state);
      await advance("receipt_completed");
    }
    if (state.phase === "receipt_completed") {
      await runtime.deleteBridge(state);
      await advance("bridge_deleted");
    }
    if (state.phase === "bridge_deleted") {
      const archive = await runtime.publishArchive(state, runDirectory, backupRoot);
      if (
        archive?.verified !== true ||
        !Number.isSafeInteger(archive.bytes) ||
        archive.bytes < 1 ||
        !SHA256.test(archive.sha256 ?? "")
      )
        throw new Error("backup_weekly_archive_unverified");
      await advance("archive_verified", {
        archiveBytes: archive.bytes,
        archiveSha256: archive.sha256,
        archiveVerifiedAt: now().toISOString(),
      });
    }
    if (state.phase === "archive_verified") {
      await runtime.cleanupInternal(state, runDirectory);
      await advance("completed", { completedAt: now().toISOString() });
    }
    return state;
  } catch (error) {
    state = {
      ...state,
      lastError: { code: safeError(error), at: now().toISOString() },
      updatedAt: now().toISOString(),
    };
    await save(statePath, state);
    throw new Error(state.lastError.code);
  }
}
