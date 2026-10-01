const VERSION = "ops-health.v1";

const RESPONSES = Object.freeze({
  backup_daily_missing:
    "Run the existing backup command after confirming the control epoch; investigate manually if publication still fails.",
  backup_generation_invalid:
    "Run the existing backup inspect command and follow its verification failure; investigate the affected backup store manually.",
  backup_generations_insufficient:
    "Run the existing backup command; investigate retention or publication manually if the minimum is still unmet.",
  backup_health_incomplete:
    "Run the existing backup inspect command and investigate the verification or bounded-scan failure manually.",
});

export function redactedBackup(result, expectedEpoch) {
  if (
    !result ||
    result.epoch !== expectedEpoch ||
    !Array.isArray(result.alerts) ||
    typeof result.healthy !== "boolean" ||
    typeof result.complete !== "boolean"
  )
    throw new Error("ops_invalid_backup_health");
  const alerts = [];
  if (!result.complete)
    alerts.push({
      code: "backup_health_incomplete",
      response: RESPONSES.backup_health_incomplete,
    });
  for (const code of result.alerts)
    if (/^backup_[a-z_]+$/.test(code))
      alerts.push({
        code,
        response:
          RESPONSES[code] ??
          "Run the existing backup health command and investigate this alert manually.",
      });
  const policy = result.policy ?? {};
  return {
    healthy: Boolean(result.healthy),
    complete: Boolean(result.complete),
    epoch: Number(result.epoch ?? expectedEpoch),
    observedAt: Number(result.observedAt ?? Date.now()),
    eligible: Number(result.eligible ?? 0),
    missing: Number(result.missing ?? 0),
    latestCreatedAt:
      result.latestCreatedAt === null || result.latestCreatedAt === undefined
        ? null
        : Number(result.latestCreatedAt),
    scanned: Number(result.scanned ?? 0),
    verified: Number(result.verified ?? 0),
    alerts: [...new Map(alerts.map((alert) => [alert.code, alert])).values()].sort((a, b) =>
      a.code.localeCompare(b.code),
    ),
    policy: {
      minimumGenerations: Number(policy.minimumGenerations ?? 0),
      maximumAgeMs: Number(policy.maximumAgeMs ?? 0),
      freshnessMs: Number(policy.freshnessMs ?? 0),
    },
    scope: "backup identifiers, object keys, and provider details omitted",
  };
}

export function compose(operations, backup) {
  const alerts = [...operations.alerts, ...backup.alerts].sort((a, b) =>
    a.code.localeCompare(b.code),
  );
  const complete = Boolean(operations.complete && backup.complete);
  return {
    version: VERSION,
    observedAt: Math.max(Number(operations.observedAt), Number(backup.observedAt)),
    expectedEpoch: operations.expectedEpoch,
    complete,
    healthy: Boolean(complete && operations.healthy && backup.healthy && alerts.length === 0),
    authority: operations.authority,
    domains: operations.domains,
    backup,
    alerts,
  };
}

export function failureEnvelope(code) {
  return {
    version: VERSION,
    complete: false,
    healthy: false,
    error: code,
  };
}

export function healthExitCode(envelope) {
  return envelope.healthy ? 0 : 2;
}
