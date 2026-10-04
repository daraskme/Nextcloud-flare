import { execFile as execute } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { constants, createReadStream } from "node:fs";
import {
  chmod,
  copyFile,
  link,
  lstat,
  mkdir,
  open,
  readdir,
  readFile,
  realpath,
  rename,
  rm,
  unlink,
} from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";
import { promisify } from "node:util";
import {
  archiveMemberAllowed,
  archiveTarArguments,
  archiveTarBytes,
  MAX_OBJECTS,
  MAX_TAR_BYTES,
} from "../../scripts/backup/archiveFormat.mjs";
import {
  encryptArchiveFile,
  validateArchivePlainSize,
} from "../../scripts/backup/encryptedArchive.mjs";
import { restoreGeneration } from "../../scripts/backup/generation.mjs";
import { CHUNK_BYTES, digest } from "../../scripts/backup/objectStore.mjs";
import { encode, fileChunks } from "../../scripts/backup/publication.mjs";
import { verifyExtractedBlobs } from "../../scripts/backup/restoreEncryptedArchive.mjs";

const execFile = promisify(execute);
const ID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
const HASH = /^[a-f0-9]{64}$/;
const MAGIC = Buffer.from([78, 67, 70, 69, 78, 67, 49, 0]);
const activeArchives = new Set();
const fail = (code) => {
  throw new Error(code);
};

export function checkMountRecord(record, mountPoint, volumeUuid) {
  const mounts = record?.filesystems;
  if (
    !Array.isArray(mounts) ||
    mounts.length !== 1 ||
    mounts[0].target !== mountPoint ||
    String(mounts[0].uuid).toUpperCase() !== volumeUuid.toUpperCase()
  )
    fail("backup_volume_unavailable");
  const options = String(mounts[0].options).split(",");
  if (options.includes("ro") || !options.includes("rw")) fail("backup_volume_read_only");
}

export async function verifyMountedStorage(
  { mountPoint, volumeUuid, backupRoot },
  { command = execFile } = {},
) {
  if (
    !mountPoint ||
    resolve(mountPoint) !== mountPoint ||
    !volumeUuid ||
    resolve(backupRoot) !== backupRoot ||
    !backupRoot.startsWith(mountPoint + sep)
  )
    fail("backup_volume_configuration");
  let record;
  try {
    const result = await command(
      "findmnt",
      ["--json", "--target", mountPoint, "--output", "TARGET,UUID,OPTIONS"],
      { timeout: 10_000, maxBuffer: 16_384 },
    );
    record = JSON.parse(result.stdout);
  } catch {
    fail("backup_volume_unavailable");
  }
  checkMountRecord(record, mountPoint, volumeUuid);
  // Never create the mount point or silently save onto the internal root filesystem.
  try {
    const info = await lstat(backupRoot);
    if (!info.isDirectory() || info.isSymbolicLink() || (await realpath(backupRoot)) !== backupRoot)
      fail("backup_volume_unavailable");
  } catch {
    fail("backup_volume_unavailable");
  }
  const probe = join(backupRoot, `.ncf-probe-${randomUUID()}`);
  let owned = false;
  try {
    const handle = await open(
      probe,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      0o600,
    );
    owned = true;
    try {
      await handle.writeFile("ncf-storage-probe\n");
      await handle.sync();
    } finally {
      await handle.close();
    }
    if ((await readFile(probe, "utf8")) !== "ncf-storage-probe\n")
      fail("backup_volume_write_failed");
  } catch {
    fail("backup_volume_write_failed");
  } finally {
    if (owned) await unlink(probe);
  }
}

export async function fileDigest(path, { ciphertext = false } = {}) {
  const info = await lstat(path);
  if (!info.isFile() || info.isSymbolicLink()) fail("backup_archive_not_file");
  const hash = createHash("sha256");
  let bytes = 0;
  let first = true;
  for await (const chunk of createReadStream(path)) {
    if (first && ciphertext && (chunk.length < 12 || !chunk.subarray(0, 8).equals(MAGIC)))
      fail("backup_archive_not_ciphertext");
    first = false;
    bytes += chunk.length;
    hash.update(chunk);
  }
  const after = await lstat(path);
  if (
    bytes !== info.size ||
    after.size !== info.size ||
    after.mtimeMs !== info.mtimeMs ||
    after.ctimeMs !== info.ctimeMs ||
    after.dev !== info.dev ||
    after.ino !== info.ino ||
    (ciphertext && bytes < 12)
  )
    fail("backup_archive_changed");
  return { bytes, sha256: hash.digest("hex") };
}

async function privateDirectory(path) {
  const info = await lstat(path);
  if (
    !info.isDirectory() ||
    info.isSymbolicLink() ||
    (info.mode & 0o077) !== 0 ||
    (await realpath(path)) !== resolve(path)
  )
    fail("backup_archive_private_directory");
}

/** Check current storage, not a historical success receipt. Cache only an unchanged daily digest. */
export async function verifyPublishedArchive(
  configuration,
  state,
  { command = execFile, previous, now = new Date() } = {},
) {
  if (
    !ID.test(state?.id ?? "") ||
    !HASH.test(state?.archiveSha256 ?? "") ||
    !Number.isSafeInteger(state?.archiveBytes) ||
    state.archiveBytes < 12
  )
    fail("backup_archive_receipt_invalid");
  await verifyMountedStorage(configuration, { command });
  const path = join(configuration.backupRoot, `backup-${state.id}.ncf`);
  let info;
  try {
    info = await lstat(path);
  } catch (error) {
    if (error.code === "ENOENT") fail("backup_archive_missing");
    fail("backup_archive_unavailable");
  }
  if (!info.isFile() || info.isSymbolicLink() || info.size !== state.archiveBytes)
    fail("backup_archive_mismatch");
  const signature = [info.dev, info.ino, info.size, info.mtimeMs, info.ctimeMs];
  const verifiedAt = Date.parse(previous?.digestVerifiedAt);
  const cached =
    previous?.id === state.id &&
    previous?.sha256 === state.archiveSha256 &&
    previous?.bytes === state.archiveBytes &&
    JSON.stringify(previous?.signature) === JSON.stringify(signature) &&
    Number.isFinite(verifiedAt) &&
    verifiedAt <= now.getTime() &&
    now.getTime() - verifiedAt < 86_400_000;
  if (!cached) {
    let actual;
    try {
      actual = await fileDigest(path, { ciphertext: true });
    } catch (error) {
      if (error.code === "ENOENT") fail("backup_archive_missing");
      if (
        [
          "backup_archive_not_file",
          "backup_archive_not_ciphertext",
          "backup_archive_changed",
        ].includes(error.message)
      )
        fail("backup_archive_mismatch");
      fail("backup_archive_unavailable");
    }
    if (actual.bytes !== state.archiveBytes || actual.sha256 !== state.archiveSha256)
      fail("backup_archive_mismatch");
  }
  return {
    id: state.id,
    bytes: state.archiveBytes,
    sha256: state.archiveSha256,
    signature,
    digestVerifiedAt: cached ? previous.digestVerifiedAt : now.toISOString(),
    verified: true,
  };
}

/** Fixed archive members; filenames and plaintext metadata are encrypted inside the archive. */
export async function archiveMembers(workDirectory, id) {
  if (!ID.test(id)) fail("backup_archive_identity");
  await privateDirectory(workDirectory);
  const roots = [`downloaded/${id}`, "blob-copy"];
  const files = [];
  const sizes = [];
  const walk = async (relative) => {
    const path = join(workDirectory, relative);
    const info = await lstat(path);
    if (info.isSymbolicLink() || (info.mode & 0o077) !== 0) fail("backup_archive_unsafe_member");
    if (info.isDirectory()) {
      for (const name of (await readdir(path)).sort()) {
        if (!/^[A-Za-z0-9._-]+$/.test(name)) fail("backup_archive_unsafe_member");
        await walk(`${relative}/${name}`);
      }
    } else if (info.isFile()) {
      if (info.size > MAX_TAR_BYTES) fail("backup_archive_member_limit");
      if (!archiveMemberAllowed(relative, id)) fail("backup_archive_unsafe_member");
      files.push(relative);
      sizes.push(info.size);
      if (files.length > MAX_OBJECTS + 3) fail("backup_archive_member_limit");
    } else fail("backup_archive_unsafe_member");
  };
  for (const root of roots) await walk(root);
  for (const required of [
    `downloaded/${id}/manifest.json`,
    `downloaded/${id}/data.sql`,
    "blob-copy/manifest.json",
  ])
    if (!files.includes(required)) fail("backup_archive_missing_member");
  await validateArchivePlainSize(archiveTarBytes(sizes));
  return files.sort();
}

/** Copy opaque bytes to NTFS atomically without overwriting an existing generation. */
export async function publishCiphertext(source, target, expected) {
  if (!HASH.test(expected.sha256) || !Number.isSafeInteger(expected.bytes) || expected.bytes < 12)
    fail("backup_archive_receipt_invalid");
  const matches = async (path) => {
    const actual = await fileDigest(path, { ciphertext: true });
    if (actual.bytes !== expected.bytes || actual.sha256 !== expected.sha256)
      fail("backup_archive_collision");
  };
  await matches(source);
  try {
    await matches(target);
    return { ...expected, verified: true };
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  const temporary = join(dirname(target), `.ncf-part-${randomUUID()}`);
  let owned = false;
  try {
    await copyFile(source, temporary, constants.COPYFILE_EXCL);
    owned = true;
    const file = await open(temporary, "r");
    try {
      await file.sync();
    } finally {
      await file.close();
    }
    await matches(temporary);
    try {
      await link(temporary, target);
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
    }
    await matches(target);
    const directory = await open(dirname(target), "r");
    try {
      await directory.sync();
    } finally {
      await directory.close();
    }
    return { ...expected, verified: true };
  } finally {
    if (owned)
      await unlink(temporary).catch((e) => {
        if (e.code !== "ENOENT") throw e;
      });
  }
}

async function syncDirectory(path) {
  const handle = await open(path, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function saveReceipt(path, receipt) {
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    const handle = await open(temporary, "wx", 0o600);
    try {
      await handle.writeFile(`${JSON.stringify(receipt)}\n`);
      await handle.sync();
    } finally {
      await handle.close();
    }
    await link(temporary, path);
    await syncDirectory(dirname(path));
  } finally {
    await unlink(temporary).catch((error) => {
      if (error.code !== "ENOENT") throw error;
    });
  }
}

async function memberDigests(workDirectory, members) {
  const results = [];
  for (const member of members) results.push(await fileDigest(join(workDirectory, member)));
  return results;
}

/** Reconstruct the pinned publication and audit copied blobs, never infer it from ciphertext. */
async function verifyArchiveInputs(state, workDirectory, members, staging) {
  const database = join(staging, `verify-${randomUUID()}.sqlite`);
  try {
    const { manifest } = await restoreGeneration({
      directory: join(workDirectory, "downloaded", state.id),
      target: database,
    });
    if (manifest.generation.id !== state.id || manifest.generation.epoch !== state.epoch)
      fail("backup_archive_identity");
    const handle = await open(join(workDirectory, "downloaded", state.id, "data.sql"), "r");
    const parts = [];
    try {
      for await (const bytes of fileChunks(handle, manifest.data.bytes))
        parts.push({ bytes: bytes.length, sha256: digest(bytes) });
    } finally {
      await handle.close();
    }
    const publication = encode({
      format: "nextcloud-flare.r2-backup",
      version: 1,
      chunkBytes: CHUNK_BYTES,
      manifest,
      parts,
    });
    if (digest(publication) !== state.manifestSha256) fail("backup_publication_hash_mismatch");
    await verifyExtractedBlobs({
      tree: workDirectory,
      database,
      generationManifest: manifest,
      members: new Set(members),
    });
    return await memberDigests(workDirectory, members);
  } finally {
    await rm(database, { force: true });
  }
}

export function createArchiveStorage(configuration, { command = execFile } = {}) {
  const verifyStorage = async (requestedRoot) => {
    if (requestedRoot !== configuration.backupRoot) fail("backup_volume_configuration");
    await verifyMountedStorage(configuration, { command });
  };
  return {
    verifyStorage,
    async verifyArchive(state, requestedRoot) {
      if (requestedRoot !== configuration.backupRoot) fail("backup_volume_configuration");
      return verifyPublishedArchive(configuration, state, { command });
    },
    async publishArchive(state, workDirectory, requestedRoot) {
      await verifyStorage(requestedRoot);
      if (!ID.test(state.id) || !HASH.test(state.manifestSha256)) fail("backup_archive_identity");
      const members = await archiveMembers(workDirectory, state.id);
      const staging = join(workDirectory, "archive");
      await mkdir(staging, { mode: 0o700 }).catch((e) => {
        if (e.code !== "EEXIST") throw e;
      });
      await privateDirectory(staging);
      // Cross-process serialization belongs to the runner's existing flock service wrapper.
      if (activeArchives.has(staging)) fail("backup_archive_busy");
      activeArchives.add(staging);
      try {
        const plain = join(staging, "backup.tar");
        const cipher = join(staging, "backup.ncf");
        const receiptPath = join(staging, "receipt.json");
        let receipt;
        try {
          const info = await lstat(receiptPath);
          if (!info.isFile() || info.isSymbolicLink() || info.mode & 0o077 || info.size > 4096)
            fail("backup_archive_receipt_invalid");
          receipt = JSON.parse(await readFile(receiptPath, "utf8"));
        } catch (e) {
          if (e.code !== "ENOENT") throw e;
        }
        if (!receipt) {
          const inputs = await verifyArchiveInputs(state, workDirectory, members, staging);
          let exists = false;
          try {
            const info = await lstat(cipher);
            if (!info.isFile() || info.isSymbolicLink() || info.mode & 0o077)
              fail("backup_archive_untracked_cipher");
            exists = true;
          } catch (e) {
            if (e.code !== "ENOENT") throw e;
          }
          if (exists) {
            // An external generation without its receipt must never be overwritten or guessed.
            try {
              await lstat(join(requestedRoot, `backup-${state.id}.ncf`));
              fail("backup_archive_untracked_cipher");
            } catch (error) {
              if (error.code !== "ENOENT") throw error;
            }
            await unlink(cipher);
            await syncDirectory(staging);
          }
          const temporary = join(staging, `backup-${randomUUID()}.tar`);
          try {
            await execFile("tar", archiveTarArguments(workDirectory, temporary, members), {
              timeout: 600_000,
              maxBuffer: 4096,
            });
            await chmod(temporary, 0o600);
            await rename(temporary, plain);
          } catch {
            fail("backup_archive_pack_failed");
          } finally {
            await unlink(temporary).catch((e) => {
              if (e.code !== "ENOENT") throw e;
            });
          }
          const result = await encryptArchiveFile({
            sourceFile: plain,
            publicKeyFile: configuration.publicKeyFile,
            outputFile: cipher,
            accountId: configuration.accountId,
          });
          const after = await memberDigests(workDirectory, members);
          if (JSON.stringify(after) !== JSON.stringify(inputs))
            fail("backup_archive_inputs_changed");
          receipt = {
            id: state.id,
            manifestSha256: state.manifestSha256,
            bytes: result.cipherBytes,
            sha256: result.cipherSha256,
            plainBytes: result.plainBytes,
            plainSha256: result.plainSha256,
          };
          await saveReceipt(receiptPath, receipt);
        }
        if (receipt.id !== state.id || receipt.manifestSha256 !== state.manifestSha256)
          fail("backup_archive_receipt_invalid");
        await verifyStorage(requestedRoot);
        const target = join(requestedRoot, `backup-${state.id}.ncf`);
        const result = await publishCiphertext(cipher, target, receipt);
        return { bytes: result.bytes, sha256: result.sha256, verified: true };
      } finally {
        activeArchives.delete(staging);
      }
    },
  };
}
