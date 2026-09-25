import { parseArgs } from "node:util";
import { openBackupMonitor } from "./backup/monitor.mjs";
import { backupNotifier } from "./backup/notification.mjs";

let monitor;
try {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      directory: { type: "string" },
      source: { type: "string" },
      "max-run-ms": { type: "string" },
      "run-id": { type: "string" },
      help: { type: "boolean" },
    },
  });
  if (values.help)
    console.log(`Usage:
  pnpm backup:monitor check --directory PATH [--max-run-ms N]
  pnpm backup:monitor notify --directory PATH --source NAME [--max-run-ms N]
  pnpm backup:monitor abandon --directory PATH --run-id UUID
notify requires NCF_BACKUP_NOTIFY_URL (HTTPS) and NCF_BACKUP_NOTIFY_TOKEN. Only changes and recovery are delivered.
abandon records an interrupted local run as failed. Confirm the old runner has stopped first; it never cancels or thaws a backup.
Exit 0: healthy; 2: unhealthy; 1: configuration/storage/delivery failure or notification pending.`);
  else {
    const command = positionals[0],
      allowed = {
        check: ["directory", "max-run-ms"],
        notify: ["directory", "source", "max-run-ms"],
        abandon: ["directory", "run-id"],
      }[command];
    if (
      positionals.length !== 1 ||
      !values.directory ||
      !allowed ||
      Object.keys(values).some((k) => !allowed.includes(k))
    )
      throw new Error("backup_monitor_invalid_arguments");
    if (values["max-run-ms"] !== undefined && !/^\d+$/.test(values["max-run-ms"]))
      throw new Error("backup_monitor_invalid_policy");
    const policy =
      values["max-run-ms"] === undefined ? {} : { maxRunMs: Number(values["max-run-ms"]) };
    const send = command === "notify" ? backupNotifier(process.env) : undefined;
    monitor = await openBackupMonitor(values.directory);
    if (command === "abandon") monitor.finish(values["run-id"], 1);
    const result =
      command === "notify"
        ? await monitor.notify({ ...policy, source: values.source, send })
        : monitor.inspect(policy);
    console.log(JSON.stringify({ command, result }));
    if (result.pending) process.exitCode = 1;
    else if (!result.healthy) process.exitCode = 2;
  }
} catch (error) {
  const message = error instanceof Error ? error.message : "";
  console.error(/^backup_monitor_[a-z_]+$/.test(message) ? message : "backup_monitor_failed");
  process.exitCode = 1;
} finally {
  monitor?.close();
}
