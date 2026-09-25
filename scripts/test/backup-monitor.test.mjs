import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { MONITOR_FRESHNESS_MS, MONITOR_RUN_MS, openBackupMonitor } from "../backup/monitor.mjs";
import { backupNotifier } from "../backup/notification.mjs";

let directory, monitor;
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "backup-monitor-test-"));
  monitor = await openBackupMonitor(directory);
});
afterEach(async () => {
  vi.useRealTimers();
  monitor.close();
  await rm(directory, { recursive: true, force: true });
});
function success(start = 1000) {
  const id = monitor.begin(2, start);
  monitor.finish(id, 0, start + 1);
  return id;
}
const source = "test-env";
const settings = {
  NCF_BACKUP_NOTIFY_URL: "https://receiver.invalid/alerts",
  NCF_BACKUP_NOTIFY_TOKEN: "secret-test-token-1234",
};

it("persists successful runs across reopening and never refreshes timestamps on completion replay", async () => {
  const id = success();
  monitor.close();
  monitor = await openBackupMonitor(directory);
  monitor.finish(id, 0, 9000);
  expect(monitor.inspect({ now: 10000 })).toMatchObject({
    healthy: true,
    run: { id, finishedAt: 1001, lastSuccessAt: 1001 },
  });
  expect(() => monitor.finish(id, 2, 10000)).toThrow("backup_monitor_run_changed");
});
it("preserves the previous success and failure while a retry is running", () => {
  success();
  const failed = monitor.begin(2, 2000);
  monitor.finish(failed, 2, 2100);
  const retry = monitor.begin(2, 2200);
  expect(monitor.inspect({ now: 2300 })).toMatchObject({
    issues: ["backup_monitor_run_unhealthy"],
    run: { id: retry, lastSuccessAt: 1001, lastExitCode: 2, finishedAt: null },
  });
  monitor.finish(retry, 0, 2400);
  expect(monitor.inspect({ now: 2400 }).healthy).toBe(true);
});
it("refuses a concurrent start and stale completion without changing the active identity", async () => {
  const id = monitor.begin(2, 1000),
    other = await openBackupMonitor(directory);
  try {
    expect(() => other.begin(2, 1100)).toThrow("backup_monitor_run_active");
    expect(() => other.finish(crypto.randomUUID(), 1, 1200)).toThrow("backup_monitor_run_changed");
    expect(other.inspect({ now: 1200 }).run.id).toBe(id);
  } finally {
    other.close();
  }
});
it("retains an interrupted run until its exact ID is marked failed", async () => {
  const id = monitor.begin(2, 1000);
  monitor.close();
  monitor = await openBackupMonitor(directory);
  expect(() => monitor.begin(2, 1000000000)).toThrow("backup_monitor_run_active");
  monitor.finish(id, 1, 2000);
  expect(monitor.inspect({ now: 2000 }).issues).toEqual([
    "backup_monitor_no_success",
    "backup_monitor_run_failed",
  ]);
  const next = monitor.begin(2, 3000);
  expect(() => monitor.finish(id, 0, 3100)).toThrow("backup_monitor_run_changed");
  monitor.finish(next, 0, 3200);
});
it("detects no success, a run exceeding six hours, and success strictly older than 24 hours", () => {
  expect(monitor.inspect({ now: 0 }).issues).toEqual(["backup_monitor_uninitialized"]);
  const id = monitor.begin(2, 1000);
  expect(monitor.inspect({ now: 1000 + MONITOR_RUN_MS }).issues).toEqual([
    "backup_monitor_no_success",
  ]);
  expect(monitor.inspect({ now: 1001 + MONITOR_RUN_MS }).issues).toContain(
    "backup_monitor_run_overdue",
  );
  monitor.finish(id, 0, 1002 + MONITOR_RUN_MS);
  const finished = monitor.inspect({ now: 1002 + MONITOR_RUN_MS }).run.lastSuccessAt;
  expect(monitor.inspect({ now: finished + MONITOR_FRESHNESS_MS }).healthy).toBe(true);
  expect(monitor.inspect({ now: finished + MONITOR_FRESHNESS_MS + 1 }).issues).toEqual([
    "backup_monitor_success_overdue",
  ]);
});
it("reports host clock rollback and refuses to advance a run with a reversed clock", () => {
  success();
  expect(monitor.inspect({ now: 999 }).issues).toContain("backup_monitor_clock_conflict");
  expect(() => monitor.begin(2, 900)).toThrow("backup_monitor_clock_conflict");
  const id = monitor.begin(2, 1100);
  expect(() => monitor.finish(id, 0, 1000)).toThrow("backup_monitor_clock_conflict");
});
it.each([0, -1, 1.5, MONITOR_FRESHNESS_MS + 1])(
  "refuses an invalid long-run threshold %s",
  (maxRunMs) => {
    expect(() => monitor.inspect({ maxRunMs })).toThrow("backup_monitor_invalid_policy");
  },
);
it("stays quiet when healthy and deduplicates unchanged incidents across process restarts", async () => {
  success();
  const send = vi.fn().mockResolvedValue(undefined);
  expect((await monitor.notify({ source, send, now: 1002 })).notified).toBe(false);
  const id = monitor.begin(2, 2000);
  monitor.finish(id, 1, 2100);
  expect((await monitor.notify({ source, send, now: 2200 })).notified).toBe(true);
  monitor.close();
  monitor = await openBackupMonitor(directory);
  expect((await monitor.notify({ source, send, now: 2300 })).notified).toBe(false);
  success(2400);
  await monitor.notify({ source, send, now: 2500 });
  await monitor.notify({ source, send, now: 2600 });
  expect(send.mock.calls.map(([event]) => event.type)).toEqual([
    "backup.alert",
    "backup.recovered",
  ]);
});
it("durably retries one event ID after an unknown delivery and orders recovery after it", async () => {
  const send = vi
    .fn()
    .mockRejectedValueOnce(new Error("provider https://secret.invalid SQL secret"));
  await expect(monitor.notify({ source, send, now: 1000 })).rejects.toThrow(
    /^backup_monitor_delivery_failed$/,
  );
  const original = send.mock.calls[0][0];
  success(2000);
  monitor.close();
  monitor = await openBackupMonitor(directory);
  expect((await monitor.notify({ source, send, now: 3000 })).pending).toBe(true);
  expect(send).toHaveBeenCalledTimes(1);
  expect((await monitor.notify({ source, send, now: 31000 })).pending).toBe(true);
  expect(send.mock.calls[1][0]).toEqual(original);
  await monitor.notify({ source, send, now: 31001 });
  expect(send.mock.calls[2][0].type).toBe("backup.recovered");
  expect(send.mock.calls[2][0].id).not.toBe(original.id);
});
it("does not lose a failed run followed by recovery between watchdog polls", async () => {
  const failed = monitor.begin(2, 1000);
  monitor.finish(failed, 1, 1100);
  success(1200);
  monitor.close();
  monitor = await openBackupMonitor(directory);
  const send = vi.fn();
  expect(monitor.inspect({ now: 1300 }).healthy).toBe(true);
  expect((await monitor.notify({ source, send, now: 1300 })).pending).toBe(true);
  expect(send.mock.calls[0][0]).toMatchObject({
    type: "backup.alert",
    observedAt: 1100,
    run: { id: failed, exitCode: 1 },
  });
  await monitor.notify({ source, send, now: 1400 });
  expect(send.mock.calls[1][0].type).toBe("backup.recovered");
});
it("coalesces unchanged failures without losing the first unacknowledged incident", async () => {
  const first = monitor.begin(2, 1000);
  monitor.finish(first, 1, 1100);
  const second = monitor.begin(2, 1200);
  monitor.finish(second, 1, 1300);
  const send = vi.fn();
  await monitor.notify({ source, send, now: 1400 });
  expect(send.mock.calls[0][0].run.id).toBe(first);
  const third = monitor.begin(2, 1500);
  monitor.finish(third, 1, 1600);
  await monitor.notify({ source, send, now: 1700 });
  expect(send).toHaveBeenCalledTimes(1);
  success(1800);
  await monitor.notify({ source, send, now: 1900 });
  expect(send.mock.calls[1][0].type).toBe("backup.recovered");
});
it("a failed completion transaction retains the running record instead of reporting success", () => {
  const id = monitor.begin(2, 1000);
  monitor.db.exec(`CREATE TRIGGER test_monitor_write_failure BEFORE UPDATE ON backup_monitor_run
    WHEN NEW.exit_code=0 BEGIN SELECT RAISE(ABORT,'disk failure fixture'); END;`);
  expect(() => monitor.finish(id, 0, 1100)).toThrow();
  expect(monitor.inspect({ now: 1200 }).run).toMatchObject({
    finishedAt: null,
    lastSuccessAt: null,
  });
});
it("lets one monitor claim delivery while another observes the same pending event", async () => {
  let release;
  const other = await openBackupMonitor(directory);
  const send = vi.fn(
    () =>
      new Promise((r) => {
        release = r;
      }),
  );
  const pending = monitor.notify({ source, send, now: 1000 });
  try {
    expect((await other.notify({ source, send, now: 1001 })).pending).toBe(true);
    expect(send).toHaveBeenCalledTimes(1);
    release();
    await pending;
    expect((await other.notify({ source, send, now: 1002 })).notified).toBe(false);
  } finally {
    release();
    other.close();
  }
});
it("a late acknowledgement cannot clear a newer pending event", async () => {
  let releaseOld, releaseNew;
  const old = monitor.notify({
    source,
    now: 1000,
    send: () =>
      new Promise((r) => {
        releaseOld = r;
      }),
  });
  await monitor.notify({ source, now: 31000, send: async () => {} });
  success(32000);
  const newer = monitor.notify({
    source,
    now: 33000,
    send: () =>
      new Promise((r) => {
        releaseNew = r;
      }),
  });
  releaseOld();
  await old;
  const ignored = vi.fn();
  expect((await monitor.notify({ source, now: 33001, send: ignored })).pending).toBe(true);
  expect(ignored).not.toHaveBeenCalled();
  releaseNew();
  await newer;
});
it("does not strand a pending delivery lease after a large backward clock change", async () => {
  const send = vi.fn().mockRejectedValueOnce(new Error("unknown"));
  await expect(monitor.notify({ source, send, now: 100000 })).rejects.toThrow();
  await monitor.notify({ source, send, now: 1000 });
  expect(send.mock.calls[1][0].id).toBe(send.mock.calls[0][0].id);
});
it("pins the notification source to the local environment directory", async () => {
  success();
  const send = vi.fn();
  await monitor.notify({ source, send, now: 2000 });
  await expect(monitor.notify({ source: "another-env", send, now: 2100 })).rejects.toThrow(
    "backup_monitor_source_changed",
  );
  expect(send).not.toHaveBeenCalled();
});
it.each([
  "http://receiver.invalid",
  "https://user:pass@receiver.invalid",
  "https://receiver.invalid/#secret",
  "bad",
])("rejects unsafe receiver configuration %s", (url) => {
  expect(() => backupNotifier({ ...settings, NCF_BACKUP_NOTIFY_URL: url })).toThrow(
    "backup_monitor_unconfigured",
  );
});
it("sends bounded JSON with bearer authentication, stable idempotency key and no redirects", async () => {
  const fetcher = vi.fn().mockResolvedValue(new Response("ignored secret body", { status: 202 }));
  const event = { id: crypto.randomUUID(), type: "backup.alert" };
  await backupNotifier(settings, fetcher)(event);
  const [url, options] = fetcher.mock.calls[0];
  expect(url.href).toBe(settings.NCF_BACKUP_NOTIFY_URL);
  expect(options).toMatchObject({
    method: "POST",
    redirect: "error",
    headers: {
      authorization: `Bearer ${settings.NCF_BACKUP_NOTIFY_TOKEN}`,
      "idempotency-key": event.id,
    },
    body: JSON.stringify(event),
  });
});
it.each([302, 400, 429, 500])("does not acknowledge HTTP %s or expose its body", async (status) => {
  const fetcher = vi.fn().mockResolvedValue(new Response("secret provider response", { status }));
  await expect(backupNotifier(settings, fetcher)({ id: crypto.randomUUID() })).rejects.toThrow(
    /^backup_monitor_delivery_failed$/,
  );
  expect(fetcher).toHaveBeenCalledTimes(1);
});
it("bounds a hung notification to ten seconds and aborts without automatic retries", async () => {
  vi.useFakeTimers();
  let signal;
  const fetcher = vi.fn((_, options) => {
    signal = options.signal;
    return new Promise(() => {});
  });
  const result = backupNotifier(settings, fetcher)({ id: crypto.randomUUID() });
  const assertion = expect(result).rejects.toThrow(/^backup_monitor_delivery_failed$/);
  await vi.advanceTimersByTimeAsync(10000);
  await assertion;
  expect(signal.aborted).toBe(true);
  expect(fetcher).toHaveBeenCalledTimes(1);
});
it("delivers incident and recovery through a local HTTP receiver fixture", async () => {
  const received = [];
  const server = createServer(async (request, response) => {
    let data = "";
    for await (const chunk of request) data += chunk;
    received.push({
      event: JSON.parse(data),
      key: request.headers["idempotency-key"],
      auth: request.headers.authorization,
    });
    response.writeHead(202);
    response.end();
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    // Test adapter routes only to this fixture; production still accepts HTTPS exclusively.
    const send = backupNotifier(settings, (_, options) =>
      fetch(`http://127.0.0.1:${server.address().port}`, options),
    );
    await monitor.notify({ source, send, now: 1000 });
    success(2000);
    await monitor.notify({ source, send, now: 2100 });
    expect(received.map((r) => r.event.type)).toEqual(["backup.alert", "backup.recovered"]);
    expect(
      received.every(
        (r) => r.key === r.event.id && r.auth === `Bearer ${settings.NCF_BACKUP_NOTIFY_TOKEN}`,
      ),
    ).toBe(true);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
it("records invalid maintain configuration as failure through the actual CLI without touching a backup", async () => {
  const exec = promisify(execFile);
  await expect(
    exec(
      process.execPath,
      ["scripts/backup.mjs", "maintain", "--monitor-directory", directory, "--epoch", "invalid"],
      { cwd: join(import.meta.dirname, "../..") },
    ),
  ).rejects.toMatchObject({ code: 1 });
  expect(monitor.inspect().run).toMatchObject({ epoch: null, exitCode: 1, lastSuccessAt: null });
  const error = await exec(
    process.execPath,
    ["scripts/backup-monitor.mjs", "check", "--directory", directory],
    { cwd: join(import.meta.dirname, "../..") },
  ).catch((e) => e);
  expect(error.code).toBe(2);
  expect(JSON.parse(error.stdout).result.issues).toContain("backup_monitor_run_failed");
});
it("the actual abandon command requires the current run ID and only records local failure", async () => {
  const id = monitor.begin(2);
  const exec = promisify(execFile),
    cwd = join(import.meta.dirname, "../..");
  await expect(
    exec(
      process.execPath,
      [
        "scripts/backup-monitor.mjs",
        "abandon",
        "--directory",
        directory,
        "--run-id",
        crypto.randomUUID(),
      ],
      { cwd },
    ),
  ).rejects.toMatchObject({ code: 1 });
  expect(monitor.inspect().run.finishedAt).toBeNull();
  await expect(
    exec(
      process.execPath,
      ["scripts/backup-monitor.mjs", "abandon", "--directory", directory, "--run-id", id],
      { cwd },
    ),
  ).rejects.toMatchObject({ code: 2 });
  expect(monitor.inspect().run.exitCode).toBe(1);
});
