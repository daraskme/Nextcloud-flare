import { parseArgs } from "node:util";
import { inspectBackupHealth } from "./backup/health.mjs";
import { localBackupStore, S3BackupStore } from "./backup/objectStore.mjs";
import { opsControls } from "./ops/control.mjs";
import { compose, failureEnvelope, healthExitCode, redactedBackup } from "./ops/health.mjs";

const usage = `Usage:
  pnpm ops:health --operator-config JSON --local --config PATH --epoch N [--environment NAME]
  pnpm ops:health --operator-config JSON --remote --epoch N

Produces one redacted JSON envelope. Exit 0: complete and healthy; 2: unhealthy or incomplete; 1: inspection failed.
`;

function epoch(value) {
  if (!/^\d+$/.test(value ?? "")) throw new Error("invalid_ops_health_arguments");
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) throw new Error("invalid_ops_health_arguments");
  return parsed;
}

function stableCode(error) {
  const message = error instanceof Error ? error.message : "";
  return /^(?:ops|backup|invalid_ops_health)_[a-z_]+$/.test(message)
    ? message
    : "ops_health_failed";
}

try {
  const { values } = parseArgs({
    options: {
      config: { type: "string" },
      environment: { type: "string" },
      local: { type: "boolean" },
      remote: { type: "boolean" },
      epoch: { type: "string" },
      "operator-config": { type: "string" },
      help: { type: "boolean" },
    },
  });
  if (values.help) {
    console.log(usage);
  } else {
    if (
      !values["operator-config"] ||
      !!values.local === !!values.remote ||
      (values.local && !values.config) ||
      (values.remote && (values.config || values.environment))
    )
      throw new Error("invalid_ops_health_arguments");
    const expectedEpoch = epoch(values.epoch);
    let controls;
    let store;
    try {
      controls = await opsControls(values["operator-config"], values.local ? "local" : "remote");
      store = values.local
        ? await localBackupStore(values.config, values.environment)
        : new S3BackupStore(process.env);
      const operations = await controls.operations.inspect(expectedEpoch);
      const backup = redactedBackup(
        await inspectBackupHealth({
          epoch: expectedEpoch,
          control: controls.backup,
          store,
          progress: () => {},
        }),
        expectedEpoch,
      );
      const envelope = compose(operations, backup);
      console.log(JSON.stringify(envelope));
      process.exitCode = healthExitCode(envelope);
    } finally {
      try {
        await store?.dispose();
      } finally {
        await controls?.dispose();
      }
    }
  }
} catch (error) {
  console.log(JSON.stringify(failureEnvelope(stableCode(error))));
  process.exitCode = 1;
}
