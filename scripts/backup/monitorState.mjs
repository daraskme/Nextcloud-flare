import { constants } from "node:fs";
import { mkdir, open, readFile, rename, stat, unlink } from "node:fs/promises";
import { dirname, join } from "node:path";
import { BACKUP_ALERT_EVENT_VERSION } from "./alertEvent.mjs";

export const STATE_FILE = "backup-monitor-state.json";
export const REPORT_FILE = "backup-monitor-report.json";

async function ensureDirectory(path) {
  await mkdir(path, { recursive: true, mode: 0o700 });
}

async function atomicWriteJson(path, value) {
  await ensureDirectory(dirname(path));
  const temp = join(
    dirname(path),
    `.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}`,
  );
  const file = await open(temp, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
  try {
    await file.writeFile(`${JSON.stringify(value)}\n`, "utf8");
    await file.sync();
  } finally {
    await file.close();
  }
  await rename(temp, path);
  await chmodFile(path);
}

async function chmodFile(path) {
  const file = await open(path, constants.O_RDONLY);
  try {
    await file.chmod(0o600);
    await file.sync();
  } finally {
    await file.close();
  }
}

function validState(value) {
  return (
    value?.version === BACKUP_ALERT_EVENT_VERSION &&
    value?.status?.version === BACKUP_ALERT_EVENT_VERSION &&
    ["healthy", "unhealthy", "error"].includes(value.status.state) &&
    typeof value.status.command === "string" &&
    Array.isArray(value.status.codes) &&
    value.status.codes.every((code) => typeof code === "string") &&
    typeof value.eventId === "string"
  );
}

export async function readMonitorState(directory) {
  const path = join(directory, STATE_FILE);
  try {
    const value = JSON.parse(await readFile(path, "utf8"));
    if (!validState(value)) throw new Error("backup_monitor_state_invalid");
    return value;
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

export async function writeMonitorState(directory, state) {
  await atomicWriteJson(join(directory, STATE_FILE), state);
}

export async function writeMonitorReport(directory, report) {
  await atomicWriteJson(join(directory, REPORT_FILE), report);
}

export async function fileMode(path) {
  return (await stat(path)).mode & 0o777;
}

export async function removeMonitorFiles(directory) {
  await Promise.all(
    [STATE_FILE, REPORT_FILE].map(async (file) => {
      try {
        await unlink(join(directory, file));
      } catch (error) {
        if (error?.code !== "ENOENT") throw error;
      }
    }),
  );
}
