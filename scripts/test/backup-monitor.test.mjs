import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { beforeEach, expect, it } from "vitest";
import {
  assertNoSensitiveText,
  normalizeBackupFailure,
  normalizeBackupResult,
  transitionEvent,
} from "../backup/alertEvent.mjs";
import { runBackupMonitor } from "../backup/monitor.mjs";
import { fileMode, readMonitorState } from "../backup/monitorState.mjs";

let root, delivered;
const exec = promisify(execFile);
const generation = "00000000-0000-0000-0000-000000000001";
const unhealthy = (alerts = ["backup_generations_insufficient"]) => ({
  healthy: false,
  epoch: 2,
  completed: [],
  initial: { alerts, complete: true, eligible: 1, missing: 4 },
  health: {
    healthy: false,
    alerts,
    complete: true,
    eligible: 1,
    missing: 4,
    scanned: 1,
    verified: 1,
    generations: [
      {
        id: generation,
        manifestSha256: "a".repeat(64),
        manifestKey: `sys/backups/v1/${generation}/manifest.json`,
      },
    ],
  },
  cleanup: null,
});
const healthy = () => ({
  healthy: true,
  epoch: 2,
  completed: [],
  initial: { alerts: [], complete: true, eligible: 5, missing: 0 },
  health: {
    healthy: true,
    alerts: [],
    complete: true,
    eligible: 5,
    missing: 0,
    scanned: 5,
    verified: 5,
  },
  cleanup: { healthy: true, complete: true },
});
async function monitor(result, extra = {}) {
  return runBackupMonitor({
    stateDirectory: root,
    execute: async () => {
      if (result instanceof Error) throw result;
      return result;
    },
    deliver: async (event) => {
      delivered.push(event);
      if (extra.failDelivery) throw new Error("backup_webhook_non_2xx");
    },
    observedAt: Date.UTC(2026, 8, 25, 12),
  });
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "backup-monitor-"));
  delivered = [];
});

it("normalizes stable sorted alert codes and redacts backup identifiers", () => {
  const normalized = normalizeBackupResult({
    command: "maintain",
    result: unhealthy(["backup_daily_missing", "backup_generations_insufficient"]),
  });
  expect(normalized.status.codes).toEqual([
    "backup_daily_missing",
    "backup_generations_insufficient",
  ]);
  expect(JSON.stringify(normalized)).not.toContain(generation);
  expect(JSON.stringify(normalized)).not.toContain("a".repeat(64));
  expect(JSON.stringify(normalized)).not.toContain("sys/backups");
  expect(normalizeBackupResult({ command: "maintain", result: unhealthy() }).eventId).toBe(
    normalizeBackupResult({ command: "maintain", result: unhealthy() }).eventId,
  );
});

it("rejects source paths, SQL, provider details and authorization material before delivery", () => {
  for (const value of [
    { path: "/var/lib/nextcloud-flare-backup/generations" },
    { sql: "SELECT * FROM users" },
    { key: `sys/backups/v1/${generation}/parts/00000` },
    { hash: "b".repeat(64) },
    { provider: "Authorization: Bearer token" },
  ])
    expect(() => assertNoSensitiveText(value)).toThrow("backup_alert_redaction_failed");
});

it("sends the first unhealthy event, suppresses identical repeats and preserves exit 2", async () => {
  expect(await monitor(unhealthy())).toMatchObject({ exitCode: 2 });
  expect(delivered).toHaveLength(1);
  expect(delivered[0]).toMatchObject({
    kind: "backup.unhealthy",
    status: { state: "unhealthy", codes: ["backup_generations_insufficient"] },
  });
  expect(await monitor(unhealthy())).toMatchObject({ exitCode: 2, deliveredEventId: null });
  expect(delivered).toHaveLength(1);
  expect(await fileMode(join(root, "backup-monitor-state.json"))).toBe(0o600);
  expect(await fileMode(join(root, "backup-monitor-report.json"))).toBe(0o600);
});

it("sends changed alert sets, one recovery event and then suppresses healthy repeats", async () => {
  await monitor(unhealthy());
  await monitor(unhealthy(["backup_daily_missing"]));
  expect(delivered.at(-1)).toMatchObject({
    kind: "backup.unhealthy",
    status: { codes: ["backup_daily_missing"] },
  });
  const recovered = await monitor(healthy());
  expect(recovered.exitCode).toBe(0);
  expect(delivered.at(-1)).toMatchObject({
    kind: "backup.recovered",
    status: { state: "recovered", recoveredFrom: ["backup_daily_missing"] },
  });
  expect(await monitor(healthy())).toMatchObject({ exitCode: 0, deliveredEventId: null });
  expect(delivered.filter((event) => event.kind === "backup.recovered")).toHaveLength(1);
});

it("sends a sanitized error event for inspection failure and returns exit 1", async () => {
  const result = await monitor(
    new Error(
      `https://r2.example.invalid/private ${generation} ${"c".repeat(64)} SELECT * FROM users`,
    ),
  );
  expect(result.exitCode).toBe(1);
  expect(delivered).toHaveLength(1);
  expect(delivered[0]).toMatchObject({
    kind: "backup.error",
    status: { state: "error", codes: ["backup_failed"] },
  });
  expect(JSON.stringify(delivered[0])).not.toMatch(/r2\.example|SELECT|00000000|cccc/);
});

it("keeps retryable report and previous state when delivery fails", async () => {
  await expect(monitor(unhealthy(), { failDelivery: true })).rejects.toThrow(
    "backup_webhook_non_2xx",
  );
  expect(await readMonitorState(root)).toBeNull();
  let report = JSON.parse(await readFile(join(root, "backup-monitor-report.json"), "utf8"));
  expect(report).toMatchObject({ delivery: "failed", status: { state: "unhealthy" } });
  expect(await monitor(unhealthy())).toMatchObject({ exitCode: 2 });
  expect(delivered).toHaveLength(2);
  report = JSON.parse(await readFile(join(root, "backup-monitor-report.json"), "utf8"));
  expect(report).toMatchObject({ delivery: "delivered" });
  await rm(root, { recursive: true, force: true });
});

it("builds no event for an initial healthy result but records the baseline state", async () => {
  const result = await monitor(healthy());
  expect(result).toMatchObject({ exitCode: 0, deliveredEventId: null });
  expect(delivered).toHaveLength(0);
  expect(await readMonitorState(root)).toMatchObject({ status: { state: "healthy", codes: [] } });
  expect(await fileMode(join(root, "backup-monitor-state.json"))).toBe(0o600);
});

it("uses deterministic recovery IDs without leaking previous alert internals", () => {
  const prior = normalizeBackupResult({ command: "maintain", result: unhealthy() });
  const current = normalizeBackupResult({ command: "maintain", result: healthy() });
  expect(
    transitionEvent({
      previous: { status: prior.status },
      normalized: current,
      observedAt: 1,
    }).eventId,
  ).toBe(
    transitionEvent({
      previous: { status: prior.status },
      normalized: current,
      observedAt: 2,
    }).eventId,
  );
});

it("normalizes known backup errors without provider detail", () => {
  const normalized = normalizeBackupFailure(new Error("backup_inventory_changed: source /tmp/db"));
  expect(normalized.status.codes).toEqual(["backup_inventory_changed"]);
  expect(JSON.stringify(normalized)).not.toContain("/tmp/db");
});

it.each([
  ["healthy", 0],
  ["unhealthy", 2],
  ["error", 1],
  ["delivery-fail", 1],
])("preserves CLI exit precedence for %s as %s", async (kind, code) => {
  const dir = await mkdtemp(join(tmpdir(), "backup-monitor-cli-"));
  const fixture = join(import.meta.dirname, "fixtures/backup-monitor-exit-fixture.mjs");
  try {
    if (code === 0) await exec(process.execPath, [fixture, kind, dir]);
    else {
      await expect(exec(process.execPath, [fixture, kind, dir])).rejects.toMatchObject({ code });
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
