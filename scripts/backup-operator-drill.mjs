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
const { restoreStatus, verifyRestoreSelection } = await moduleAt("scripts/restore/verify.mjs");
const { verifyRestoreD1 } = await moduleAt("scripts/restore/target.mjs");
const { verifyRestoreBookmark } = await moduleAt("scripts/restore/bookmark.mjs");
const { verifyRestoreBlobs } = await moduleAt("scripts/restore/blobs.mjs");
const { verifyRestoreBindings } = await moduleAt("scripts/restore/bindings.mjs");
const { freezeRestoreDatabase } = await moduleAt("scripts/restore/freeze.mjs");
const { reserveRestoreEpoch } = await moduleAt("scripts/restore/epoch.mjs");
const { verifyRestoredSnapshot } = await moduleAt("scripts/restore/snapshot.mjs");
const { adoptRestoreEpoch } = await moduleAt("scripts/restore/adoption.mjs");
const { auditRestored, repairRestoredNative, resumeRestored } = await moduleAt(
  "scripts/restore/recovery.mjs",
);
const { applyRestoreTimeTravel, timeTravelProvider } = await moduleAt(
  "scripts/restore/timeTravel.mjs",
);
const { S3BackupStore, bindingBackupStore } = await moduleAt("scripts/backup/objectStore.mjs");
const { RESTORE_BACKUPS_PROBE_KEY } = await moduleAt("packages/shared/src/restoreBackups.ts");
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
import { ControlDO as BaseControlDO, CONTROL_NAME } from ${JSON.stringify(join(repo, "packages/worker/src/do/ControlDO.ts"))};
export { BackupOperator } from ${JSON.stringify(join(repo, "packages/worker/src/backup/operator.ts"))};
export { DatabaseRestoreOperator } from ${JSON.stringify(join(repo, "packages/worker/src/backup/restoreOperator.ts"))};
// Simulate only the S3 provider response. D1, DO, R2, signing and private RPC are real local engines.
export class ControlDO extends BaseControlDO {
  constructor(state, env) {
    super(state, env);
    globalThis.fetch = async (input, init) => {
      const request = new Request(input, init);
      if (request.method !== 'GET' || request.url !==
        'https://${"a".repeat(32)}.r2.cloudflarestorage.com/operator-drill-blobs/system/r2-binding-probe-v1'
        || !request.headers.get('authorization')?.startsWith('AWS4-HMAC-SHA256 '))
        throw new Error('unexpected_drill_s3_request');
      const object = await env.BLOBS.get('system/r2-binding-probe-v1');
      return object ? new Response(await object.arrayBuffer()) : new Response(null, { status: 404 });
    };
  }
}
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
          RESTORE_WRITE_ENABLED: "true",
          R2_INVENTORY_ACCOUNT_ID: "a".repeat(32),
          R2_INVENTORY_BUCKET: "operator-drill-blobs",
          R2_INVENTORY_ACCESS_KEY_ID: "b".repeat(32),
          R2_INVENTORY_SECRET_ACCESS_KEY: "c".repeat(64),
        },
        d1_databases: [
          {
            binding: "DB",
            database_name: "operator-drill",
            database_id: "00000000-0000-0000-0000-000000000000",
            migrations_dir: join(repo, "packages/worker/migrations"),
          },
        ],
        r2_buckets: [
          { binding: "BACKUPS", bucket_name: "operator-drill" },
          { binding: "BLOBS", bucket_name: "operator-drill-blobs" },
        ],
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
  const fixtureObject = await env.BLOBS.put(`u/${fixture.ids.user}/b/${fixture.ids.blob}`, "abc");
  await env.DB.prepare(
    "INSERT INTO blob_storage(blob_id,bytes,r2_etag,observed_at) VALUES(?,3,?,?)",
  )
    .bind(fixture.ids.blob, fixtureObject.etag, Date.now())
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
      "grantPublicationWrite",
      "checkPublicationWrites",
      "finishPublicationWrite",
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
  const store = bindingBackupStore(env.BACKUPS);
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
      ["attestBookmark", [2, restoreId, {}, {}]],
      ["verifyBlobs", [2, restoreId, {}, {}]],
      ["challengeBackups", [2, restoreId, {}, {}]],
      ["attestBackups", [2, restoreId, {}, "", ""]],
      ["verifyBindings", [2, restoreId, {}, "", ""]],
      ["freeze", [2, restoreId, {}, {}]],
      ["reserveEpoch", [2, restoreId, {}]],
      ["beginTimeTravel", [2, restoreId, {}, {}]],
      ["finishTimeTravel", [2, restoreId, {}, {}]],
      ["challengeSnapshot", [2, restoreId, {}]],
      ["attestSnapshot", [2, restoreId, {}, {}]],
      ["beginAdoption", [2, restoreId, {}]],
      ["attestAdoption", [2, restoreId, {}]],
      ["auditRecovery", [2, restoreId]],
      ["repairNative", [2, restoreId]],
      ["rebuildRecoveryFts", [2, restoreId]],
      ["releaseRecovery", [2, restoreId]],
      ["resumeRecovery", [2, restoreId]],
      ["resumeRecoveryGc", [2, restoreId]],
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
  assert.equal(sqlVerified.tables, 68);
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
  // Real private RPC and DO persistence with an explicitly simulated provider response.
  const bookmarkId = crypto.randomUUID(),
    timestamp = new Date(Date.now() - 60000).toISOString(),
    bookmarkReader = {
      target: { mode: "remote", databaseId: d1Reader.target.databaseId, accountId: "a".repeat(32) },
      readMirror: d1Reader.readMirror,
      readBookmark: async () => ({ bookmark: "drill-bookmark", timestamp }),
    };
  await restoreControl.prepare(2, bookmarkId, { kind: "time_travel", bookmark: "drill-bookmark" });
  const verifyBookmark = () =>
    verifyRestoreBookmark({
      epoch: 2,
      id: bookmarkId,
      control: restoreControl,
      reader: bookmarkReader,
      timestamp,
    });
  const bookmark = await verifyBookmark();
  assert.equal(bookmark.state, "bookmark_verified");
  assert.equal("token" in bookmark, false);
  await worker.evictDurableObject("CONTROL", { name: "singleton" });
  assert.notEqual((await verifyBookmark()).challengeId, bookmark.challengeId);
  const blobsReader = {
    ...bookmarkReader,
    blobsTarget: {
      accountId: "a".repeat(32),
      bucket: "operator-drill-blobs",
      jurisdiction: "default",
    },
    assertUnchanged: async () => {},
  };
  const verifyBlobs = () =>
    verifyRestoreBlobs({ epoch: 2, id: bookmarkId, control: restoreControl, reader: blobsReader });
  const blobs = await verifyBlobs();
  assert.equal(blobs.state, "blobs_verified");
  assert.equal("token" in blobs, false);
  const probeKey = "system/r2-binding-probe-v1",
    probe = await (await env.BLOBS.get(probeKey)).text();
  assert.equal(probe.length, 64);
  await worker.evictDurableObject("CONTROL", { name: "singleton" });
  const nextBlobs = await verifyBlobs();
  assert.notEqual(nextBlobs.attemptId, blobs.attemptId);
  assert.notEqual(nextBlobs.challengeId, blobs.challengeId);
  assert.notEqual(await (await env.BLOBS.get(probeKey)).text(), probe);
  const bindingReader = {
    ...blobsReader,
    backupsTarget: { accountId: "a".repeat(32), bucket: "operator-drill", jurisdiction: "default" },
  };
  const backupProbeStore = new S3BackupStore(
    {
      R2_BACKUP_ACCOUNT_ID: "a".repeat(32),
      R2_BACKUP_BUCKET: "operator-drill",
      R2_BACKUP_ACCESS_KEY_ID: "b".repeat(32),
      R2_BACKUP_SECRET_ACCESS_KEY: "c".repeat(64),
    },
    {
      timeoutMs: 10000,
      fetch: async (request) => {
        assert.equal(request.method, "GET");
        assert.equal(
          request.url,
          `https://${"a".repeat(32)}.r2.cloudflarestorage.com/operator-drill/${RESTORE_BACKUPS_PROBE_KEY}`,
        );
        assert.match(request.headers.get("authorization"), /^AWS4-HMAC-SHA256 /);
        const object = await env.BACKUPS.get(RESTORE_BACKUPS_PROBE_KEY);
        return object
          ? new Response(await object.arrayBuffer())
          : new Response(null, { status: 404 });
      },
    },
  );
  const verifyBindings = () =>
    verifyRestoreBindings({
      epoch: 2,
      id: bookmarkId,
      control: restoreControl,
      reader: bindingReader,
      store: backupProbeStore,
    });
  const bindings = await verifyBindings();
  assert.equal(bindings.state, "bindings_verified");
  const backupsNonce = await (await env.BACKUPS.get(RESTORE_BACKUPS_PROBE_KEY)).text();
  await worker.evictDurableObject("CONTROL", { name: "singleton" });
  const nextBindings = await verifyBindings();
  assert.notEqual(nextBindings.challengeId, bindings.challengeId);
  assert.notEqual(nextBindings.backups.attemptId, bindings.backups.attemptId);
  assert.notEqual(await (await env.BACKUPS.get(RESTORE_BACKUPS_PROBE_KEY)).text(), backupsNonce);
  const freezeDatabase = () =>
    freezeRestoreDatabase({
      epoch: 2,
      id: bookmarkId,
      control: restoreControl,
      reader: bindingReader,
      store: backupProbeStore,
    });
  // The backup fixture deliberately retains an ordinary reservation. Freezing must
  // refuse it; only this known, unused fixture reservation is explicitly released.
  await assert.rejects(freezeDatabase(), /database_restore_freeze_pending/);
  assert.equal((await restoreControl.inspect(2, bookmarkId)).state, "preparing");
  await query("UPDATE reservations SET state='released' WHERE id='held' AND state='reserved'");
  await env.DB.prepare(
    "UPDATE control SET bootstrap_done_at=1,bootstrap_iss='https://access.invalid',bootstrap_sub=?",
  )
    .bind(fixture.ids.user)
    .run();
  const frozen = await freezeDatabase();
  assert.equal(frozen.state, "frozen");
  await assert.rejects(
    query("UPDATE control SET updated_at=updated_at+1"),
    /database_restore_frozen/,
  );
  await worker.evictDurableObject("CONTROL", { name: "singleton" });
  assert.deepEqual(await freezeDatabase(), frozen);
  const beforeCancel = (await query("SELECT admission_revision,admission_token FROM control"))[0];
  await restoreControl.cancel(2, bookmarkId);
  const afterCancel = (
    await query("SELECT admission_revision,admission_token,restore_freeze_token FROM control")
  )[0];
  assert.equal(afterCancel.restore_freeze_token, null);
  assert.equal(afterCancel.admission_revision, beforeCancel.admission_revision + 1);
  assert.notEqual(afterCancel.admission_token, beforeCancel.admission_token);
  await assert.rejects(verifyBookmark(), /database_restore_not_preparing/);
  await assert.rejects(verifyBlobs(), /database_restore_not_preparing/);
  await assert.rejects(verifyBindings(), /database_restore_not_preparing/);
  assert.deepEqual(
    (await query("SELECT epoch,maintenance,gc_paused,backup_frozen FROM control"))[0],
    { epoch: 2, maintenance: 1, gc_paused: 1, backup_frozen: 0 },
  );
  const epochId = crypto.randomUUID();
  await restoreControl.prepare(2, epochId, { kind: "time_travel", bookmark: "drill-bookmark" });
  await verifyRestoreBookmark({
    epoch: 2,
    id: epochId,
    control: restoreControl,
    reader: bookmarkReader,
    timestamp,
  });
  await freezeRestoreDatabase({
    epoch: 2,
    id: epochId,
    control: restoreControl,
    reader: bindingReader,
    store: backupProbeStore,
  });
  const beforeReservation = await query("SELECT * FROM control");
  const reserveEpoch = () =>
    reserveRestoreEpoch({ epoch: 2, id: epochId, control: restoreControl, reader: bindingReader });
  const reserved = await reserveEpoch();
  assert.equal(reserved.state, "epoch_reserved");
  assert.equal(reserved.newEpoch, 3);
  assert.equal("token" in reserved, false);
  assert.equal((await (await env.BACKUPS.get("sys/epoch/3.json")).json()).reason, "restore");
  await worker.evictDurableObject("CONTROL", { name: "singleton" });
  assert.deepEqual(await reserveEpoch(), reserved);
  assert.equal((await restoreControl.inspect(2, epochId)).newEpoch, 3);
  await assert.rejects(restoreControl.cancel(2, epochId), /database_restore_epoch_reserved/);
  assert.deepEqual(await query("SELECT * FROM control"), beforeReservation);
  let providerCalls = 0;
  const provider = timeTravelProvider("synthetic-local-token", {
    fetch: async (url, options) => {
      providerCalls++;
      assert.equal(url.origin, "https://api.cloudflare.com");
      assert.equal(options.method, "POST");
      assert.equal(options.redirect, "manual");
      assert.equal(url.searchParams.get("bookmark"), "drill-bookmark");
      assert.equal((await restoreControl.inspect(2, epochId)).state, "restore_pending");
      // Simulate only the control-row rollback. No request leaves this process.
      await query("UPDATE control SET restore_freeze_token=NULL");
      await query(
        "UPDATE control SET epoch=1,maintenance=0,gc_paused=0,admission_revision=0,admission_token=NULL",
      );
      return Response.json({
        success: true,
        result: { bookmark: "drill-restored", previous_bookmark: "drill-before" },
      });
    },
  });
  const apply = () =>
    applyRestoreTimeTravel({
      epoch: 2,
      id: epochId,
      control: restoreControl,
      reader: bindingReader,
      timestamp,
      provider,
    });
  const written = await apply();
  assert.equal(written.state, "restore_written");
  assert.equal(written.newEpoch, 3);
  assert.deepEqual(written.restoreResult, {
    bookmark: "drill-restored",
    previousBookmark: "drill-before",
  });
  await worker.evictDurableObject("CONTROL", { name: "singleton" });
  assert.deepEqual(await apply(), written);
  assert.equal(providerCalls, 1);
  const stopped = await api.recover();
  assert.equal(stopped.epoch, 2);
  assert.equal(stopped.maintenance, true);
  assert.equal(stopped.gcPaused, true);
  assert.equal((await query("SELECT epoch FROM control"))[0].epoch, 1);
  await assert.rejects(restoreControl.cancel(2, epochId), /database_restore_epoch_reserved/);
  const beforeSnapshot = await query("SELECT * FROM control");
  const snapshot = await verifyRestoredSnapshot({
    epoch: 2,
    id: epochId,
    control: restoreControl,
    reader: { ...bindingReader, snapshotQuery: query },
  });
  assert.equal(snapshot.state, "snapshot_verified");
  assert.equal(snapshot.tables, 68);
  assert.equal(snapshot.newEpoch, 3);
  await worker.evictDurableObject("CONTROL", { name: "singleton" });
  assert.equal(
    (await restoreControl.inspect(2, epochId)).snapshotVerifiedAt,
    snapshot.snapshotVerifiedAt,
  );
  assert.equal((await apply()).state, "snapshot_verified");
  assert.equal(providerCalls, 1);
  assert.deepEqual(await query("SELECT * FROM control"), beforeSnapshot);
  const adoption = await adoptRestoreEpoch({
    epoch: 2,
    id: epochId,
    control: restoreControl,
    reader: { ...bindingReader, snapshotQuery: query },
  });
  assert.equal(adoption.state, "epoch_adopted");
  await worker.evictDurableObject("CONTROL", { name: "singleton" });
  assert.deepEqual(restoreStatus(await restoreControl.inspect(2, epochId), 2, epochId), adoption);
  const adoptedControl = await api.recover();
  assert.equal(adoptedControl.epoch, 3);
  assert.equal(adoptedControl.maintenance, true);
  assert.equal(adoptedControl.gcPaused, true);
  assert.deepEqual((await query("SELECT epoch,maintenance,gc_paused FROM control"))[0], {
    epoch: 3,
    maintenance: 1,
    gc_paused: 1,
  });
  assert.equal((await apply()).state, "epoch_adopted");
  assert.equal(providerCalls, 1);
  const nativeRepair = await repairRestoredNative({
    epoch: 2,
    id: epochId,
    control: restoreControl,
  });
  assert.equal(nativeRepair.repair.completed, true);
  assert.equal(nativeRepair.repair.unknown, 0);
  const recovery = await auditRestored({ epoch: 2, id: epochId, control: restoreControl });
  assert.equal(recovery.audit.completed, true);
  const resumed = await resumeRestored({ epoch: 2, id: epochId, control: restoreControl });
  assert.deepEqual(resumed.control, { epoch: 3, maintenance: false, gcPaused: true });
  await worker.evictDurableObject("CONTROL", { name: "singleton" });
  const gcResumed = await resumeRestored({
    epoch: 2,
    id: epochId,
    control: restoreControl,
    gc: true,
  });
  assert.deepEqual(gcResumed.control, { epoch: 3, maintenance: false, gcPaused: false });
  assert.equal((await apply()).state, "gc_resumed");
  assert.equal(providerCalls, 1);
  const report = {
    result: "PASS",
    directory,
    id,
    tables: download.manifest.tables.length,
    bytes: download.manifest.data.bytes,
    adoption: { state: adoption.state, newEpoch: adoption.newEpoch },
    recovery: {
      state: gcResumed.state,
      repair: nativeRepair.repair,
      audit: recovery.audit,
      control: gcResumed.control,
    },
    snapshot: {
      state: snapshot.state,
      tables: snapshot.tables,
      bytes: snapshot.bytes,
      schemaSha256: snapshot.schemaSha256,
      dataSha256: snapshot.dataSha256,
    },
    proof:
      "Private BackupOperator and separate DatabaseRestoreOperator capability, including denial for all twenty-six restore methods with backup-only grants; real daily capture plus four replenishments; maintenance expiry sweep and corruption warnings; restore preparation, isolated SQL verification and durable attestation, independent D1 observation, Time Travel bookmark observation and D1/BLOBS/BACKUPS verification with simulated provider responses; D1 freeze, rejected writes, eviction replay and cancellation with a fresh closed token; request-bound future epoch reservation in DO/R2; one-shot Time Travel dispatch and completion with a simulated control-row rollback; restored snapshot schema/all-table/isolated SQL/FK/FTS verification with a durable DO attestation and eviction replay; atomic D1 adoption with independent marker readback, reserved DO epoch publication and eviction replay; bounded native repair scan with no pending rows, restored FTS rebuild and full audit, exact hold release, service admission then GC resume with eviction, no repeat POST or cancellation.",
    limits:
      "Local service-binding capability only; bookmark and S3 provider responses are simulated. Remote Time Travel/R2, credentials/getPlatformProxy transport and separate Wrangler CLI are not exercised here. No scheduler installation, external notification, independent BLOBS copy or live restore.",
  };
  await writeFile(join(directory, "report.json"), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report));
} finally {
  await harness.close();
}
