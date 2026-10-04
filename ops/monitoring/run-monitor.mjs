#!/usr/bin/env node
import { execFile } from "node:child_process";
import { lstat, mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { fetchBillableUsage, summarizeBillableUsage } from "../staging/billing-snapshot.mjs";
import { runHttpProbes } from "../staging/smoke-check.mjs";
import {
  currentMonitorStatus,
  MAX_MONITOR_PENDING_NOTIFICATIONS,
  planNotifications,
} from "./monitor-core.mjs";

const execFileAsync = promisify(execFile);
const privateMode = (mode) => (mode & 0o077) === 0;

async function ensurePrivateDirectory(path) {
  await mkdir(path, { recursive: true, mode: 0o700 });
  const info = await lstat(path);
  if (!info.isDirectory() || (!privateMode(info.mode) && process.platform !== "win32"))
    throw new Error("monitor_private_state_directory_required");
}

async function readPrivateJson(path, maxBytes = 128 * 1024) {
  try {
    const info = await lstat(path);
    if (
      !info.isFile() ||
      info.size > maxBytes ||
      (!privateMode(info.mode) && process.platform !== "win32")
    )
      return null;
    return JSON.parse(await readFile(path, "utf8"));
  } catch {
    return null;
  }
}

async function writePrivateJson(path, value) {
  const temporary = `${path}.${process.pid}.tmp`;
  const handle = await open(temporary, "wx", 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`);
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true });
  }
}

async function appendIncident(path, event, now) {
  const record = {
    at: now.toISOString(),
    category: event.category,
    from: event.from,
    to: event.to,
    kind: event.kind,
  };
  const handle = await open(path, "a", 0o600);
  try {
    await handle.chmod(0o600);
    await handle.writeFile(`${JSON.stringify(record)}\n`);
    await handle.sync();
  } finally {
    await handle.close();
  }
}

export async function notifyDesktop(event, exec = execFileAsync) {
  await exec(
    "busctl",
    [
      "--user",
      "--",
      "call",
      "org.freedesktop.Notifications",
      "/org/freedesktop/Notifications",
      "org.freedesktop.Notifications",
      "Notify",
      "susssasa{sv}i",
      "Nextcloud-flare",
      "0",
      "",
      event.title,
      event.body,
      "0",
      "0",
      "-1",
    ],
    { timeout: 5000, windowsHide: true },
  );
}

export async function runMonitorCycle({
  backupState,
  billingSnapshot,
  liveCheck,
  config,
  stateDirectory,
  now = new Date(),
  notify = notifyDesktop,
}) {
  await ensurePrivateDirectory(stateDirectory);
  const statePath = join(stateDirectory, "state.json");
  const incidentPath = join(stateDirectory, "incidents.jsonl");
  const old = await readPrivateJson(statePath, 64 * 1024);
  const previous = old?.version === 1 ? old.status : null;
  const status = currentMonitorStatus({
    backup: backupState,
    billing: billingSnapshot,
    liveCheck,
    config,
    now,
  });
  const events = planNotifications(previous, status);
  const pending = [
    ...(Array.isArray(old?.pending)
      ? old.pending.filter((item) => typeof item?.title === "string")
      : []),
    ...events.map(({ category, from, to, kind, title, body }) => ({
      category,
      from,
      to,
      kind,
      title,
      body,
    })),
  ].slice(-MAX_MONITOR_PENDING_NOTIFICATIONS);
  const saved = {
    version: 1,
    checkedAt: now.toISOString(),
    status,
    pending,
  };
  await writePrivateJson(statePath, saved);
  for (const event of events) await appendIncident(incidentPath, event, now);

  const remaining = [];
  let delivered = 0;
  for (const event of pending) {
    try {
      await notify(event);
      delivered++;
    } catch {
      remaining.push(event);
    }
  }
  await writePrivateJson(statePath, { ...saved, pending: remaining });
  return {
    backup: status.backup.state,
    billing: status.billing.state,
    live: status.live.state,
    notificationsDelivered: delivered,
    notificationsPending: remaining.length,
  };
}

/** Billing and anonymous HTTP probes fail independently; no response body or URL is persisted. */
export async function collectHourlyObservations({
  accountId,
  token,
  observedAt = new Date(),
  usage = fetchBillableUsage,
  summarize = summarizeBillableUsage,
  probe = runHttpProbes,
}) {
  const [billing, live] = await Promise.allSettled([
    Promise.resolve().then(async () => ({
      ...summarize(await usage(accountId, token), accountId),
      observedAt: observedAt.toISOString(),
    })),
    Promise.resolve().then(() =>
      probe({
        appOrigin: "https://staging-app.darask.date",
        contentOrigin: "https://staging-content.darask.date",
      }),
    ),
  ]);
  return {
    billingSnapshot: billing.status === "fulfilled" ? billing.value : null,
    liveCheck:
      live.status === "fulfilled" && typeof live.value?.passed === "boolean"
        ? { passed: live.value.passed }
        : null,
  };
}

async function main() {
  if (process.argv.length !== 3 || process.argv[2] !== "--execute") {
    console.log("Usage: node ops/monitoring/run-monitor.mjs --execute");
    return;
  }
  const home = homedir();
  const configPath = resolve(
    process.env.NCF_MONITOR_CONFIG ?? join(home, ".config/nextcloud-flare/monitor.json"),
  );
  const stateDirectory = resolve(
    process.env.NCF_MONITOR_STATE_DIR ?? join(home, ".local/state/nextcloud-flare-monitor"),
  );
  const backupStatePath = join(
    resolve(process.env.NCF_BACKUP_STATE_ROOT ?? join(home, ".local/state/nextcloud-flare-backup")),
    "state.json",
  );
  const config = await readPrivateJson(configPath, 16 * 1024);
  const backupState = await readPrivateJson(backupStatePath, 16 * 1024);

  const { billingSnapshot, liveCheck } = await collectHourlyObservations({
    accountId: process.env.CLOUDFLARE_ACCOUNT_ID,
    token: process.env.CLOUDFLARE_API_TOKEN,
  });
  try {
    if (billingSnapshot) {
      await ensurePrivateDirectory(stateDirectory);
      await writePrivateJson(join(stateDirectory, "billing-snapshot.json"), billingSnapshot);
    }
  } catch {
    // A snapshot write failure does not suppress the live or backup checks.
  }
  const fallbackConfig = config ?? {};
  const result = await runMonitorCycle({
    backupState,
    billingSnapshot,
    liveCheck,
    config: fallbackConfig,
    stateDirectory,
  });
  console.log(JSON.stringify(result));
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(() => {
    console.error("monitor_unavailable");
    process.exitCode = 1;
  });
}
