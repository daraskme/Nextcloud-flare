import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";

import {
  BACKUP_CHUNK_BYTES,
  BACKUP_MANIFEST_BYTES,
  BACKUP_MAX_PARTS,
  backupManifestKey,
  backupPartKey,
} from "../../packages/shared/src/backupPublication.ts";

const require = createRequire(new URL("../../packages/worker/package.json", import.meta.url));
const { AwsClient } = require("aws4fetch");
export const CHUNK_BYTES = BACKUP_CHUNK_BYTES;
export const MAX_PARTS = BACKUP_MAX_PARTS;
export const MAX_MANIFEST_BYTES = BACKUP_MANIFEST_BYTES;
export const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
export function generationId(id) {
  if (typeof id !== "string" || !/^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(id))
    throw new Error("backup_invalid_generation");
  return id;
}
export const manifestKey = backupManifestKey;
export const partKey = backupPartKey;
export function validateKey(key) {
  if (
    typeof key !== "string" ||
    !/^sys\/backups\/v1\/[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}\/(?:manifest\.json|parts\/\d{6}-[0-9a-f]{64}\.bin)$/.test(
      key,
    )
  )
    throw new Error("backup_invalid_object_key");
  const part = /\/parts\/(\d{6})-/.exec(key);
  if (part && Number(part[1]) >= MAX_PARTS) throw new Error("backup_invalid_object_key");
}
function validatePayload(key, bytes) {
  validateKey(key);
  const limit = key.endsWith("/manifest.json") ? MAX_MANIFEST_BYTES : CHUNK_BYTES;
  if (!(bytes instanceof Uint8Array) || bytes.byteLength < 1 || bytes.byteLength > limit)
    throw new Error("backup_object_size");
}
function byteLimit(value) {
  if (!Number.isSafeInteger(value) || value < 1 || value > MAX_MANIFEST_BYTES)
    throw new Error("backup_invalid_object_limit");
}
async function boundedBody(body, length, limit, signal) {
  byteLimit(limit);
  if (!body || (length !== null && (!/^\d+$/.test(String(length)) || Number(length) > limit))) {
    void body?.cancel().catch(() => {});
    throw new Error("backup_object_size");
  }
  const reader = body.getReader(),
    chunks = [];
  const cancel = () => {
    void reader.cancel().catch(() => {});
  };
  signal.addEventListener("abort", cancel, { once: true });
  let size = 0;
  try {
    while (true) {
      const result = await reader.read();
      if (signal.aborted) throw new Error("backup_store_timeout");
      if (result.done) break;
      size += result.value.byteLength;
      if (size > limit) {
        cancel();
        throw new Error("backup_object_size");
      }
      chunks.push(Buffer.from(result.value));
    }
    if (length !== null && size !== Number(length)) throw new Error("backup_object_size");
    return Buffer.concat(chunks, size);
  } finally {
    signal.removeEventListener("abort", cancel);
    reader.releaseLock();
  }
}
async function deadline(run, timeoutMs) {
  const controller = new AbortController();
  let timer;
  const expired = new Promise((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new Error("backup_store_timeout"));
    }, timeoutMs);
  });
  try {
    return await Promise.race([run(controller.signal), expired]);
  } catch (error) {
    const code =
      error instanceof Error &&
      /^backup_(?:store_(?:timeout|http_\d{3})|object_size)$/.test(error.message)
        ? error.message
        : "backup_store_unavailable";
    throw new Error(code);
  } finally {
    clearTimeout(timer);
  }
}

/** A fixed private R2 endpoint, only GET and conditional PUT under sys/backups/v1. No retries or deletes. */
export class S3BackupStore {
  constructor(env, { fetch: transport = fetch, timeoutMs = 60000 } = {}) {
    const account = env.R2_BACKUP_ACCOUNT_ID,
      bucket = env.R2_BACKUP_BUCKET;
    const jurisdiction = env.R2_BACKUP_JURISDICTION ?? "default";
    const accessKeyId = env.R2_BACKUP_ACCESS_KEY_ID,
      secretAccessKey = env.R2_BACKUP_SECRET_ACCESS_KEY;
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
      throw new Error("backup_store_unconfigured");
    this.source = Object.freeze({ account, bucket, jurisdiction });
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
  async #request(method, key, bytes, limit) {
    validateKey(key);
    byteLimit(limit);
    if (method !== "GET" && method !== "PUT") throw new Error("backup_invalid_object_method");
    return deadline(async (signal) => {
      const headers = bytes
        ? {
            "If-None-Match": "*",
            "Content-Type": "application/octet-stream",
            "Content-Length": String(bytes.length),
            "Content-MD5": createHash("md5").update(bytes).digest("base64"),
            "x-amz-content-sha256": digest(bytes),
          }
        : {};
      const request = await this.signer.sign(this.endpoint + key, {
        method,
        headers,
        ...(bytes ? { body: bytes } : {}),
        signal,
        redirect: "manual",
      });
      if (signal.aborted) throw new Error("backup_store_timeout");
      const response = await this.transport(request);
      if (signal.aborted || response.redirected || response.status !== 200) {
        void response.body?.cancel().catch(() => {});
        if (signal.aborted) throw new Error("backup_store_timeout");
        if (!response.redirected && method === "GET" && response.status === 404) return null;
        if (!response.redirected && method === "PUT" && response.status === 412) return false;
        throw new Error(`backup_store_http_${response.status}`);
      }
      if (method === "PUT") {
        void response.body?.cancel().catch(() => {});
        return true;
      }
      return boundedBody(response.body, response.headers.get("Content-Length"), limit, signal);
    }, this.timeoutMs);
  }
  get(key, limit) {
    return this.#request("GET", key, null, limit);
  }
  put(key, bytes) {
    validatePayload(key, bytes);
    return this.#request("PUT", key, bytes, MAX_MANIFEST_BYTES);
  }
  async dispose() {}
}

/** Local Wrangler R2 binding only. remoteBindings:false is mandatory even if the config opts into remote. */
export async function localBackupStore(configPath, environment) {
  const { getPlatformProxy } = await import("wrangler");
  const proxy = await getPlatformProxy({
    configPath: resolve(configPath),
    ...(environment ? { environment } : {}),
    // getPlatformProxy's default resolves against cwd; Wrangler dev/export use the config directory.
    persist: { path: join(dirname(resolve(configPath)), ".wrangler/state/v3") },
    remoteBindings: false,
    envFiles: [],
  });
  const bucket = proxy.env.BACKUPS;
  if (!bucket || typeof bucket.put !== "function" || typeof bucket.get !== "function") {
    await proxy.dispose();
    throw new Error("backup_store_unconfigured");
  }
  return {
    get: async (key, limit) => {
      validateKey(key);
      byteLimit(limit);
      return deadline(async (signal) => {
        const object = await bucket.get(key);
        if (signal.aborted) {
          void object?.body?.cancel().catch(() => {});
          throw new Error("backup_store_timeout");
        }
        return object === null ? null : boundedBody(object.body, object.size, limit, signal);
      }, 60000);
    },
    put: async (key, bytes) => {
      validatePayload(key, bytes);
      return deadline(
        async () =>
          (await bucket.put(key, bytes, {
            onlyIf: new Headers({ "If-None-Match": "*" }),
            httpMetadata: { contentType: "application/octet-stream" },
          })) !== null,
        60000,
      );
    },
    dispose: () => proxy.dispose(),
  };
}
