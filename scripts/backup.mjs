import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { captureGeneration, restoreGeneration, verifyGeneration } from "./backup/generation.mjs";
import { wranglerSource } from "./backup/wrangler.mjs";

const usage = `Usage:
  pnpm backup capture --config PATH --database DB --local|--remote --id UUID --epoch N --directory PATH [--environment NAME]
  pnpm backup verify --directory GENERATION_PATH
  pnpm backup restore-offline --directory GENERATION_PATH --target NEW_SQLITE_FILE

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
      help: { type: "boolean" },
    },
  });
  if (values.help) console.log(usage);
  else {
    if (positionals.length !== 1 || !values.directory) throw new Error("invalid_backup_arguments");
    const directory = resolve(values.directory);
    let manifest;
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
        id: manifest.generation.id,
        epoch: manifest.generation.epoch,
        bytes: manifest.data.bytes,
        scope:
          "SQL generation and offline FTS/FK/data verification; R2 content, epoch recovery and live restore are separate.",
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
