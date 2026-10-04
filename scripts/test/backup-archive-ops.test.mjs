import { createHash } from "node:crypto";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { createArchiveStorage, verifyPublishedArchive } from "../../ops/backup/archive-storage.mjs";
import { runMonitorCycle } from "../../ops/monitoring/run-monitor.mjs";
import {
  japaneseBackupWeek,
  runStagingWeeklyBackup,
} from "../../ops/staging/weekly-backup-runner.mjs";
import { createRecipientVault } from "../../packages/web/src/lib/cryptoEnvelope.ts";
import {
  publicKeyFileJson,
  recoveryFileJson,
} from "../../packages/web/src/lib/encryptionVaultStore.ts";
import { auditRestoredBlobBytes } from "../backup/blobAudit.mjs";
import { restoreGeneration } from "../backup/generation.mjs";
import { publishGeneration } from "../backup/publication.mjs";
import { restoreEncryptedArchive } from "../backup/restoreEncryptedArchive.mjs";
import { fixtureGeneration } from "./fixtures/backup.mjs";

const faults = vi.hoisted(() => ({ receipt: false, beforeReceipt: null }));
vi.mock("node:fs/promises", async (original) => {
  const fs = await original();
  return {
    ...fs,
    async open(path, ...args) {
      const handle = await fs.open(path, ...args);
      if (!basename(String(path)).startsWith("receipt.json.")) return handle;
      return new Proxy(handle, {
        get(target, key) {
          if (key === "writeFile")
            return async (...values) => {
              await faults.beforeReceipt?.();
              if (faults.receipt) {
                await target.writeFile(String(values[0]).slice(0, 19));
                throw Object.assign(new Error("fixture_enospc"), { code: "ENOSPC" });
              }
              return target.writeFile(...values);
            };
          const value = target[key];
          return typeof value === "function" ? value.bind(target) : value;
        },
      });
    },
  };
});

const roots = [];
const posixIt = it.skipIf(process.platform === "win32");
const now = new Date("2026-10-04T05:00:00Z");
afterEach(async () => {
  faults.receipt = false;
  faults.beforeReceipt = null;
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
const sha = (data) => createHash("sha256").update(data).digest("hex");

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "ncf-archive-ops-"));
  roots.push(root);
  await chmod(root, 0o700);
  const work = join(root, "work"),
    backupRoot = join(root, "external");
  await mkdir(work, { mode: 0o700 });
  await mkdir(backupRoot, { mode: 0o700 });
  const blob = Buffer.from("abc"),
    etag = "a".repeat(32);
  const generation = await fixtureGeneration(join(work, "downloaded"), 0, (db, ids) => {
    db.prepare("UPDATE blobs SET r2_etag=?,sha256_verified=? WHERE id=?").run(
      etag,
      sha(blob),
      ids.blob,
    );
    db.prepare("INSERT INTO blob_storage(blob_id,bytes,r2_etag,observed_at) VALUES(?,3,?,1)").run(
      ids.blob,
      etag,
    );
  });
  const objects = new Map();
  const published = await publishGeneration({
    directory: generation.directory,
    store: {
      get: async (key) => objects.get(key) ?? null,
      put: async (key, bytes) => objects.set(key, bytes),
    },
  });
  const database = join(work, "restored.sqlite");
  await restoreGeneration({ directory: generation.directory, target: database });
  await auditRestoredBlobBytes({
    generation: generation.directory,
    database,
    directory: join(work, "blob-copy"),
    maxObjects: 1,
    maxBytes: 3,
    source: {
      get: async () =>
        new Response(blob, { headers: { ETag: `"${etag}"`, "Content-Length": "3" } }),
    },
  });
  const accountId = "archive_fixture",
    vault = await createRecipientVault(accountId);
  const publicKeyFile = join(root, "public.json"),
    recoveryFile = join(root, "recovery.json");
  await writeFile(publicKeyFile, publicKeyFileJson(accountId, vault.unlocked.publicKey), {
    mode: 0o600,
  });
  await writeFile(recoveryFile, recoveryFileJson(accountId, vault.vault, vault.recoveryKey), {
    mode: 0o600,
  });
  const config = { backupRoot, mountPoint: root, volumeUuid: "ABC123", accountId, publicKeyFile };
  const command = vi.fn(async () => ({
    stdout: JSON.stringify({ filesystems: [{ target: root, uuid: "ABC123", options: "rw" }] }),
  }));
  const storage = createArchiveStorage(config, { command });
  const state = {
    version: 1,
    week: japaneseBackupWeek(now),
    id: generation.manifest.generation.id,
    epoch: 1,
    phase: "bridge_deleted",
    manifestSha256: published.sha256,
    updatedAt: now.toISOString(),
  };
  const target = join(backupRoot, `backup-${state.id}.ncf`);
  const publish = () => storage.publishArchive(state, work, backupRoot);
  return { root, work, config, command, storage, state, target, publish, recoveryFile, accountId };
}

posixIt(
  "recovers repeated receipt-only ENOSPC from verified same-generation inputs and restores the real ciphertext",
  async () => {
    const f = await fixture();
    faults.receipt = true;
    for (let attempt = 0; attempt < 2; attempt++) {
      await expect(f.publish()).rejects.toMatchObject({ code: "ENOSPC" });
      expect((await lstat(join(f.work, "archive/backup.ncf"))).size).toBeGreaterThan(12);
      expect(await readdir(f.config.backupRoot)).toEqual([]);
      expect(await readdir(join(f.work, "archive"))).toEqual(["backup.ncf", "backup.tar"]);
    }
    faults.receipt = false;
    const archive = await f.publish();
    expect(await f.publish()).toEqual(archive);
    const result = await restoreEncryptedArchive({
      cipherFile: f.target,
      recoveryFile: f.recoveryFile,
      accountId: f.accountId,
      expectedCipherSha256: archive.sha256,
      generationId: f.state.id,
      destination: join(f.root, "restored"),
    });
    expect(result.objects).toBe(1);
    expect(result.bytes).toBe(3);
    expect(await readFile(join(result.extracted, "blob-copy/objects/00000000.bin"), "utf8")).toBe(
      "abc",
    );
  },
  30_000,
);

posixIt(
  "does not recover an orphan from a different manifest or corrupt copied input, or overwrite an external generation",
  async () => {
    const f = await fixture();
    faults.receipt = true;
    await expect(f.publish()).rejects.toMatchObject({ code: "ENOSPC" });
    faults.receipt = false;
    const orphan = await readFile(join(f.work, "archive/backup.ncf"));
    await expect(
      f.storage.publishArchive(
        { ...f.state, manifestSha256: "0".repeat(64) },
        f.work,
        f.config.backupRoot,
      ),
    ).rejects.toThrow("backup_publication_hash_mismatch");
    await writeFile(join(f.work, "blob-copy/objects/00000000.bin"), "abd", { mode: 0o600 });
    await expect(f.publish()).rejects.toThrow("backup_restore_blob_mismatch");
    await writeFile(join(f.work, "blob-copy/objects/00000000.bin"), "abc", { mode: 0o600 });
    await writeFile(f.target, "existing unrelated archive", { mode: 0o600 });
    await expect(f.publish()).rejects.toThrow("backup_archive_untracked_cipher");
    expect(await readFile(f.target, "utf8")).toBe("existing unrelated archive");
    expect(await readFile(join(f.work, "archive/backup.ncf"))).toEqual(orphan);
  },
  30_000,
);

posixIt(
  "serializes archive staging and refuses concurrent receipt publication",
  async () => {
    const f = await fixture();
    let reached, release;
    const paused = new Promise((resolve) => {
      reached = resolve;
    });
    const barrier = new Promise((resolve) => {
      release = resolve;
    });
    faults.beforeReceipt = async () => {
      reached();
      await barrier;
    };
    const first = f.publish();
    await paused;
    await expect(f.publish()).rejects.toThrow("backup_archive_busy");
    release();
    expect((await first).verified).toBe(true);
    expect((await f.publish()).verified).toBe(true);
  },
  30_000,
);

posixIt(
  "checks actual archive deletion, same-size corruption, unavailable volume and safe completed-week retry without new remote work",
  async () => {
    const f = await fixture(),
      archive = await f.publish();
    const original = await readFile(f.target);
    const state = {
      ...f.state,
      phase: "completed",
      archiveBytes: archive.bytes,
      archiveSha256: archive.sha256,
      archiveVerifiedAt: now.toISOString(),
      completedAt: now.toISOString(),
    };
    const notifications = [];
    const monitorInput = {
      backupState: state,
      billingSnapshot: null,
      liveCheck: { passed: true },
      config: {},
      stateDirectory: join(f.root, "monitor"),
      now,
      storageConfiguration: f.config,
      archiveVerifier: (config, receipt, options) =>
        verifyPublishedArchive(config, receipt, { ...options, command: f.command }),
      notify: async (event) => notifications.push(event),
    };
    expect((await runMonitorCycle(monitorInput)).backup).toBe("healthy");
    const firstCheck = JSON.parse(
      await readFile(join(f.root, "monitor/state.json"), "utf8"),
    ).archiveCheck;
    expect(
      (await runMonitorCycle({ ...monitorInput, now: new Date(now.getTime() + 3_600_000) })).backup,
    ).toBe("healthy");
    expect(
      JSON.parse(await readFile(join(f.root, "monitor/state.json"), "utf8")).archiveCheck
        .digestVerifiedAt,
    ).toBe(firstCheck.digestVerifiedAt);
    const tomorrow = new Date(now.getTime() + 25 * 3_600_000);
    expect((await runMonitorCycle({ ...monitorInput, now: tomorrow })).backup).toBe("healthy");
    expect(
      JSON.parse(await readFile(join(f.root, "monitor/state.json"), "utf8")).archiveCheck
        .digestVerifiedAt,
    ).toBe(tomorrow.toISOString());
    const stateRoot = join(f.root, "weekly-state");
    await mkdir(stateRoot, { mode: 0o700 });
    await writeFile(join(stateRoot, "state.json"), JSON.stringify(state), { mode: 0o600 });
    const runtime = { ...f.storage, deployBegin: vi.fn() };
    const retry = () =>
      runStagingWeeklyBackup({
        stateRoot,
        workRoot: join(f.root, "weekly-work"),
        backupRoot: f.config.backupRoot,
        runtime,
        now: () => now,
      });
    expect((await retry()).phase).toBe("completed");
    await unlink(f.target);
    expect((await runMonitorCycle(monitorInput)).backup).toBe("failed");
    await expect(retry()).rejects.toThrow("backup_archive_missing");
    expect(JSON.parse(await readFile(join(stateRoot, "state.json"), "utf8")).lastError.code).toBe(
      "backup_archive_missing",
    );
    await writeFile(f.target, original, { mode: 0o600 });
    expect((await retry()).lastError).toBeUndefined();
    expect((await runMonitorCycle(monitorInput)).backup).toBe("healthy");
    await unlink(f.target);
    await mkdir(f.target, { mode: 0o700 });
    await expect(f.storage.verifyArchive(state, f.config.backupRoot)).rejects.toThrow(
      "backup_archive_mismatch",
    );
    await rm(f.target, { recursive: true });
    const alias = join(f.root, "pinned-cipher.ncf");
    await writeFile(alias, original, { mode: 0o600 });
    await symlink(alias, f.target);
    await expect(f.storage.verifyArchive(state, f.config.backupRoot)).rejects.toThrow(
      "backup_archive_mismatch",
    );
    await unlink(f.target);
    await writeFile(f.target, original.subarray(0, 12), { mode: 0o600 });
    await expect(f.storage.verifyArchive(state, f.config.backupRoot)).rejects.toThrow(
      "backup_archive_mismatch",
    );
    const corrupt = Buffer.from(original);
    corrupt[corrupt.length - 1] ^= 1;
    await writeFile(f.target, corrupt, { mode: 0o600 });
    expect((await runMonitorCycle(monitorInput)).backup).toBe("failed");
    await expect(retry()).rejects.toThrow("backup_archive_mismatch");
    f.command.mockRejectedValue(new Error("private path and credentials must not escape"));
    expect((await runMonitorCycle(monitorInput)).backup).toBe("unknown");
    await expect(retry()).rejects.toThrow("backup_weekly_storage_unavailable");
    f.command.mockResolvedValue({
      stdout: JSON.stringify({ filesystems: [{ target: f.root, uuid: "ABC123", options: "rw" }] }),
    });
    await writeFile(f.target, original, { mode: 0o600 });
    expect((await retry()).lastError).toBeUndefined();
    expect((await runMonitorCycle(monitorInput)).backup).toBe("healthy");
    expect(runtime.deployBegin).not.toHaveBeenCalled();
    expect(
      notifications.filter((event) => event.category === "backup").map((event) => event.to),
    ).toEqual(["failed", "healthy", "failed", "unknown", "healthy"]);
    expect(JSON.stringify(notifications)).not.toContain(f.root);
    expect(JSON.stringify(notifications)).not.toContain("credentials");
  },
  30_000,
);

posixIt(
  "retains verified-phase recovery material when storage disappears before cleanup, then resumes safely",
  async () => {
    const f = await fixture();
    const archive = await f.publish();
    const original = await readFile(f.target);
    const stateRoot = join(f.root, "pre-cleanup-state");
    await mkdir(stateRoot, { mode: 0o700 });
    await writeFile(
      join(stateRoot, "state.json"),
      JSON.stringify({
        ...f.state,
        phase: "archive_verified",
        archiveBytes: archive.bytes,
        archiveSha256: archive.sha256,
        archiveVerifiedAt: now.toISOString(),
      }),
      { mode: 0o600 },
    );
    const cleanupInternal = vi.fn(),
      runtime = { ...f.storage, cleanupInternal };
    const retry = () =>
      runStagingWeeklyBackup({
        stateRoot,
        workRoot: join(f.root, "pre-cleanup-work"),
        backupRoot: f.config.backupRoot,
        runtime,
        now: () => now,
      });
    await unlink(f.target);
    await expect(retry()).rejects.toThrow("backup_archive_missing");
    expect(cleanupInternal).not.toHaveBeenCalled();
    expect(JSON.parse(await readFile(join(stateRoot, "state.json"), "utf8")).phase).toBe(
      "archive_verified",
    );
    await writeFile(f.target, original, { mode: 0o600 });
    expect((await retry()).phase).toBe("completed");
    expect(cleanupInternal).toHaveBeenCalledOnce();
  },
  30_000,
);
