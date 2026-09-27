import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { promisify } from "node:util";
import { beforeEach, expect, it, vi } from "vitest";
import { auditRestored, rebuildRestoredFts, resumeRestored } from "../restore/recovery.mjs";

let selected, control, page;
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
