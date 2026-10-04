import { createHash, randomBytes } from "node:crypto";
import { constants, createReadStream, openAsBlob } from "node:fs";
import { link, lstat, open, readdir, readFile, realpath, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.resolve("wrangler"));
const { build } = require("esbuild");
const MAX_CONTAINER_BYTES = 536_870_912_000;
const MAX_KEY_FILE_BYTES = 16 * 1024;
const SHA256 = /^[a-f0-9]{64}$/;
const ACCOUNT = /^[A-Za-z0-9_-]{1,128}$/;
const MIME = "application/x-tar";
const ARCHIVE_NAME = "backup.tar";
let cryptoModule;

function fail(code) {
  throw new Error(code);
}

/** Bundle the exact browser container implementation without copying its crypto. */
async function cryptoFunctions() {
  cryptoModule ??= (async () => {
    const root = new URL("../../packages/web/src/lib/", import.meta.url);
    const result = await build({
      stdin: {
        contents: [
          'export { createEncryptedContainer, readContainerHeader, openContainerHeader, decryptContainerPlainRange } from "./encryptedContainer.ts";',
          'export { unlockRecipientVault, cipherSize, MAX_CIPHER_BYTES } from "./cryptoEnvelope.ts";',
          'export { parseRecoveryFile, verifyRecipientPublicKey } from "./encryptionVaultStore.ts";',
        ].join("\n"),
        resolveDir: fileURLToPath(root),
        sourcefile: "ncf-backup-crypto-entry.ts",
        loader: "ts",
      },
      bundle: true,
      platform: "node",
      target: "node24",
      format: "esm",
      write: false,
      logLevel: "silent",
    });
    if (result.outputFiles?.length !== 1) fail("backup_crypto_bundle_invalid");
    const specifier = `data:text/javascript;base64,${Buffer.from(result.outputFiles[0].contents).toString("base64")}`;
    return import(specifier);
  })();
  return cryptoModule;
}

function exactKeys(value, expected) {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.keys(value).sort().join("\0") === [...expected].sort().join("\0")
  );
}

function checkedAccount(value) {
  if (typeof value !== "string" || !ACCOUNT.test(value)) fail("backup_archive_account_invalid");
  return value;
}

function checkedSha(value) {
  if (value !== undefined && (typeof value !== "string" || !SHA256.test(value)))
    fail("backup_archive_hash_invalid");
  return value;
}

function checkedPath(value) {
  if (typeof value !== "string" || !isAbsolute(value) || resolve(value) !== value)
    fail("backup_archive_path_invalid");
  return value;
}

async function regularFile(path, limit, privateMode = false) {
  checkedPath(path);
  const item = await lstat(path, { bigint: true });
  if (
    !item.isFile() ||
    item.size > BigInt(limit) ||
    item.size < 0n ||
    (privateMode && (Number(item.mode) & 0o077) !== 0) ||
    (privateMode && process.getuid?.() !== Number(item.uid)) ||
    (await realpath(path)) !== path
  )
    fail("backup_archive_input_invalid");
  return item;
}

async function privateOutput(path) {
  checkedPath(path);
  if (process.platform === "win32") fail("backup_archive_private_storage_required");
  const parent = dirname(path);
  const item = await lstat(parent, { bigint: true });
  if (
    !item.isDirectory() ||
    (Number(item.mode) & 0o077) !== 0 ||
    process.getuid?.() !== Number(item.uid) ||
    (await realpath(parent)) !== parent
  )
    fail("backup_archive_private_storage_required");
}

/** Remove only this output's interrupted private temp files under an exclusive caller lock. */
export async function cleanupArchiveTemps(outputFile, olderThanMs = 24 * 60 * 60 * 1000) {
  await privateOutput(outputFile);
  if (
    !Number.isSafeInteger(olderThanMs) ||
    olderThanMs < 0 ||
    olderThanMs > 7 * 24 * 60 * 60 * 1000
  )
    fail("backup_archive_cleanup_invalid");
  const prefix = `${basename(outputFile)}.tmp-`;
  let removed = 0;
  for (const entry of await readdir(dirname(outputFile), { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.startsWith(prefix)) continue;
    if (!/^[a-f0-9]{32}$/.test(entry.name.slice(prefix.length))) continue;
    const path = join(dirname(outputFile), entry.name);
    const item = await lstat(path);
    if (
      !item.isFile() ||
      (item.mode & 0o777) !== 0o600 ||
      item.uid !== process.getuid?.() ||
      item.mtimeMs > Date.now() - olderThanMs
    )
      continue;
    await rm(path);
    removed++;
  }
  return removed;
}

function sameFile(before, after) {
  return (
    before.dev === after.dev &&
    before.ino === after.ino &&
    before.size === after.size &&
    before.mtimeNs === after.mtimeNs &&
    before.ctimeNs === after.ctimeNs
  );
}

async function hashFile(path, maximum) {
  const hash = createHash("sha256");
  let size = 0;
  for await (const part of createReadStream(path, { highWaterMark: 1024 * 1024 })) {
    size += part.length;
    if (size > maximum) fail("backup_archive_size_invalid");
    hash.update(part);
  }
  return { bytes: size, sha256: hash.digest("hex") };
}

async function writeAll(handle, bytes) {
  let offset = 0;
  while (offset < bytes.length) {
    const { bytesWritten } = await handle.write(bytes, offset, bytes.length - offset);
    if (bytesWritten < 1) fail("backup_archive_write_failed");
    offset += bytesWritten;
  }
}

async function publicRecipient(path, accountId, verifyRecipientPublicKey) {
  await regularFile(path, MAX_KEY_FILE_BYTES);
  const value = JSON.parse(await readFile(path, "utf8"));
  if (
    !exactKeys(value, ["version", "accountId", "recipient"]) ||
    value.version !== 1 ||
    value.accountId !== accountId
  )
    fail("backup_archive_public_key_invalid");
  await verifyRecipientPublicKey(value.recipient);
  return value.recipient;
}

/** Reserve the complete bounded header before hashing or packing a large archive. */
export async function validateArchivePlainSize(bytes) {
  const crypto = await cryptoFunctions();
  try {
    if (
      !Number.isSafeInteger(bytes) ||
      bytes < 0 ||
      crypto.cipherSize(bytes) + 12 + 16 * 1024 > crypto.MAX_CIPHER_BYTES
    )
      fail("backup_archive_container_limit");
  } catch {
    fail("backup_archive_container_limit");
  }
}

/** Encrypt one already-packed private tar into the existing NCFENC1 container. */
export async function encryptArchiveFile({ sourceFile, publicKeyFile, outputFile, accountId }) {
  checkedAccount(accountId);
  await privateOutput(outputFile);
  const sourceStat = await regularFile(sourceFile, MAX_CONTAINER_BYTES, true);
  if (sourceFile === outputFile) fail("backup_archive_path_invalid");
  await validateArchivePlainSize(Number(sourceStat.size));
  const sourceHash = await hashFile(sourceFile, MAX_CONTAINER_BYTES);
  if (sourceHash.bytes !== Number(sourceStat.size)) fail("backup_archive_source_changed");
  const crypto = await cryptoFunctions();
  const recipient = await publicRecipient(
    publicKeyFile,
    accountId,
    crypto.verifyRecipientPublicKey,
  );
  const file = new File([await openAsBlob(sourceFile)], ARCHIVE_NAME, {
    type: MIME,
    lastModified: 0,
  });
  const temporary = `${outputFile}.tmp-${randomBytes(16).toString("hex")}`;
  let written = false;
  let published = false;
  const writer = async (opaqueName) => {
    const handle = await open(
      temporary,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      0o600,
    );
    let closed = false;
    return {
      async write(bytes) {
        await writeAll(handle, bytes);
      },
      async close() {
        await handle.sync();
        await handle.close();
        closed = true;
        written = true;
        return new File([await openAsBlob(temporary)], opaqueName, {
          type: "application/octet-stream",
        });
      },
      async discard() {
        if (!closed) await handle.close().catch(() => {});
        await rm(temporary, { force: true });
      },
    };
  };
  let completed;
  try {
    completed = await crypto.createEncryptedContainer(file, [recipient], writer, undefined, {
      legacyUnsigned: true,
    });
    if (!written) fail("backup_archive_write_failed");
    const cipher = await hashFile(temporary, MAX_CONTAINER_BYTES);
    const finalSource = await regularFile(sourceFile, MAX_CONTAINER_BYTES, true);
    const rereadSource = await hashFile(sourceFile, MAX_CONTAINER_BYTES);
    if (
      !sameFile(sourceStat, finalSource) ||
      rereadSource.bytes !== sourceHash.bytes ||
      rereadSource.sha256 !== sourceHash.sha256
    )
      fail("backup_archive_source_changed");
    if (cipher.bytes !== completed.header.totalBytes) fail("backup_archive_size_invalid");
    await link(temporary, outputFile); // Atomic no-overwrite publication on the private filesystem.
    published = true;
    const saved = await hashFile(outputFile, MAX_CONTAINER_BYTES);
    if (saved.bytes !== cipher.bytes || saved.sha256 !== cipher.sha256)
      fail("backup_archive_cipher_hash_mismatch");
    return {
      cipherBytes: cipher.bytes,
      cipherSha256: cipher.sha256,
      plainBytes: sourceHash.bytes,
      plainSha256: sourceHash.sha256,
    };
  } catch (error) {
    if (completed) await completed.discard().catch(() => {});
    if (published) await rm(outputFile, { force: true }).catch(() => {});
    throw error;
  } finally {
    await rm(temporary, { force: true }).catch(() => {});
  }
}

/** Decrypt locally to a new 0600 tar; extraction is deliberately separate. */
export async function decryptArchiveFile({
  cipherFile,
  recoveryFile,
  outputFile,
  accountId,
  expectedCipherSha256,
  expectedPlainSha256,
}) {
  checkedAccount(accountId);
  checkedSha(expectedCipherSha256);
  checkedSha(expectedPlainSha256);
  await privateOutput(outputFile);
  if (outputFile === cipherFile || outputFile === recoveryFile) fail("backup_archive_path_invalid");
  const cipherStat = await regularFile(cipherFile, MAX_CONTAINER_BYTES);
  await regularFile(recoveryFile, MAX_KEY_FILE_BYTES, true);
  const cipherHash = await hashFile(cipherFile, MAX_CONTAINER_BYTES);
  if (
    cipherHash.bytes !== Number(cipherStat.size) ||
    (expectedCipherSha256 && cipherHash.sha256 !== expectedCipherSha256)
  )
    fail("backup_archive_cipher_hash_mismatch");
  const crypto = await cryptoFunctions();
  const recovery = crypto.parseRecoveryFile(await readFile(recoveryFile, "utf8"), accountId);
  const unlocked = await crypto.unlockRecipientVault(
    recovery.recipientVault,
    recovery.recoveryKey,
    accountId,
  );
  const blob = await openAsBlob(cipherFile);
  const header = await crypto.readContainerHeader(blob);
  const opened = await crypto.openContainerHeader(header, unlocked, { legacyUnsigned: true });
  if (opened.metadata.name !== ARCHIVE_NAME || opened.metadata.mime !== MIME)
    fail("backup_archive_metadata_invalid");
  const temporary = `${outputFile}.tmp-${randomBytes(16).toString("hex")}`;
  const handle = await open(
    temporary,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
    0o600,
  );
  let published = false;
  try {
    const hash = createHash("sha256");
    let plainBytes = 0;
    for await (const plain of crypto.decryptContainerPlainRange(
      opened,
      0,
      opened.envelope.plainSize,
      async (range) =>
        new Uint8Array(
          await blob
            .slice(range.cipherOffset, range.cipherOffset + range.cipherLength)
            .arrayBuffer(),
        ),
    )) {
      plainBytes += plain.length;
      if (plainBytes > opened.envelope.plainSize) fail("backup_archive_size_invalid");
      hash.update(plain);
      await writeAll(handle, plain);
    }
    if (plainBytes !== opened.envelope.plainSize) fail("backup_archive_size_invalid");
    const plainSha256 = hash.digest("hex");
    if (expectedPlainSha256 && plainSha256 !== expectedPlainSha256)
      fail("backup_archive_plain_hash_mismatch");
    await handle.sync();
    await handle.close();
    const finalCipher = await regularFile(cipherFile, MAX_CONTAINER_BYTES);
    const rereadCipher = await hashFile(cipherFile, MAX_CONTAINER_BYTES);
    if (
      !sameFile(cipherStat, finalCipher) ||
      rereadCipher.bytes !== cipherHash.bytes ||
      rereadCipher.sha256 !== cipherHash.sha256
    )
      fail("backup_archive_source_changed");
    await link(temporary, outputFile); // EEXIST is never overwritten.
    published = true;
    const saved = await hashFile(outputFile, MAX_CONTAINER_BYTES);
    if (saved.bytes !== plainBytes || saved.sha256 !== plainSha256)
      fail("backup_archive_plain_hash_mismatch");
    return { plainBytes, plainSha256 };
  } catch (error) {
    await handle.close().catch(() => {});
    if (published) await rm(outputFile, { force: true }).catch(() => {});
    throw error;
  } finally {
    await rm(temporary, { force: true }).catch(() => {});
  }
}

function cliArguments(argv) {
  const [command, ...items] = argv;
  if (!["encrypt", "decrypt"].includes(command) || items.length % 2 !== 0)
    fail("backup_archive_usage");
  const values = new Map();
  for (let index = 0; index < items.length; index += 2) {
    const key = items[index];
    if (!/^--[a-z0-9-]+$/.test(key) || values.has(key) || !items[index + 1])
      fail("backup_archive_usage");
    values.set(key, items[index + 1]);
  }
  const allowed =
    command === "encrypt"
      ? ["--source", "--public-key", "--output", "--account"]
      : [
          "--cipher",
          "--recovery",
          "--output",
          "--account",
          "--expected-cipher-sha256",
          "--expected-plain-sha256",
        ];
  if (
    [...values.keys()].some((key) => !allowed.includes(key)) ||
    allowed.slice(0, 4).some((key) => !values.has(key))
  )
    fail("backup_archive_usage");
  return { command, values };
}

export async function runEncryptedArchiveCli(argv, logger = console) {
  try {
    const { command, values } = cliArguments(argv);
    const outputFile = values.get("--output");
    const accountId = values.get("--account");
    const result =
      command === "encrypt"
        ? await encryptArchiveFile({
            sourceFile: values.get("--source"),
            publicKeyFile: values.get("--public-key"),
            outputFile,
            accountId,
          })
        : await decryptArchiveFile({
            cipherFile: values.get("--cipher"),
            recoveryFile: values.get("--recovery"),
            outputFile,
            accountId,
            expectedCipherSha256: values.get("--expected-cipher-sha256"),
            expectedPlainSha256: values.get("--expected-plain-sha256"),
          });
    logger.log(JSON.stringify({ command, verified: true, ...result }));
    return 0;
  } catch (error) {
    const code =
      error instanceof Error && /^backup_[a-z_]+$/.test(error.message)
        ? error.message
        : "backup_archive_failed";
    logger.error(JSON.stringify({ verified: false, error: code }));
    return 1;
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1]))
  process.exitCode = await runEncryptedArchiveCli(process.argv.slice(2));
