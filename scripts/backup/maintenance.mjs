import { BACKUP_MIN_GENERATIONS } from "../../packages/shared/src/backupRetention.ts";
import { inspectBackupHealth } from "./health.mjs";
import { runBackup, validateDailyPlan } from "./operator.mjs";
import { sweepBackups } from "./sweep.mjs";

/** One scheduled cycle. Every identity belongs to the durable server plan, never runner disk. */
export async function maintainBackups({
  epoch,
  control,
  store,
  progress = () => {},
  inspect = inspectBackupHealth,
  run = runBackup,
  pruneExpired = false,
  sweep = sweepBackups,
  ...options
}) {
  if (!Number.isSafeInteger(epoch) || epoch < 1 || typeof pruneExpired !== "boolean")
    throw new Error("invalid_backup_request");
  const args = { ...options, epoch, control, store, progress };
  let plan = validateDailyPlan(await control.daily(epoch), epoch);
  const completed = [];
  async function capture(current) {
    progress({ stage: "maintenance_identity", id: current.id, epoch });
    const result = await run({ ...args, id: current.id });
    if (result?.id !== current.id || result.epoch !== epoch || result.state !== "completed")
      throw new Error("backup_invalid_completion");
    completed.push(current.id);
  }
  if (plan.state === "run") await capture(plan);
  // A completed but corrupt daily export must not prevent recovery of redundancy.
  // The health check verifies it, reports the damage and determines the shortage.
  const initial = await inspect(args);
  if (
    initial.epoch !== epoch ||
    !Number.isSafeInteger(initial.missing) ||
    initial.missing < 0 ||
    initial.missing > BACKUP_MIN_GENERATIONS ||
    typeof initial.complete !== "boolean" ||
    !Array.isArray(initial.alerts)
  )
    throw new Error("backup_invalid_health");
  progress({
    stage: "maintenance_health",
    phase: "before",
    healthy: initial.healthy,
    missing: initial.missing,
    alerts: initial.alerts,
  });
  let health = initial;
  if (initial.complete) {
    const needed = Math.max(
      initial.missing,
      initial.alerts.includes("backup_daily_missing") ? 1 : 0,
    );
    for (let index = 0; index < needed; index++) {
      const next = validateDailyPlan(await control.replenish(epoch, plan.id), epoch);
      if (next.id === plan.id) throw new Error("backup_replenishment_stalled");
      plan = next;
      // Another runner may already have completed this successor. Re-inspect instead
      // of creating the remaining successors from an obsolete shortage count.
      if (plan.state === "completed") break;
      await capture(plan);
    }
    if (needed > 0) health = await inspect(args);
  }
  progress({
    stage: "maintenance_health",
    phase: "after",
    healthy: health.healthy,
    missing: health.missing,
    alerts: health.alerts,
  });
  let cleanup = null;
  if (pruneExpired && health.complete && health.healthy && !health.active) {
    cleanup = await sweep(args);
    if (
      cleanup?.epoch !== epoch ||
      typeof cleanup.complete !== "boolean" ||
      typeof cleanup.healthy !== "boolean"
    )
      throw new Error("backup_invalid_sweep_result");
  }
  return {
    healthy: health.healthy && (!pruneExpired || cleanup?.healthy === true),
    epoch,
    completed,
    initial,
    health,
    cleanup,
    scope:
      "Daily capture and bounded replenishment; optional durable expiry sweep after healthy inspection. No past-date backfill, automatic cancellation or live restore.",
  };
}
