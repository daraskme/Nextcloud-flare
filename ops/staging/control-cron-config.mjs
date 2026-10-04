import { chmod, readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const templatePath = fileURLToPath(
  new URL("./control-cron.wrangler.example.jsonc", import.meta.url),
);
const generatedPath = fileURLToPath(new URL("./control-cron.generated.jsonc", import.meta.url));

export function validateCronConfig(config) {
  if (
    config.name !== "ncf-staging-control-recovery" ||
    config.main !== "./control-cron.mjs" ||
    config.workers_dev !== false ||
    config.preview_urls !== false ||
    config.routes !== undefined ||
    config.services?.length !== 1 ||
    config.services[0]?.binding !== "STAGING_CONTROL" ||
    config.services[0]?.service !== "next-cloud-flare-staging" ||
    config.services[0]?.entrypoint !== "StagingControlOperator" ||
    config.services[0]?.props?.purpose !== "staging-control-recovery-v1" ||
    config.services[0]?.props?.environment !== "staging" ||
    JSON.stringify(config.triggers?.crons) !== '["* * * * *"]' ||
    config.vars?.STAGING_TARGET !== "next-cloud-flare-staging" ||
    config.vars?.STAGING_CONTROL_CRON_ENABLED !== "true"
  )
    throw new Error("staging_control_cron_config_invalid");
}

export async function generateCronConfig(accountId) {
  if (typeof accountId !== "string" || !/^[a-f0-9]{32}$/.test(accountId))
    throw new Error("staging_control_account_id_required");
  const config = JSON.parse(await readFile(templatePath, "utf8"));
  validateCronConfig(config);
  config.account_id = accountId;
  await writeFile(generatedPath, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  await chmod(generatedPath, 0o600);
  return generatedPath;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  try {
    await generateCronConfig(process.env.CLOUDFLARE_ACCOUNT_ID);
    process.stdout.write("Generated private staging control Cron config\n");
  } catch (error) {
    const message = error instanceof Error ? error.message : "";
    process.stderr.write(
      `${/^staging_control_[a-z_]+$/.test(message) ? message : "staging_control_cron_config_invalid"}\n`,
    );
    process.exitCode = 1;
  }
}
