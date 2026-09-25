import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { operatorControl } from "./backup/control.mjs";
import { captureGeneration, restoreGeneration, verifyGeneration } from "./backup/generation.mjs";
import { inspectBackupHealth } from "./backup/health.mjs";
import { localBackupStore, S3BackupStore } from "./backup/objectStore.mjs";
import { operatorIdentity, runBackup, runDailyBackup } from "./backup/operator.mjs";
import { downloadGeneration, publishGeneration } from "./backup/publication.mjs";
import { wranglerSource } from "./backup/wrangler.mjs";

const usage = `Usage:
  pnpm backup health --operator-config JSON --local --config PATH --epoch N [--environment NAME]
  pnpm backup health --operator-config JSON --remote --epoch N
  pnpm backup daily --operator-config JSON --config PATH --database DB --local|--remote --epoch N --directory GENERATIONS [--environment NAME]
  pnpm backup run --operator-config JSON --config PATH --database DB --local|--remote --id UUID --epoch N --directory GENERATIONS [--environment NAME]
  pnpm backup receipt|cancel --operator-config JSON --local|--remote --id UUID --epoch N
  pnpm backup capture --config PATH --database DB --local|--remote --id UUID --epoch N --directory PATH [--environment NAME]
  pnpm backup verify --directory GENERATION_PATH
  pnpm backup restore-offline --directory GENERATION_PATH --target NEW_SQLITE_FILE
  pnpm backup publish --directory GENERATION_PATH --local --config PATH [--environment NAME]
  pnpm backup download --id UUID --directory GENERATIONS --local --config PATH [--manifest-sha256 HEX]
  publish/download --remote use R2_BACKUP_* environment credentials instead of --local/--config.

capture requires an already-frozen generation from ControlDO.beginBackup. It never releases the barrier.
run begins, captures, verifies, publishes and completes the same explicit generation. Re-run the same arguments after failure; no automatic cancel.
daily uses a durable server-owned identity and UTC capture day; re-run after failure with the same configuration. A completed day re-verifies stored data.
health verifies stored SQL generations and the 35-day / minimum-five / daily policy against server time. Exit 0: healthy; 2: unhealthy or incomplete; 1: inspection failed.
The private BackupOperator service binding requires an enabled target and an explicit matching environment capability.
restore-offline creates a new frozen inspection database; it does not restore a live D1 or resume service.
`;
try {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      config: { type: "string" },
      database: { type: "string" },
      environment: { type: "string" },
      local: { type: "boolean" },
      remote: { type: "boolean" },
      id: { type: "string" },
      epoch: { type: "string" },
      directory: { type: "string" },
      target: { type: "string" },
      "manifest-sha256": { type: "string" },
      "operator-config": { type: "string" },
      help: { type: "boolean" },
    },
  });
  if (values.help) console.log(usage);
  else {
    if (positionals.length !== 1) throw new Error("invalid_backup_arguments");
    const allowed = {
      capture: ["directory", "config", "database", "local", "remote", "id", "epoch", "environment"],
      verify: ["directory"],
      "restore-offline": ["directory", "target"],
      publish: ["directory", "local", "remote", "config", "environment"],
      download: ["directory", "local", "remote", "config", "environment", "id", "manifest-sha256"],
      run: [
        "directory",
        "config",
        "database",
        "local",
        "remote",
        "id",
        "epoch",
        "environment",
        "operator-config",
      ],
      daily: [
        "directory",
        "config",
        "database",
        "local",
        "remote",
        "epoch",
        "environment",
        "operator-config",
      ],
      health: ["config", "environment", "local", "remote", "epoch", "operator-config"],
      receipt: ["local", "remote", "id", "epoch", "operator-config"],
      cancel: ["local", "remote", "id", "epoch", "operator-config"],
    }[positionals[0]];
    if (!allowed || Object.keys(values).some((key) => !allowed.includes(key)))
      throw new Error("invalid_backup_arguments");
    if (["run", "daily", "health", "receipt", "cancel"].includes(positionals[0])) {
      if (
        !values["operator-config"] ||
        !!values.local === !!values.remote ||
        !/^\d+$/.test(values.epoch ?? "")
      )
        throw new Error("invalid_backup_arguments");
      const epoch = Number(values.epoch),
        id = values.id,
        mode = values.local ? "local" : "remote";
      if (!["daily", "health"].includes(positionals[0])) operatorIdentity(epoch, id);
      else if (!Number.isSafeInteger(epoch) || epoch < 1) throw new Error("invalid_backup_request");
      if (
        ["run", "daily"].includes(positionals[0]) &&
        (!values.directory || !values.config || !values.database)
      )
        throw new Error("invalid_backup_arguments");
      if (
        positionals[0] === "health" &&
        ((values.local && !values.config) ||
          (values.remote && (values.config || values.environment)))
      )
        throw new Error("invalid_backup_arguments");
      const control = await operatorControl(values["operator-config"], mode);
      let store;
      try {
        let result;
        if (["run", "daily", "health"].includes(positionals[0])) {
          store = values.local
            ? await localBackupStore(values.config, values.environment)
            : new S3BackupStore(process.env);
          if (positionals[0] === "health") {
            result = await inspectBackupHealth({
              epoch,
              control,
              store,
              progress: (event) => console.log(JSON.stringify(event)),
            });
            if (!result.healthy) process.exitCode = 2;
          } else {
            const source = await wranglerSource({
              config: values.config,
              database: values.database,
              environment: values.environment,
              mode,
            });
            result = await (positionals[0] === "daily" ? runDailyBackup : runBackup)({
              directory: values.directory,
              id,
              epoch,
              control,
              source,
              store,
              progress: (event) => console.log(JSON.stringify(event)),
            });
          }
        } else result = await control[positionals[0]](epoch, id);
        console.log(JSON.stringify({ command: positionals[0], result }));
      } finally {
        try {
          await store?.dispose();
        } finally {
          await control.dispose();
        }
      }
    } else {
      if (!values.directory) throw new Error("invalid_backup_arguments");
      const directory = resolve(values.directory);
      let manifest, receipt;
      if (positionals[0] === "capture") {
        if (
          !values.config ||
          !values.database ||
          !!values.local === !!values.remote ||
          !values.id ||
          !/^\d+$/.test(values.epoch ?? "") ||
          values.target
        )
          throw new Error("invalid_backup_arguments");
        const source = await wranglerSource({
          config: values.config,
          database: values.database,
          environment: values.environment,
          mode: values.local ? "local" : "remote",
        });
        ({ manifest } = await captureGeneration({
          directory,
          id: values.id,
          epoch: Number(values.epoch),
          source,
          progress: (stage) => console.log(JSON.stringify({ stage })),
        }));
      } else if (positionals[0] === "publish" || positionals[0] === "download") {
        if (
          !!values.local === !!values.remote ||
          (values.local && !values.config) ||
          (values.remote && (values.config || values.environment)) ||
          (positionals[0] === "download" && !values.id)
        )
          throw new Error("invalid_backup_arguments");
        const store = values.local
          ? await localBackupStore(values.config, values.environment)
          : new S3BackupStore(process.env);
        try {
          const progress = (event) => console.log(JSON.stringify(event));
          receipt =
            positionals[0] === "publish"
              ? await publishGeneration({ directory, store, progress })
              : await downloadGeneration({
                  directory,
                  store,
                  id: values.id,
                  expectedSha256: values["manifest-sha256"],
                  progress,
                });
          manifest = receipt.manifest;
        } finally {
          await store.dispose();
        }
      } else {
        if (
          ["config", "database", "environment", "local", "remote", "id", "epoch"].some(
            (key) => values[key] !== undefined,
          )
        )
          throw new Error("invalid_backup_arguments");
        if (positionals[0] === "verify" && !values.target)
          manifest = await verifyGeneration(directory);
        else if (positionals[0] === "restore-offline" && values.target)
          ({ manifest } = await restoreGeneration({ directory, target: resolve(values.target) }));
        else throw new Error("invalid_backup_arguments");
      }
      console.log(
        JSON.stringify({
          result: "verified",
          command: positionals[0],
          id: manifest.generation.id,
          epoch: manifest.generation.epoch,
          bytes: manifest.data.bytes,
          ...(receipt ? { objectKey: receipt.key, manifestSha256: receipt.sha256 } : {}),
          scope:
            "Verified SQL generation; publish/download transport uses BACKUPS. Original BLOBS content, backup_runs completion, epoch recovery and live restore are separate.",
        }),
      );
    }
  }
} catch (error) {
  // No source SQL, credentials, provider errors, signed URLs, or node values in operator logs.
  const message = error instanceof Error ? error.message.split("\n")[0] : "";
  const code = /^(?:backup|invalid_backup)_[a-z_]+$/.test(message) ? message : "backup_failed";
  console.error(
    `${code}: verify arguments and inspect the same generation receipt; an interrupted operation may have committed. No automatic cancellation was attempted.`,
  );
  process.exitCode = 1;
}
