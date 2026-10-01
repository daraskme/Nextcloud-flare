import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { operatorControl } from "./backup/control.mjs";
import { maintainBackups } from "./backup/maintenance.mjs";
import { runBackupMonitor } from "./backup/monitor.mjs";
import { localBackupStore, S3BackupStore } from "./backup/objectStore.mjs";
import { sendStdoutEvent, sendWebhookEvent } from "./backup/webhookSink.mjs";
import { wranglerSource } from "./backup/wrangler.mjs";

const usage = `Usage:
  pnpm backup:monitor --state-directory PATH --dry-run --operator-config JSON --config PATH --database DB --local|--remote --epoch N --directory GENERATIONS [--environment NAME]
  pnpm backup:monitor --state-directory PATH --webhook-url-env NAME [--webhook-authorization-env NAME] --operator-config JSON --config PATH --database DB --local|--remote --epoch N --directory GENERATIONS [--environment NAME]

Runs backup maintain --prune-expired, converts the final redacted health result into a
deduplicated backup alert/recovery event, and preserves maintain's exit 0/2 unless
inspection or notification fails. Webhook URLs must be HTTPS except loopback tests.
`;

function fail() {
  throw new Error("invalid_backup_monitor_arguments");
}

function optionUrl(values) {
  if (values["webhook-url"]) return values["webhook-url"];
  if (values["webhook-url-env"]) return process.env[values["webhook-url-env"]];
  return process.env.NCF_BACKUP_WEBHOOK_URL;
}

try {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      config: { type: "string" },
      database: { type: "string" },
      environment: { type: "string" },
      local: { type: "boolean" },
      remote: { type: "boolean" },
      epoch: { type: "string" },
      directory: { type: "string" },
      "operator-config": { type: "string" },
      "state-directory": { type: "string" },
      "webhook-url": { type: "string" },
      "webhook-url-env": { type: "string" },
      "webhook-authorization-env": { type: "string" },
      "webhook-timeout-ms": { type: "string" },
      "dry-run": { type: "boolean" },
      help: { type: "boolean" },
    },
  });
  if (values.help) console.log(usage);
  else {
    if (positionals.length !== 0) fail();
    const timeoutMs = values["webhook-timeout-ms"]
      ? Number(values["webhook-timeout-ms"])
      : undefined;
    if (
      !values["state-directory"] ||
      !values["operator-config"] ||
      !values.directory ||
      !values.config ||
      !values.database ||
      !!values.local === !!values.remote ||
      !/^\d+$/.test(values.epoch ?? "") ||
      (values.remote && values.environment) ||
      (values["webhook-url"] && values["webhook-url-env"]) ||
      (values["dry-run"] && (values["webhook-url"] || values["webhook-url-env"])) ||
      (timeoutMs !== undefined && !Number.isSafeInteger(timeoutMs))
    )
      fail();
    const epoch = Number(values.epoch),
      mode = values.local ? "local" : "remote";
    if (!Number.isSafeInteger(epoch) || epoch < 1) throw new Error("invalid_backup_request");
    const endpoint = optionUrl(values);
    if (!values["dry-run"] && !endpoint) fail();
    const authorization = values["webhook-authorization-env"]
      ? process.env[values["webhook-authorization-env"]]
      : process.env.NCF_BACKUP_WEBHOOK_AUTHORIZATION;
    const deliver = values["dry-run"]
      ? (event) => sendStdoutEvent(event)
      : (event) =>
          sendWebhookEvent({
            event,
            endpoint,
            authorization,
            timeoutMs,
          });
    let control, store;
    const execute = async () => {
      control = await operatorControl(values["operator-config"], mode);
      store = values.local
        ? await localBackupStore(values.config, values.environment)
        : new S3BackupStore(process.env);
      const source = await wranglerSource({
        config: values.config,
        database: values.database,
        environment: values.environment,
        mode,
      });
      return maintainBackups({
        pruneExpired: true,
        directory: resolve(values.directory),
        epoch,
        control,
        source,
        store,
      });
    };
    try {
      const result = await runBackupMonitor({
        stateDirectory: resolve(values["state-directory"]),
        execute,
        deliver,
      });
      console.log(
        JSON.stringify({
          command: "backup-monitor",
          result: {
            status: result.status,
            deliveredEventId: result.deliveredEventId,
          },
        }),
      );
      process.exitCode = result.exitCode;
    } finally {
      try {
        await store?.dispose();
      } finally {
        await control?.dispose();
      }
    }
  }
} catch (error) {
  const message = error instanceof Error ? error.message.split("\n")[0] : "";
  const code = /^(?:backup|invalid_backup)_[a-z0-9_]+$/.test(message) ? message : "backup_failed";
  console.error(
    `${code}: backup monitor did not publish a trusted final state; rerun with the same arguments after fixing configuration or delivery.`,
  );
  process.exitCode = 1;
}
