import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { promisify } from "node:util";
import { beforeEach, expect, it, vi } from "vitest";
import { RESTORE_DOMAIN_KINDS } from "../../packages/shared/src/restoreDomain.ts";
import { repairRestoredDomain } from "../restore/recovery.mjs";

let selected, control;
const cleanup = () => ({
  claimed: 1,
  absent: 0,
  queued: 0,
  retried: 1,
  r2Calls: 1,
  token: "private",
});
beforeEach(() => {
  selected = {
    epoch: 2,
    id: randomUUID(),
    newEpoch: 3,
    state: "epoch_adopted",
    createdAt: 10,
    snapshotVerifiedAt: 20,
    source: { kind: "time_travel", bookmark: "selected" },
    restoreResult: { bookmark: "restored", previousBookmark: "before" },
  };
  control = {
    inspect: vi.fn(async () => selected),
    repairDomain: vi.fn(async (_epoch, _id, kind) => ({
      ...selected,
      repair: {
        kind,
        pending: true,
        token: "private",
        ...(["single", "multipart"].includes(kind)
          ? { cleanup: cleanup(), held: 0 }
          : kind === "reservations"
            ? { released: 1 }
            : kind === "outbox"
              ? { failed: 1 }
              : kind === "orphan-inventory"
                ? {
                    inventory: {
                      claimed: true,
                      examined: 2,
                      observed: 1,
                      advanced: true,
                      completed: false,
                      r2Calls: 2,
                      cursor: "private",
                    },
                  }
                : {
                    cleanup: {
                      claimed: 1,
                      deleted: 0,
                      retried: 1,
                      r2Calls: 1,
                      ...(kind === "orphan-gc" ? { changed: 0 } : {}),
                      token: "private",
                    },
                  }),
      },
    })),
    releaseRecovery: vi.fn(),
    resumeRecovery: vi.fn(),
  };
  const repair = control.repairDomain.getMockImplementation();
  control.repairDomain.mockImplementation(async (...args) => {
    const raw = await repair(...args);
    if (args[2] === "images")
      raw.repair.cleanup = {
        inspected: 1,
        retired: 1,
        settled: 0,
        held: 1,
        r2Calls: 1,
        token: "private",
        key: "private",
      };
    return raw;
  });
});
const args = () => ({ epoch: 2, id: selected.id, kind: "single", control });
it.each(RESTORE_DOMAIN_KINDS)(
  "executes one bounded %s pass and sanitizes its result",
  async (kind) => {
    const result = await repairRestoredDomain({ ...args(), kind, limit: 2 });
    expect(result.repair).toMatchObject({ kind, pending: true });
    expect(control.repairDomain).toHaveBeenCalledExactlyOnceWith(2, selected.id, kind, 2);
    expect(JSON.stringify(result)).not.toContain("private");
    expect(control.releaseRecovery).not.toHaveBeenCalled();
    expect(control.resumeRecovery).not.toHaveBeenCalled();
  },
);
it("preserves pending even when no upload is eligible for cleanup", async () => {
  const result = await control.repairDomain(2, selected.id, "multipart");
  result.repair.cleanup = { claimed: 0, absent: 0, queued: 0, retried: 0, r2Calls: 0 };
  result.repair.held = 1;
  control.repairDomain.mockResolvedValue(result);
  expect((await repairRestoredDomain({ ...args(), kind: "multipart" })).repair).toMatchObject({
    pending: true,
    held: 1,
  });
});
it.each([{ kind: "unknown" }, { limit: 0 }, { limit: 21 }, { limit: 1.5 }])(
  "rejects invalid bounds before RPC: %j",
  async (input) => {
    await expect(repairRestoredDomain({ ...args(), ...input })).rejects.toThrow(/invalid_/);
    expect(control.inspect).not.toHaveBeenCalled();
  },
);
it("does not retry an unknown repair RPC or resume admission", async () => {
  control.repairDomain.mockRejectedValue(new Error("database_restore_operator_timeout"));
  await expect(repairRestoredDomain(args())).rejects.toThrow(/timeout/);
  expect(control.repairDomain).toHaveBeenCalledTimes(1);
  expect(control.resumeRecovery).not.toHaveBeenCalled();
});
it.each(["released", "id", "kind", "pending", "count", "sum", "r2", "held"])(
  "rejects an invalid domain reply: %s",
  async (mode) => {
    const raw = await control.repairDomain(2, selected.id, "single");
    if (mode === "released") {
      raw.state = "recovery_ready";
      raw.recoveryReleasedAt = 30;
    }
    if (mode === "id") raw.id = randomUUID();
    if (mode === "kind") raw.repair.kind = "multipart";
    if (mode === "pending") raw.repair.pending = 0;
    if (mode === "count") raw.repair.cleanup.claimed = -1;
    if (mode === "sum") raw.repair.cleanup.absent = 1;
    if (mode === "r2") raw.repair.cleanup.r2Calls = 2;
    if (mode === "held") raw.repair.held = 1;
    control.repairDomain.mockResolvedValue(raw);
    await expect(repairRestoredDomain(args())).rejects.toThrow(/invalid_/);
  },
);
it.each(["reservations", "outbox"])("rejects an excessive %s repair count", async (kind) => {
  const raw = await control.repairDomain(2, selected.id, kind);
  raw.repair[kind === "reservations" ? "released" : "failed"] = 21;
  control.repairDomain.mockResolvedValue(raw);
  await expect(repairRestoredDomain({ ...args(), kind })).rejects.toThrow(/invalid_/);
});
it.each([
  ["blob-gc", "claimed", 21],
  ["blob-gc", "deleted", 1],
  ["blob-gc", "r2Calls", 3],
  ["orphan-gc", "changed", undefined],
  ["orphan-gc", "changed", -1],
  ["orphan-gc", "changed", 1],
  ["orphan-gc", "r2Calls", 4],
])("rejects invalid GC counts %s %s=%s", async (kind, field, value) => {
  const raw = await control.repairDomain(2, selected.id, kind);
  raw.repair.cleanup[field] = value;
  control.repairDomain.mockResolvedValue(raw);
  await expect(repairRestoredDomain({ ...args(), kind })).rejects.toThrow(/invalid_/);
});
it.each([
  { inspected: 9 },
  { inspected: 0 },
  { retired: 2 },
  { retired: 0, settled: 1, held: 0 },
  { settled: 1 },
  { held: -1 },
  { held: 0.5 },
  { r2Calls: 2 },
  { r2Calls: undefined },
])("rejects invalid image repair counts %j", async (change) => {
  const raw = await control.repairDomain(2, selected.id, "images");
  Object.assign(raw.repair.cleanup, change);
  control.repairDomain.mockResolvedValue(raw);
  await expect(repairRestoredDomain({ ...args(), kind: "images" })).rejects.toThrow(/invalid_/);
});
it("reports an ineligible image hold without claiming completion or retrying", async () => {
  const raw = await control.repairDomain(2, selected.id, "images");
  raw.repair.cleanup = { inspected: 0, retired: 0, settled: 0, held: 0, r2Calls: 0 };
  control.repairDomain.mockClear().mockResolvedValue(raw);
  expect((await repairRestoredDomain({ ...args(), kind: "images" })).repair).toEqual({
    kind: "images",
    pending: true,
    cleanup: raw.repair.cleanup,
  });
  expect(control.repairDomain).toHaveBeenCalledTimes(1);
});
it("accepts image settlement without HEAD when physical storage was already recorded", async () => {
  const raw = await control.repairDomain(2, selected.id, "images");
  raw.repair.pending = false;
  raw.repair.cleanup = { inspected: 1, retired: 1, settled: 1, held: 0, r2Calls: 0 };
  control.repairDomain.mockResolvedValue(raw);
  expect((await repairRestoredDomain({ ...args(), kind: "images", limit: 1 })).repair.pending).toBe(
    false,
  );
});
it.each([
  { claimed: 1 },
  { claimed: false },
  { examined: 21 },
  { observed: 3 },
  { r2Calls: 4 },
  { advanced: true, r2Calls: 0 },
  { advanced: false, completed: true },
  { completed: true },
])("rejects inconsistent inventory replies %j", async (change) => {
  const raw = await control.repairDomain(2, selected.id, "orphan-inventory");
  Object.assign(raw.repair.inventory, change);
  control.repairDomain.mockResolvedValue(raw);
  await expect(repairRestoredDomain({ ...args(), kind: "orphan-inventory" })).rejects.toThrow(
    /invalid_/,
  );
});
it("accepts a completed inventory page with no remaining walk", async () => {
  const raw = await control.repairDomain(2, selected.id, "orphan-inventory");
  raw.repair.inventory.completed = true;
  raw.repair.pending = false;
  control.repairDomain.mockResolvedValue(raw);
  expect((await repairRestoredDomain({ ...args(), kind: "orphan-inventory" })).repair.pending).toBe(
    false,
  );
});
it.each([
  ["--local", "--kind", "single"],
  ["--remote"],
  ["--remote", "--kind", "unknown"],
  ["--remote", "--kind", "single", "--limit", "0"],
  ["--remote", "--kind", "multipart", "--limit", "21"],
  ["--remote", "--kind", "outbox", "--max-pages", "2"],
])("rejects invalid CLI arguments without loading a capability: %j", async (...extra) => {
  await expect(
    promisify(execFile)(process.execPath, [
      "scripts/database-restore.mjs",
      "repair-restored",
      ...extra,
      "--operator-config",
      "missing.json",
      "--epoch",
      "2",
      "--id",
      selected.id,
    ]),
  ).rejects.toMatchObject({
    stderr: expect.stringContaining("database_restore_invalid_arguments"),
  });
});
