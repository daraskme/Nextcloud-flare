import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const configPath = fileURLToPath(new URL("./wrangler.staging.example.jsonc", import.meta.url));
const parsed = ts.parseConfigFileTextToJson(configPath, readFileSync(configPath, "utf8"));
if (parsed.error) throw new Error("Invalid staging Wrangler template");
const config = parsed.config;

function expect(condition, message) {
  if (!condition) throw new Error(message);
}
function resourceName(value) {
  expect(
    typeof value === "string" && /^[a-z][a-z0-9-]{2,62}$/.test(value),
    "Invalid resource name",
  );
  return value;
}

expect(config.name === "next-cloud-flare-staging", "Unexpected Worker name");
expect(config.workers_dev === false && config.preview_urls === false, "Public preview enabled");
expect(config.d1_databases?.length === 1, "Expected one D1 database");
expect(config.kv_namespaces?.length === 1, "Expected one KV namespace");
expect(config.r2_buckets?.length === 2, "Expected two R2 buckets");
expect(config.queues?.consumers?.length === 2, "Expected primary and DLQ consumers");
expect(config.secrets?.required?.length > 0, "Expected required secret names");

const d1 = resourceName(config.d1_databases[0].database_name);
const kv = "ncf-staging-cache";
const buckets = config.r2_buckets.map((bucket) => resourceName(bucket.bucket_name));
const queues = config.queues.consumers.map((consumer) => resourceName(consumer.queue));
expect(config.queues.producers?.[0]?.queue === queues[0], "Unexpected primary Queue");
expect(config.queues.consumers[0].dead_letter_queue === queues[1], "Unexpected DLQ");
expect(new Set([d1, kv, ...buckets, ...queues]).size === 6, "Duplicate resource name");

const plan = {
  note: "Review only. This program does not contact Cloudflare or run these commands.",
  worker: config.name,
  resources: [
    {
      kind: "D1",
      name: d1,
      binding: "DB",
      create: ["pnpm", "exec", "wrangler", "d1", "create", d1, "--no-update-config"],
      inspect: ["pnpm", "exec", "wrangler", "d1", "list", "--json"],
    },
    {
      kind: "KV",
      name: kv,
      binding: "CACHE",
      create: ["pnpm", "exec", "wrangler", "kv", "namespace", "create", kv, "--no-update-config"],
      inspect: ["pnpm", "exec", "wrangler", "kv", "namespace", "list"],
    },
    ...buckets.map((name, index) => ({
      kind: "R2",
      name,
      binding: config.r2_buckets[index].binding,
      create: ["pnpm", "exec", "wrangler", "r2", "bucket", "create", name, "--no-update-config"],
      inspect: ["pnpm", "exec", "wrangler", "r2", "bucket", "list"],
    })),
    ...queues.map((name) => ({
      kind: "Queue",
      name,
      create: ["pnpm", "exec", "wrangler", "queues", "create", name],
      inspect: ["pnpm", "exec", "wrangler", "queues", "list"],
    })),
  ],
  afterResources: [
    "Copy the D1 UUID and KV namespace ID from list output to GitHub Environment staging variables; verify names and account first.",
    "Run staging-config.mjs generate and a local Wrangler dry-run with the generated config.",
    "Configure Access user and public Bypass paths before exposing either Custom Domain.",
    "Review and apply D1 migrations remotely as a separate, explicit operation.",
    "Create the private app secret file and deploy the first Worker with --secrets-file only after all gates pass.",
  ],
  requiredWorkerSecretNames: config.secrets.required,
};

console.log(JSON.stringify(plan, null, 2));
