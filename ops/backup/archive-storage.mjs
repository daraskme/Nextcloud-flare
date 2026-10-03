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
  unlink,
  writeFile,
} from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";
import { promisify } from "node:util";
import { encryptArchiveFile } from "../../scripts/backup/encryptedArchive.mjs";

const execFile = promisify(execute);
const ID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
const HASH = /^[a-f0-9]{64}$/;
const MAGIC = Buffer.from([78, 67, 70, 69, 78, 67, 49, 0]);
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

/** Fixed archive members; filenames and plaintext metadata are encrypted inside the archive. */
export async function archiveMembers(workDirectory, id) {
  if (!ID.test(id)) fail("backup_archive_identity");
  await privateDirectory(workDirectory);
  const roots = [`downloaded/${id}`, "blob-copy"];
  const files = [];
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
      if (
        !(
          relative === `downloaded/${id}/manifest.json` ||
          relative === `downloaded/${id}/data.sql` ||
          relative === "blob-copy/manifest.json" ||
          /^blob-copy\/objects\/[0-9]{8}\.bin$/.test(relative)
        )
      )
        fail("backup_archive_unsafe_member");
      files.push(relative);
      if (files.length > 100_003) fail("backup_archive_member_limit");
    } else fail("backup_archive_unsafe_member");
  };
  for (const root of roots) await walk(root);
  for (const required of [
    `downloaded/${id}/manifest.json`,
    `downloaded/${id}/data.sql`,
    "blob-copy/manifest.json",
  ])
    if (!files.includes(required)) fail("backup_archive_missing_member");
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

export function createArchiveStorage(configuration) {
  const verifyStorage = async (requestedRoot) => {
    if (requestedRoot !== configuration.backupRoot) fail("backup_volume_configuration");
    await verifyMountedStorage(configuration);
  };
  return {
    verifyStorage,
    async publishArchive(state, workDirectory, requestedRoot) {
      await verifyStorage(requestedRoot);
      if (!ID.test(state.id) || !HASH.test(state.manifestSha256)) fail("backup_archive_identity");
      const members = await archiveMembers(workDirectory, state.id);
      const staging = join(workDirectory, "archive");
      await mkdir(staging, { mode: 0o700 }).catch((e) => {
        if (e.code !== "EEXIST") throw e;
      });
      await privateDirectory(staging);
      const plain = join(staging, "backup.tar");
      const cipher = join(staging, "backup.ncf");
      const receiptPath = join(staging, "receipt.json");
      let receipt;
      try {
        receipt = JSON.parse(await readFile(receiptPath, "utf8"));
      } catch (e) {
        if (e.code !== "ENOENT") throw e;
      }
      if (!receipt) {
        let exists = false;
        try {
          await lstat(cipher);
          exists = true;
        } catch (e) {
          if (e.code !== "ENOENT") throw e;
        }
        if (exists) fail("backup_archive_untracked_cipher");
        const temporary = join(staging, `backup-${randomUUID()}.tar`);
        try {
          await execFile(
            "tar",
            [
              "--create",
              "--format=ustar",
              "--sort=name",
              "--mtime=@0",
              "--owner=0",
              "--group=0",
              "--numeric-owner",
              "--file",
              temporary,
              "--directory",
              workDirectory,
              "--",
              ...members,
            ],
            { timeout: 600_000, maxBuffer: 4096 },
          );
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
        receipt = {
          id: state.id,
          manifestSha256: state.manifestSha256,
          bytes: result.cipherBytes,
          sha256: result.cipherSha256,
          plainBytes: result.plainBytes,
          plainSha256: result.plainSha256,
        };
        await writeFile(receiptPath, JSON.stringify(receipt) + "\n", { flag: "wx", mode: 0o600 });
      }
      if (receipt.id !== state.id || receipt.manifestSha256 !== state.manifestSha256)
        fail("backup_archive_receipt_invalid");
      await verifyStorage(requestedRoot);
      const target = join(requestedRoot, `backup-${state.id}.ncf`);
      const result = await publishCiphertext(cipher, target, receipt);
      return { bytes: result.bytes, sha256: result.sha256, verified: true };
    },
  };
}
