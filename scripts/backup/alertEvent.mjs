import { createHash } from "node:crypto";

export const BACKUP_ALERT_EVENT_VERSION = 1;
const CODE = /^(?:backup|invalid_backup)_[a-z0-9_]+$/;
const generationUuid = /[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}/iu;
const manifestHash = /\b[a-f0-9]{64}\b/iu;
const objectKey = /\bsys\/backups\/v\d+\/[^\s"'<>]+/iu;
const sourcePath = /(?:^|[\s"'=:/])(?:\/|[A-Za-z]:[\\/])[\w .:/\\-]+/u;
const sql = /\b(?:SELECT|INSERT|UPDATE|DELETE|CREATE|DROP|ALTER|PRAGMA)\b/iu;
const secret = /\b(?:authorization|bearer|token|secret|password|credential|access[_-]?key)\b/iu;

function stableJson(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((item) => stableJson(item)).join(",")}]`;
  return `{${Object.keys(value)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`)
    .join(",")}}`;
}

function eventIdFor(status) {
  const hash = createHash("sha256")
    .update(stableJson({ version: BACKUP_ALERT_EVENT_VERSION, status }))
    .digest("hex")
    .slice(0, 32);
  return `backup-monitor-v${BACKUP_ALERT_EVENT_VERSION}-${hash}`;
}

export function assertNoSensitiveText(value) {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  if (
    generationUuid.test(text) ||
    manifestHash.test(text) ||
    objectKey.test(text) ||
    sourcePath.test(text) ||
    sql.test(text) ||
    secret.test(text)
  )
    throw new Error("backup_alert_redaction_failed");
}

function backupCode(value, fallback) {
  if (typeof value !== "string") return fallback;
  const token = value.match(/^(?:backup|invalid_backup)_[a-z0-9_]+/)?.[0];
  return token && CODE.test(token) ? token : fallback;
}

function sortedCodes(codes, fallback) {
  const set = new Set();
  for (const code of codes) set.add(backupCode(code, fallback));
  return [...set].sort();
}

function cleanupCodes(cleanup) {
  if (cleanup === null || cleanup === undefined || cleanup.healthy === true) return [];
  if (cleanup.complete === false) return ["backup_sweep_incomplete"];
  if (Number.isSafeInteger(cleanup.errors) && cleanup.errors > 0) return ["backup_sweep_errors"];
  return ["backup_sweep_unhealthy"];
}

function safeSummary(result) {
  const health = result?.health ?? result;
  return {
    complete: health?.complete === true,
    eligible: Number.isSafeInteger(health?.eligible) ? health.eligible : null,
    missing: Number.isSafeInteger(health?.missing) ? health.missing : null,
    scanned: Number.isSafeInteger(health?.scanned) ? health.scanned : null,
    verified: Number.isSafeInteger(health?.verified) ? health.verified : null,
    cleanupComplete:
      result?.cleanup && typeof result.cleanup.complete === "boolean"
        ? result.cleanup.complete
        : null,
    cleanupHealthy:
      result?.cleanup && typeof result.cleanup.healthy === "boolean"
        ? result.cleanup.healthy
        : null,
  };
}

export function normalizeBackupResult({ command, result }) {
  if (!result || result.epoch === undefined) throw new Error("backup_invalid_monitor_result");
  const alerts = Array.isArray(result.health?.alerts)
    ? result.health.alerts
    : Array.isArray(result.alerts)
      ? result.alerts
      : [];
  const state = result.healthy === true ? "healthy" : "unhealthy";
  const codes =
    state === "healthy"
      ? []
      : sortedCodes([...alerts, ...cleanupCodes(result.cleanup)], "backup_unhealthy");
  const status = {
    version: BACKUP_ALERT_EVENT_VERSION,
    command,
    state,
    codes: codes.length ? codes : state === "healthy" ? [] : ["backup_unhealthy"],
  };
  const normalized = { status, eventId: eventIdFor(status), summary: safeSummary(result) };
  assertNoSensitiveText(normalized);
  return normalized;
}

export function normalizeBackupFailure(error) {
  const firstLine = error instanceof Error ? error.message.split("\n")[0] : "";
  const code = backupCode(firstLine, "backup_failed");
  const status = {
    version: BACKUP_ALERT_EVENT_VERSION,
    command: "maintain",
    state: "error",
    codes: [code],
  };
  const normalized = {
    status,
    eventId: eventIdFor(status),
    summary: {
      complete: false,
      eligible: null,
      missing: null,
      scanned: null,
      verified: null,
      cleanupComplete: null,
      cleanupHealthy: null,
    },
  };
  assertNoSensitiveText(normalized);
  return normalized;
}

export function stateForFile(normalized) {
  return {
    version: BACKUP_ALERT_EVENT_VERSION,
    status: normalized.status,
    eventId: normalized.eventId,
  };
}

function sameStatus(a, b) {
  return stableJson(a) === stableJson(b);
}

export function transitionEvent({ previous, normalized, observedAt = Date.now() }) {
  const prior = previous?.status;
  if (normalized.status.state === "healthy") {
    if (prior && prior.state !== "healthy") {
      const eventStatus = {
        version: BACKUP_ALERT_EVENT_VERSION,
        command: normalized.status.command,
        state: "recovered",
        codes: [],
        recoveredFrom: sortedCodes(prior.codes ?? [], "backup_unhealthy"),
      };
      const event = {
        version: BACKUP_ALERT_EVENT_VERSION,
        kind: "backup.recovered",
        eventId: eventIdFor(eventStatus),
        observedAt,
        status: eventStatus,
        summary: normalized.summary,
      };
      assertNoSensitiveText(event);
      return event;
    }
    return null;
  }
  if (prior && sameStatus(prior, normalized.status)) return null;
  const kind = normalized.status.state === "error" ? "backup.error" : "backup.unhealthy";
  const event = {
    version: BACKUP_ALERT_EVENT_VERSION,
    kind,
    eventId: normalized.eventId,
    observedAt,
    status: normalized.status,
    summary: normalized.summary,
  };
  assertNoSensitiveText(event);
  return event;
}

export function redactedReport({ normalized, deliveredEventId, delivery }) {
  const report = {
    version: BACKUP_ALERT_EVENT_VERSION,
    status: normalized.status,
    eventId: normalized.eventId,
    deliveredEventId,
    delivery,
    summary: normalized.summary,
  };
  assertNoSensitiveText(report);
  return report;
}
