import assert from "node:assert/strict";
import { test } from "node:test";
import { allowedCleanupKeys } from "./fault-cleanup.mjs";
import { faultWorkerConfig, resourceNames, validateLedger } from "./fault-config.mjs";
import { migrationImportPlan } from "./fault-provision.mjs";

const id = "11111111-2222-4333-8444-555555555555";
const accountId = "a".repeat(32);
const ledger = () => ({
  version: 1,
  id,
  names: resourceNames(id),
  created: [{ kind: "d1", name: resourceNames(id).d1, uuid: id }],
});

test("drill resources have UUID-scoped names and reject forged ledger ownership", () => {
  const valid = ledger();
  assert.equal(validateLedger(valid), valid);
  assert.throws(() => resourceNames("ncf-staging"), /fault_invalid_run_id/);
  assert.throws(
    () => validateLedger({ ...valid, names: { ...valid.names, blobs: "ncf-staging-blobs" } }),
    /fault_invalid_ledger/,
  );
  assert.throws(
    () =>
      validateLedger({ ...valid, created: [{ kind: "worker", name: "next-cloud-flare-staging" }] }),
    /fault_invalid_ledger/,
  );
  assert.throws(
    () => validateLedger({ ...valid, created: [...valid.created, ...valid.created] }),
    /fault_invalid_ledger/,
  );
  assert.throws(() => validateLedger({ ...valid, detached: ["worker"] }), /fault_invalid_ledger/);
});

test("cleanup accepts only the isolated run's exact synthetic keys", () => {
  assert.deepEqual(allowedCleanupKeys("blobs", id, [`fault/${id}/complete`]), [
    `fault/${id}/complete`,
  ]);
  assert.deepEqual(allowedCleanupKeys("backups", id, ["sys/epoch/2.json"]), ["sys/epoch/2.json"]);
  for (const key of ["u/private/b/private", "sys/backups/v1/other/manifest.json", "../escape"])
    assert.throws(() => allowedCleanupKeys("blobs", id, [key]), /fault_cleanup_foreign_object/);
  assert.throws(
    () => allowedCleanupKeys("blobs", id, [`fault/${id}/complete`, `fault/${id}/complete`]),
    /fault_cleanup_foreign_object/,
  );
  assert.throws(() => allowedCleanupKeys("backups", id, ["sys/epoch/3.json"]));
});

test("private Worker has no public route and uses only dedicated D1, R2 and Queues", () => {
  const config = faultWorkerConfig({ ledger: ledger(), accountId });
  const names = resourceNames(id);
  assert.equal(config.workers_dev, false);
  assert.equal(config.preview_urls, false);
  assert.equal(config.routes, undefined);
  assert.equal(config.assets, undefined);
  assert.equal(config.vars.FAULT_ARMED, "false");
  assert.equal(config.d1_databases[0].database_name, names.d1);
  assert.deepEqual(
    config.r2_buckets.map((item) => item.bucket_name),
    [names.blobs, names.backups],
  );
  assert.deepEqual(
    config.queues.consumers.map((item) => item.queue),
    [names.queue, names.dlq],
  );
  assert.equal(config.queues.consumers[0].dead_letter_queue, names.dlq);
  assert.equal(config.queues.consumers[0].max_retries, 2);
  assert.equal(config.queues.consumers[1].max_retries, 3);
  assert.deepEqual(config.triggers.crons, ["* * * * *"]);
  assert.equal(
    faultWorkerConfig({ ledger: ledger(), accountId, armed: true }).vars.FAULT_ARMED,
    "true",
  );
  assert.throws(() => faultWorkerConfig({ ledger: ledger(), accountId: "invalid" }));
});

test("migration import uses only the exact unapplied prefix through later additions", () => {
  const names = ["0001_foundation.sql", "0002_content_media.sql", "0003_invariant_guards.sql"];
  for (let n = 4; n <= 56; n++) names.push(`${String(n).padStart(4, "0")}_sample.sql`);
  assert.deepEqual(migrationImportPlan(names, []), []);
  assert.deepEqual(migrationImportPlan(names, names.slice(0, 53)), [
    { first: names[53], last: names[55], before: 53, after: 56 },
  ]);
  assert.deepEqual(migrationImportPlan(names, names.slice(0, 2))[0], {
    first: names[2],
    last: names[2],
    before: 2,
    after: 3,
  });
  assert.equal(migrationImportPlan(names, names)[0], undefined);
  assert.throws(() => migrationImportPlan(names, [names[0], "0002_other.sql"]), /conflict/);
  assert.throws(() => migrationImportPlan(names, [names[0]]), /conflict/);
});
