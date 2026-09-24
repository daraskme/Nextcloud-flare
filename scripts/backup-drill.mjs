// An isolated local Wrangler exercise. No existing local state or remote resources are modified.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { foundationFixture } from "../packages/worker/test/fixtures/foundation.ts";

const root = resolve(import.meta.dirname, "..");
await mkdir(join(root, ".wrangler"), { recursive: true });
const directory = await mkdtemp(join(root, ".wrangler/backup-drill-"));
const config = join(directory, "wrangler.json"),
  id = randomUUID(),
  token = randomUUID();
await writeFile(
  join(directory, "worker.js"),
  'export default {fetch(){return new Response("isolated backup drill")}};',
);
await writeFile(
  config,
  JSON.stringify({
    name: "ncf-backup-drill",
    main: "worker.js",
    compatibility_date: "2026-08-15",
    workers_dev: false,
    d1_databases: [
      {
        binding: "DB",
        database_name: "backup-drill",
        database_id: "00000000-0000-0000-0000-000000000000",
        migrations_dir: join(root, "packages/worker/migrations"),
      },
    ],
  }),
);
const exec = promisify(execFile);
let command = 0;
async function run(script, args) {
  const result = await exec(process.execPath, [script, ...args], {
    cwd: root,
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
    env: { ...process.env, CI: "true", WRANGLER_SEND_METRICS: "false" },
  });
  await writeFile(join(directory, `${++command}.log`), result.stdout + result.stderr);
  return result.stdout;
}
const wrangler = fileURLToPath(
  new URL("../node_modules/wrangler/bin/wrangler.js", import.meta.url),
);
const local = (args) => run(wrangler, [...args, "--local", "--config", config]);
await local(["d1", "migrations", "apply", "DB"]);
const now = Date.now(),
  fixture = foundationFixture("drill", now - 1000);
const literal = (value) =>
  value === null
    ? "NULL"
    : typeof value === "number"
      ? String(value)
      : "'" + value.replaceAll("'", "''") + "'";
const bound = ({ sql, values = [] }) => {
  let index = 0;
  const text = sql.replace(/\?/g, () => literal(values[index++]));
  assert.equal(index, values.length);
  return text + ";";
};
const seed = fixture.statements.map(bound);
seed.push(
  bound({
    sql: "INSERT INTO blob_storage(blob_id,bytes,r2_etag,observed_at) VALUES(?,3,'local-fixture',?)",
    values: [fixture.ids.blob, now],
  }),
);
seed.push(
  bound({
    sql: "INSERT INTO reservations(id,owner_id,bytes,state,expires_at,epoch) VALUES('held',?,5,'reserved',?,1)",
    values: [fixture.ids.user, now + 86400000],
  }),
);
seed.push(
  bound({
    sql: "INSERT INTO search_index(node_id,space_id,text_norm,tokens,normalization_version,revision) VALUES(?,?,'sample','sample','fixture',1)",
    values: [fixture.ids.file, fixture.ids.space],
  }),
);
seed.push("INSERT INTO search_fts(search_fts) VALUES('rebuild');");
seed.push(
  bound({
    sql: "INSERT INTO backup_runs(id,epoch,state,created_at,barrier_token) VALUES(?,1,'exporting',?,?)",
    values: [id, now, token],
  }),
);
seed.push(bound({ sql: "UPDATE control SET backup_token=?,backup_frozen=1", values: [token] }));
await writeFile(join(directory, "seed.sql"), seed.join("\n"));
await local(["d1", "execute", "DB", "--file", join(directory, "seed.sql")]);
console.log(JSON.stringify({ stage: "capture", directory }));
const cli = join(root, "scripts/backup.mjs"),
  generations = join(directory, "generations"),
  generation = join(generations, id);
await run(cli, [
  "capture",
  "--config",
  config,
  "--database",
  "DB",
  "--local",
  "--id",
  id,
  "--epoch",
  "1",
  "--directory",
  generations,
]);
await run(cli, ["verify", "--directory", generation]);
await run(cli, [
  "restore-offline",
  "--directory",
  generation,
  "--target",
  join(directory, "restored.sqlite"),
]);
const restored = new DatabaseSync(join(directory, "restored.sqlite"));
try {
  assert.deepEqual(
    { ...restored.prepare("SELECT used_bytes,reserved_bytes,physical_bytes FROM users").get() },
    { used_bytes: 3, reserved_bytes: 5, physical_bytes: 3 },
  );
  assert.equal(
    restored.prepare("SELECT COUNT(*) n FROM search_fts WHERE search_fts MATCH 'sample'").get().n,
    1,
  );
  assert.throws(() => restored.exec("UPDATE control SET maintenance=0"), /backup_frozen/);
} finally {
  restored.close();
}
const status = JSON.parse(
  await local([
    "d1",
    "execute",
    "DB",
    "--command",
    "SELECT backup_frozen,backup_token FROM control",
    "--json",
  ]),
);
assert.deepEqual(status[0].results, [{ backup_frozen: 1, backup_token: token }]);
const manifest = JSON.parse(await readFile(join(generation, "manifest.json"), "utf8"));
assert.equal(manifest.tables.length, 67);
const report = {
  result: "PASS",
  directory,
  id,
  tables: manifest.tables.length,
  bytes: manifest.data.bytes,
  proof:
    "Real local Wrangler capture, source-to-target row fingerprints, verify CLI, offline restore CLI, FTS/accounting/FK/schema and source freeze retained.",
  limits:
    "Fixture freeze, no ControlDO operator channel or R2 content/manifest publication, live restore, epoch recovery or remote commands.",
};
await writeFile(join(directory, "report.json"), JSON.stringify(report, null, 2));
console.log(JSON.stringify(report));
