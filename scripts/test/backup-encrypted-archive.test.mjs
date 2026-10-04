import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { constants } from "node:fs";
import { chmod, lstat, mkdtemp, open, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "vitest";
import {
  cipherSize,
  createRecipientVault,
  MAX_CIPHER_BYTES,
} from "../../packages/web/src/lib/cryptoEnvelope.ts";
import {
  publicKeyFileJson,
  recoveryFileJson,
} from "../../packages/web/src/lib/encryptionVaultStore.ts";
import {
  cleanupArchiveTemps,
  decryptArchiveFile,
  encryptArchiveFile,
  runEncryptedArchiveCli,
  validateArchivePlainSize,
} from "../backup/encryptedArchive.mjs";

const roots = [];
const posixTest = test.skipIf(process.platform === "win32");

test("archive preflight reserves the real cipher overhead and the bounded container header", async () => {
  await validateArchivePlainSize(8 * 1024 ** 3);
  const headerBytes = 12 + 16 * 1024;
  const nearLimit = MAX_CIPHER_BYTES - 4 * 1024 * 1024;
  assert.ok(cipherSize(nearLimit) + headerBytes <= MAX_CIPHER_BYTES);
  await validateArchivePlainSize(nearLimit);
  const overflow = MAX_CIPHER_BYTES - 1024;
  await assert.rejects(validateArchivePlainSize(overflow), /backup_archive_container_limit/);
  await assert.rejects(validateArchivePlainSize(-1), /backup_archive_container_limit/);
  await assert.rejects(
    validateArchivePlainSize(Number.MAX_SAFE_INTEGER),
    /backup_archive_container_limit/,
  );
});

posixTest("oversized tar is refused before hashing or reading recipient keys", async () => {
  const f = await fixture(0);
  const file = await open(f.sourceFile, "r+");
  try {
    await file.truncate(MAX_CIPHER_BYTES - 1024);
  } finally {
    await file.close();
  }
  await assert.rejects(
    encryptArchiveFile({
      sourceFile: f.sourceFile,
      publicKeyFile: join(f.root, "missing-public.json"),
      outputFile: f.cipherFile,
      accountId: "admin_fixture",
    }),
    /backup_archive_container_limit/,
  );
  await assert.rejects(lstat(f.cipherFile), { code: "ENOENT" });
});
afterEach(async () => {
  await Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function fixture(size = 4 * 1024 * 1024 + 17) {
  const root = await mkdtemp(join(tmpdir(), "ncf-encrypted-archive-test-"));
  roots.push(root);
  await chmod(root, 0o700);
  const accountId = "backup_admin";
  const vault = await createRecipientVault(accountId);
  const publicKeyFile = join(root, "public.json");
  const recoveryFile = join(root, "recovery.json");
  const sourceFile = join(root, "backup.tar");
  const cipherFile = join(root, "archive.ncf");
  const outputFile = join(root, "restored.tar");
  await writeFile(publicKeyFile, publicKeyFileJson(accountId, vault.unlocked.publicKey), {
    mode: 0o600,
    flag: "wx",
  });
  await writeFile(recoveryFile, recoveryFileJson(accountId, vault.vault, vault.recoveryKey), {
    mode: 0o600,
    flag: "wx",
  });
  const file = await open(
    sourceFile,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL,
    0o600,
  );
  try {
    await file.truncate(size);
    if (size > 0) {
      const marker = randomBytes(Math.min(64, size));
      await file.write(marker, 0, marker.length, size - marker.length);
    }
    await file.sync();
  } finally {
    await file.close();
  }
  return {
    root,
    accountId,
    vault,
    publicKeyFile,
    recoveryFile,
    sourceFile,
    cipherFile,
    outputFile,
  };
}

const encrypt = (fixtureValue) =>
  encryptArchiveFile({ ...fixtureValue, outputFile: fixtureValue.cipherFile });

posixTest(
  "streams a multi-chunk backup through the existing container and verifies exact offline restore",
  async () => {
    const f = await fixture();
    const encrypted = await encrypt(f);
    assert.equal(encrypted.plainBytes, 4 * 1024 * 1024 + 17);
    assert.match(encrypted.cipherSha256, /^[a-f0-9]{64}$/);
    assert.ok(encrypted.cipherBytes > encrypted.plainBytes);
    assert.equal((await lstat(f.cipherFile)).mode & 0o777, 0o600);
    const restored = await decryptArchiveFile({
      cipherFile: f.cipherFile,
      recoveryFile: f.recoveryFile,
      outputFile: f.outputFile,
      accountId: f.accountId,
      expectedCipherSha256: encrypted.cipherSha256,
      expectedPlainSha256: encrypted.plainSha256,
    });
    assert.equal(restored.plainBytes, encrypted.plainBytes);
    assert.equal(restored.plainSha256, encrypted.plainSha256);
    assert.deepEqual(await readFile(f.outputFile), await readFile(f.sourceFile));
    assert.equal((await lstat(f.outputFile)).mode & 0o777, 0o600);
    await assert.rejects(encrypt(f), { code: "EEXIST" });
    await assert.rejects(
      decryptArchiveFile({
        cipherFile: f.cipherFile,
        recoveryFile: f.recoveryFile,
        outputFile: f.outputFile,
        accountId: f.accountId,
      }),
      { code: "EEXIST" },
    );
    assert.deepEqual(await readFile(f.outputFile), await readFile(f.sourceFile));
  },
);

posixTest(
  "streams a sparse archive larger than 64 MiB without a whole-file buffer",
  async () => {
    const f = await fixture(64 * 1024 * 1024 + 1);
    const encrypted = await encrypt(f);
    const restored = await decryptArchiveFile({
      cipherFile: f.cipherFile,
      recoveryFile: f.recoveryFile,
      outputFile: f.outputFile,
      accountId: f.accountId,
      expectedCipherSha256: encrypted.cipherSha256,
      expectedPlainSha256: encrypted.plainSha256,
    });
    assert.equal(restored.plainBytes, 64 * 1024 * 1024 + 1);
    assert.equal((await lstat(f.outputFile)).size, restored.plainBytes);
  },
  60_000,
);

posixTest("wrong recovery key and tampered last chunk leave no published plaintext", async () => {
  const f = await fixture();
  await encrypt(f);
  const other = await createRecipientVault("other_admin");
  await writeFile(f.recoveryFile, recoveryFileJson(f.accountId, f.vault.vault, other.recoveryKey), {
    mode: 0o600,
  });
  await assert.rejects(decryptArchiveFile(f));
  await assert.rejects(lstat(f.outputFile), { code: "ENOENT" });
  await writeFile(
    f.recoveryFile,
    recoveryFileJson(f.accountId, f.vault.vault, f.vault.recoveryKey),
    { mode: 0o600 },
  );
  const file = await open(f.cipherFile, "r+");
  try {
    const stat = await file.stat();
    const byte = Buffer.alloc(1);
    await file.read(byte, 0, 1, stat.size - 1);
    byte[0] ^= 1;
    await file.write(byte, 0, 1, stat.size - 1);
  } finally {
    await file.close();
  }
  await assert.rejects(decryptArchiveFile(f));
  await assert.rejects(lstat(f.outputFile), { code: "ENOENT" });
  assert.equal(
    (await readdir(f.root)).some((name) => name.startsWith("restored.tar.tmp-")),
    false,
  );
});

posixTest("rejects an exposed recovery file and symlinked archive paths", async () => {
  const f = await fixture(0);
  const encrypted = await encrypt(f);
  await chmod(f.recoveryFile, 0o644);
  await assert.rejects(decryptArchiveFile(f), /backup_archive_input_invalid/);
  await chmod(f.recoveryFile, 0o600);
  const sourceLink = join(f.root, "linked.tar");
  const { symlink } = await import("node:fs/promises");
  await symlink(f.sourceFile, sourceLink);
  await assert.rejects(
    encryptArchiveFile({ ...f, sourceFile: sourceLink, outputFile: join(f.root, "linked.ncf") }),
    /backup_archive_input_invalid/,
  );
  const restored = await decryptArchiveFile({
    ...f,
    expectedCipherSha256: encrypted.cipherSha256,
    expectedPlainSha256: encrypted.plainSha256,
  });
  assert.equal(restored.plainBytes, 0);
});

posixTest(
  "offline decrypt CLI verifies expected hashes without printing paths or key material",
  async () => {
    const f = await fixture(19);
    const encrypted = await encrypt(f);
    const output = [];
    const errors = [];
    const exit = await runEncryptedArchiveCli(
      [
        "decrypt",
        "--cipher",
        f.cipherFile,
        "--recovery",
        f.recoveryFile,
        "--output",
        f.outputFile,
        "--account",
        f.accountId,
        "--expected-cipher-sha256",
        encrypted.cipherSha256,
        "--expected-plain-sha256",
        encrypted.plainSha256,
      ],
      { log: (value) => output.push(value), error: (value) => errors.push(value) },
    );
    assert.equal(exit, 0, JSON.stringify(errors));
    assert.deepEqual(errors, []);
    assert.deepEqual(JSON.parse(output[0]), {
      command: "decrypt",
      verified: true,
      plainBytes: encrypted.plainBytes,
      plainSha256: encrypted.plainSha256,
    });
    assert.ok(!output[0].includes(f.root));
    assert.ok(!output[0].includes(f.vault.recoveryKey));
    assert.deepEqual(await readFile(f.outputFile), await readFile(f.sourceFile));
  },
);

posixTest(
  "interrupted temp cleanup is limited to one exact output prefix and private regular files",
  async () => {
    const f = await fixture(1);
    const stale = `${f.cipherFile}.tmp-${"a".repeat(32)}`;
    const unrelated = `${f.outputFile}.tmp-${"b".repeat(32)}`;
    const suspicious = `${f.cipherFile}.tmp-${"c".repeat(32)}`;
    await writeFile(stale, "incomplete", { mode: 0o600, flag: "wx" });
    await writeFile(unrelated, "keep", { mode: 0o600, flag: "wx" });
    await writeFile(suspicious, "keep", { mode: 0o644, flag: "wx" });
    await chmod(suspicious, 0o644);
    assert.equal(await cleanupArchiveTemps(f.cipherFile, 0), 1);
    await assert.rejects(lstat(stale), { code: "ENOENT" });
    assert.equal(await readFile(unrelated, "utf8"), "keep");
    assert.equal(await readFile(suspicious, "utf8"), "keep");
  },
);

test.skipIf(process.platform !== "win32")(
  "archive encryption refuses a Windows output before reading key material",
  async () => {
    const root = await mkdtemp(join(tmpdir(), "ncf-archive-windows-"));
    roots.push(root);
    await assert.rejects(
      encryptArchiveFile({
        sourceFile: join(root, "missing.tar"),
        publicKeyFile: join(root, "missing-public.json"),
        outputFile: join(root, "archive.ncf"),
        accountId: "admin_fixture",
      }),
      /backup_archive_private_storage_required/,
    );
  },
);
