import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { promisify } from "node:util";
import { beforeEach, expect, it, vi } from "vitest";
import {
  auditRestored,
  rebuildRestoredFts,
  repairRestoredNative,
  resumeRestored,
} from "../restore/recovery.mjs";

let selected, control, page;
const live = () => ({
  kdf: { checked: 0, reconciled: 0, pending: 0, unknown: 0 },
  r2: { checked: 0, reconciled: 0, pending: 0, unknown: 0 },
});
const audit = (stage = "complete", pages = 10) => ({
  epoch: 3,
  stage,
  pages,
  afterId: "",
  completed: stage === "complete",
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
  page = audit();
  control = {
    inspect: vi.fn(async () => structuredClone(selected)),
    repairNative: vi.fn(async () => ({
      ...selected,
      repair: {
        stage: "complete",
        afterId: "",
        checked: 3,
        reconciled: 2,
        unknown: 1,
        completed: true,
        live: live(),
        databasePending: { kdf: 0, r2: 1 },
        token: "private",
      },
    })),
    auditRecovery: vi.fn(async () => ({ ...selected, audit: page })),
    rebuildRecoveryFts: vi.fn(async () => ({ ...selected, audit: audit("users", 0) })),
    releaseRecovery: vi.fn(async () => {
      selected = { ...selected, state: "recovery_ready", recoveryReleasedAt: 30 };
      return selected;
    }),
    resumeRecovery: vi.fn(async () => {
      selected.state = "service_resumed";
      return {
        ...selected,
        control: { epoch: 3, maintenance: false, gcPaused: true, token: "private" },
      };
    }),
    resumeRecoveryGc: vi.fn(async () => {
      selected.state = "gc_resumed";
      return { ...selected, control: { epoch: 3, maintenance: false, gcPaused: false } };
    }),
  };
});
const args = () => ({ epoch: 2, id: selected.id, control });

it("reports unknown native rows separately from a complete scan without opening admission", async () => {
  const result = await repairRestoredNative(args());
  expect(result.repair).toEqual({
    stage: "complete",
    afterId: "",
    checked: 3,
    reconciled: 2,
    unknown: 1,
    completed: true,
    live: live(),
    databasePending: { kdf: 0, r2: 1 },
    pending: true,
  });
  expect(JSON.stringify(result)).not.toContain("private");
  expect(control.releaseRecovery).not.toHaveBeenCalled();
});
it("respects the native page budget and retains server progress", async () => {
  control.repairNative.mockResolvedValue({
    ...selected,
    repair: {
      stage: "kdf",
      afterId: selected.id,
      checked: 1,
      reconciled: 1,
      unknown: 0,
      completed: false,
      live: live(),
      databasePending: { kdf: 0, r2: 0 },
    },
  });
  expect(
    (await repairRestoredNative({ ...args(), maxPages: 2, pageSize: 1 })).repair.completed,
  ).toBe(false);
  expect(control.repairNative).toHaveBeenCalledTimes(2);
  expect(control.repairNative).toHaveBeenLastCalledWith(2, selected.id, 1);
});
it.each(["kdf", "r2", "database-kdf", "database-r2"])(
  "keeps a completed historical scan pending when %s holds remain",
  async (kind) => {
    const value = await control.repairNative();
    control.repairNative.mockClear();
    value.repair.checked = value.repair.reconciled = value.repair.unknown = 0;
    value.repair.databasePending = { kdf: 0, r2: 0 };
    if (kind.startsWith("database-")) value.repair.databasePending[kind.slice(9)] = 1;
    else value.repair.live[kind] = { checked: 0, reconciled: 0, pending: 1, unknown: 1 };
    control.repairNative.mockResolvedValue(value);
    const result = await repairRestoredNative(args());
    expect(result.repair).toMatchObject({ completed: true, unknown: 0, pending: true });
    expect(control.repairNative).toHaveBeenCalledTimes(1);
    expect(control.releaseRecovery).not.toHaveBeenCalled();
  },
);
it("clears pending only when the scan, local holds and database holds are all clear", async () => {
  const value = await control.repairNative();
  value.repair.unknown = 0;
  value.repair.checked = value.repair.reconciled;
  value.repair.databasePending.r2 = 0;
  value.repair.live.kdf = { checked: 2, reconciled: 2, pending: 0, unknown: 0, token: "private" };
  control.repairNative.mockResolvedValue(value);
  const result = await repairRestoredNative(args());
  expect(result.repair.pending).toBe(false);
  expect(JSON.stringify(result)).not.toContain("private");
});
it.each([
  ["live", undefined],
  ["live", { kdf: {} }],
  ["databasePending", undefined],
  ["databasePending", { kdf: -1, r2: 0 }],
  ["databasePending", { kdf: 0, r2: "0" }],
])("rejects missing or invalid %s counts", async (key, replacement) => {
  const value = await control.repairNative();
  value.repair[key] = replacement;
  control.repairNative.mockResolvedValue(value);
  await expect(repairRestoredNative(args())).rejects.toThrow(/invalid_native_repair/);
});
it.each([
  ["kdf", "checked", 11],
  ["r2", "checked", -1],
  ["kdf", "reconciled", 1],
  ["r2", "reconciled", 1.5],
  ["kdf", "pending", 21],
  ["r2", "pending", 33],
  ["r2", "unknown", 1],
])("rejects invalid live %s %s count", async (kind, field, count) => {
  const value = await control.repairNative();
  value.repair.live[kind][field] = count;
  control.repairNative.mockResolvedValue(value);
  await expect(repairRestoredNative(args())).rejects.toThrow(/invalid_native_repair/);
});
it.each(["stage", "counts", "completed", "id"])(
  "rejects invalid native repair output: %s",
  async (kind) => {
    const value = await control.repairNative();
    control.repairNative.mockClear();
    if (kind === "stage") value.repair.stage = "unknown";
    if (kind === "counts") value.repair.unknown = 4;
    if (kind === "completed") value.repair.completed = false;
    if (kind === "id") value.id = randomUUID();
    control.repairNative.mockResolvedValue(value);
    await expect(repairRestoredNative(args())).rejects.toThrow(/invalid_/);
    expect(control.repairNative).toHaveBeenCalledTimes(1);
  },
);
it("does not automatically retry an unknown native repair RPC", async () => {
  control.repairNative.mockRejectedValue(new Error("database_restore_operator_timeout"));
  await expect(repairRestoredNative(args())).rejects.toThrow(/timeout/);
  expect(control.repairNative).toHaveBeenCalledTimes(1);
});
it.each([{ maxPages: 0 }, { maxPages: 101 }, { pageSize: 0 }, { pageSize: 21 }])(
  "rejects invalid native bounds before RPC: %j",
  async (limits) => {
    await expect(repairRestoredNative({ ...args(), ...limits })).rejects.toThrow(
      /invalid_recovery_limit/,
    );
    expect(control.inspect).not.toHaveBeenCalled();
  },
);

it("returns sanitized complete audit evidence without releasing or resuming", async () => {
  const result = await auditRestored(args());
  expect(result.audit).toEqual({
    epoch: 3,
    stage: "complete",
    pages: 10,
    afterId: "",
    completed: true,
  });
  expect(control.releaseRecovery).not.toHaveBeenCalled();
  expect(control.resumeRecovery).not.toHaveBeenCalled();
  expect(JSON.stringify(result)).not.toContain("private");
});
it("stops at the page budget and leaves durable progress for the next invocation", async () => {
  page = audit("users", 1);
  const result = await auditRestored({ ...args(), maxPages: 2, pageSize: 20 });
  expect(result.audit.completed).toBe(false);
  expect(control.auditRecovery).toHaveBeenCalledTimes(2);
  expect(control.auditRecovery).toHaveBeenLastCalledWith(2, selected.id, 20);
});
it.each([{ maxPages: 0 }, { maxPages: 101 }, { pageSize: 21 }, { pageSize: 0 }])(
  "rejects invalid page limits %j",
  async (limits) => {
    await expect(auditRestored({ ...args(), ...limits })).rejects.toThrow(/invalid_recovery_limit/);
    expect(control.inspect).not.toHaveBeenCalled();
  },
);
it.each(["epoch", "stage", "completed", "pages"])("rejects malformed audit %s", async (key) => {
  page[key] = key === "epoch" ? 2 : key === "stage" ? "unknown" : key === "completed" ? false : -1;
  await expect(auditRestored(args())).rejects.toThrow(/invalid_recovery_audit/);
});
it("does not retry a failed audit page or release its hold", async () => {
  control.auditRecovery.mockRejectedValue(new Error("recovery_final_fence_pending"));
  await expect(auditRestored(args())).rejects.toThrow(/final_fence_pending/);
  expect(control.auditRecovery).toHaveBeenCalledTimes(1);
  expect(control.releaseRecovery).not.toHaveBeenCalled();
});
it("rebuilds FTS explicitly and returns the restarted audit", async () => {
  expect((await rebuildRestoredFts(args())).audit).toEqual({
    epoch: 3,
    stage: "users",
    pages: 0,
    afterId: "",
    completed: false,
  });
  expect(control.resumeRecovery).not.toHaveBeenCalled();
});
it("releases the exact completed audit before opening service, leaving GC to a separate call", async () => {
  const opened = await resumeRestored(args());
  expect(opened.state).toBe("service_resumed");
  expect(opened.control).toEqual({ epoch: 3, maintenance: false, gcPaused: true });
  expect(control.releaseRecovery.mock.invocationCallOrder[0]).toBeLessThan(
    control.resumeRecovery.mock.invocationCallOrder[0],
  );
  expect(control.resumeRecoveryGc).not.toHaveBeenCalled();
  expect((await resumeRestored({ ...args(), gc: true })).control.gcPaused).toBe(false);
  expect(control.releaseRecovery).toHaveBeenCalledTimes(1);
});
it("keeps admission closed when release is rejected", async () => {
  control.releaseRecovery.mockRejectedValue(new Error("recovery_audit_incomplete"));
  await expect(resumeRestored(args())).rejects.toThrow(/audit_incomplete/);
  expect(control.resumeRecovery).not.toHaveBeenCalled();
});
it("never retries an unknown opening response", async () => {
  control.resumeRecovery.mockRejectedValue(new Error("database_restore_operator_timeout"));
  await expect(resumeRestored(args())).rejects.toThrow(/timeout/);
  expect(control.resumeRecovery).toHaveBeenCalledTimes(1);
  expect(control.resumeRecoveryGc).not.toHaveBeenCalled();
});
it("refuses GC before service has resumed", async () => {
  await expect(resumeRestored({ ...args(), gc: true })).rejects.toThrow(/not_resumed/);
  expect(control.releaseRecovery).not.toHaveBeenCalled();
  expect(control.resumeRecoveryGc).not.toHaveBeenCalled();
});
it("reports current GC policy on replay instead of pretending a later pause was undone", async () => {
  selected = { ...selected, state: "gc_resumed", recoveryReleasedAt: 30 };
  control.resumeRecoveryGc.mockResolvedValue({
    ...selected,
    control: { epoch: 3, maintenance: false, gcPaused: true },
  });
  expect((await resumeRestored({ ...args(), gc: true })).control.gcPaused).toBe(true);
});
it("rejects a mismatched request returned by a resume RPC", async () => {
  control.resumeRecovery.mockResolvedValue({
    ...selected,
    state: "service_resumed",
    recoveryReleasedAt: 30,
    id: randomUUID(),
    control: { epoch: 3, maintenance: false, gcPaused: true },
  });
  await expect(resumeRestored(args())).rejects.toThrow(/invalid_status/);
});
it.each([
  ["repair-restored-native", "--local"],
  ["repair-restored-native", "--remote", "--max-pages", "0"],
  ["audit-restored", "--local"],
  ["audit-restored", "--remote", "--max-pages", "0"],
  ["resume-restored", "--remote", "--page-size", "20"],
  ["resume-restored-gc", "--local"],
])("rejects invalid recovery CLI arguments before opening a capability: %j", async (...extra) => {
  await expect(
    promisify(execFile)(process.execPath, [
      "scripts/database-restore.mjs",
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
