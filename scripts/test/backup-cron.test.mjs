import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test, vi } from "vitest";
import bridge, { advanceBackup } from "../../ops/staging/backup-cron.mjs";
import {
  buildCronConfig,
  generateCronConfig,
  validateCronConfig,
} from "../../ops/staging/backup-cron-config.mjs";

const id = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
const hash = "f".repeat(64);
const accountId = "a".repeat(32);
const roots = [];
const posixOnly = process.platform === "win32" ? test.skip : test;
const windowsOnly = process.platform === "win32" ? test : test.skip;
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function env(operation, control, manifestSha256) {
  return {
    BACKUP_CRON_ENABLED: "true",
    BACKUP_TARGET: "next-cloud-flare-staging",
    BACKUP_EPOCH: "2",
    BACKUP_ID: id,
    BACKUP_OPERATION: operation,
    ...(manifestSha256 === undefined ? {} : { BACKUP_MANIFEST_SHA256: manifestSha256 }),
    BACKUP_CONTROL: control,
  };
}

test("begin replays the same fixed identity and never invokes unrelated authority", async () => {
  const calls = [];
  const control = {
    async begin(epoch, requestedId) {
      calls.push([epoch, requestedId]);
      return { id, epoch, state: "frozen", watermark: null };
    },
    complete() {
      throw new Error("wrong_method");
    },
    receipt() {
      throw new Error("wrong_method");
    },
  };
  const logs = [];
  assert.deepEqual(await advanceBackup(env("begin", control), (status) => logs.push(status)), {
    operation: "begin",
    stage: "frozen",
  });
  assert.deepEqual(await advanceBackup(env("begin", control), (status) => logs.push(status)), {
    operation: "begin",
    stage: "frozen",
  });
  assert.deepEqual(calls, [
    [2, id],
    [2, id],
  ]);
  assert.equal(JSON.stringify(logs).includes(id), false);
  assert.equal(JSON.stringify(logs).includes(hash), false);
});

test("complete retries one immutable hash, bounds calls, and accepts a completed replay", async () => {
  let calls = 0;
  const control = {
    async complete(epoch, requestedId, requestedHash) {
      assert.deepEqual([epoch, requestedId, requestedHash], [2, id, hash]);
      calls++;
      return {
        id,
        epoch,
        manifestSha256: hash,
        state: calls >= 5 ? "completed" : "verifying",
        partsVerified: calls,
        partsTotal: 5,
      };
    },
  };
  const logs = [];
  assert.deepEqual(
    await advanceBackup(env("complete", control, hash), (status) => logs.push(status)),
    { operation: "complete", stage: "verifying" },
  );
  assert.equal(calls, 4);
  assert.deepEqual(
    await advanceBackup(env("complete", control, hash), (status) => logs.push(status)),
    { operation: "complete", stage: "completed" },
  );
  assert.equal(calls, 5);
  assert.equal(JSON.stringify(logs).includes(id), false);
  assert.equal(JSON.stringify(logs).includes(hash), false);
});

test("invalid and uncertain responses fail closed without a release or cancel call", async () => {
  const methods = [];
  const control = {
    async complete() {
      methods.push("complete");
      throw new Error(`private ${id} ${hash}`);
    },
    cancel() {
      methods.push("cancel");
    },
    release() {
      methods.push("release");
    },
  };
  await assert.rejects(advanceBackup(env("complete", control, hash)), /private/);
  assert.deepEqual(methods, ["complete"]);
  await assert.rejects(
    advanceBackup(
      env(
        "complete",
        {
          complete: async () => ({
            id,
            epoch: 2,
            state: "completed",
            manifestSha256: "0".repeat(64),
            partsVerified: 1,
            partsTotal: 1,
          }),
        },
        hash,
      ),
    ),
    { message: "staging_backup_cron_invalid_status" },
  );
  await assert.rejects(advanceBackup(env("complete", control)), {
    message: "staging_backup_cron_unconfigured",
  });
  await assert.rejects(advanceBackup({ ...env("begin", control), BACKUP_EPOCH: "3" }), {
    message: "staging_backup_cron_unconfigured",
  });
});

test("receipt is read-only and logs state without identity or manifest", async () => {
  let calls = 0;
  const control = {
    async receipt(epoch, requestedId) {
      assert.deepEqual([epoch, requestedId], [2, id]);
      calls++;
      return calls === 1 ? null : { id, epoch, state: "completed", manifestSha256: hash };
    },
  };
  const logs = [];
  assert.deepEqual(await advanceBackup(env("receipt", control), (status) => logs.push(status)), {
    operation: "receipt",
    stage: "missing",
  });
  assert.deepEqual(await advanceBackup(env("receipt", control), (status) => logs.push(status)), {
    operation: "receipt",
    stage: "completed",
  });
  assert.equal(calls, 2);
  assert.equal(JSON.stringify(logs).includes(id), false);
  assert.equal(JSON.stringify(logs).includes(hash), false);
});

test("config has only the private named service binding and pins one operation", async () => {
  const begin = await buildCronConfig({ accountId, id, operation: "begin" });
  assert.equal(begin.services.length, 1);
  assert.equal(begin.services[0].entrypoint, "BackupOperator");
  assert.equal(begin.workers_dev, false);
  assert.equal(begin.preview_urls, false);
  assert.equal(begin.routes, undefined);
  assert.equal(begin.d1_databases, undefined);
  assert.equal(begin.r2_buckets, undefined);
  assert.equal(begin.vars.BACKUP_MANIFEST_SHA256, undefined);
  const complete = await buildCronConfig({
    accountId,
    id,
    operation: "complete",
    manifestSha256: hash,
  });
  assert.equal(complete.vars.BACKUP_MANIFEST_SHA256, hash);
  assert.throws(() => validateCronConfig({ ...complete, routes: ["*"] }), {
    message: "staging_backup_cron_config_invalid",
  });
  assert.throws(
    () =>
      validateCronConfig({ ...complete, vars: { ...complete.vars, BACKUP_OPERATION: "begin" } }),
    { message: "staging_backup_cron_config_invalid" },
  );
  await assert.rejects(buildCronConfig({ accountId, id, operation: "complete" }), {
    message: "staging_backup_cron_config_invalid",
  });
});

posixOnly("generated config remains private and refuses an identity switch", async () => {
  const root = await mkdtemp(join(tmpdir(), "ncf-backup-cron-test-"));
  roots.push(root);
  const path = join(root, "generated.jsonc");
  await generateCronConfig({ accountId, id, operation: "begin" }, path);
  assert.equal((await stat(path)).mode & 0o777, 0o600);
  await generateCronConfig({ accountId, id, operation: "complete", manifestSha256: hash }, path);
  const config = validateCronConfig(JSON.parse(await readFile(path, "utf8")));
  assert.equal(config.vars.BACKUP_OPERATION, "complete");
  await assert.rejects(
    generateCronConfig(
      { accountId, id: "11111111-2222-4333-8444-555555555555", operation: "begin" },
      path,
    ),
    { message: "staging_backup_cron_identity_conflict" },
  );
  assert.equal((await stat(path)).mode & 0o777, 0o600);
});

windowsOnly(
  "refuses to reuse a config when Windows cannot attest private permissions",
  async () => {
    const root = await mkdtemp(join(tmpdir(), "ncf-backup-cron-test-"));
    roots.push(root);
    const path = join(root, "generated.jsonc");
    await generateCronConfig({ accountId, id, operation: "begin" }, path);
    assert.notEqual((await stat(path)).mode & 0o077, 0);
    await assert.rejects(generateCronConfig({ accountId, id, operation: "begin" }, path), {
      message: "staging_backup_cron_config_invalid",
    });
  },
);

test("HTTP is unavailable", () => {
  assert.equal(bridge.fetch().status, 404);
});

test("scheduled errors never log provider text, UUID or manifest hash", async () => {
  const error = vi.spyOn(console, "error").mockImplementation(() => {});
  try {
    await assert.rejects(
      bridge.scheduled(
        null,
        env(
          "complete",
          {
            complete() {
              throw new Error(`private ${id} ${hash}`);
            },
          },
          hash,
        ),
      ),
      { message: "staging_backup_cron_failed" },
    );
    assert.deepEqual(error.mock.calls, [["staging_backup_cron_failed"]]);
  } finally {
    error.mockRestore();
  }
});
