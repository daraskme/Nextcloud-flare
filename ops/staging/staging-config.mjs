import { chmodSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const directory = fileURLToPath(new URL(".", import.meta.url));
const templatePath = `${directory}wrangler.staging.example.jsonc`;
const generatedPath = `${directory}wrangler.staging.generated.jsonc`;

function readJsonc(path) {
  const parsed = ts.parseConfigFileTextToJson(path, readFileSync(path, "utf8"));
  if (parsed.error) throw new Error(`Invalid staging template: ${path}`);
  return parsed.config;
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function validateTemplate(config) {
  assert(config.name === "next-cloud-flare-staging", "Unexpected Worker name");
  assert(
    config.workers_dev === false && config.preview_urls === false,
    "Public preview is enabled",
  );
  assert(config.vars?.ENVIRONMENT === "staging", "Unexpected environment marker");
  assert(
    config.vars.CLIENT_ENCRYPTION_REQUIRED === "true",
    "Staging client encryption must be required",
  );
  assert(
    ["true", "false"].includes(config.vars.STAGING_CONTROL_OPERATOR_ENABLED) &&
      config.vars.EPOCH_FLOOR === "2",
    "Unexpected control recovery configuration",
  );
  assert(
    config.vars.BACKUP_OPERATOR_ENABLED === undefined ||
      ["true", "false"].includes(config.vars.BACKUP_OPERATOR_ENABLED),
    "Unexpected backup operator configuration",
  );
  assert(
    config.vars.APP_ORIGIN === "https://staging-app.darask.date" &&
      config.vars.CONTENT_ORIGIN === "https://staging-content.darask.date",
    "Unexpected staging origins",
  );
  assert(
    JSON.stringify(config.routes) ===
      JSON.stringify([
        { pattern: "staging-app.darask.date", custom_domain: true },
        { pattern: "staging-content.darask.date", custom_domain: true },
      ]),
    "Unexpected custom domains",
  );
  assert(
    config.d1_databases?.length === 1 && config.d1_databases[0].binding === "DB",
    "Unexpected D1 binding",
  );
  assert(
    config.kv_namespaces?.length === 1 && config.kv_namespaces[0].binding === "CACHE",
    "Unexpected KV binding",
  );
  assert(config.queues?.producers?.[0]?.queue === "ncf-staging-jobs", "Unexpected queue producer");
  assert(
    config.queues?.consumers?.length === 2 &&
      config.queues.consumers[0].queue === "ncf-staging-jobs" &&
      config.queues.consumers[0].dead_letter_queue === "ncf-staging-jobs-dlq" &&
      config.queues.consumers[1].queue === "ncf-staging-jobs-dlq",
    "Unexpected queue consumers",
  );
  assert(JSON.stringify(config.triggers?.crons) === '["* * * * *"]', "Unexpected cron");
  assert(
    Array.isArray(config.secrets?.required) && config.secrets.required.length > 0,
    "No required secrets",
  );
}

function generate() {
  const config = readJsonc(templatePath);
  validateTemplate(config);
  const d1 = process.env.STAGING_D1_DATABASE_ID?.trim() ?? "";
  const kv = process.env.STAGING_KV_NAMESPACE_ID?.trim() ?? "";
  assert(
    /^[a-f\d]{8}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{12}$/i.test(d1),
    "Invalid STAGING_D1_DATABASE_ID",
  );
  assert(/^[a-f\d]{32}$/i.test(kv), "Invalid STAGING_KV_NAMESPACE_ID");
  assert(d1 !== "00000000-0000-0000-0000-000000000000", "Local D1 placeholder rejected");
  assert(kv !== "00000000000000000000000000000000", "Local KV placeholder rejected");
  config.d1_databases[0].database_id = d1;
  config.kv_namespaces[0].id = kv;
  assert(!JSON.stringify(config).includes("REPLACE_WITH_"), "Unreplaced staging placeholder");
  writeFileSync(generatedPath, `${JSON.stringify(config, null, 2)}\n`, { flag: "w", mode: 0o600 });
  chmodSync(generatedPath, 0o600);
  console.log("Generated staging Wrangler config with validated resource IDs");
}

function checkSecrets(listPath) {
  assert(listPath, "Missing secret list file");
  const config = readJsonc(generatedPath);
  validateTemplate(config);
  const found = JSON.parse(readFileSync(listPath, "utf8"));
  assert(
    Array.isArray(found) && found.every((item) => typeof item?.name === "string"),
    "Invalid Wrangler secret list",
  );
  const present = new Set(found.map((item) => item.name));
  const missing = config.secrets.required.filter((name) => !present.has(name));
  assert(missing.length === 0, `Missing staging Worker secrets: ${missing.join(", ")}`);
  console.log(
    `Confirmed ${config.secrets.required.length} required secret names on staging Worker`,
  );
}

function inspectResourceIds(d1ListPath, kvListPath) {
  assert(d1ListPath && kvListPath, "Expected D1 and KV list JSON paths");
  const config = readJsonc(templatePath);
  validateTemplate(config);
  const databases = JSON.parse(readFileSync(d1ListPath, "utf8"));
  const namespaces = JSON.parse(readFileSync(kvListPath, "utf8"));
  assert(Array.isArray(databases) && Array.isArray(namespaces), "Invalid resource list JSON");
  const d1Matches = databases.filter((row) => row?.name === config.d1_databases[0].database_name);
  const kvMatches = namespaces.filter((row) => row?.title === "ncf-staging-cache");
  assert(
    d1Matches.length === 1 && kvMatches.length === 1,
    "Expected one exact D1 and KV name match",
  );
  const d1 = d1Matches[0].uuid;
  const kv = kvMatches[0].id;
  assert(
    typeof d1 === "string" && /^[a-f\d]{8}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{12}$/i.test(d1),
    "Invalid D1 UUID in resource list",
  );
  assert(typeof kv === "string" && /^[a-f\d]{32}$/i.test(kv), "Invalid KV ID in resource list");
  assert(d1 !== "00000000-0000-0000-0000-000000000000", "Local D1 placeholder rejected");
  assert(kv !== "00000000000000000000000000000000", "Local KV placeholder rejected");
  console.log(`STAGING_D1_DATABASE_ID=${d1}`);
  console.log(`STAGING_KV_NAMESPACE_ID=${kv}`);
}

function setOperatorEnabled(enabled) {
  const config = readJsonc(generatedPath);
  validateTemplate(config);
  assert(
    config.d1_databases?.[0]?.database_id !== "REPLACE_WITH_STAGING_D1_UUID" &&
      config.kv_namespaces?.[0]?.id !== "REPLACE_WITH_STAGING_KV_ID",
    "Generate the staging config first",
  );
  config.vars.STAGING_CONTROL_OPERATOR_ENABLED = String(enabled);
  writeFileSync(generatedPath, `${JSON.stringify(config, null, 2)}\n`, { flag: "w", mode: 0o600 });
  chmodSync(generatedPath, 0o600);
  console.log(`Staging control operator ${enabled ? "enabled" : "disabled"} in generated config`);
}

function setBackupOperatorEnabled(enabled) {
  const config = readJsonc(generatedPath);
  validateTemplate(config);
  assert(
    config.d1_databases?.[0]?.database_id !== "REPLACE_WITH_STAGING_D1_UUID" &&
      config.kv_namespaces?.[0]?.id !== "REPLACE_WITH_STAGING_KV_ID",
    "Generate the staging config first",
  );
  config.vars.BACKUP_OPERATOR_ENABLED = String(enabled);
  writeFileSync(generatedPath, `${JSON.stringify(config, null, 2)}\n`, { flag: "w", mode: 0o600 });
  chmodSync(generatedPath, 0o600);
  console.log(`Staging backup operator ${enabled ? "enabled" : "disabled"} in generated config`);
}

switch (process.argv[2]) {
  case "generate":
    generate();
    break;
  case "check-secrets":
    checkSecrets(process.argv[3]);
    break;
  case "inspect-ids":
    inspectResourceIds(process.argv[3], process.argv[4]);
    break;
  case "operator-enable":
    setOperatorEnabled(true);
    break;
  case "operator-disable":
    setOperatorEnabled(false);
    break;
  case "backup-operator-enable":
    setBackupOperatorEnabled(true);
    break;
  case "backup-operator-disable":
    setBackupOperatorEnabled(false);
    break;
  default:
    throw new Error(
      "Usage: node staging-config.mjs generate|check-secrets|inspect-ids|operator-enable|operator-disable|backup-operator-enable|backup-operator-disable [JSON files]",
    );
}
