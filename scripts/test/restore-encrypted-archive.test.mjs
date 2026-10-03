import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, mkdtemp, open, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, test } from "vitest";
import { archiveMembers } from "../../ops/backup/archive-storage.mjs";
import { createRecipientVault } from "../../packages/web/src/lib/cryptoEnvelope.ts";
import {
  publicKeyFileJson,
  recoveryFileJson,
} from "../../packages/web/src/lib/encryptionVaultStore.ts";
import { auditRestoredBlobBytes } from "../backup/blobAudit.mjs";
import { encryptArchiveFile } from "../backup/encryptedArchive.mjs";
import { restoreGeneration } from "../backup/generation.mjs";
import {
  extractArchiveTar,
  restoreEncryptedArchive,
  runRestoreEncryptedArchiveCli,
} from "../backup/restoreEncryptedArchive.mjs";
import { fixtureGeneration } from "./fixtures/backup.mjs";

const execute = promisify(execFile);
const roots = [];
const posixTest = test.skipIf(process.platform === "win32");
afterEach(async () => {
  await Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "ncf-restore-archive-"));
  roots.push(root);
  await chmod(root, 0o700);
  const work = join(root, "work");
  await (await import("node:fs/promises")).mkdir(work, { mode: 0o700 });
  const blob = Buffer.from("abc");
  const r2Etag = "a".repeat(32);
  const generation = await fixtureGeneration(join(work, "downloaded"), 0, (db, ids) => {
    db.prepare("UPDATE blobs SET r2_etag=?,sha256_verified=? WHERE id=?").run(
      r2Etag,
      sha(blob),
      ids.blob,
    );
    db.prepare("INSERT INTO blob_storage(blob_id,bytes,r2_etag,observed_at) VALUES(?,3,?,1)").run(
      ids.blob,
      r2Etag,
    );
  });
  const id = generation.manifest.generation.id;
  const database = join(work, "temporary.sqlite");
  await restoreGeneration({ directory: generation.directory, target: database });
  const source = {
    async get(_key, expected) {
      return new Response(blob, { headers: { ETag: `"${expected}"`, "Content-Length": "3" } });
    },
  };
  await auditRestoredBlobBytes({
    generation: generation.directory,
    database,
    directory: join(work, "blob-copy"),
    source,
    maxObjects: 1,
    maxBytes: 3,
  });
  const accountId = "admin_fixture";
  const vault = await createRecipientVault(accountId);
  const publicKeyFile = join(root, "public.json");
  const recoveryFile = join(root, "recovery.json");
  await writeFile(publicKeyFile, publicKeyFileJson(accountId, vault.unlocked.publicKey), {
    mode: 0o600,
  });
  await writeFile(recoveryFile, recoveryFileJson(accountId, vault.vault, vault.recoveryKey), {
    mode: 0o600,
  });
  return { root, work, id, accountId, publicKeyFile, recoveryFile };
}

async function packed(f, name = "backup") {
  const sourceFile = join(f.root, `${name}.tar`);
  const files = await archiveMembers(f.work, f.id);
  await execute("tar", [
    "--create",
    "--format=ustar",
    "--sort=name",
    "--mtime=@0",
    "--owner=0",
    "--group=0",
    "--numeric-owner",
    "--file",
    sourceFile,
    "--directory",
    f.work,
    "--",
    ...files,
  ]);
  await chmod(sourceFile, 0o600);
  const cipherFile = join(f.root, `${name}.ncf`);
  const encrypted = await encryptArchiveFile({
    sourceFile,
    publicKeyFile: f.publicKeyFile,
    outputFile: cipherFile,
    accountId: f.accountId,
  });
  return { sourceFile, cipherFile, encrypted };
}

posixTest(
  "decrypts pinned ciphertext and reconstructs SQL, FTS and exact original blob bytes offline",
  async () => {
    const f = await fixture();
    const archive = await packed(f);
    const destination = join(f.root, "restored");
    const result = await restoreEncryptedArchive({
      cipherFile: archive.cipherFile,
      recoveryFile: f.recoveryFile,
      accountId: f.accountId,
      expectedCipherSha256: archive.encrypted.cipherSha256,
      generationId: f.id,
      destination,
    });
    assert.equal(result.objects, 1);
    assert.equal(result.bytes, 3);
    assert.equal(result.generationId, f.id);
    assert.equal(
      (await readFile(join(result.extracted, "blob-copy/objects/00000000.bin"))).toString(),
      "abc",
    );
    assert.ok(
      (await readFile(result.database)).subarray(0, 16).toString().startsWith("SQLite format 3"),
    );
    await assert.rejects(
      restoreEncryptedArchive({
        cipherFile: archive.cipherFile,
        recoveryFile: f.recoveryFile,
        accountId: f.accountId,
        expectedCipherSha256: archive.encrypted.cipherSha256,
        generationId: f.id,
        destination,
      }),
      { code: "EEXIST" },
    );
    const output = [];
    const errors = [];
    const exit = await runRestoreEncryptedArchiveCli(
      [
        "--cipher",
        archive.cipherFile,
        "--recovery",
        f.recoveryFile,
        "--account",
        f.accountId,
        "--expected-cipher-sha256",
        archive.encrypted.cipherSha256,
        "--generation",
        f.id,
        "--destination",
        join(f.root, "cli-restored"),
      ],
      { log: (line) => output.push(line), error: (line) => errors.push(line) },
    );
    assert.equal(exit, 0, JSON.stringify(errors));
    assert.equal(JSON.parse(output[0]).verified, true);
    assert.ok(!output[0].includes(f.root));
  },
  30_000,
);

posixTest(
  "rejects wrong pinned hash and copied object corruption without leaving extracted plaintext",
  async () => {
    const f = await fixture();
    const good = await packed(f);
    const wrongTarget = join(f.root, "wrong-hash");
    await assert.rejects(
      restoreEncryptedArchive({
        cipherFile: good.cipherFile,
        recoveryFile: f.recoveryFile,
        accountId: f.accountId,
        expectedCipherSha256: "0".repeat(64),
        generationId: f.id,
        destination: wrongTarget,
      }),
      /backup_archive_cipher_hash_mismatch/,
    );
    await assert.rejects((await import("node:fs/promises")).lstat(wrongTarget), { code: "ENOENT" });
    await writeFile(join(f.work, "blob-copy/objects/00000000.bin"), "abd");
    const bad = await packed(f, "corrupt");
    const badTarget = join(f.root, "bad-blob");
    await assert.rejects(
      restoreEncryptedArchive({
        cipherFile: bad.cipherFile,
        recoveryFile: f.recoveryFile,
        accountId: f.accountId,
        expectedCipherSha256: bad.encrypted.cipherSha256,
        generationId: f.id,
        destination: badTarget,
      }),
      /backup_restore_blob_mismatch/,
    );
    await assert.rejects((await import("node:fs/promises")).lstat(badTarget), { code: "ENOENT" });
  },
  30_000,
);

posixTest(
  "rejects traversal member in a valid-checksum ustar before writing outside fresh destination",
  async () => {
    const f = await fixture();
    const archive = await packed(f);
    const tar = await open(archive.sourceFile, "r+");
    try {
      const header = Buffer.alloc(512);
      await tar.read(header, 0, 512, 0);
      header.fill(0, 0, 100);
      header.write("../escape", 0, "ascii");
      header.fill(0x20, 148, 156);
      const checksum = header.reduce((sum, byte) => sum + byte, 0);
      header.write(checksum.toString(8).padStart(6, "0") + "\0 ", 148, "ascii");
      await tar.write(header, 0, 512, 0);
    } finally {
      await tar.close();
    }
    const destination = join(f.root, "malicious");
    await assert.rejects(
      extractArchiveTar(archive.sourceFile, destination, f.id),
      /backup_restore_tar_invalid/,
    );
    await assert.rejects((await import("node:fs/promises")).lstat(join(f.root, "escape")), {
      code: "ENOENT",
    });
    await assert.rejects((await import("node:fs/promises")).lstat(destination), { code: "ENOENT" });
  },
);

test.skipIf(process.platform !== "win32")(
  "offline restore refuses a Windows plaintext destination before reading recovery data",
  async () => {
    const root = await mkdtemp(join(tmpdir(), "ncf-restore-windows-"));
    roots.push(root);
    await assert.rejects(
      restoreEncryptedArchive({
        cipherFile: join(root, "missing.ncf"),
        recoveryFile: join(root, "missing-recovery.json"),
        accountId: "admin_fixture",
        expectedCipherSha256: "a".repeat(64),
        generationId: "11111111-2222-4333-8444-555555555555",
        destination: join(root, "restored"),
      }),
      /backup_restore_private_parent_required/,
    );
  },
);
