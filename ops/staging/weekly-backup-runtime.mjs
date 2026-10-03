import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { chmod, copyFile, lstat, mkdir, readFile, rm } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { parseBackupPublication } from "../../packages/shared/src/backupPublication.ts";
import { auditRestoredBlobBytes, S3BlobSource } from "../../scripts/backup/blobAudit.mjs";
import { exportData } from "../../scripts/backup/export.mjs";
import {
  captureGeneration,
  restoreGeneration,
  verifyGeneration,
} from "../../scripts/backup/generation.mjs";
import {
  digest,
  MAX_MANIFEST_BYTES,
  manifestKey,
  S3BackupStore,
} from "../../scripts/backup/objectStore.mjs";
import { downloadGeneration, publishGeneration } from "../../scripts/backup/publication.mjs";
import { generateCronConfig, validateCronConfig } from "./backup-cron-config.mjs";

const execute = promisify(execFile);
const wranglerPath = fileURLToPath(
  new URL("../../node_modules/wrangler/bin/wrangler.js", import.meta.url),
);
const bridgeSourcePath = fileURLToPath(new URL("./backup-cron.mjs", import.meta.url));
const SHA256 = /^[a-f0-9]{64}$/;
const UUID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;
const BRIDGE_NAME = "ncf-staging-backup-bridge";
function validGeneration(state) {
  if (!UUID.test(state?.id ?? "") || !Number.isSafeInteger(state?.epoch) || state.epoch < 1)
    throw new Error("backup_generation_invalid");
}

function configured(env) {
  if (
    !/^[a-f0-9]{32}$/.test(env.CLOUDFLARE_ACCOUNT_ID ?? "") ||
    !UUID.test(env.STAGING_D1_DATABASE_ID ?? "") ||
    !env.CLOUDFLARE_API_TOKEN ||
    env.R2_INVENTORY_ACCOUNT_ID !== env.CLOUDFLARE_ACCOUNT_ID ||
    env.R2_INVENTORY_BUCKET !== "ncf-staging-blobs" ||
    !env.R2_INVENTORY_ACCESS_KEY_ID ||
    !env.R2_INVENTORY_SECRET_ACCESS_KEY ||
    !Number.isSafeInteger(Number(env.NCF_BACKUP_AUDIT_MAX_OBJECTS)) ||
    Number(env.NCF_BACKUP_AUDIT_MAX_OBJECTS) < 1 ||
    !Number.isSafeInteger(Number(env.NCF_BACKUP_AUDIT_MAX_BYTES)) ||
    Number(env.NCF_BACKUP_AUDIT_MAX_BYTES) < 1
  )
    throw new Error("backup_weekly_unconfigured");
}

async function cloudflare(env, path, options = {}) {
  let response;
  try {
    response = await fetch(
      `https://api.cloudflare.com/client/v4/accounts/${env.CLOUDFLARE_ACCOUNT_ID}${path}`,
      {
        ...options,
        headers: { Authorization: `Bearer ${env.CLOUDFLARE_API_TOKEN}`, ...options.headers },
        redirect: "error",
        signal: AbortSignal.timeout(30000),
      },
    );
  } catch {
    throw new Error("backup_cloudflare_unavailable");
  }
  return response;
}

async function d1Query(env, sql) {
  if (!/^(SELECT|PRAGMA)\b/i.test(sql.trim())) throw new Error("backup_read_only_required");
  const response = await cloudflare(env, `/d1/database/${env.STAGING_D1_DATABASE_ID}/query`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ sql }),
  });
  let result;
  try {
    result = await response.json();
  } catch {
    throw new Error("backup_query_unavailable");
  }
  if (
    !response.ok ||
    result?.success !== true ||
    result.result?.length !== 1 ||
    result.result[0]?.success !== true ||
    !Array.isArray(result.result[0]?.results)
  )
    throw new Error("backup_query_unavailable");
  return result.result[0].results;
}

async function tokenStore(env) {
  const response = await cloudflare(env, "/tokens/verify");
  let result;
  try {
    result = await response.json();
  } catch {
    throw new Error("backup_token_verify_failed");
  }
  if (!response.ok || result?.success !== true || !/^[a-f0-9]{32}$/.test(result.result?.id ?? ""))
    throw new Error("backup_token_verify_failed");
  return new S3BackupStore({
    R2_BACKUP_ACCOUNT_ID: env.CLOUDFLARE_ACCOUNT_ID,
    R2_BACKUP_BUCKET: "ncf-staging-backups",
    R2_BACKUP_ACCESS_KEY_ID: result.result.id,
    R2_BACKUP_SECRET_ACCESS_KEY: createHash("sha256")
      .update(env.CLOUDFLARE_API_TOKEN)
      .digest("hex"),
  });
}

async function runWrangler(args, errorCode) {
  try {
    await execute(process.execPath, [wranglerPath, ...args], {
      env: { ...process.env, CI: "true", WRANGLER_SEND_METRICS: "false" },
      timeout: 180000,
      maxBuffer: 1024 * 1024,
    });
  } catch {
    // Wrangler/provider output may contain request details; do not preserve it.
    throw new Error(errorCode);
  }
}

async function bridgeExists(env) {
  const response = await cloudflare(env, `/workers/scripts/${BRIDGE_NAME}`);
  void response.body?.cancel().catch(() => {});
  if (response.status === 404) return false;
  if (response.status === 200) return true;
  throw new Error("backup_bridge_inspect_failed");
}

export async function preparePrivateBridgeConfig(env, state, operation, workRoot) {
  validGeneration(state);
  if (!isAbsolute(workRoot ?? "") || resolve(workRoot) !== workRoot)
    throw new Error("backup_weekly_unconfigured");
  const directory = join(workRoot, state.id, "bridge");
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const info = await lstat(directory);
  if (!info.isDirectory() || info.isSymbolicLink() || (info.mode & 0o077) !== 0)
    throw new Error("backup_bridge_directory_not_private");
  const script = join(directory, "backup-cron.mjs");
  try {
    await copyFile(bridgeSourcePath, script, constants.COPYFILE_EXCL);
    await chmod(script, 0o600);
  } catch (error) {
    if (error?.code !== "EEXIST") throw new Error("backup_bridge_source_unavailable");
    const saved = await lstat(script);
    if (
      !saved.isFile() ||
      saved.isSymbolicLink() ||
      (saved.mode & 0o077) !== 0 ||
      !Buffer.from(await readFile(script)).equals(await readFile(bridgeSourcePath))
    )
      throw new Error("backup_bridge_source_changed");
  }
  const configPath = join(directory, "backup-cron.generated.jsonc");
  await generateCronConfig(
    {
      accountId: env.CLOUDFLARE_ACCOUNT_ID,
      id: state.id,
      epoch: state.epoch,
      operation,
      ...(operation === "complete" ? { manifestSha256: state.manifestSha256 } : {}),
    },
    configPath,
  );
  return configPath;
}

async function currentReceipt(env, state) {
  validGeneration(state);
  const [control] = await d1Query(env, "SELECT epoch,backup_frozen FROM control WHERE singleton=1");
  const [run] = await d1Query(
    env,
    `SELECT state,manifest_sha256 AS manifestSha256,released_at AS releasedAt,completed_at AS completedAt FROM backup_runs WHERE id='${state.id}' AND epoch=${state.epoch}`,
  );
  if (control?.epoch !== state.epoch) throw new Error("backup_epoch_changed");
  return { control, run };
}

async function assertFrozenReceipt(env, state) {
  const { control, run } = await currentReceipt(env, state);
  if (control.backup_frozen !== 1 || run?.state !== "exporting" || run.releasedAt !== null)
    throw new Error("backup_generation_not_frozen");
}

async function poll(assertion, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  do {
    if (await assertion()) return;
    if (Date.now() >= deadline) break;
    await new Promise((resolve) => setTimeout(resolve, 5000));
  } while (true);
  throw new Error("backup_bridge_timeout");
}

async function exists(path) {
  try {
    return await lstat(path);
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

/** Only the fixed staging account, database, buckets and private bridge are reachable. */
export function createWeeklyBackupRuntime({
  env = process.env,
  workRoot,
  verifyStorage,
  publishArchive,
  cleanupInternal = async (_state, directory) => rm(directory, { recursive: true, force: true }),
}) {
  configured(env);
  if (
    !verifyStorage ||
    !publishArchive ||
    !isAbsolute(workRoot ?? "") ||
    resolve(workRoot) !== workRoot
  )
    throw new Error("backup_weekly_unconfigured");
  const source = {
    query: (sql) => d1Query(env, sql),
    export: (path, specs) => exportData(path, specs, (sql) => d1Query(env, sql)),
  };
  return {
    verifyStorage,
    publishArchive,
    cleanupInternal,
    async currentEpoch() {
      const [control] = await d1Query(env, "SELECT epoch FROM control WHERE singleton=1");
      if (!Number.isSafeInteger(control?.epoch) || control.epoch < 1)
        throw new Error("backup_epoch_invalid");
      return control.epoch;
    },
    async deployBegin(state) {
      await currentReceipt(env, state);
      const configPath = join(workRoot, state.id, "bridge", "backup-cron.generated.jsonc");
      if (!(await exists(configPath)) && (await bridgeExists(env)))
        throw new Error("backup_bridge_identity_conflict");
      await preparePrivateBridgeConfig(env, state, "begin", workRoot);
      await runWrangler(["deploy", "--config", configPath], "backup_bridge_deploy_failed");
    },
    async waitFrozen(state) {
      await poll(async () => {
        const { control, run } = await currentReceipt(env, state);
        if (run?.state === "failed" || (run !== undefined && run.releasedAt !== null))
          throw new Error("backup_generation_failed");
        return control.backup_frozen === 1 && run?.state === "exporting";
      }, 300000);
    },
    async capture(state, directory) {
      await assertFrozenReceipt(env, state);
      const generations = join(directory, "generations");
      const saved = join(generations, state.id);
      const info = await exists(saved);
      if (info) {
        if (!info.isDirectory()) throw new Error("backup_generation_conflict");
        const manifest = await verifyGeneration(saved);
        if (manifest.generation.id !== state.id || manifest.generation.epoch !== state.epoch)
          throw new Error("backup_generation_conflict");
      } else {
        await captureGeneration({
          directory: generations,
          id: state.id,
          epoch: state.epoch,
          source,
        });
      }
      try {
        await assertFrozenReceipt(env, state);
      } catch (error) {
        if (!info) await rm(saved, { recursive: true, force: true });
        throw error;
      }
    },
    async publish(state, directory) {
      const store = await tokenStore(env);
      const result = await publishGeneration({
        directory: join(directory, "generations", state.id),
        store,
      });
      return result.sha256;
    },
    async restore(state, directory) {
      if (!SHA256.test(state.manifestSha256 ?? "")) throw new Error("backup_invalid_manifest_hash");
      const store = await tokenStore(env);
      const bytes = await store.get(manifestKey(state.id), MAX_MANIFEST_BYTES);
      if (!bytes || digest(bytes) !== state.manifestSha256)
        throw new Error("backup_publication_hash_mismatch");
      const publication = parseBackupPublication(bytes, state.id);
      const downloaded = join(directory, "downloaded", state.id);
      const prior = await exists(downloaded);
      if (prior) {
        if (!prior.isDirectory()) throw new Error("backup_generation_conflict");
        const manifest = await verifyGeneration(downloaded);
        if (manifest.generation.id !== state.id || manifest.generation.epoch !== state.epoch)
          throw new Error("backup_generation_conflict");
        assert.deepEqual(manifest, publication.manifest, "backup_generation_conflict");
      } else {
        await downloadGeneration({
          id: state.id,
          directory: join(directory, "downloaded"),
          store,
          expectedSha256: state.manifestSha256,
        });
      }
      const target = join(directory, "restored.sqlite");
      const old = await exists(target);
      if (old && !old.isFile()) throw new Error("backup_restore_target_invalid");
      if (old) await rm(target);
      await restoreGeneration({ directory: downloaded, target });
    },
    async audit(state, directory) {
      const destination = join(directory, "blob-copy");
      const prior = await exists(destination);
      if (prior && !prior.isDirectory()) throw new Error("backup_blob_destination_invalid");
      if (prior) await rm(destination, { recursive: true });
      await auditRestoredBlobBytes({
        generation: join(directory, "downloaded", state.id),
        database: join(directory, "restored.sqlite"),
        directory: destination,
        source: new S3BlobSource(env),
        maxObjects: Number(env.NCF_BACKUP_AUDIT_MAX_OBJECTS),
        maxBytes: Number(env.NCF_BACKUP_AUDIT_MAX_BYTES),
      });
    },
    async deployComplete(state) {
      if (!SHA256.test(state.manifestSha256 ?? "")) throw new Error("backup_invalid_manifest_hash");
      await currentReceipt(env, state);
      const configPath = join(workRoot, state.id, "bridge", "backup-cron.generated.jsonc");
      if (!(await exists(configPath)) && (await bridgeExists(env)))
        throw new Error("backup_bridge_identity_conflict");
      await preparePrivateBridgeConfig(env, state, "complete", workRoot);
      await runWrangler(["deploy", "--config", configPath], "backup_bridge_deploy_failed");
    },
    async waitCompleted(state) {
      await poll(async () => {
        const { control, run } = await currentReceipt(env, state);
        if (run?.state === "failed") throw new Error("backup_generation_failed");
        if (run?.manifestSha256 && run.manifestSha256 !== state.manifestSha256)
          throw new Error("backup_generation_conflict");
        return (
          run?.state === "completed" &&
          run.manifestSha256 === state.manifestSha256 &&
          run.completedAt !== null &&
          run.releasedAt !== null &&
          control.backup_frozen === 0
        );
      }, 540000);
    },
    async deleteBridge(state) {
      validGeneration(state);
      const bridgeConfigPath = join(workRoot, state.id, "bridge", "backup-cron.generated.jsonc");
      const configInfo = await exists(bridgeConfigPath);
      if (!configInfo) {
        if (await bridgeExists(env)) throw new Error("backup_bridge_config_missing");
        return;
      }
      if (!configInfo.isFile()) throw new Error("backup_bridge_config_missing");
      const config = validateCronConfig(JSON.parse(await readFile(bridgeConfigPath, "utf8")));
      if (
        config.vars.BACKUP_ID !== state.id ||
        Number(config.vars.BACKUP_EPOCH) !== state.epoch ||
        config.account_id !== env.CLOUDFLARE_ACCOUNT_ID
      )
        throw new Error("backup_bridge_identity_conflict");
      if (await bridgeExists(env)) {
        await runWrangler(
          ["delete", BRIDGE_NAME, "--config", bridgeConfigPath],
          "backup_bridge_delete_failed",
        );
        if (await bridgeExists(env)) throw new Error("backup_bridge_delete_unknown");
      }
      await rm(bridgeConfigPath);
    },
  };
}
