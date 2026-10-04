import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "vitest";
import {
  assessBackupState,
  assessBilling,
  assessLiveCheck,
  currentMonitorStatus,
  planNotifications,
} from "../../ops/monitoring/monitor-core.mjs";
import {
  collectHourlyObservations,
  notifyDesktop,
  runMonitorCycle,
} from "../../ops/monitoring/run-monitor.mjs";
import { runHttpProbes } from "../../ops/staging/smoke-check.mjs";

const now = new Date("2026-10-04T03:00:00.000Z");
const config = {
  version: 1,
  backupMaxAgeDays: 8,
  backupGraceHours: 12,
  billingMaxAgeHours: 96,
  baselineJpyDefault: 0,
  baselineJpyByPeriod: { "2026-09-19T00:00:00Z": 60 },
  jpyPerCurrencyUnit: { USD: 200 },
  thresholdsJpy: [5000, 8000, 10000],
};
const backup = {
  version: 1,
  week: "2026-09-27",
  id: "8bf3fbce-92d0-4680-a37e-ae0f0f85a557",
  epoch: 2,
  phase: "completed",
  updatedAt: "2026-10-04T02:30:00.000Z",
  manifestSha256: "a".repeat(64),
  archiveSha256: "b".repeat(64),
  archiveBytes: 1234,
  archiveVerifiedAt: "2026-10-04T02:00:00.000Z",
  completedAt: "2026-10-04T02:30:00.000Z",
};
const billing = (overrides = {}) => ({
  scope: "account-wide-metered-usage",
  billingCurrency: "USD",
  billingPeriodStart: "2026-09-19T00:00:00Z",
  reportedPeriodEnd: "2026-10-04T00:00:00.000Z",
  billed: 25.3,
  observedAt: "2026-10-04T02:50:00.000Z",
  stagingAttribution: "unavailable",
  ...overrides,
});

test("desktop notification passes the negative persistent timeout after the busctl option delimiter", async () => {
  let invocation;
  await notifyDesktop(
    { title: "Backup needs attention", body: "Open the local status." },
    async (...args) => {
      invocation = args;
    },
  );
  assert.equal(invocation[0], "busctl");
  assert.deepEqual(invocation[1].slice(0, 3), ["--user", "--", "call"]);
  assert.equal(invocation[1].at(-1), "-1");
  assert.deepEqual(invocation[2], { timeout: 5000, windowsHide: true });
});

test("backup health requires completed offline restore and verified encrypted archive, and accepts the weekly age window", () => {
  assert.deepEqual(assessBackupState(backup, { now }), {
    state: "healthy",
    code: "backup_verified",
  });
  assert.equal(
    assessBackupState(
      {
        ...backup,
        archiveVerifiedAt: "2026-09-24T23:00:00.000Z",
        completedAt: "2026-09-25T00:00:00.000Z",
      },
      { now },
    ).state,
    "stale",
  );
  assert.equal(
    assessBackupState({ ...backup, archiveSha256: undefined }, { now }).state,
    "unknown",
  );
  assert.equal(assessBackupState({ ...backup, lastError: null }, { now }).state, "failed");
  assert.equal(assessBackupState({ ...backup, phase: "restored" }, { now }).state, "in_progress");
  assert.deepEqual(
    assessBackupState(
      { ...backup, lastError: { code: "backup_weekly_storage_read_only", at: now.toISOString() } },
      { now },
    ),
    { state: "failed", code: "volume_read_only" },
  );
  assert.equal(assessBackupState(null, { now }).state, "unknown");
  assert.equal(assessBackupState({ ...backup, epoch: 3 }, { now }).state, "healthy");
  assert.equal(assessBackupState({ ...backup, epoch: null }, { now }).state, "unknown");
  assert.deepEqual(
    assessBackupState(
      {
        ...backup,
        phase: "created",
        epoch: null,
        lastError: { code: "backup_weekly_storage_unavailable" },
      },
      { now },
    ),
    { state: "failed", code: "volume_unavailable" },
  );
});

test("billing converts account-wide costs conservatively, subtracts the configured baseline, and alerts at the three configured levels", () => {
  assert.equal(
    assessBilling(billing({ billed: 0.3 }), config, { now }).state,
    "unattributed_below_threshold",
  );
  assert.equal(assessBilling(billing({ billed: 25.3 }), config, { now }).state, "threshold_5000");
  assert.equal(assessBilling(billing({ billed: 25.31 }), config, { now }).state, "threshold_5000");
  assert.equal(assessBilling(billing({ billed: 40.3 }), config, { now }).state, "threshold_8000");
  assert.equal(assessBilling(billing({ billed: 50.31 }), config, { now }).state, "threshold_10000");
});

test("missing, stale, unconfigured, or misattributed billing never reports budget health", () => {
  assert.equal(assessBilling(null, config, { now }).state, "unknown");
  assert.equal(
    assessBilling(billing({ observedAt: "2026-09-20T00:00:00Z" }), config, { now }).state,
    "unknown",
  );
  assert.equal(
    assessBilling(billing({ stagingAttribution: null }), config, { now }).state,
    "unknown",
  );
  assert.equal(
    assessBilling(billing({ billingCurrency: "JPY" }), config, { now }).state,
    "unknown",
  );
  assert.equal(
    assessBilling(billing(), { ...config, baselineJpyDefault: Number.NaN }, { now }).state,
    "unknown",
  );
  const status = currentMonitorStatus({ backup, billing: null, config: {}, now });
  assert.equal(status.billing.state, "unknown");
});

test("anonymous HTTP reachability distinguishes passed, failed, and unperformed checks", () => {
  assert.deepEqual(assessLiveCheck({ passed: true }), {
    state: "reachable",
    code: "http_probes_passed",
  });
  assert.deepEqual(assessLiveCheck({ passed: false }), {
    state: "failed",
    code: "http_probes_failed",
  });
  assert.deepEqual(assessLiveCheck(null), {
    state: "unknown",
    code: "http_probes_not_run",
  });
  const reachable = {
    backup: { state: "healthy", code: "backup_verified" },
    billing: { state: "unknown", code: "billing_snapshot_missing" },
    live: assessLiveCheck({ passed: true }),
  };
  assert.equal(
    planNotifications(null, reachable).some((event) => event.category === "live"),
    false,
  );
  const failed = { ...reachable, live: assessLiveCheck({ passed: false }) };
  assert.match(planNotifications(reachable, failed)[0].body, /匿名 HTTP チェックが失敗/);
  const unknown = { ...reachable, live: assessLiveCheck(null) };
  assert.match(planNotifications(failed, unknown)[0].body, /到達性は不明/);
  assert.match(planNotifications(unknown, reachable)[0].body, /全機能の正常性は検証していません/);
});

test("billing and anonymous HTTP probes settle independently without retaining probe details", async () => {
  const probe = async ({ appOrigin, contentOrigin }) => {
    assert.equal(appOrigin, "https://staging-app.darask.date");
    assert.equal(contentOrigin, "https://staging-content.darask.date");
    return { passed: true, results: [{ url: "private-secret", status: 200 }] };
  };
  assert.deepEqual(
    await collectHourlyObservations({
      accountId: "test",
      token: "secret",
      observedAt: now,
      usage: async () => {
        throw new Error("billing_failed");
      },
      probe,
    }),
    { billingSnapshot: null, liveCheck: { passed: true } },
  );
  const second = await collectHourlyObservations({
    accountId: "test",
    token: "secret",
    observedAt: now,
    usage: async () => [],
    summarize: () => billing(),
    probe: async () => {
      throw new Error("network_failed");
    },
  });
  assert.equal(second.billingSnapshot?.observedAt, now.toISOString());
  assert.equal(second.liveCheck, null);
});

test("the reused nine HTTP probes never follow redirects or send authentication", async () => {
  const requests = [];
  const result = await runHttpProbes({
    appOrigin: "https://staging-app.darask.date",
    contentOrigin: "https://staging-content.darask.date",
    fetchImpl: async (url, options) => {
      requests.push({ url, options });
      assert.equal(options.redirect, "manual");
      assert.ok(["GET", "HEAD"].includes(options.method));
      assert.equal(options.headers, undefined);
      assert.equal(options.body, undefined);
      const path = new URL(url).pathname;
      if (
        path === "/" ||
        path.startsWith("/private-assets/") ||
        (path === "/_ncf-smoke-unknown" && new URL(url).hostname.startsWith("staging-app"))
      )
        return new Response(null, { status: 302, headers: { Location: "/cdn-cgi/access/login" } });
      if (path === "/s" || path.startsWith("/public-assets/"))
        return new Response(null, { status: 200 });
      if (path === "/dav")
        return new Response(null, {
          status: 401,
          headers: { "WWW-Authenticate": "Basic realm=staging" },
        });
      if (path.startsWith("/api/v1/public/shares/"))
        return new Response(null, {
          status: 401,
          headers: { "Content-Type": "application/problem+json" },
        });
      return new Response(null, {
        status: 404,
        headers: { "Content-Type": "application/problem+json" },
      });
    },
  });
  assert.equal(requests.length, 9);
  assert.equal(result.passed, true);
});

test("notifications are deduplicated and recovery does not claim staging attribution", () => {
  const first = currentMonitorStatus({
    backup: null,
    billing: billing({ billed: 0.3 }),
    config,
    now,
  });
  const initial = planNotifications(null, first);
  assert.equal(initial.length, 3);
  assert.ok(initial.every((event) => !JSON.stringify(event).includes("25.3")));
  assert.deepEqual(planNotifications(first, first), []);

  const high = currentMonitorStatus({ backup, billing: billing({ billed: 50.31 }), config, now });
  const recovered = planNotifications(high, first);
  const billingRecovery = recovered.find((event) => event.category === "billing");
  assert.match(billingRecovery.body, /stagingの利用額は個別に帰属できない/);
  assert.match(billingRecovery.body, /予算が健全という確認にはなりません/);
  const availability = planNotifications(
    {
      backup: { state: "healthy", code: "backup_verified" },
      billing: { state: "unknown", code: "billing_snapshot_missing" },
    },
    { backup: { state: "healthy", code: "backup_verified" }, billing: first.billing },
  ).find((event) => event.category === "billing");
  assert.match(availability.body, /請求データを取得できました/);
});

test.skipIf(process.platform === "win32")(
  "monitor persists only fixed incident metadata, retries failed desktop delivery, and deduplicates repeats",
  async () => {
    const directory = await mkdtemp(join(tmpdir(), "ncf-monitor-test-"));
    await chmod(directory, 0o700);
    try {
      const sent = [];
      const input = {
        backupState: backup,
        billingSnapshot: billing({ billed: 50.31 }),
        liveCheck: { passed: true, results: [{ url: "private-secret" }] },
        config,
        stateDirectory: directory,
        now,
        notify: async (event) => sent.push(event),
      };
      const first = await runMonitorCycle(input);
      assert.equal(first.notificationsDelivered, 1);
      assert.equal(first.backup, "healthy");
      assert.equal(first.billing, "threshold_10000");
      assert.equal(first.live, "reachable");
      assert.equal(sent.length, 1);
      assert.doesNotMatch(JSON.stringify(sent), /50\.31|AccountId|token/i);

      const duplicate = await runMonitorCycle({ ...input, now: new Date(now.getTime() + 60_000) });
      assert.equal(duplicate.notificationsDelivered, 0);
      assert.equal(sent.length, 1);

      const stored = await readFile(join(directory, "state.json"), "utf8");
      const incidents = await readFile(join(directory, "incidents.jsonl"), "utf8");
      assert.doesNotMatch(stored, /50\.31|AccountId|token/i);
      assert.doesNotMatch(stored, /private-secret/);
      assert.deepEqual(JSON.parse(stored).status.live, {
        state: "reachable",
        code: "http_probes_passed",
      });
      assert.doesNotMatch(incidents, /50\.31|AccountId|token/i);
      assert.equal((await stat(join(directory, "state.json"))).mode & 0o777, 0o600);
      assert.equal((await stat(join(directory, "incidents.jsonl"))).mode & 0o777, 0o600);

      const retryDirectory = await mkdtemp(join(tmpdir(), "ncf-monitor-pending-"));
      await chmod(retryDirectory, 0o700);
      try {
        const fail = await runMonitorCycle({
          ...input,
          stateDirectory: retryDirectory,
          notify: async () => {
            throw new Error("private bus detail must not persist");
          },
        });
        assert.equal(fail.notificationsPending, 1);
        const retried = await runMonitorCycle({
          ...input,
          stateDirectory: retryDirectory,
          now: new Date(now.getTime() + 60_000),
        });
        assert.equal(retried.notificationsDelivered, 1);
        assert.equal(retried.notificationsPending, 0);
      } finally {
        await rm(retryDirectory, { recursive: true, force: true });
      }
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  },
);
