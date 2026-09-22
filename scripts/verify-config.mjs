import assert from "node:assert/strict";
import ts from "typescript";

const parsed = ts.readConfigFile("wrangler.jsonc", ts.sys.readFile);
assert.equal(parsed.error, undefined, "wrangler.jsonc must parse");
const config = parsed.config;
assert.equal(config.workers_dev, false);
assert.equal(config.preview_urls, false);
assert.equal(config.assets.run_worker_first, true);
assert.equal(config.assets.not_found_handling, "none");
assert.equal(config.vars.ENVIRONMENT, "development");
assert.equal(config.vars.PBKDF2_ITERATIONS, "100000");
assert.equal(config.compatibility_date, "2026-08-15");
assert.ok(config.compatibility_flags.includes("nodejs_compat"));
assert.equal(config.routes, undefined, "local configuration must not claim a remote route");
assert.equal(config.env, undefined, "remote environments require their own reviewed inventory");
assert.equal(config.d1_databases[0].database_id, "00000000-0000-0000-0000-000000000000");
assert.equal(config.kv_namespaces[0].id, "00000000000000000000000000000000");
assert.equal(config.images.binding, "IMAGES");
assert.equal(config.assets.binding, "ASSETS");
assert.deepEqual(config.r2_buckets.map((item) => item.binding).sort(), ["BACKUPS", "BLOBS"]);
assert.deepEqual(config.durable_objects.bindings.map((item) => item.name).sort(), [
  "BUDGETS",
  "CONTROL",
  "LOCKS",
  "UPLOADS",
]);
assert.deepEqual(config.migrations[0].new_sqlite_classes.sort(), [
  "BudgetDO",
  "ControlDO",
  "LockDO",
  "UploadDO",
]);
assert.equal(config.queues.producers[0].binding, "JOBS");
assert.equal(config.queues.consumers[0].max_retries, 10);
assert.equal(config.queues.consumers[0].max_concurrency, 8);
assert.equal(config.queues.consumers[0].dead_letter_queue, "ncf-local-jobs-dlq");
assert.deepEqual(config.triggers.crons, ["* * * * *"]);
assert.equal(config.ratelimits[0].name, "EDGE_LIMITER");
assert.equal(config.ratelimits[0].simple.period, 60);
assert.ok(!Object.hasOwn(config.vars, "DEV_BYPASS_ACCESS"));
console.log("Local binding configuration verified; no remote environment is configured.");
