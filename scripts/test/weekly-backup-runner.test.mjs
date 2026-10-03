import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  japaneseBackupWeek,
  runStagingWeeklyBackup,
} from "../../ops/staging/weekly-backup-runner.mjs";

const HASH = "a".repeat(64);
const posixIt = it.skipIf(process.platform === "win32");
let root, stateRoot, workRoot, backupRoot, calls, runtime;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "ncf-weekly-backup-"));
  stateRoot = join(root, "state");
  workRoot = join(root, "work");
  backupRoot = join(root, "external");
  await mkdir(backupRoot, { mode: 0o700 });
  calls = [];
  runtime = Object.fromEntries(
    [
      "verifyStorage",
      "currentEpoch",
      "deployBegin",
      "waitFrozen",
      "capture",
      "publish",
      "restore",
      "audit",
      "deployComplete",
      "waitCompleted",
      "deleteBridge",
      "publishArchive",
      "cleanupInternal",
    ].map((step) => [
      step,
      vi.fn(async (state) => {
        calls.push({ step, id: state?.id });
        if (step === "currentEpoch") return 7;
        if (step === "publish") return HASH;
        if (step === "publishArchive") return { bytes: 123, sha256: HASH, verified: true };
      }),
    ]),
  );
});
afterEach(async () => rm(root, { recursive: true, force: true }));
const run = (date = "2026-10-04T00:30:00Z") =>
  runStagingWeeklyBackup({
    stateRoot,
    workRoot,
    backupRoot,
    runtime,
    now: () => new Date(date),
  });

it("uses the JST Sunday week across the UTC date boundary", () => {
  expect(japaneseBackupWeek(new Date("2026-10-03T15:29:00Z"))).toBe("2026-10-04");
  expect(japaneseBackupWeek(new Date("2026-10-05T12:00:00Z"))).toBe("2026-10-04");
  expect(japaneseBackupWeek(new Date("2026-10-10T15:00:00Z"))).toBe("2026-10-11");
});

it.skipIf(process.platform !== "win32")(
  "rejects an internal state path on the external volume before any action",
  async () => {
    stateRoot = backupRoot;
    await expect(run()).rejects.toThrow("backup_weekly_unconfigured");
    expect(runtime.verifyStorage).not.toHaveBeenCalled();
  },
);

posixIt("resumes the same frozen generation after an offline restore failure", async () => {
  runtime.restore.mockRejectedValueOnce(new Error("backup_store_timeout"));
  await expect(run()).rejects.toThrow("backup_store_timeout");
  const failed = JSON.parse(await readFile(join(stateRoot, "state.json"), "utf8"));
  expect(failed.phase).toBe("published");
  expect(failed.lastError.code).toBe("backup_store_timeout");
  const completed = await run();
  expect(completed.phase).toBe("completed");
  expect(completed.id).toBe(failed.id);
  expect(completed.epoch).toBe(7);
  expect(runtime.currentEpoch).toHaveBeenCalledTimes(1);
  expect(completed.archiveSha256).toBe(HASH);
  expect(runtime.deployBegin).toHaveBeenCalledTimes(1);
  expect(runtime.capture).toHaveBeenCalledTimes(1);
  expect(runtime.publish).toHaveBeenCalledTimes(1);
  expect(runtime.restore).toHaveBeenCalledTimes(2);
  expect(runtime.deleteBridge).toHaveBeenCalledTimes(1);
  await run("2026-10-05T00:30:00Z");
  expect(runtime.deployBegin).toHaveBeenCalledTimes(1);
});

posixIt("preserves completed remote receipt while an encrypted archive is retried", async () => {
  runtime.publishArchive.mockRejectedValueOnce(new Error("backup_archive_write_failed"));
  await expect(run()).rejects.toThrow("backup_archive_write_failed");
  const failed = JSON.parse(await readFile(join(stateRoot, "state.json"), "utf8"));
  expect(failed.phase).toBe("bridge_deleted");
  await run();
  expect(runtime.deployBegin).toHaveBeenCalledTimes(1);
  expect(runtime.deployComplete).toHaveBeenCalledTimes(1);
  expect(runtime.deleteBridge).toHaveBeenCalledTimes(1);
  expect(runtime.publishArchive).toHaveBeenCalledTimes(2);
  expect(runtime.cleanupInternal).toHaveBeenCalledTimes(1);
});

posixIt("records a missing external volume before any remote backup action", async () => {
  runtime.verifyStorage.mockRejectedValueOnce(new Error("backup_weekly_storage_unavailable"));
  await expect(run()).rejects.toThrow("backup_weekly_storage_unavailable");
  const state = JSON.parse(await readFile(join(stateRoot, "state.json"), "utf8"));
  expect(state.phase).toBe("created");
  expect(state.lastError.code).toBe("backup_weekly_storage_unavailable");
  expect(runtime.deployBegin).not.toHaveBeenCalled();
  expect(runtime.capture).not.toHaveBeenCalled();
  expect(runtime.currentEpoch).not.toHaveBeenCalled();
  await run();
  expect(runtime.deployBegin).toHaveBeenCalledTimes(1);
});

posixIt("rejects an invalid live epoch without assigning a generation epoch", async () => {
  runtime.currentEpoch.mockResolvedValue(0);
  await expect(run()).rejects.toThrow("backup_epoch_invalid");
  const state = JSON.parse(await readFile(join(stateRoot, "state.json"), "utf8"));
  expect(state).toMatchObject({
    phase: "created",
    epoch: null,
    lastError: { code: "backup_epoch_invalid" },
  });
  expect(runtime.deployBegin).not.toHaveBeenCalled();
});

posixIt("preserves the storage adapter's read-only error for local monitoring", async () => {
  runtime.verifyStorage.mockRejectedValueOnce(new Error("backup_volume_read_only"));
  await expect(run()).rejects.toThrow("backup_weekly_storage_read_only");
  const state = JSON.parse(await readFile(join(stateRoot, "state.json"), "utf8"));
  expect(state.lastError.code).toBe("backup_weekly_storage_read_only");
  expect(runtime.currentEpoch).not.toHaveBeenCalled();
  expect(runtime.deployBegin).not.toHaveBeenCalled();
});

posixIt(
  "fails closed after a frozen error without deleting the bridge or starting a second ID",
  async () => {
    runtime.audit.mockRejectedValueOnce(new Error("backup_blob_etag_mismatch"));
    await expect(run()).rejects.toThrow("backup_blob_etag_mismatch");
    const failed = JSON.parse(await readFile(join(stateRoot, "state.json"), "utf8"));
    expect(failed.phase).toBe("restored");
    expect(runtime.deployComplete).not.toHaveBeenCalled();
    expect(runtime.deleteBridge).not.toHaveBeenCalled();
    const retried = await run("2026-10-11T00:30:00Z");
    expect(retried.id).toBe(failed.id);
    expect(retried.week).toBe(failed.week);
  },
);

posixIt(
  "retains an unfinished generation's original epoch when the live epoch changes",
  async () => {
    runtime.restore.mockRejectedValueOnce(new Error("backup_store_timeout"));
    await expect(run()).rejects.toThrow("backup_store_timeout");
    const before = JSON.parse(await readFile(join(stateRoot, "state.json"), "utf8"));
    expect(before.epoch).toBe(7);
    runtime.currentEpoch.mockResolvedValue(8);
    runtime.restore.mockRejectedValueOnce(new Error("backup_epoch_changed"));
    await expect(run("2026-10-11T00:30:00Z")).rejects.toThrow("backup_epoch_changed");
    const after = JSON.parse(await readFile(join(stateRoot, "state.json"), "utf8"));
    expect(after).toMatchObject({ id: before.id, epoch: 7, phase: "published" });
    expect(runtime.currentEpoch).toHaveBeenCalledTimes(1);
    expect(runtime.deployBegin).toHaveBeenCalledTimes(1);
  },
);
