import { lstat, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { validateCronConfig } from "../../ops/staging/backup-cron-config.mjs";
import {
  completedBridgeWaitMs,
  preparePrivateBridgeConfig,
} from "../../ops/staging/weekly-backup-runtime.mjs";

const MINUTE = 60_000;
const CHUNK = 8 * 1024 * 1024;
const completionState = { id: "11111111-2222-4333-8444-555555555555", epoch: 7 };
function sqlManifest(bytes) {
  return {
    generation: { id: completionState.id, epoch: completionState.epoch },
    data: { file: "data.sql", bytes },
  };
}

const roots = [];
const posixIt = it.skipIf(process.platform === "win32");
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

it("budgets propagation and one cron tick per four SQL parts, excluding blob copy size", () => {
  expect(completedBridgeWaitMs(completionState, sqlManifest(1))).toBe(21 * MINUTE);
  expect(completedBridgeWaitMs(completionState, sqlManifest(4 * CHUNK))).toBe(21 * MINUTE);
  expect(completedBridgeWaitMs(completionState, sqlManifest(4 * CHUNK + 1))).toBe(22 * MINUTE);
  expect(
    completedBridgeWaitMs(completionState, {
      ...sqlManifest(4 * CHUNK + 1),
      blobs: { bytes: 10 * 1024 ** 3 },
    }),
  ).toBe(22 * MINUTE);
  expect(completedBridgeWaitMs(completionState, sqlManifest(10 * 1024 ** 3))).toBe(340 * MINUTE);
  expect(completedBridgeWaitMs(completionState, sqlManifest(11 * 1024 ** 3))).toBe(360 * MINUTE);
});

it("rejects missing, mismatched or unbounded local SQL manifest input", () => {
  for (const manifest of [
    undefined,
    {},
    { generation: { ...completionState } },
    { ...sqlManifest(1), generation: { ...completionState, epoch: 8 } },
    { ...sqlManifest(1), generation: { ...completionState, id: "other" } },
    { ...sqlManifest(1), data: { file: "blob-copy", bytes: 1 } },
    sqlManifest(0),
    sqlManifest(-1),
    sqlManifest(1.5),
    sqlManifest(Number.MAX_SAFE_INTEGER),
  ])
    expect(() => completedBridgeWaitMs(completionState, manifest)).toThrow(
      "backup_generation_conflict",
    );
});

posixIt(
  "keeps the pinned bridge script and config in private work storage across an operation retry",
  async () => {
    const root = await mkdtemp(join(tmpdir(), "ncf-weekly-bridge-"));
    roots.push(root);
    const env = { CLOUDFLARE_ACCOUNT_ID: "a".repeat(32) };
    const state = {
      id: "11111111-2222-4333-8444-555555555555",
      epoch: 7,
      manifestSha256: "b".repeat(64),
    };
    const path = await preparePrivateBridgeConfig(env, state, "begin", root);
    expect(path.startsWith(join(root, state.id, "bridge"))).toBe(true);
    expect((await lstat(dirname(path))).mode & 0o077).toBe(0);
    expect((await lstat(path)).mode & 0o077).toBe(0);
    expect((await lstat(join(dirname(path), "backup-cron.mjs"))).mode & 0o077).toBe(0);
    expect(validateCronConfig(JSON.parse(await readFile(path, "utf8"))).vars.BACKUP_EPOCH).toBe(
      "7",
    );
    await preparePrivateBridgeConfig(env, state, "complete", root);
    expect(validateCronConfig(JSON.parse(await readFile(path, "utf8"))).vars.BACKUP_OPERATION).toBe(
      "complete",
    );
    await expect(
      preparePrivateBridgeConfig(env, { ...state, epoch: 8 }, "begin", root),
    ).rejects.toThrow("staging_backup_cron_identity_conflict");
    await writeFile(join(dirname(path), "backup-cron.mjs"), "altered");
    await expect(preparePrivateBridgeConfig(env, state, "complete", root)).rejects.toThrow(
      "backup_bridge_source_changed",
    );
  },
);

it.skipIf(process.platform !== "win32")(
  "rejects a relative bridge work root before creating files",
  async () => {
    await expect(
      preparePrivateBridgeConfig(
        { CLOUDFLARE_ACCOUNT_ID: "a".repeat(32) },
        { id: "11111111-2222-4333-8444-555555555555", epoch: 7 },
        "begin",
        "relative-work",
      ),
    ).rejects.toThrow("backup_weekly_unconfigured");
  },
);
