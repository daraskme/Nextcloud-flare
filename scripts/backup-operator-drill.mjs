// Isolated engine/API proof only; no production route, credentials, or remote resources.
import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { pathToFileURL } from "node:url";

const repo = join(import.meta.dirname, "..");
const require = createRequire(join(repo, "package.json"));
const { createTestHarness } = require("wrangler");
const moduleAt = (path) => import(pathToFileURL(join(repo, path)).href);
const { restoreGeneration } = await moduleAt("scripts/backup/generation.mjs");
const { downloadGeneration } = await moduleAt("scripts/backup/publication.mjs");
const { runBackup } = await moduleAt("scripts/backup/operator.mjs");
const { maintainBackups } = await moduleAt("scripts/backup/maintenance.mjs");
const { pruneBackup } = await moduleAt("scripts/backup/prune.mjs");
const { controlCalls } = await moduleAt("scripts/backup/control.mjs");
const { restoreControlCalls } = await moduleAt("scripts/restore/control.mjs");
const { verifyRestoreSelection } = await moduleAt("scripts/restore/verify.mjs");
const { verifyRestoreD1 } = await moduleAt("scripts/restore/target.mjs");
const { RESTORE_D1_QUERY } = await moduleAt("packages/shared/src/restoreTarget.ts");
const { exportData } = await moduleAt("scripts/backup/export.mjs");
const { foundationFixture } = await moduleAt("packages/worker/test/fixtures/foundation.ts");
await mkdir(join(repo, ".wrangler"), { recursive: true });
const directory = await mkdtemp(join(repo, ".wrangler/operator-drill-"));
const source = join(directory, "worker.ts");
await writeFile(
  source,
  `
import { WorkerEntrypoint } from 'cloudflare:workers';
import { ControlDO, CONTROL_NAME } from ${JSON.stringify(join(repo, "packages/worker/src/do/ControlDO.ts"))};
export { BackupOperator } from ${JSON.stringify(join(repo, "packages/worker/src/backup/operator.ts"))};
export { DatabaseRestoreOperator } from ${JSON.stringify(join(repo, "packages/worker/src/backup/restoreOperator.ts"))};
export { ControlDO };
export default class Probe extends WorkerEntrypoint {
  async recover() { return this.env.CONTROL.get(this.env.CONTROL.idFromName(CONTROL_NAME)).recover(); }
  async fetch() { return new Response(null,{status:404}); }
}
`,
);
const caller = join(directory, "caller.js");
await writeFile(caller, "export default {fetch(){return new Response(null,{status:404})}}");
const disabled = join(directory, "disabled.ts");
await writeFile(
  disabled,
  `export { BackupOperator } from ${JSON.stringify(join(repo, "packages/worker/src/backup/operator.ts"))};
export { DatabaseRestoreOperator } from ${JSON.stringify(join(repo, "packages/worker/src/backup/restoreOperator.ts"))};
export default { fetch(){ return new Response(null,{status:404}); } };`,
);
const harness = createTestHarness({
  root: repo,
  workers: [
    {
      config: {
        name: "ncf-backup-operator-drill",
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
          RESTORE_OPERATOR_ENABLED: "true",
        },
        d1_databases: [
          {
            binding: "DB",
            database_name: "operator-drill",
            database_id: "00000000-0000-0000-0000-000000000000",
            migrations_dir: join(repo, "packages/worker/migrations"),
          },
        ],
        r2_buckets: [{ binding: "BACKUPS", bucket_name: "operator-drill" }],
        durable_objects: { bindings: [{ name: "CONTROL", class_name: "ControlDO" }] },
        migrations: [{ tag: "probe-v1", new_sqlite_classes: ["ControlDO"] }],
      },
    },
    {
      config: {
        name: "operator-client",
        main: caller,
        compatibility_date: "2026-08-15",
        workers_dev: false,
        preview_urls: false,
        services: [
          ...[
            ["RESTORE_CONTROL", "ncf-backup-operator-drill", "database-restore-v1", "development"],
            ["RESTORE_WRONG_ENV", "ncf-backup-operator-drill", "database-restore-v1", "production"],
            [
              "RESTORE_BACKUP_GRANT",
              "ncf-backup-operator-drill",
              "logical-backup-v1",
              "development",
            ],
            ["RESTORE_DISABLED", "restore-backup-only", "database-restore-v1", "development"],
          ].map(([binding, service, purpose, environment]) => ({
            binding,
            service,
            entrypoint: "DatabaseRestoreOperator",
            props: { purpose, environment },
          })),
          {
            binding: "RESTORE_NO_GRANT",
            service: "ncf-backup-operator-drill",
            entrypoint: "DatabaseRestoreOperator",
          },
          {
            binding: "BACKUP_CONTROL",
            service: "ncf-backup-operator-drill",
            entrypoint: "BackupOperator",
            props: { purpose: "logical-backup-v1", environment: "development" },
          },
          {
            binding: "WRONG_ENV",
            service: "ncf-backup-operator-drill",
            entrypoint: "BackupOperator",
            props: { purpose: "logical-backup-v1", environment: "production" },
          },
          {
            binding: "NO_GRANT",
            service: "ncf-backup-operator-drill",
            entrypoint: "BackupOperator",
          },
          {
            binding: "DISABLED",
            service: "operator-disabled",
            entrypoint: "BackupOperator",
            props: { purpose: "logical-backup-v1", environment: "development" },
          },
        ],
      },
    },
    {
      config: {
        name: "operator-disabled",
        main: disabled,
        compatibility_date: "2026-08-15",
        vars: { ENVIRONMENT: "development" },
        workers_dev: false,
        preview_urls: false,
      },
    },
    {
      config: {
        name: "restore-backup-only",
        main: disabled,
        compatibility_date: "2026-08-15",
        vars: { ENVIRONMENT: "development", BACKUP_OPERATOR_ENABLED: "true" },
        workers_dev: false,
        preview_urls: false,
      },
    },
  ],
});
try {
  await harness.listen();
  const worker = harness.getWorker("ncf-backup-operator-drill");
  await worker.applyD1Migrations("DB");
  const env = await worker.getEnv(),
    api = await worker.getExport();
  assert.equal((await api.recover()).epoch, 2);
  const query = async (sql) => (await env.DB.prepare(sql).all()).results;
  const fixture = foundationFixture("flow", Date.now() - 1000);
  await env.DB.batch(
    fixture.statements.map(({ sql, values = [] }) => env.DB.prepare(sql).bind(...values)),
  );
  await env.DB.prepare(
    "INSERT INTO blob_storage(blob_id,bytes,r2_etag,observed_at) VALUES(?,3,'flow-fixture',?)",
  )
    .bind(fixture.ids.blob, Date.now())
    .run();
  await env.DB.prepare(
    "INSERT INTO reservations(id,owner_id,bytes,state,expires_at,epoch) VALUES('held',?,5,'reserved',?,2)",
  )
    .bind(fixture.ids.user, Date.now() + 86400000)
    .run();
  await env.DB.prepare(
    "INSERT INTO search_index(node_id,space_id,text_norm,tokens,normalization_version,revision) VALUES(?,?,'sample','sample','fixture',1)",
  )
    .bind(fixture.ids.file, fixture.ids.space)
    .run();
  await env.DB.prepare("INSERT INTO search_fts(search_fts) VALUES('rebuild')").run();
  const before = (await query("SELECT maintenance,gc_paused,gc_operator_paused FROM control"))[0];
  let id = crypto.randomUUID();
  const clientEnv = await harness.getWorker("operator-client").getEnv();
  for (const binding of ["WRONG_ENV", "NO_GRANT", "DISABLED"]) {
    for (const method of [
      "begin",
      "complete",
      "cancel",
      "receipt",
      "daily",
      "inventory",
      "replenish",
      "prune",
      "sweep",
    ]) {
      await assert.rejects(
        controlCalls(clientEnv[binding])[method](2, id, "0".repeat(64)),
        /backup_operator_forbidden/,
      );
    }
  }
  assert.equal((await query("SELECT COUNT(*) n FROM backup_runs"))[0].n, 0);
  assert.equal((await clientEnv.BACKUP_CONTROL.fetch("https://operator.invalid")).status, 404);
  const control = controlCalls(clientEnv.BACKUP_CONTROL);
  const dataSource = {
    query,
    export: (output, tableSpecs) => exportData(output, tableSpecs, query),
  };
  const store = {
    async get(key, limit) {
      const object = await env.BACKUPS.get(key);
      if (object === null) return null;
      assert.ok(object.size <= limit);
      const bytes = Buffer.from(await object.arrayBuffer());
      assert.equal(bytes.length, object.size);
      return bytes;
    },
    async put(key, bytes) {
      return (
        (await env.BACKUPS.put(key, bytes, { onlyIf: new Headers({ "If-None-Match": "*" }) })) !==
        null
      );
    },
  };
  const run = () =>
    runBackup({
      directory: join(directory, "generations"),
      id,
      epoch: 2,
      source: dataSource,
      store,
      control,
    });
  const maintain = () =>
    maintainBackups({
      pruneExpired: true,
      directory: join(directory, "generations"),
      epoch: 2,
      source: dataSource,
      store,
      control,
    });
  const maintenance = await maintain();
  assert.equal(maintenance.healthy, true);
  assert.equal(maintenance.initial.missing, 4);
  assert.equal(maintenance.health.eligible, 5);
  assert.equal(maintenance.completed.length, 5);
  assert.equal(maintenance.cleanup.healthy, true);
  id = maintenance.completed.at(-1);
  const result = await run();
  assert.equal(result.state, "completed");
  await worker.evictDurableObject("CONTROL", { name: "singleton" });
  const replay = await maintain();
  assert.equal(replay.healthy, true);
  assert.deepEqual(replay.completed, []);
  assert.equal((await query("SELECT COUNT(*) n FROM backup_runs WHERE state='completed'"))[0].n, 5);
  assert.equal((await run()).state, "completed");
  assert.deepEqual(
    (await query("SELECT maintenance,gc_paused,gc_operator_paused FROM control"))[0],
    before,
  );
  assert.equal((await query("SELECT backup_frozen FROM control"))[0].backup_frozen, 0);
  const receipt = await control.receipt(2, id);
  assert.equal(receipt.state, "completed");
  assert.equal(receipt.manifestSha256, result.manifestSha256);
  const download = await downloadGeneration({
    directory: join(directory, "download"),
    id,
    store,
    expectedSha256: result.manifestSha256,
  });
  const target = join(directory, "restored.sqlite");
  await restoreGeneration({ directory: download.directory, target });
  const restored = new DatabaseSync(target);
  try {
    assert.deepEqual(
      { ...restored.prepare("SELECT used_bytes,reserved_bytes,physical_bytes FROM users").get() },
      { used_bytes: 3, reserved_bytes: 5, physical_bytes: 3 },
    );
    assert.equal(
      restored.prepare("SELECT COUNT(*) n FROM search_fts WHERE search_fts MATCH 'sample'").get().n,
      1,
    );
    assert.equal(restored.prepare("SELECT backup_frozen FROM control").get().backup_frozen, 1);
    assert.equal(
      restored.prepare("SELECT state FROM backup_runs WHERE id=?").get(id).state,
      "exporting",
    );
  } finally {
    restored.close();
  }
  // Create an explicitly old, transport-only fixture in the isolated binding.
  // The fresh real SQL generations must survive pruning and reject deletion themselves.
  await assert.rejects(pruneBackup({ epoch: 2, id, control }), /backup_not_expired/);
  const { expiredBackupFixture } = await moduleAt("scripts/test/fixtures/expired-backup.mjs");
  const expired = expiredBackupFixture(),
    expiredId = expired.id;
  await env.BACKUPS.put(expired.partKey, expired.part);
  await env.BACKUPS.put(expired.key, expired.bytes);
  await env.DB.prepare(`INSERT INTO backup_runs(id,epoch,state,created_at,completed_at,released_at,barrier_token,manifest_key,manifest_sha256)
    VALUES(?,1,'completed',1,2,2,?,?,?)`)
    .bind(expiredId, expired.token, expired.key, expired.hash)
    .run();
  const swept = await maintain();
  assert.equal(swept.healthy, true);
  assert.equal(swept.cleanup.absent, 1);
  await worker.evictDurableObject("CONTROL", { name: "singleton" });
  assert.equal((await pruneBackup({ epoch: 2, id: expiredId, control })).state, "absent");
  assert.equal(
    (await env.BACKUPS.list({ prefix: `sys/backups/v1/${expiredId}/` })).objects.length,
    0,
  );
  assert.equal((await control.receipt(1, expiredId)).state, "completed");
  assert.notEqual(await env.BACKUPS.head(download.key), null);
  const corrupt = expiredBackupFixture();
  await env.BACKUPS.put(corrupt.partKey, corrupt.part);
  await env.BACKUPS.put(corrupt.key, "corrupt");
  await env.DB.prepare(`INSERT INTO backup_runs(id,epoch,state,created_at,completed_at,released_at,barrier_token,manifest_key,manifest_sha256)
    VALUES(?,1,'completed',1,2,2,?,?,?)`)
    .bind(corrupt.id, corrupt.token, corrupt.key, corrupt.hash)
    .run();
  const warning = await maintain();
  assert.equal(warning.healthy, false);
  assert.equal(warning.health.healthy, true);
  assert.equal(warning.cleanup.complete, true);
  assert.equal(warning.cleanup.errors, 1);
  assert.equal(warning.cleanup.lastError.id, corrupt.id);
  assert.notEqual(await env.BACKUPS.head(corrupt.partKey), null);
  const cancelled = crypto.randomUUID();
  assert.equal((await control.begin(2, cancelled)).state, "frozen");
  assert.equal((await control.cancel(2, cancelled)).state, "released");
  assert.equal((await control.receipt(2, cancelled)).state, "failed");
  assert.equal((await control.receipt(2, id)).state, "completed");
  const restoreId = crypto.randomUUID(),
    selection = { kind: "logical", id, epoch: 2, manifestSha256: download.sha256 };
  for (const binding of [
    "RESTORE_WRONG_ENV",
    "RESTORE_BACKUP_GRANT",
    "RESTORE_DISABLED",
    "RESTORE_NO_GRANT",
  ]) {
    for (const [method, args] of [
      ["prepare", [2, restoreId, selection]],
      ["inspect", [2, restoreId]],
      ["verify", [2, restoreId]],
      ["attest", [2, restoreId, download.sha256]],
      [
        "challengeD1",
        [2, restoreId, { mode: "local", databaseId: "00000000-0000-0000-0000-000000000000" }],
      ],
      ["attestD1", [2, restoreId, {}]],
      ["cancel", [2, restoreId]],
    ])
      await assert.rejects(
        async () => clientEnv[binding][method](...args),
        /database_restore_operator_forbidden/,
      );
  }
  assert.equal((await clientEnv.RESTORE_CONTROL.fetch("https://restore.invalid")).status, 404);
  const restoreControl = restoreControlCalls(clientEnv.RESTORE_CONTROL);
  assert.equal((await restoreControl.prepare(2, restoreId, selection)).state, "preparing");
  const sqlVerified = await verifyRestoreSelection({
    epoch: 2,
    id: restoreId,
    control: restoreControl,
    store,
  });
  assert.equal(sqlVerified.state, "sql_verified");
  assert.equal(sqlVerified.bytes, download.manifest.data.bytes);
  assert.equal(sqlVerified.tables, 67);
  const d1Reader = {
    target: { mode: "local", databaseId: "00000000-0000-0000-0000-000000000000" },
    readMirror: () => query(RESTORE_D1_QUERY),
  };
  const verifiedD1 = await verifyRestoreD1({
    epoch: 2,
    id: restoreId,
    control: restoreControl,
    reader: d1Reader,
  });
  assert.equal(verifiedD1.state, "d1_verified");
  assert.equal("token" in verifiedD1, false);
  await worker.evictDurableObject("CONTROL", { name: "singleton" });
  const nextD1 = await verifyRestoreD1({
    epoch: 2,
    id: restoreId,
    control: restoreControl,
    reader: d1Reader,
  });
  assert.ok(nextD1.revision > verifiedD1.revision);
  assert.notEqual(nextD1.challengeId, verifiedD1.challengeId);
  assert.deepEqual((await restoreControl.inspect(2, restoreId)).source, selection);
  assert.equal(
    (await verifyRestoreSelection({ epoch: 2, id: restoreId, control: restoreControl, store }))
      .state,
    "sql_verified",
  );
  assert.equal((await restoreControl.cancel(2, restoreId)).state, "cancelled");
  await assert.rejects(
    verifyRestoreD1({ epoch: 2, id: restoreId, control: restoreControl, reader: d1Reader }),
    /database_restore_not_preparing/,
  );
  await assert.rejects(
    verifyRestoreSelection({ epoch: 2, id: restoreId, control: restoreControl, store }),
    /database_restore_not_preparing/,
  );
  assert.deepEqual(
    (await query("SELECT epoch,maintenance,gc_paused,backup_frozen FROM control"))[0],
    { epoch: 2, maintenance: 1, gc_paused: 1, backup_frozen: 0 },
  );
  const report = {
    result: "PASS",
    directory,
    id,
    tables: download.manifest.tables.length,
    bytes: download.manifest.data.bytes,
    proof:
      "Private BackupOperator and separate DatabaseRestoreOperator capability, including denial for backup-only grants; real daily capture plus four replenishments; maintenance expiry sweep and corruption warnings; restore preparation, isolated full SQL verification and durable attestation, fresh independent D1 mirror observation, eviction replay and cancellation retaining closed admission.",
    limits:
      "Local service-binding capability only; remote credentials/getPlatformProxy transport and separate Wrangler CLI are not exercised here. No scheduler installation, external notification, independent BLOBS copy or live restore.",
  };
  await writeFile(join(directory, "report.json"), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report));
} finally {
  await harness.close();
}
