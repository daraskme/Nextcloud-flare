import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { captureGeneration, restoreGeneration, verifyGeneration } from "./backup/generation.mjs";
import { localBackupStore, S3BackupStore } from "./backup/objectStore.mjs";
import { downloadGeneration, publishGeneration } from "./backup/publication.mjs";
import { wranglerSource } from "./backup/wrangler.mjs";

const usage = `Usage:
  pnpm backup capture --config PATH --database DB --local|--remote --id UUID --epoch N --directory PATH [--environment NAME]
  pnpm backup verify --directory GENERATION_PATH
  pnpm backup restore-offline --directory GENERATION_PATH --target NEW_SQLITE_FILE
  pnpm backup publish --directory GENERATION_PATH --local --config PATH [--environment NAME]
  pnpm backup download --id UUID --directory GENERATIONS --local --config PATH [--manifest-sha256 HEX]
  publish/download --remote use R2_BACKUP_* environment credentials instead of --local/--config.

capture requires an already-frozen generation from ControlDO.beginBackup. It never releases the barrier.
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
      help: { type: "boolean" },
    },
  });
  if (values.help) console.log(usage);
  else {
    if (positionals.length !== 1 || !values.directory) throw new Error("invalid_backup_arguments");
    const allowed = {
      capture: ["directory", "config", "database", "local", "remote", "id", "epoch", "environment"],
      verify: ["directory"],
      "restore-offline": ["directory", "target"],
      publish: ["directory", "local", "remote", "config", "environment"],
      download: ["directory", "local", "remote", "config", "environment", "id", "manifest-sha256"],
    }[positionals[0]];
    if (!allowed || Object.keys(values).some((key) => !allowed.includes(key)))
      throw new Error("invalid_backup_arguments");
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
} catch (error) {
  // No source SQL, credentials, provider errors, signed URLs, or node values in operator logs.
  const message = error instanceof Error ? error.message.split("\n")[0] : "";
  const code = /^(?:backup|invalid_backup)_[a-z_]+$/.test(message) ? message : "backup_failed";
  console.error(
    `${code}: verify arguments, source freeze, schema and artifact integrity; source barrier was not released`,
  );
  process.exitCode = 1;
}
