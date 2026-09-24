import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { lstat, mkdir, mkdtemp, open, rename, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { verifyGeneration } from "./generation.mjs";
import {
  CHUNK_BYTES,
  digest,
  generationId,
  MAX_MANIFEST_BYTES,
  MAX_PARTS,
  manifestKey,
  partKey,
} from "./objectStore.mjs";

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value !== null && typeof value === "object")
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, canonical(value[key])]),
    );
  return value;
}
export const encode = (value) => Buffer.from(JSON.stringify(canonical(value)));
function manifestShape(manifest) {
  assert.deepEqual(
    Object.keys(manifest).sort(),
    ["capturedAt", "data", "format", "generation", "schema", "tables", "version"],
    "backup_invalid_manifest",
  );
  assert.deepEqual(
    Object.keys(manifest.schema).sort(),
    ["migrations", "sha256"],
    "backup_invalid_manifest",
  );
  if (
    !Number.isSafeInteger(manifest.data.bytes) ||
    manifest.data.bytes < 1 ||
    manifest.data.bytes > CHUNK_BYTES * MAX_PARTS
  )
    throw new Error("backup_export_size");
}
export async function* fileChunks(handle, size, chunkSize = CHUNK_BYTES) {
  if (!Number.isSafeInteger(chunkSize) || chunkSize < 1 || chunkSize > CHUNK_BYTES)
    throw new Error("backup_invalid_part");
  let offset = 0;
  while (offset < size) {
    const chunk = Buffer.alloc(Math.min(chunkSize, size - offset));
    let filled = 0;
    while (filled < chunk.length) {
      const { bytesRead } = await handle.read(
        chunk,
        filled,
        chunk.length - filled,
        offset + filled,
      );
      if (!bytesRead) throw new Error("backup_file_changed");
      filled += bytesRead;
    }
    yield chunk;
    offset += chunk.length;
  }
}
export async function ensureObject(store, key, bytes) {
  const existing = await store.get(key, bytes.length);
  if (existing !== null) {
    if (!Buffer.from(existing).equals(bytes)) throw new Error("backup_object_conflict");
    return;
  }
  try {
    await store.put(key, bytes);
  } catch {
    /* A lost ACK can only be reconciled by the exact object. */
  }
  const observed = await store.get(key, bytes.length);
  if (observed === null) throw new Error("backup_store_write_unknown");
  if (!Buffer.from(observed).equals(bytes)) throw new Error("backup_object_conflict");
}

/** The manifest is committed only after every immutable part and the whole SQL hash are verified. */
export async function publishGeneration({ directory, store, progress = () => {} }) {
  const manifest = await verifyGeneration(directory);
  manifestShape(manifest);
  const id = generationId(manifest.generation.id),
    key = manifestKey(id);
  const existing = await store.get(key, MAX_MANIFEST_BYTES);
  if (existing !== null) {
    const saved = readPublication(existing, id);
    if (!encode(saved.manifest).equals(encode(manifest))) throw new Error("backup_object_conflict");
  }
  const handle = await open(join(directory, "data.sql"), "r");
  try {
    const before = await handle.stat();
    if (!before.isFile() || before.size !== manifest.data.bytes)
      throw new Error("backup_file_changed");
    const parts = [],
      hash = createHash("sha256");
    for await (const bytes of fileChunks(handle, before.size)) {
      hash.update(bytes);
      const part = { bytes: bytes.length, sha256: digest(bytes) };
      await ensureObject(store, partKey(id, parts.length, part.sha256), bytes);
      parts.push(part);
      progress({ stage: "part_verified", parts: parts.length });
    }
    const after = await handle.stat();
    if (
      after.size !== before.size ||
      after.mtimeMs !== before.mtimeMs ||
      hash.digest("hex") !== manifest.data.sha256
    )
      throw new Error("backup_file_changed");
    const publication = {
      format: "nextcloud-flare.r2-backup",
      version: 1,
      chunkBytes: CHUNK_BYTES,
      manifest,
      parts,
    };
    const bytes = encode(publication);
    if (bytes.length > MAX_MANIFEST_BYTES) throw new Error("backup_manifest_size");
    await ensureObject(store, key, bytes);
    return { id, manifest, key, sha256: digest(bytes), bytes: bytes.length, parts: parts.length };
  } finally {
    await handle.close();
  }
}
function readPublication(bytes, id) {
  let result;
  try {
    result = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    throw new Error("backup_invalid_publication");
  }
  if (
    result?.format !== "nextcloud-flare.r2-backup" ||
    result.version !== 1 ||
    result.chunkBytes !== CHUNK_BYTES ||
    result.manifest?.generation?.id !== id ||
    !Array.isArray(result.parts) ||
    result.parts.length < 1 ||
    result.parts.length > MAX_PARTS
  )
    throw new Error("backup_invalid_publication");
  assert.deepEqual(
    Object.keys(result).sort(),
    ["chunkBytes", "format", "manifest", "parts", "version"],
    "backup_invalid_publication",
  );
  manifestShape(result.manifest);
  let total = 0;
  for (const [index, part] of result.parts.entries()) {
    if (
      part === null ||
      typeof part !== "object" ||
      Object.keys(part).sort().join(",") !== "bytes,sha256" ||
      !Number.isSafeInteger(part.bytes) ||
      part.bytes < 1 ||
      part.bytes > CHUNK_BYTES ||
      (index < result.parts.length - 1 && part.bytes !== CHUNK_BYTES) ||
      !/^[a-f0-9]{64}$/.test(part.sha256)
    )
      throw new Error("backup_invalid_part");
    total += part.bytes;
  }
  if (total !== result.manifest.data.bytes) throw new Error("backup_export_size");
  return result;
}
async function absent(path) {
  try {
    await lstat(path);
  } catch (error) {
    if (error.code === "ENOENT") return;
    throw error;
  }
  throw new Error("backup_destination_exists");
}
/** Download into a new local generation and run the same offline restore gate before publishing it locally. */
export async function downloadGeneration({
  directory,
  id,
  store,
  expectedSha256,
  progress = () => {},
}) {
  generationId(id);
  if (expectedSha256 !== undefined && !/^[a-f0-9]{64}$/.test(expectedSha256))
    throw new Error("backup_invalid_manifest_hash");
  const bytes = await store.get(manifestKey(id), MAX_MANIFEST_BYTES);
  if (bytes === null) throw new Error("backup_generation_missing");
  if (expectedSha256 !== undefined && digest(bytes) !== expectedSha256)
    throw new Error("backup_publication_hash_mismatch");
  const publication = readPublication(bytes, id);
  const root = resolve(directory),
    target = join(root, id);
  await mkdir(root, { recursive: true, mode: 0o700 });
  const lockPath = join(root, `${id}.lock`),
    lock = await open(lockPath, "wx", 0o600);
  let temporary, handle;
  try {
    await absent(target);
    temporary = await mkdtemp(join(root, `.${id}-`));
    handle = await open(join(temporary, "data.sql"), "wx", 0o600);
    for (const [index, part] of publication.parts.entries()) {
      const value = await store.get(partKey(id, index, part.sha256), part.bytes);
      if (value === null || value.length !== part.bytes || digest(value) !== part.sha256)
        throw new Error("backup_part_mismatch");
      await handle.writeFile(value);
      progress({ stage: "part_downloaded", parts: index + 1 });
    }
    await handle.sync();
    await handle.close();
    handle = null;
    await writeFile(
      join(temporary, "manifest.json"),
      JSON.stringify(publication.manifest, null, 2) + "\n",
      { flag: "wx", mode: 0o600 },
    );
    const manifest = await verifyGeneration(temporary);
    await absent(target);
    await rename(temporary, target);
    temporary = null;
    return { directory: target, manifest, key: manifestKey(id), sha256: digest(bytes) };
  } finally {
    await handle?.close();
    if (temporary) await rm(temporary, { recursive: true, force: true });
    await lock.close();
    await rm(lockPath);
  }
}
