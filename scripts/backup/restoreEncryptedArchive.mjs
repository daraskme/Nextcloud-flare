import { createHash } from "node:crypto";
import { constants, createReadStream } from "node:fs";
import { lstat, mkdir, open, readFile, realpath, rm } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { decryptArchiveFile } from "./encryptedArchive.mjs";
import { restoreGeneration } from "./generation.mjs";

const UUID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;
const SHA256 = /^[a-f0-9]{64}$/;
const SAFE_ID = /^[A-Za-z0-9_-]{1,128}$/;
const ETAG = /^[A-Za-z0-9._-]{1,256}$/;
const TAR_BLOCK = 512;
const MAX_TAR_BYTES = 536_870_912_000;
const MAX_OBJECTS = 100_000;
const MAX_MANIFEST_BYTES = 64 * 1024 * 1024;

function fail(code) {
  throw new Error(code);
}

function exactPath(path) {
  if (typeof path !== "string" || !isAbsolute(path) || resolve(path) !== path)
    fail("backup_restore_path_invalid");
  return path;
}

async function privateParent(path) {
  const parent = resolve(path, "..");
  const info = await lstat(parent);
  if (
    process.platform === "win32" ||
    !info.isDirectory() ||
    info.isSymbolicLink() ||
    (info.mode & 0o077) !== 0 ||
    info.uid !== process.getuid?.() ||
    (await realpath(parent)) !== parent
  )
    fail("backup_restore_private_parent_required");
}

async function createdPrivateDirectory(path) {
  const info = await lstat(path);
  if (
    !info.isDirectory() ||
    info.isSymbolicLink() ||
    (info.mode & 0o077) !== 0 ||
    info.uid !== process.getuid?.() ||
    (await realpath(path)) !== path
  )
    fail("backup_restore_private_directory_required");
}

function memberAllowed(path, id) {
  return (
    path === `downloaded/${id}/manifest.json` ||
    path === `downloaded/${id}/data.sql` ||
    path === "blob-copy/manifest.json" ||
    /^blob-copy\/objects\/[0-9]{8}\.bin$/.test(path)
  );
}

function tarText(bytes) {
  const zero = bytes.indexOf(0);
  const data = zero < 0 ? bytes : bytes.subarray(0, zero);
  if (data.some((byte) => byte < 0x20 || byte > 0x7e)) fail("backup_restore_tar_invalid");
  return Buffer.from(data).toString("ascii");
}

function tarOctal(bytes) {
  const text = tarText(bytes).trim();
  if (!/^[0-7]{1,16}$/.test(text)) fail("backup_restore_tar_invalid");
  const value = Number.parseInt(text, 8);
  if (!Number.isSafeInteger(value)) fail("backup_restore_tar_invalid");
  return value;
}

async function readExactly(handle, offset, length) {
  const buffer = Buffer.alloc(length);
  let read = 0;
  while (read < length) {
    const result = await handle.read(buffer, read, length - read, offset + read);
    if (!result.bytesRead) fail("backup_restore_tar_truncated");
    read += result.bytesRead;
  }
  return buffer;
}

/** Parse only regular ustar members, with fixed names and exact bounds. */
export async function extractArchiveTar(tarFile, destination, id) {
  if (!UUID.test(id)) fail("backup_restore_identity_invalid");
  exactPath(tarFile);
  exactPath(destination);
  await privateParent(destination);
  const source = await lstat(tarFile);
  if (
    !source.isFile() ||
    source.isSymbolicLink() ||
    source.size < 2 * TAR_BLOCK ||
    source.size > MAX_TAR_BYTES ||
    source.size % TAR_BLOCK !== 0 ||
    (await realpath(tarFile)) !== tarFile
  )
    fail("backup_restore_tar_invalid");
  await mkdir(destination, { mode: 0o700 }); // Exclusive: never touch an existing restore tree.
  let success = false;
  let handle;
  try {
    await createdPrivateDirectory(destination);
    handle = await open(tarFile, "r");
    const names = new Set();
    let offset = 0;
    let endSeen = false;
    while (offset < source.size) {
      const header = await readExactly(handle, offset, TAR_BLOCK);
      if (header.every((byte) => byte === 0)) {
        if (offset + 2 * TAR_BLOCK > source.size) fail("backup_restore_tar_truncated");
        const tail = Buffer.alloc(TAR_BLOCK);
        for (let position = offset; position < source.size; position += TAR_BLOCK) {
          const block = await readExactly(handle, position, TAR_BLOCK);
          if (!block.equals(tail)) fail("backup_restore_tar_invalid");
        }
        endSeen = true;
        break;
      }
      const checksum = tarOctal(header.subarray(148, 156));
      let actual = 0;
      for (let index = 0; index < TAR_BLOCK; index++)
        actual += index >= 148 && index < 156 ? 0x20 : header[index];
      const name = tarText(header.subarray(0, 100));
      const prefix = tarText(header.subarray(345, 500));
      const type = header[156];
      const bytes = tarOctal(header.subarray(124, 136));
      if (
        actual !== checksum ||
        (type !== 0 && type !== 0x30) ||
        tarText(header.subarray(257, 263)) !== "ustar" ||
        prefix ||
        !memberAllowed(name, id) ||
        names.has(name) ||
        names.size >= MAX_OBJECTS + 3 ||
        bytes > MAX_TAR_BYTES
      )
        fail("backup_restore_tar_invalid");
      const padded = Math.ceil(bytes / TAR_BLOCK) * TAR_BLOCK;
      if (!Number.isSafeInteger(padded) || offset + TAR_BLOCK + padded > source.size)
        fail("backup_restore_tar_truncated");
      names.add(name);
      const output = join(destination, name);
      const segments = name.split("/");
      let current = destination;
      for (const segment of segments.slice(0, -1)) {
        current = join(current, segment);
        await mkdir(current, { mode: 0o700 }).catch((error) => {
          if (error.code !== "EEXIST") throw error;
        });
      }
      const file = await open(
        output,
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
        0o600,
      );
      try {
        let copied = 0;
        while (copied < bytes) {
          const part = await readExactly(
            handle,
            offset + TAR_BLOCK + copied,
            Math.min(1024 * 1024, bytes - copied),
          );
          let written = 0;
          while (written < part.length) {
            const result = await file.write(part, written, part.length - written);
            if (!result.bytesWritten) fail("backup_restore_write_failed");
            written += result.bytesWritten;
          }
          copied += part.length;
        }
        await file.sync();
      } finally {
        await file.close();
      }
      offset += TAR_BLOCK + padded;
    }
    if (
      !endSeen ||
      !names.has(`downloaded/${id}/manifest.json`) ||
      !names.has(`downloaded/${id}/data.sql`) ||
      !names.has("blob-copy/manifest.json")
    )
      fail("backup_restore_tar_invalid");
    const after = await handle.stat();
    if (after.size !== source.size || after.mtimeMs !== source.mtimeMs || after.ino !== source.ino)
      fail("backup_restore_tar_changed");
    success = true;
    return names;
  } finally {
    await handle?.close();
    if (!success) await rm(destination, { recursive: true, force: true });
  }
}

async function shaFile(path, expectedBytes) {
  const info = await lstat(path);
  if (!info.isFile() || info.isSymbolicLink() || info.size !== expectedBytes)
    fail("backup_restore_blob_mismatch");
  const hash = createHash("sha256");
  let bytes = 0;
  for await (const part of createReadStream(path)) {
    bytes += part.length;
    if (bytes > expectedBytes) fail("backup_restore_blob_mismatch");
    hash.update(part);
  }
  const after = await lstat(path);
  if (bytes !== expectedBytes || after.size !== info.size || after.mtimeMs !== info.mtimeMs)
    fail("backup_restore_blob_mismatch");
  return hash.digest("hex");
}

/** Compare every copied original with the freshly restored SQLite, without R2 access. */
export async function verifyExtractedBlobs({ tree, database, generationManifest, members }) {
  const manifestFile = join(tree, "blob-copy/manifest.json");
  const info = await lstat(manifestFile);
  if (!info.isFile() || info.size > MAX_MANIFEST_BYTES)
    fail("backup_restore_blob_manifest_invalid");
  let manifest;
  try {
    manifest = JSON.parse(await readFile(manifestFile, "utf8"));
  } catch {
    fail("backup_restore_blob_manifest_invalid");
  }
  if (
    !manifest ||
    !Array.isArray(manifest.entries) ||
    manifest.generationId !== generationManifest.generation.id ||
    manifest.epoch !== generationManifest.generation.epoch ||
    manifest.sqlSha256 !== generationManifest.data.sha256 ||
    !Number.isSafeInteger(manifest.objects) ||
    manifest.objects !== manifest.entries.length ||
    manifest.objects > MAX_OBJECTS ||
    !Number.isSafeInteger(manifest.bytes) ||
    manifest.bytes < 0 ||
    !SHA256.test(manifest.aggregateSha256)
  )
    fail("backup_restore_blob_manifest_invalid");
  const db = new DatabaseSync(database, { readOnly: true });
  let rows;
  try {
    rows = db
      .prepare(`SELECT b.id,b.owner_id,b.r2_key,b.size,b.r2_etag,b.sha256_verified,
      s.bytes AS storage_bytes,s.r2_etag AS storage_etag,s.removed_at
      FROM blobs b LEFT JOIN blob_storage s ON s.blob_id=b.id
      WHERE b.state IN ('committed','gc_candidate') ORDER BY b.id`)
      .all();
  } finally {
    db.close();
  }
  if (rows.length !== manifest.objects) fail("backup_restore_blob_mismatch");
  const aggregate = createHash("sha256");
  let total = 0;
  for (const [index, row] of rows.entries()) {
    const entry = manifest.entries[index];
    const file = `objects/${String(index).padStart(8, "0")}.bin`;
    const member = `blob-copy/${file}`;
    if (
      !SAFE_ID.test(row.id) ||
      !SAFE_ID.test(row.owner_id) ||
      row.r2_key !== `u/${row.owner_id}/b/${row.id}` ||
      !Number.isSafeInteger(row.size) ||
      row.size < 0 ||
      row.storage_bytes !== row.size ||
      row.storage_etag !== row.r2_etag ||
      row.removed_at !== null ||
      !ETAG.test(row.r2_etag) ||
      !entry ||
      entry.key !== row.r2_key ||
      entry.file !== file ||
      entry.bytes !== row.size ||
      entry.r2Etag !== row.r2_etag ||
      !SHA256.test(entry.sha256) ||
      (row.sha256_verified !== null && entry.sha256 !== row.sha256_verified) ||
      !members.has(member)
    )
      fail("backup_restore_blob_mismatch");
    if ((await shaFile(join(tree, member), row.size)) !== entry.sha256)
      fail("backup_restore_blob_mismatch");
    aggregate.update(`${entry.key}\0${entry.bytes}\0${entry.r2Etag}\0${entry.sha256}\n`);
    total += row.size;
    if (!Number.isSafeInteger(total) || total > MAX_TAR_BYTES) fail("backup_restore_blob_mismatch");
  }
  if (
    manifest.bytes !== total ||
    manifest.aggregateSha256 !== aggregate.digest("hex") ||
    [...members].filter((name) => name.startsWith("blob-copy/objects/")).length !== rows.length
  )
    fail("backup_restore_blob_mismatch");
  return { objects: rows.length, bytes: total, aggregateSha256: manifest.aggregateSha256 };
}

/** Offline only: decrypt a pinned archive, reconstruct SQLite, then hash all included originals. */
export async function restoreEncryptedArchive({
  cipherFile,
  recoveryFile,
  accountId,
  expectedCipherSha256,
  generationId,
  destination,
}) {
  if (!UUID.test(generationId ?? "") || !SHA256.test(expectedCipherSha256 ?? ""))
    fail("backup_restore_identity_invalid");
  exactPath(destination);
  await privateParent(destination);
  await mkdir(destination, { mode: 0o700 });
  let success = false;
  try {
    await createdPrivateDirectory(destination);
    const tarFile = join(destination, "backup.tar");
    const decrypted = await decryptArchiveFile({
      cipherFile,
      recoveryFile,
      accountId,
      expectedCipherSha256,
      outputFile: tarFile,
    });
    const tree = join(destination, "extracted");
    const members = await extractArchiveTar(tarFile, tree, generationId);
    const generation = join(tree, "downloaded", generationId);
    const database = join(destination, "restored.sqlite");
    const restored = await restoreGeneration({ directory: generation, target: database });
    if (restored.manifest.generation.id !== generationId) fail("backup_restore_identity_invalid");
    const blob = await verifyExtractedBlobs({
      tree,
      database,
      generationManifest: restored.manifest,
      members,
    });
    success = true;
    return {
      generationId,
      epoch: restored.manifest.generation.epoch,
      cipherSha256: expectedCipherSha256,
      plainSha256: decrypted.plainSha256,
      ...blob,
      database,
      extracted: tree,
    };
  } finally {
    // Only a directory created exclusively by this call may be removed on failure.
    if (!success) await rm(destination, { recursive: true, force: true });
  }
}

function cliArguments(args) {
  if (args.length !== 12) fail("backup_restore_usage");
  const values = new Map();
  for (let index = 0; index < args.length; index += 2) {
    const name = args[index];
    if (
      !/^(--cipher|--recovery|--account|--expected-cipher-sha256|--generation|--destination)$/.test(
        name,
      ) ||
      values.has(name)
    )
      fail("backup_restore_usage");
    values.set(name, args[index + 1]);
  }
  if (values.size !== 6 || [...values.values()].some((value) => !value))
    fail("backup_restore_usage");
  return values;
}

export async function runRestoreEncryptedArchiveCli(args, logger = console) {
  try {
    const options = cliArguments(args);
    const result = await restoreEncryptedArchive({
      cipherFile: options.get("--cipher"),
      recoveryFile: options.get("--recovery"),
      accountId: options.get("--account"),
      expectedCipherSha256: options.get("--expected-cipher-sha256"),
      generationId: options.get("--generation"),
      destination: options.get("--destination"),
    });
    logger.log(
      JSON.stringify({
        verified: true,
        generationId: result.generationId,
        epoch: result.epoch,
        objects: result.objects,
        bytes: result.bytes,
        aggregateSha256: result.aggregateSha256,
      }),
    );
    return 0;
  } catch (error) {
    const code =
      error instanceof Error && /^backup_[a-z_]+$/.test(error.message)
        ? error.message
        : "backup_restore_failed";
    logger.error(JSON.stringify({ verified: false, error: code }));
    return 1;
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1]))
  process.exitCode = await runRestoreEncryptedArchiveCli(process.argv.slice(2));
