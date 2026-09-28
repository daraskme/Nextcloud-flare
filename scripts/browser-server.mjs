import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import ts from "typescript";

const root = resolve(import.meta.dirname, "..");
const args = process.argv.slice(2);
if (args.length > 1 || (args.length === 1 && args[0] !== "--single-host"))
  throw new Error("invalid_browser_server_arguments");
const singleHost = args[0] === "--single-host";
const port = singleHost ? "8880" : "8879";
const instance = singleHost ? "browser-single-host" : "browser";
const parsed = ts.readConfigFile(resolve(root, "wrangler.jsonc"), ts.sys.readFile);
if (parsed.error) throw new Error("invalid_local_config");
const config = parsed.config;
const state = resolve(root, `.wrangler/${instance}-tests`);
const configFile = resolve(root, `.wrangler/${instance}-config.json`);
config.name = `ncf-${instance}-test`;
config.main = resolve(root, "packages/worker/test/browser/entry.ts");
config.assets.directory = resolve(root, "packages/web/dist");
config.d1_databases[0].migrations_dir = resolve(root, "packages/worker/migrations");
config.queues.consumers = [];
config.triggers = { crons: [] };
Object.assign(config.vars, {
  EPOCH_FLOOR: "2",
  APP_ORIGIN: `https://app.ncf.test:${port}`,
  CONTENT_ORIGIN: `https://${singleHost ? "app" : "content"}.ncf.test:${port}`,
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
  port,
  "--local-protocol",
  "https",
  "--persist-to",
  state,
]);
for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => server.kill(signal));
server.on("exit", (code) => {
  process.exitCode = code ?? 0;
});
