const UUID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;
const SHA256 = /^[a-f0-9]{64}$/;
const ISO_WEEK = /^\d{4}-\d{2}-\d{2}$/;
const PHASES = new Set([
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
export const DEFAULT_BILLING_THRESHOLDS_JPY = Object.freeze([5000, 8000, 10000]);
const MAX_PENDING_NOTIFICATIONS = 32;

const finiteDate = (value) => {
  if (typeof value !== "string") return null;
  const date = Date.parse(value);
  return Number.isFinite(date) ? date : null;
};

function safeBackupError(code) {
  if (code === "backup_weekly_storage_unavailable") return "volume_unavailable";
  if (code === "backup_weekly_storage_read_only") return "volume_read_only";
  if (typeof code === "string" && /^backup_weekly_[a-z0-9_]+$/.test(code)) return "backup_failed";
  return "backup_failed";
}

export function assessBackupState(state, { now = new Date(), maxAgeMs = 8.5 * 86_400_000 } = {}) {
  if (
    !state ||
    typeof state !== "object" ||
    state.version !== 1 ||
    !ISO_WEEK.test(state.week ?? "") ||
    !UUID.test(state.id ?? "") ||
    !(
      (Number.isSafeInteger(state.epoch) && state.epoch > 0) ||
      (state.phase === "created" && state.epoch === null)
    ) ||
    !PHASES.has(state.phase)
  )
    return { state: "unknown", code: "backup_state_missing_or_invalid" };
  if (Object.hasOwn(state, "lastError"))
    return { state: "failed", code: safeBackupError(state.lastError?.code) };

  if (state.phase === "completed") {
    if (
      !SHA256.test(state.manifestSha256 ?? "") ||
      !SHA256.test(state.archiveSha256 ?? "") ||
      !Number.isSafeInteger(state.archiveBytes) ||
      state.archiveBytes < 1 ||
      !finiteDate(state.archiveVerifiedAt) ||
      !finiteDate(state.completedAt)
    )
      return { state: "unknown", code: "backup_completion_unverified" };
    const completedAt = finiteDate(state.completedAt);
    const archiveVerifiedAt = finiteDate(state.archiveVerifiedAt);
    if (
      completedAt > now.getTime() + 60_000 ||
      archiveVerifiedAt > completedAt + 60_000 ||
      archiveVerifiedAt > now.getTime() + 60_000
    )
      return { state: "unknown", code: "backup_timestamp_invalid" };
    if (now.getTime() - completedAt > maxAgeMs) return { state: "stale", code: "backup_stale" };
    return { state: "healthy", code: "backup_verified" };
  }

  const updatedAt = finiteDate(state.updatedAt);
  if (updatedAt === null || updatedAt > now.getTime() + 60_000)
    return { state: "unknown", code: "backup_timestamp_invalid" };
  if (now.getTime() - updatedAt > maxAgeMs)
    return { state: "stale", code: "backup_incomplete_stale" };
  return { state: "in_progress", code: "backup_incomplete" };
}

function validBillingConfig(config) {
  if (!config || typeof config !== "object") return false;
  const thresholds = config.thresholdsJpy;
  if (
    config.version !== 1 ||
    !Array.isArray(thresholds) ||
    thresholds.length !== 3 ||
    thresholds.some((value, index) => value !== DEFAULT_BILLING_THRESHOLDS_JPY[index])
  )
    return false;
  if (
    !Number.isFinite(config.billingMaxAgeHours) ||
    config.billingMaxAgeHours < 1 ||
    config.billingMaxAgeHours > 240 ||
    !Number.isFinite(config.baselineJpyDefault) ||
    config.baselineJpyDefault < 0 ||
    !config.jpyPerCurrencyUnit ||
    typeof config.jpyPerCurrencyUnit !== "object" ||
    !config.baselineJpyByPeriod ||
    typeof config.baselineJpyByPeriod !== "object"
  )
    return false;
  return (
    Object.entries(config.jpyPerCurrencyUnit).every(
      ([currency, rate]) => /^[A-Z]{3}$/.test(currency) && Number.isFinite(rate) && rate > 0,
    ) &&
    Object.entries(config.baselineJpyByPeriod).every(
      ([period, baseline]) =>
        Number.isFinite(Date.parse(period)) && Number.isFinite(baseline) && baseline >= 0,
    )
  );
}

export function assessBilling(snapshot, config, { now = new Date() } = {}) {
  if (!validBillingConfig(config)) return { state: "unknown", code: "billing_config_invalid" };
  if (!snapshot || typeof snapshot !== "object")
    return { state: "unknown", code: "billing_snapshot_missing" };
  if (
    snapshot.scope !== "account-wide-metered-usage" ||
    snapshot.stagingAttribution !== "unavailable" ||
    typeof snapshot.billingCurrency !== "string" ||
    !Number.isFinite(snapshot.billed) ||
    snapshot.billed < 0
  )
    return { state: "unknown", code: "billing_scope_or_attribution_unknown" };

  const observedAt = finiteDate(snapshot.observedAt);
  const reportedEnd = finiteDate(snapshot.reportedPeriodEnd);
  const maxAgeMs = config.billingMaxAgeHours * 3_600_000;
  if (
    observedAt === null ||
    observedAt > now.getTime() + 60_000 ||
    now.getTime() - observedAt > maxAgeMs ||
    reportedEnd === null ||
    reportedEnd > now.getTime() + 60_000 ||
    now.getTime() - reportedEnd > maxAgeMs
  )
    return { state: "unknown", code: "billing_snapshot_stale" };

  const rate = config.jpyPerCurrencyUnit[snapshot.billingCurrency];
  if (!Number.isFinite(rate)) return { state: "unknown", code: "billing_currency_unconfigured" };
  const baseline =
    config.baselineJpyByPeriod?.[snapshot.billingPeriodStart] ?? config.baselineJpyDefault;
  if (!Number.isFinite(baseline) || baseline < 0)
    return { state: "unknown", code: "billing_baseline_invalid" };
  // Round the account-wide estimate upward so small FX variation cannot delay a warning.
  const estimatedJpy = Math.ceil(snapshot.billed * rate);
  const aboveBaselineJpy = Math.max(0, estimatedJpy - baseline);
  const threshold = [...config.thresholdsJpy]
    .reverse()
    .find((amount) => aboveBaselineJpy >= amount);
  return {
    state: threshold === undefined ? "unattributed_below_threshold" : `threshold_${threshold}`,
    code: threshold === undefined ? "billing_attribution_unavailable" : "billing_threshold_reached",
    // This is account-wide and cannot be interpreted as staging-only usage or a budget health claim.
    attribution: "unavailable",
  };
}

/** Only the aggregate probe verdict is retained; network details never enter monitor state. */
export function assessLiveCheck(liveCheck) {
  if (liveCheck?.passed === true) return { state: "reachable", code: "http_probes_passed" };
  if (liveCheck?.passed === false) return { state: "failed", code: "http_probes_failed" };
  return { state: "unknown", code: "http_probes_not_run" };
}

export function currentMonitorStatus({ backup, billing, liveCheck, config, now = new Date() }) {
  const backupMaxAgeDays = Number.isFinite(config?.backupMaxAgeDays) ? config.backupMaxAgeDays : 8;
  const backupGraceHours = Number.isFinite(config?.backupGraceHours) ? config.backupGraceHours : 12;
  const backupStatus =
    backupMaxAgeDays >= 1 &&
    backupMaxAgeDays <= 30 &&
    backupGraceHours >= 0 &&
    backupGraceHours <= 48
      ? assessBackupState(backup, {
          now,
          maxAgeMs: (backupMaxAgeDays + backupGraceHours / 24) * 86_400_000,
        })
      : { state: "unknown", code: "backup_monitor_config_invalid" };
  const billingStatus = assessBilling(billing, config, { now });
  return { backup: backupStatus, billing: billingStatus, live: assessLiveCheck(liveCheck) };
}

function notificationFor(category, status, previous) {
  if (category === "live") {
    if (status.state === "reachable")
      return previous && previous.state !== "reachable"
        ? {
            kind: "recovery",
            title: "Nextcloud-flare 公開経路の到達性が回復",
            body: "Access ゲートと公開 Worker 経路の匿名 HTTP チェックが再び通りました。ログインや全機能の正常性は検証していません。",
          }
        : null;
    return {
      kind: status.state,
      title: "Nextcloud-flare 公開経路の到達性を確認できません",
      body:
        status.state === "failed"
          ? "Access ゲートまたは公開 Worker 経路の匿名 HTTP チェックが失敗しました。非公開の監視状態を確認してください。"
          : "匿名 HTTP チェックを実施できませんでした。公開経路の到達性は不明です。",
    };
  }
  if (category === "backup") {
    if (status.state === "healthy") {
      return previous && previous.state !== "healthy"
        ? {
            kind: "recovery",
            title: "Nextcloud-flare バックアップ復旧",
            body: "週次バックアップ、オフライン復元検証、暗号化アーカイブ照合が完了しました。",
          }
        : null;
    }
    const body =
      status.state === "failed"
        ? "週次バックアップに失敗しました。外部ボリュームと非公開のインシデント記録を確認してください。"
        : status.state === "stale"
          ? "最終検証済みバックアップの期限を超えています。外部ボリュームと復元状態を確認してください。"
          : status.state === "in_progress"
            ? "週次バックアップがまだ完了していません。未完了が続く場合は非公開のインシデント記録を確認してください。"
            : "バックアップ状態を確認できません。内部状態ファイルと外部ボリュームを確認してください。";
    return {
      kind: status.state,
      title: "Nextcloud-flare バックアップ状態",
      body,
    };
  }

  if (status.state === "unknown")
    return {
      kind: "unknown",
      title: "Nextcloud-flare 請求状態を確認できません",
      body: "請求データが取得できないか古くなっています。staging予算の状態は判定できません。",
    };
  if (status.state === "unattributed_below_threshold")
    return previous && previous.state !== "unattributed_below_threshold"
      ? {
          kind: "recovery_unattributed",
          title: "Nextcloud-flare 請求アラートの変化",
          body: previous.state.startsWith("threshold_")
            ? "アカウント全体の推定値が設定した通知段階を下回りました。stagingの利用額は個別に帰属できないため、予算が健全という確認にはなりません。"
            : "請求データを取得できましたが、stagingの個別利用額は分かりません。予算が健全という確認にはなりません。",
        }
      : previous
        ? null
        : {
            kind: "unattributed",
            title: "Nextcloud-flare 請求の帰属情報なし",
            body: "請求データはCloudflareアカウント全体のものです。staging単独の費用と予算状態は確認できません。",
          };
  if (previous?.state === status.state) return null;
  return {
    kind: "threshold",
    title: "Nextcloud-flare 請求アラート",
    body: "アカウント全体の請求推定が設定した通知段階に達しました。Cloudflareの請求画面を確認してください。staging単独の金額ではありません。",
  };
}

export function planNotifications(previous, current) {
  const events = [];
  for (const category of ["backup", "billing", "live"]) {
    const before = previous?.[category] ?? null;
    const after = current[category] ?? (category === "live" ? assessLiveCheck(null) : null);
    if (!after) continue;
    if (before?.state === after.state && before?.code === after.code) continue;
    const notification = notificationFor(category, after, before);
    if (notification)
      events.push({ category, from: before?.state ?? "initial", to: after.state, ...notification });
  }
  return events;
}

export const MAX_MONITOR_PENDING_NOTIFICATIONS = MAX_PENDING_NOTIFICATIONS;
