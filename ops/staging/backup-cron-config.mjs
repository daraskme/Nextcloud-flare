import { randomUUID } from "node:crypto";
import { chmod, lstat, readFile, rename, rm, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const templatePath = fileURLToPath(
  new URL("./backup-cron.wrangler.example.jsonc", import.meta.url),
);
const generatedPath = fileURLToPath(new URL("./backup-cron.generated.jsonc", import.meta.url));
const ID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;
const SHA256 = /^[a-f0-9]{64}$/;
const keys = (value) =>
  Object.keys(value ?? {})
    .sort()
    .join(",");

function fixedShape(config) {
  return (
    keys(config) ===
      "$schema,account_id,compatibility_date,main,name,preview_urls,send_metrics,services,triggers,vars,workers_dev" &&
    config.$schema === "../../node_modules/wrangler/config-schema.json" &&
    config.name === "ncf-staging-backup-bridge" &&
    config.main === "./backup-cron.mjs" &&
    config.compatibility_date === "2026-08-15" &&
    config.workers_dev === false &&
    config.preview_urls === false &&
    config.send_metrics === false &&
    Array.isArray(config.services) &&
    config.services.length === 1 &&
    keys(config.services[0]) === "binding,entrypoint,props,service" &&
    config.services[0].binding === "BACKUP_CONTROL" &&
    config.services[0].service === "next-cloud-flare-staging" &&
    config.services[0].entrypoint === "BackupOperator" &&
    keys(config.services[0].props) === "environment,purpose" &&
    config.services[0].props.purpose === "logical-backup-v1" &&
    config.services[0].props.environment === "staging" &&
    keys(config.triggers) === "crons" &&
    JSON.stringify(config.triggers.crons) === '["* * * * *"]' &&
    config.vars?.BACKUP_CRON_ENABLED === "true" &&
    config.vars.BACKUP_TARGET === "next-cloud-flare-staging" &&
    config.vars.BACKUP_EPOCH === "2"
  );
}

export function validateCronConfig(config) {
  const vars = config?.vars;
  if (
    !fixedShape(config) ||
    !/^[a-f0-9]{32}$/.test(config.account_id ?? "") ||
    !ID.test(vars.BACKUP_ID ?? "") ||
    !["begin", "complete", "receipt"].includes(vars.BACKUP_OPERATION) ||
    keys(vars) !==
      (vars.BACKUP_OPERATION === "complete"
        ? "BACKUP_CRON_ENABLED,BACKUP_EPOCH,BACKUP_ID,BACKUP_MANIFEST_SHA256,BACKUP_OPERATION,BACKUP_TARGET"
        : "BACKUP_CRON_ENABLED,BACKUP_EPOCH,BACKUP_ID,BACKUP_OPERATION,BACKUP_TARGET") ||
    (vars.BACKUP_OPERATION === "complete" && !SHA256.test(vars.BACKUP_MANIFEST_SHA256 ?? ""))
  )
    throw new Error("staging_backup_cron_config_invalid");
  return config;
}

export async function buildCronConfig({ accountId, id, operation, manifestSha256 }) {
  if (
    !/^[a-f0-9]{32}$/.test(accountId ?? "") ||
    !ID.test(id ?? "") ||
    !["begin", "complete", "receipt"].includes(operation) ||
    (operation === "complete" ? !SHA256.test(manifestSha256 ?? "") : manifestSha256 !== undefined)
  )
    throw new Error("staging_backup_cron_config_invalid");
  const config = JSON.parse(await readFile(templatePath, "utf8"));
  if (
    !fixedShape(config) ||
    config.account_id !== "REPLACE_WITH_CLOUDFLARE_ACCOUNT_ID" ||
    config.vars.BACKUP_ID !== "REPLACE_WITH_BACKUP_UUID" ||
    config.vars.BACKUP_OPERATION !== "REPLACE_WITH_OPERATION" ||
    config.vars.BACKUP_MANIFEST_SHA256 !== "REPLACE_WITH_MANIFEST_SHA256"
  )
    throw new Error("staging_backup_cron_config_invalid");
  config.account_id = accountId;
  config.vars.BACKUP_ID = id;
  config.vars.BACKUP_OPERATION = operation;
  if (operation === "complete") config.vars.BACKUP_MANIFEST_SHA256 = manifestSha256;
  else delete config.vars.BACKUP_MANIFEST_SHA256;
  return validateCronConfig(config);
}

export async function generateCronConfig(input, path = generatedPath) {
  const config = await buildCronConfig(input);
  try {
    const info = await lstat(path);
    if (!info.isFile() || (info.mode & 0o077) !== 0)
      throw new Error("staging_backup_cron_config_invalid");
    const previous = validateCronConfig(JSON.parse(await readFile(path, "utf8")));
    if (previous.vars.BACKUP_ID !== input.id || previous.account_id !== input.accountId)
      throw new Error("staging_backup_cron_identity_conflict");
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, `${JSON.stringify(config, null, 2)}\n`, { flag: "wx", mode: 0o600 });
    await chmod(temporary, 0o600);
    await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true });
  }
  return path;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  try {
    await generateCronConfig({
      accountId: process.env.CLOUDFLARE_ACCOUNT_ID,
      id: process.env.NCF_BACKUP_ID,
      operation: process.argv[2],
      manifestSha256:
        process.argv[2] === "complete" ? process.env.NCF_BACKUP_MANIFEST_SHA256 : undefined,
    });
    process.stdout.write("Generated private staging backup Cron config\n");
  } catch (error) {
    const message = error instanceof Error ? error.message : "";
    process.stderr.write(
      `${/^staging_backup_cron_[a-z_]+$/.test(message) ? message : "staging_backup_cron_config_invalid"}\n`,
    );
    process.exitCode = 1;
  }
}
