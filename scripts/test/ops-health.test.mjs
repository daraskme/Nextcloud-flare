import { expect, it } from "vitest";
import { compose, failureEnvelope, healthExitCode, redactedBackup } from "../ops/health.mjs";

const operations = {
  version: "ops-health.v1",
  observedAt: 10,
  expectedEpoch: 3,
  complete: true,
  healthy: true,
  authority: {
    start: {
      control: { epoch: 3, maintenance: false, gcPaused: false },
      mirror: { epoch: 3, maintenance: false, gcPaused: false },
    },
    final: {
      control: { epoch: 3, maintenance: false, gcPaused: false },
      mirror: { epoch: 3, maintenance: false, gcPaused: false },
    },
    stable: true,
  },
  domains: {},
  alerts: [],
};

it("composes a healthy complete redacted result", () => {
  const backup = redactedBackup(
    {
      healthy: true,
      complete: true,
      epoch: 3,
      observedAt: 11,
      eligible: 2,
      missing: 0,
      latestCreatedAt: 9,
      scanned: 2,
      verified: 2,
      generations: [{ id: "generation-secret", objectKey: "object-secret" }],
      active: { provider: "provider-secret" },
      policy: { minimumGenerations: 2, maximumAgeMs: 8, freshnessMs: 4 },
      alerts: [],
    },
    3,
  );
  const result = compose(operations, backup);
  expect(result.healthy).toBe(true);
  expect(result.complete).toBe(true);
  expect(healthExitCode(result)).toBe(0);
  expect(JSON.stringify(result)).not.toContain("generation-secret");
  expect(JSON.stringify(result)).not.toContain("object-secret");
  expect(JSON.stringify(result)).not.toContain("provider-secret");
});

it("sorts alerts and fails closed for incomplete backup health", () => {
  const backup = redactedBackup(
    {
      healthy: false,
      complete: false,
      epoch: 3,
      observedAt: 11,
      alerts: ["backup_generations_insufficient", "backup_daily_missing"],
    },
    3,
  );
  const result = compose(
    {
      ...operations,
      healthy: false,
      alerts: [{ code: "permit_expired", response: "safe response" }],
    },
    backup,
  );
  expect(result.healthy).toBe(false);
  expect(result.complete).toBe(false);
  expect(healthExitCode(result)).toBe(2);
  expect(result.alerts.map(({ code }) => code)).toEqual([
    "backup_daily_missing",
    "backup_generations_insufficient",
    "backup_health_incomplete",
    "permit_expired",
  ]);
});

it("renders transport failures without raw error material", () => {
  expect(failureEnvelope("ops_operator_unavailable")).toEqual({
    version: "ops-health.v1",
    complete: false,
    healthy: false,
    error: "ops_operator_unavailable",
  });
});
