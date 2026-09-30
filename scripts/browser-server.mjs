import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import ts from "typescript";

const root = resolve(import.meta.dirname, "..");
const parsed = ts.readConfigFile(resolve(root, "wrangler.jsonc"), ts.sys.readFile);
if (parsed.error) throw new Error("invalid_local_config");
const config = parsed.config;
const state = resolve(root, ".wrangler/browser-tests");
const configFile = resolve(root, ".wrangler/browser-config.json");
config.name = "ncf-browser-test";
config.main = resolve(root, "packages/worker/test/browser/entry.ts");
config.assets.directory = resolve(root, "packages/web/dist");
config.d1_databases[0].migrations_dir = resolve(root, "packages/worker/migrations");
config.queues.consumers = [];
config.triggers = { crons: [] };
Object.assign(config.vars, {
  EPOCH_FLOOR: "2",
  APP_ORIGIN: "https://app.ncf.test:8879",
  CONTENT_ORIGIN: "https://content.ncf.test:8879",
  UPLOAD_CAPABILITY_ACTIVE_KID: "browser",
  UPLOAD_CAPABILITY_KEYS: JSON.stringify({ browser: randomBytes(32).toString("base64url") }),
});
await mkdir(resolve(root, ".wrangler"), { recursive: true });
await rm(state, { recursive: true, force: true }); // Only this isolated test directory; no development/remote state.
await writeFile(configFile, JSON.stringify(config));
const wrangler = resolve(root, "node_modules/wrangler/bin/wrangler.js");
function run(args) {
  return spawn(process.execPath, [wrangler, ...args, "--config", configFile], {
    cwd: root,
    stdio: "inherit",
    env: { ...process.env, WRANGLER_SEND_METRICS: "false" },
  });
}
const migration = run(["d1", "migrations", "apply", "DB", "--local", "--persist-to", state]);
await new Promise((resolve, reject) => {
  migration.on("exit", (code) =>
    code === 0 ? resolve() : reject(new Error(`browser_migrations_${code}`)),
  );
  migration.on("error", reject);
});
const server = run([
  "dev",
  "--local",
  "--ip",
  "127.0.0.1",
  "--port",
  "8879",
  "--local-protocol",
  "https",
  "--persist-to",
  state,
]);
for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => server.kill(signal));
server.on("exit", (code) => {
  process.exitCode = code ?? 0;
});
