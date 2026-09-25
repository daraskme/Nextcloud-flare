import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";

const repo = join(import.meta.dirname, ".."),
  require = createRequire(join(repo, "package.json"));
const { unstable_dev } = require("wrangler");
const { foundationFixture } = await import(
  pathToFileURL(join(repo, "packages/worker/test/fixtures/foundation.ts"))
);
const { DatabaseSync } = await import("node:sqlite");
const directory = await mkdtemp(join(repo, ".wrangler/backup-run-drill-")),
  source = join(directory, "worker.ts"),
  config = join(directory, "wrangler.json");
const name = "ncf-proxy-" + crypto.randomUUID();
await writeFile(
  source,
  `
import {ControlDO,CONTROL_NAME} from ${JSON.stringify(join(repo, "packages/worker/src/do/ControlDO.ts"))};
export {BackupOperator} from ${JSON.stringify(join(repo, "packages/worker/src/backup/operator.ts"))};
export {ControlDO};
export default {async fetch(request,env){if(request.method!=='POST')return new Response(null,{status:404});return Response.json(await env.CONTROL.get(env.CONTROL.idFromName(CONTROL_NAME)).recover());}};
`,
);
await writeFile(
  config,
  JSON.stringify({
    name,
    main: source,
    compatibility_date: "2026-08-15",
    compatibility_flags: ["nodejs_compat", "enable_request_signal"],
    workers_dev: false,
    preview_urls: false,
    send_metrics: false,
    vars: { ENVIRONMENT: "development", EPOCH_FLOOR: "2", BACKUP_OPERATOR_ENABLED: "true" },
    d1_databases: [
      {
        binding: "DB",
        database_name: "backup-run-drill",
        database_id: "00000000-0000-0000-0000-000000000000",
        migrations_dir: join(repo, "packages/worker/migrations"),
      },
    ],
    r2_buckets: [{ binding: "BACKUPS", bucket_name: "backup-run-drill" }],
    durable_objects: { bindings: [{ name: "CONTROL", class_name: "ControlDO" }] },
    migrations: [{ tag: "v1", new_sqlite_classes: ["ControlDO"] }],
  }),
);
const exec = promisify(execFile);
await exec(
  process.execPath,
  [
    join(repo, "node_modules/wrangler/bin/wrangler.js"),
    "d1",
    "migrations",
    "apply",
    "DB",
    "--local",
    "--config",
    config,
  ],
  {
    cwd: repo,
    maxBuffer: 8 * 1024 * 1024,
    env: { ...process.env, CI: "true", WRANGLER_SEND_METRICS: "false" },
  },
);
const server = await unstable_dev(source, {
  config,
  local: true,
  port: 0,
  inspectorPort: 0,
  logLevel: "error",
  envFiles: [],
  experimental: {
    disableDevRegistry: false,
    disableExperimentalWarning: true,
    showInteractiveDevSession: false,
  },
});

let command = 0;
async function run(script, args, expectedExit = 0) {
  const number = ++command;
  let result;
  let exit = 0;
  try {
    result = await exec(process.execPath, [script, ...args], {
      cwd: repo,
      maxBuffer: 16 * 1024 * 1024,
      env: { ...process.env, CI: "true", WRANGLER_SEND_METRICS: "false" },
    });
  } catch (error) {
    exit = error.code;
    result = { stdout: String(error.stdout ?? ""), stderr: String(error.stderr ?? "") };
  }
  await writeFile(join(directory, String(number) + ".log"), result.stdout + result.stderr);
  assert.equal(exit, expectedExit, "backup_run_drill_command_failed");
  return result.stdout;
}
const wrangler = join(repo, "node_modules/wrangler/bin/wrangler.js");
const local = (args) => run(wrangler, [...args, "--local", "--config", config]);
try {
  assert.equal(
    (await (await server.fetch("https://fixture.invalid/recover", { method: "POST" })).json())
      .epoch,
    2,
  );
  const fixture = foundationFixture("run", Date.now() - 1000);
  const literal = (value) =>
    value === null
      ? "NULL"
      : typeof value === "number"
        ? String(value)
        : "'" + value.replaceAll("'", "''") + "'";
  const seed = fixture.statements.map(({ sql, values = [] }) => {
    let index = 0;
    const text = sql.replace(/\?/g, () => literal(values[index++]));
    assert.equal(index, values.length);
    return text + ";";
  });
  await writeFile(join(directory, "seed.sql"), seed.join("\n"));
  await local(["d1", "execute", "DB", "--file", join(directory, "seed.sql")]);
  const descriptor = join(directory, "operator.json");
  await writeFile(descriptor, JSON.stringify({ service: name, environment: "development" }));
  const cli = join(repo, "scripts/backup.mjs"),
    generations = join(directory, "generations");
  const args = [
    "daily",
    "--operator-config",
    descriptor,
    "--config",
    config,
    "--database",
    "DB",
    "--local",
    "--epoch",
    "2",
    "--directory",
    generations,
  ];
  const decode = (output) =>
    JSON.parse(
      output
        .trim()
        .split("\n")
        .findLast((line) => line.startsWith('{"command":')),
    );
  const result = decode(await run(cli, args)).result;
  const id = result.id;
  assert.equal(result.state, "completed");
  assert.equal(result.daily, true);
  assert.equal(result.skipped, false);
  assert.match(result.manifestSha256, /^[a-f0-9]{64}$/);
  const replay = decode(await run(cli, args)).result;
  assert.equal(replay.id, id);
  assert.equal(replay.skipped, true);
  assert.equal(replay.manifestSha256, result.manifestSha256);
  assert.equal(
    decode(await run(cli, ["run", ...args.slice(1), "--id", id])).result.manifestSha256,
    result.manifestSha256,
  );
  const receipt = decode(
    await run(cli, [
      "receipt",
      "--operator-config",
      descriptor,
      "--local",
      "--id",
      id,
      "--epoch",
      "2",
    ]),
  ).result;
  assert.equal(receipt.state, "completed");
  assert.equal(receipt.manifestSha256, result.manifestSha256);
  const health = decode(
    await run(
      cli,
      ["health", "--operator-config", descriptor, "--local", "--config", config, "--epoch", "2"],
      2,
    ),
  ).result;
  assert.equal(health.healthy, false);
  assert.equal(health.complete, true);
  assert.equal(health.eligible, 1);
  assert.equal(health.missing, 4);
  assert.deepEqual(health.alerts, ["backup_generations_insufficient"]);
  assert.equal(health.generations[0].id, id);
  assert.equal(health.generations[0].status, "eligible");
  // Exercise the real maintain CLI dispatch/transport without five additional
  // slow Wrangler exports; the operator drill proves successful replenishment.
  const stale = ["maintain", ...args.slice(1)];
  stale[stale.indexOf("--epoch") + 1] = "1";
  await run(cli, stale, 1);
  assert.match(
    await readFile(join(directory, String(command) + ".log"), "utf8"),
    /invalid_backup_request:/,
  );
  const status = JSON.parse(
    await local([
      "d1",
      "execute",
      "DB",
      "--command",
      "SELECT backup_frozen,maintenance FROM control",
      "--json",
    ]),
  );
  assert.deepEqual(status[0].results, [{ backup_frozen: 0, maintenance: 1 }]);
  const download = join(directory, "download"),
    target = join(directory, "restored.sqlite");
  await run(cli, [
    "download",
    "--directory",
    download,
    "--id",
    id,
    "--local",
    "--config",
    config,
    "--manifest-sha256",
    result.manifestSha256,
  ]);
  await run(cli, ["restore-offline", "--directory", join(download, id), "--target", target]);
  const db = new DatabaseSync(target);
  try {
    assert.equal(db.prepare("SELECT backup_frozen FROM control").get().backup_frozen, 1);
    assert.equal(db.prepare("SELECT state FROM backup_runs WHERE id=?").get(id).state, "exporting");
    assert.equal(
      db.prepare("SELECT used_bytes FROM users WHERE id=?").get(fixture.ids.user).used_bytes,
      3,
    );
  } finally {
    db.close();
  }
  const report = {
    result: "PASS",
    directory,
    id,
    bytes: result.bytes,
    proof:
      "Actual daily/run/receipt/health/download/restore-offline CLI, private capability, typed D1 export and R2 publication, durable replay, verified shortage/exit 2; actual maintain CLI rejects stale epoch before mutation. Successful five-generation replenishment is covered by the separate operator drill.",
    limits:
      "Local dev registry and resources; successful replenishment is exercised by the separate operator drill. No remote authentication/deployment, scheduler installation, object pruning, independent BLOBS copy or live restore.",
  };
  await writeFile(join(directory, "report.json"), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report));
} finally {
  await server.stop();
}
