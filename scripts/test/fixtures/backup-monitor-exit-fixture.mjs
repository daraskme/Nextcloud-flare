import { runBackupMonitor } from "../../backup/monitor.mjs";

const kind = process.argv[2],
  stateDirectory = process.argv[3];
const base = {
  epoch: 2,
  health: {
    complete: true,
    eligible: 5,
    missing: 0,
    scanned: 5,
    verified: 5,
    alerts: [],
  },
  cleanup: null,
};
const execute = async () => {
  if (kind === "error") throw new Error("backup_inventory_changed");
  if (kind === "unhealthy" || kind === "delivery-fail")
    return {
      ...base,
      healthy: false,
      health: {
        ...base.health,
        healthy: false,
        eligible: 1,
        missing: 4,
        alerts: ["backup_daily_missing"],
      },
    };
  return { ...base, healthy: true, health: { ...base.health, healthy: true } };
};
try {
  const result = await runBackupMonitor({
    stateDirectory,
    execute,
    deliver: async () => {
      if (kind === "delivery-fail") throw new Error("backup_webhook_non_2xx");
    },
    observedAt: 1,
  });
  process.exitCode = result.exitCode;
} catch {
  process.exitCode = 1;
}
