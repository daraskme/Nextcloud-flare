import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { constants, createReadStream } from "node:fs";
import { lstat, mkdir, open, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { verifyGeneration } from "./generation.mjs";
import {
  barrier,
  barrierQuery,
  schemaDigest,
  schemaQuery,
  schemaTables,
  specs,
  tableDigests,
} from "./snapshot.mjs";

const require = createRequire(new URL("../../packages/worker/package.json", import.meta.url));
const { AwsClient } = require("aws4fetch");
const SAFE_ID = /^[A-Za-z0-9_-]{1,128}$/;
const SHA256 = /^[a-f0-9]{64}$/;
const ETAG = /^[A-Za-z0-9._-]{1,256}$/;

function fail(code) {
  throw new Error(code);
}
function objectKey(row) {
  if (
    typeof row.id !== "string" ||
    typeof row.owner_id !== "string" ||
    !SAFE_ID.test(row.id) ||
    !SAFE_ID.test(row.owner_id) ||
    row.r2_key !== `u/${row.owner_id}/b/${row.id}` ||
    Buffer.byteLength(row.r2_key) > 1024
  )
    fail("backup_blob_key_mismatch");
  return row.r2_key;
}
function etag(value) {
  if (typeof value !== "string" || !ETAG.test(value)) fail("backup_blob_etag_mismatch");
  return value;
}
function validateRow(row) {
  objectKey(row);
  if (
    !Number.isSafeInteger(row.size) ||
    row.size < 0 ||
    row.bytes !== row.size ||
    row.removed_at !== null ||
    row.r2_etag !== row.storage_etag
  )
    fail("backup_blob_storage_mismatch");
  etag(row.r2_etag);
  if (row.sha256_verified !== null && !SHA256.test(row.sha256_verified))
    fail("backup_blob_digest_mismatch");
}
function headerEtag(value) {
  if (typeof value !== "string" || !value.startsWith('"') || !value.endsWith('"'))
    fail("backup_blob_etag_mismatch");
  return etag(value.slice(1, -1));
}

/** Fixed bucket and read-only GET transport using the staging inventory credentials. */
export class S3BlobSource {
  constructor(env, { fetch: transport = fetch, timeoutMs = 120000 } = {}) {
    const account = env.R2_INVENTORY_ACCOUNT_ID;
    const bucket = env.R2_INVENTORY_BUCKET;
    const jurisdiction = env.R2_INVENTORY_JURISDICTION ?? "default";
    const accessKeyId = env.R2_INVENTORY_ACCESS_KEY_ID;
    const secretAccessKey = env.R2_INVENTORY_SECRET_ACCESS_KEY;
    if (
      !/^[a-f0-9]{32}$/.test(account ?? "") ||
      !/^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/.test(bucket ?? "") ||
      !["default", "eu", "us", "fedramp"].includes(jurisdiction) ||
      !/^[A-Za-z0-9_-]{16,128}$/.test(accessKeyId ?? "") ||
      !/^[A-Za-z0-9+/=_-]{32,128}$/.test(secretAccessKey ?? "") ||
      !Number.isSafeInteger(timeoutMs) ||
      timeoutMs < 1 ||
      timeoutMs > 120000
    )
      fail("backup_blob_source_unconfigured");
    this.endpoint = `https://${account}${jurisdiction === "default" ? "" : `.${jurisdiction}`}.r2.cloudflarestorage.com/${bucket}/`;
    this.signer = new AwsClient({
      accessKeyId,
      secretAccessKey,
      region: "auto",
      service: "s3",
      retries: 0,
    });
    this.transport = transport;
    this.timeoutMs = timeoutMs;
  }

  async get(key, expectedEtag, signal) {
    // Parse and reconstruct the only key shape that the restored DB is allowed to name.
    const match = /^u\/([A-Za-z0-9_-]{1,128})\/b\/([A-Za-z0-9_-]{1,128})$/.exec(key);
    if (!match || key !== `u/${match[1]}/b/${match[2]}`) fail("backup_blob_key_mismatch");
    etag(expectedEtag);
    try {
      const signed = await this.signer.sign(this.endpoint + key, {
        method: "GET",
        headers: { "If-Match": `"${expectedEtag}"` },
        redirect: "manual",
        signal,
      });
      if (signal.aborted) fail("backup_blob_timeout");
      return await this.transport(signed);
    } catch (error) {
      if (signal.aborted) fail("backup_blob_timeout");
      if (error instanceof Error && /^backup_blob_[a-z_]+$/.test(error.message)) throw error;
      fail("backup_blob_source_unavailable");
    }
  }
}

async function copyObject(source, row, path) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), source.timeoutMs ?? 120000);
  let response;
  let handle;
  try {
    response = await source.get(row.r2_key, row.r2_etag, controller.signal);
    if (controller.signal.aborted) fail("backup_blob_timeout");
    if (response.redirected || response.status !== 200 || !response.body)
      fail("backup_blob_source_unavailable");
    if (headerEtag(response.headers.get("ETag")) !== row.r2_etag) fail("backup_blob_etag_mismatch");
    const declared = response.headers.get("Content-Length");
    if (declared !== null && (!/^(0|[1-9][0-9]*)$/.test(declared) || Number(declared) !== row.size))
      fail("backup_blob_size_mismatch");
    handle = await open(
      path,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      0o600,
    );
    const reader = response.body.getReader();
    const hash = createHash("sha256");
    let bytes = 0;
    try {
      while (true) {
        const next = await reader.read();
        if (controller.signal.aborted) fail("backup_blob_timeout");
        if (next.done) break;
        bytes += next.value.byteLength;
        if (bytes > row.size) fail("backup_blob_size_mismatch");
        hash.update(next.value);
        let offset = 0;
        while (offset < next.value.byteLength) {
          const { bytesWritten } = await handle.write(
            next.value,
            offset,
            next.value.byteLength - offset,
          );
          if (!bytesWritten) fail("backup_blob_write_failed");
          offset += bytesWritten;
        }
      }
    } finally {
      if (controller.signal.aborted) void reader.cancel().catch(() => {});
      reader.releaseLock();
    }
    if (bytes !== row.size) fail("backup_blob_size_mismatch");
    const sha256 = hash.digest("hex");
    if (row.sha256_verified !== null && sha256 !== row.sha256_verified)
      fail("backup_blob_digest_mismatch");
    await handle.sync();
    await handle.close();
    handle = null;
    const saved = createHash("sha256");
    let savedBytes = 0;
    for await (const chunk of createReadStream(path)) {
      saved.update(chunk);
      savedBytes += chunk.length;
      if (savedBytes > row.size) fail("backup_blob_size_mismatch");
    }
    if (savedBytes !== bytes || saved.digest("hex") !== sha256) fail("backup_blob_digest_mismatch");
    return { bytes, sha256 };
  } catch (error) {
    if (controller.signal.aborted) fail("backup_blob_timeout");
    if (error instanceof Error && /^backup_blob_[a-z_]+$/.test(error.message)) throw error;
    fail("backup_blob_source_unavailable");
  } finally {
    clearTimeout(timer);
    void response?.body?.cancel().catch(() => {});
    await handle?.close();
  }
}

/** Verify a canonical offline restore, then copy only its live original blobs to a new private directory. */
export async function auditRestoredBlobBytes({
  generation,
  database,
  directory,
  source,
  maxObjects,
  maxBytes,
}) {
  if (
    !Number.isSafeInteger(maxObjects) ||
    maxObjects < 1 ||
    !Number.isSafeInteger(maxBytes) ||
    maxBytes < 1 ||
    !source ||
    typeof source.get !== "function"
  )
    fail("backup_blob_invalid_limit");
  const manifest = await verifyGeneration(generation);
  const dbPath = resolve(database);
  const info = await lstat(dbPath);
  if (!info.isFile() || (info.mode & 0o077) !== 0) fail("backup_blob_database_not_private");
  const db = new DatabaseSync(dbPath, { readOnly: true });
  let rows;
  try {
    db.exec("BEGIN");
    assert.equal(schemaDigest(db.prepare(schemaQuery).all()), manifest.schema.sha256);
    assert.deepEqual(
      barrier(db.prepare(barrierQuery).all(), manifest.generation.id, manifest.generation.epoch),
      manifest.generation,
    );
    assert.deepEqual(
      await tableDigests(specs(db, schemaTables(db)), async (sql) => db.prepare(sql).all()),
      manifest.tables,
    );
    const count = db
      .prepare(`SELECT COUNT(*) AS objects,COALESCE(SUM(size),0) AS bytes
      FROM blobs WHERE state IN ('committed','gc_candidate')`)
      .get();
    if (
      !Number.isSafeInteger(count.objects) ||
      !Number.isSafeInteger(count.bytes) ||
      count.objects > maxObjects ||
      count.bytes > maxBytes
    )
      fail("backup_blob_limit_exceeded");
    rows = db
      .prepare(`SELECT b.id,b.owner_id,b.r2_key,b.size,b.r2_etag,b.sha256_verified,
        s.bytes,s.r2_etag AS storage_etag,s.removed_at
      FROM blobs b LEFT JOIN blob_storage s ON s.blob_id=b.id
      WHERE b.state IN ('committed','gc_candidate') ORDER BY b.id`)
      .all();
  } catch (error) {
    if (error instanceof Error && error.message === "backup_blob_limit_exceeded") throw error;
    fail("backup_blob_database_mismatch");
  } finally {
    db.close();
  }
  let total = 0;
  if (rows.length > maxObjects) fail("backup_blob_limit_exceeded");
  for (const row of rows) {
    validateRow(row);
    total += row.size;
    if (!Number.isSafeInteger(total) || total > maxBytes) fail("backup_blob_limit_exceeded");
  }

  const target = resolve(directory);
  await mkdir(target, { mode: 0o700 });
  let success = false;
  try {
    const objectsDir = join(target, "objects");
    await mkdir(objectsDir, { mode: 0o700 });
    const entries = [];
    const aggregate = createHash("sha256");
    for (const [index, row] of rows.entries()) {
      const file = `${String(index).padStart(8, "0")}.bin`;
      const observed = await copyObject(source, row, join(objectsDir, file));
      const entry = {
        key: row.r2_key,
        file: `objects/${file}`,
        bytes: observed.bytes,
        r2Etag: row.r2_etag,
        sha256: observed.sha256,
      };
      entries.push(entry);
      aggregate.update(`${entry.key}\0${entry.bytes}\0${entry.r2Etag}\0${entry.sha256}\n`);
    }
    const summary = {
      generationId: manifest.generation.id,
      epoch: manifest.generation.epoch,
      sqlSha256: manifest.data.sha256,
      objects: entries.length,
      bytes: total,
      aggregateSha256: aggregate.digest("hex"),
    };
    await writeFile(
      join(target, "manifest.json"),
      JSON.stringify({ ...summary, entries }, null, 2) + "\n",
      { flag: "wx", mode: 0o600 },
    );
    success = true;
    return summary;
  } finally {
    if (!success) await rm(target, { recursive: true, force: true });
  }
}
