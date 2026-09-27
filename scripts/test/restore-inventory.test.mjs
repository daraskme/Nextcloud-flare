import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { promisify } from "node:util";
import { beforeEach, expect, it, vi } from "vitest";
import { restoreInventoryRequest } from "../../packages/shared/src/restoreInventory.ts";
import { inventoryRestored } from "../restore/inventory.mjs";

let selected, control;
const handleId = randomUUID(),
  attemptId = randomUUID();
const requests = [
  { action: "verify" },
  { action: "uploads", limit: 2 },
  { action: "bucket", limit: 2 },
  { action: "parts", handleId, limit: 2 },
  { action: "abort", handleId, attemptId },
];
const replies = {
  verify: { verification: { bindingVerified: true, verifiedAt: 30, token: "private" } },
  uploads: {
    uploads: {
      claimed: 1,
      pages: 1,
      observed: 2,
      aborted: 1,
      retried: 0,
      r2Calls: 4,
      source: "private",
    },
  },
  bucket: {
    bucket: {
      examined: 1,
      completed: true,
      handles: [{ id: handleId, state: "quarantined", r2_upload_id: "private" }],
      cursor: "private",
    },
  },
  parts: { parts: { observed: 2, heldBytes: 100, completed: true, key: "private" } },
  abort: {
    abort: { attemptId, outcome: "confirmed", replayed: false, heldBytes: 100, token: "private" },
  },
};
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
    repairInventory: vi.fn(async (_epoch, _id, request) => ({
      ...selected,
      inventory: {
        action: request.action,
        pending: true,
        ...structuredClone(replies[request.action]),
      },
    })),
    resumeRecovery: vi.fn(),
  };
});
const args = (request) => ({ epoch: 2, id: selected.id, request, control });
it.each(requests)(
  "executes one explicit $action operation and sanitizes its result",
  async (request) => {
    const result = await inventoryRestored(args(request));
    expect(result.inventory.action).toBe(request.action);
    expect(result.inventory.pending).toBe(true);
    expect(JSON.stringify(result)).not.toContain("private");
    expect(control.repairInventory).toHaveBeenCalledExactlyOnceWith(2, selected.id, request);
    expect(control.resumeRecovery).not.toHaveBeenCalled();
  },
);
it.each([
  null,
  [],
  {},
  { action: "unknown" },
  { action: "verify", limit: 1 },
  { action: "verify", key: "u/o/b/b" },
  { action: "uploads", limit: 0 },
  { action: "uploads", limit: 21 },
  { action: "bucket", limit: null },
  { action: "bucket", limit: 1.5 },
  { action: "parts", handleId: "bad" },
  { action: "parts" },
  { action: "abort", handleId },
  { action: "abort", handleId, attemptId: "bad" },
  { action: "abort", handleId, attemptId, limit: 1 },
])("rejects invalid inventory input without RPC: %j", async (request) => {
  await expect(inventoryRestored(args(request))).rejects.toThrow(/invalid_inventory_request/);
  expect(control.inspect).not.toHaveBeenCalled();
});
it("normalizes a missing page limit before the RPC", async () => {
  expect(restoreInventoryRequest({ action: "bucket" })).toEqual({ action: "bucket", limit: 20 });
  await inventoryRestored(args({ action: "bucket" }));
  expect(control.repairInventory).toHaveBeenCalledWith(2, selected.id, {
    action: "bucket",
    limit: 20,
  });
});
it("never retries an unknown abort RPC", async () => {
  control.repairInventory.mockRejectedValue(new Error("database_restore_operator_timeout"));
  await expect(inventoryRestored(args(requests[4]))).rejects.toThrow(/timeout/);
  expect(control.repairInventory).toHaveBeenCalledTimes(1);
  expect(control.resumeRecovery).not.toHaveBeenCalled();
});
it.each([
  ["verify", { bindingVerified: false }],
  ["verify", { verifiedAt: 19 }],
  ["uploads", { claimed: 3 }],
  ["uploads", { pages: 2 }],
  ["uploads", { observed: 21 }],
  ["uploads", { aborted: 11 }],
  ["uploads", { retried: 2 }],
  ["uploads", { r2Calls: 14 }],
  ["bucket", { examined: 2 }],
  ["bucket", { completed: 1 }],
  ["bucket", { handles: [{ id: "bad", state: "quarantined" }] }],
  ["bucket", { handles: [{ id: handleId, state: "closed" }] }],
  ["parts", { observed: 3 }],
  ["parts", { heldBytes: -1 }],
  ["parts", { completed: "true" }],
  ["abort", { attemptId: randomUUID() }],
  ["abort", { outcome: "started" }],
  ["abort", { replayed: 1 }],
  ["abort", { heldBytes: Number.MAX_SAFE_INTEGER + 1 }],
])("rejects malformed %s result: %j", async (action, change) => {
  const request = requests.find((r) => r.action === action),
    raw = await control.repairInventory(2, selected.id, request);
  Object.assign(raw.inventory[action === "verify" ? "verification" : action], change);
  control.repairInventory.mockResolvedValue(raw);
  await expect(inventoryRestored(args(request))).rejects.toThrow(/invalid_inventory_result/);
});
it.each(["bucket", "parts", "abort"])("rejects a false closure claim from %s", async (action) => {
  const request = requests.find((r) => r.action === action),
    raw = await control.repairInventory(2, selected.id, request);
  raw.inventory.pending = false;
  control.repairInventory.mockResolvedValue(raw);
  await expect(inventoryRestored(args(request))).rejects.toThrow(/invalid_inventory_result/);
});
it("rejects repeated operator handle IDs within one inventory page", async () => {
  const request = requests[2],
    raw = await control.repairInventory(2, selected.id, request);
  raw.inventory.bucket.examined = 2;
  raw.inventory.bucket.handles.push({ ...raw.inventory.bucket.handles[0] });
  control.repairInventory.mockResolvedValue(raw);
  await expect(inventoryRestored(args(request))).rejects.toThrow(/invalid_inventory_result/);
});
it.each(["id", "epoch", "action", "pending", "released"])(
  "rejects mismatched request/result %s",
  async (field) => {
    const raw = await control.repairInventory(2, selected.id, requests[0]);
    if (field === "id") raw.id = randomUUID();
    if (field === "epoch") raw.newEpoch = 4;
    if (field === "action") raw.inventory.action = "bucket";
    if (field === "pending") raw.inventory.pending = 1;
    if (field === "released") {
      raw.state = "recovery_ready";
      raw.recoveryReleasedAt = 40;
    }
    control.repairInventory.mockResolvedValue(raw);
    await expect(inventoryRestored(args(requests[0]))).rejects.toThrow(/invalid_/);
  },
);
it.each([
  ["--local", "--action", "verify"],
  ["--remote"],
  ["--remote", "--action", "unknown"],
  ["--remote", "--action", "parts"],
  ["--remote", "--action", "abort", "--handle-id", handleId],
  ["--remote", "--action", "verify", "--limit", "1"],
  ["--remote", "--action", "uploads", "--limit", "0"],
  ["--remote", "--action", "bucket", "--limit", "21"],
  ["--remote", "--action", "bucket", "--limit", "1.5"],
  ["--remote", "--action", "uploads", "--max-pages", "2"],
])("rejects invalid CLI arguments before capability loading %j", async (...extra) => {
  await expect(
    promisify(execFile)(process.execPath, [
      "scripts/database-restore.mjs",
      "inventory-restored",
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
