// Isolated Miniflare service-binding proof only; no remote Cloudflare behavior is validated.
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const repo = join(import.meta.dirname, "..");
const require = createRequire(join(repo, "package.json"));
const { createTestHarness } = require("wrangler");
const moduleAt = (path) => import(pathToFileURL(join(repo, path)).href);
const { foundationFixture } = await moduleAt("packages/worker/test/fixtures/foundation.ts");
await mkdir(join(repo, ".wrangler"), { recursive: true });
const directory = await mkdtemp(join(repo, ".wrangler/ops-operator-drill-"));
const source = join(directory, "worker.ts");
const caller = join(directory, "caller.js");
await writeFile(
  source,
  `
import { WorkerEntrypoint } from 'cloudflare:workers';
import { ControlDO, CONTROL_NAME } from ${JSON.stringify(join(repo, "packages/worker/src/do/ControlDO.ts"))};
export { OperationsOperator } from ${JSON.stringify(join(repo, "packages/worker/src/ops/operator.ts"))};
export { BackupOperator } from ${JSON.stringify(join(repo, "packages/worker/src/backup/operator.ts"))};
export { ControlDO };
export default class Probe extends WorkerEntrypoint {
  recover() { return this.env.CONTROL.get(this.env.CONTROL.idFromName(CONTROL_NAME)).recover(); }
  fetch() { return new Response(null,{status:404}); }
}
`,
);
await writeFile(caller, "export default {fetch(){return new Response(null,{status:404})}}");
const harness = createTestHarness({
  root: repo,
  workers: [
    {
      config: {
        name: "ncf-ops-operator-drill",
        main: source,
        compatibility_date: "2026-08-15",
        compatibility_flags: ["nodejs_compat", "enable_request_signal"],
        workers_dev: false,
        preview_urls: false,
        send_metrics: false,
        vars: {
          EPOCH_FLOOR: "2",
          ENVIRONMENT: "development",
          BACKUP_OPERATOR_ENABLED: "true",
        },
        d1_databases: [
          {
            binding: "DB",
            database_name: "ops-operator-drill",
            database_id: "00000000-0000-0000-0000-000000000000",
            migrations_dir: join(repo, "packages/worker/migrations"),
          },
        ],
        r2_buckets: [{ binding: "BACKUPS", bucket_name: "ops-operator-drill" }],
        durable_objects: { bindings: [{ name: "CONTROL", class_name: "ControlDO" }] },
        migrations: [{ tag: "ops-probe-v1", new_sqlite_classes: ["ControlDO"] }],
      },
    },
    {
      config: {
        name: "ops-operator-client",
        main: caller,
        compatibility_date: "2026-08-15",
        workers_dev: false,
        preview_urls: false,
        services: [
          {
            binding: "OPERATIONS_CONTROL",
            service: "ncf-ops-operator-drill",
            entrypoint: "OperationsOperator",
            props: { purpose: "operations-health-v1", environment: "development" },
          },
          {
            binding: "BACKUP_CONTROL",
            service: "ncf-ops-operator-drill",
            entrypoint: "BackupOperator",
            props: { purpose: "logical-backup-v1", environment: "development" },
          },
        ],
      },
    },
  ],
});

try {
  await harness.listen();
  const worker = harness.getWorker("ncf-ops-operator-drill");
  await worker.applyD1Migrations("DB");
  const target = await worker.getEnv();
  const api = await worker.getExport();
  const client = await harness.getWorker("ops-operator-client").getEnv();
  const fixture = foundationFixture("ops", Date.now() - 1000);
  await target.DB.batch(
    fixture.statements.map(({ sql, values = [] }) => target.DB.prepare(sql).bind(...values)),
  );
  assert.equal((await api.recover()).epoch, 2);
  const before = await target.DB.prepare(
    "SELECT (SELECT COUNT(*) FROM operations) AS operations,(SELECT COUNT(*) FROM permits) AS permits,(SELECT COUNT(*) FROM mutation_admissions) AS admissions,(SELECT COUNT(*) FROM backup_runs) AS backups",
  ).first();
  const snapshot = await client.OPERATIONS_CONTROL.inspect(2);
  assert.equal(snapshot.version, "ops-health.v1");
  assert.equal(snapshot.complete, true);
  assert.equal(snapshot.healthy, true);
  assert.deepEqual(
    await target.DB.prepare(
      "SELECT (SELECT COUNT(*) FROM operations) AS operations,(SELECT COUNT(*) FROM permits) AS permits,(SELECT COUNT(*) FROM mutation_admissions) AS admissions,(SELECT COUNT(*) FROM backup_runs) AS backups",
    ).first(),
    before,
  );
  assert.equal((await client.OPERATIONS_CONTROL.fetch("https://operator.invalid")).status, 404);
  assert.equal((await client.BACKUP_CONTROL.fetch("https://operator.invalid")).status, 404);
  console.log(JSON.stringify({ healthy: true, complete: true, fetchSurfacesClosed: true }));
} finally {
  try {
    await harness.close();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
