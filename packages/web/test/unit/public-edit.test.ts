import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  type EditIntent,
  type EditOperation,
  PublicClient,
  PublicError,
} from "../../src/public-share/client";
import { runPublicEdit } from "../../src/public-share/edit";
import {
  newPublicEdit,
  type PublicEditRecord,
  samePublicEdit,
  validPublicEdit,
} from "../../src/public-share/editStore";

beforeEach(() =>
  vi.stubGlobal("navigator", {
    locks: {
      request: async (_name: string, _options: object, callback: (lock: object) => unknown) =>
        callback({}),
    },
  }),
);
afterEach(() => vi.unstubAllGlobals());
const op = `op_${"a".repeat(64)}`;
function record(method: EditIntent["method"] = "POST") {
  return newPublicEdit("share", Date.now() + 60_000, "元の資料", "folder", {
    sessionId: "session",
    key: "original-key",
    method,
    suffix: method === "POST" ? "/nodes" : "/nodes/target",
    body:
      method === "POST"
        ? { kind: "folder", parentId: "parent", name: "作成名" }
        : method === "PATCH"
          ? { name: "変更名" }
          : { revision: 4 },
  });
}
function fixture(method: EditIntent["method"] = "POST") {
  const original = record(method),
    client = new PublicClient("share", null);
  let saved: PublicEditRecord | undefined;
  const store = {
    read: vi.fn(async () => saved && structuredClone(saved)),
    save: vi.fn(async (value: PublicEditRecord, _create = false) => {
      saved = structuredClone(value);
    }),
    remove: vi.fn(async () => {
      saved = undefined;
    }),
  };
  const receipt: EditOperation = {
    id: op,
    state: "committed",
    result: { status: method === "POST" ? 201 : method === "DELETE" ? 204 : 200, nodeId: "target" },
  };
  const edit = vi.spyOn(client, "edit").mockImplementation(async () => {
    expect(saved).toBeDefined();
    expect(samePublicEdit(saved!, original)).toBe(true);
    return receipt;
  });
  const lookup = vi.spyOn(client, "operation").mockResolvedValue(receipt),
    changed = vi.fn();
  const run = (mode: "new" | "check" = "new", input = original) =>
    runPublicEdit(client, input, mode, new AbortController().signal, changed, store);
  return { original, client, store, edit, lookup, changed, run, receipt, saved: () => saved };
}
it.each(["POST", "PATCH", "DELETE"] as const)(
  "persists %s before dispatch and clears only a verified terminal receipt",
  async (method) => {
    const t = fixture(method);
    expect(validPublicEdit(t.original)).toBe(true);
    expect(await t.run()).toEqual(t.receipt);
    expect(t.edit).toHaveBeenCalledWith(t.original.intent, expect.any(AbortSignal));
    expect(t.lookup).not.toHaveBeenCalled();
    expect(t.store.save).toHaveBeenNthCalledWith(1, t.original, true);
    expect(t.store.save).toHaveBeenNthCalledWith(2, { ...t.original, operationId: op });
    expect(t.saved()).toBeUndefined();
  },
);
it("does not dispatch when the journal cannot be committed", async () => {
  const t = fixture();
  t.store.save.mockRejectedValue(new Error("storage unavailable"));
  await expect(t.run()).rejects.toThrow("storage unavailable");
  expect(t.edit).not.toHaveBeenCalled();
  expect(t.lookup).not.toHaveBeenCalled();
});
it.each(["POST", "PATCH", "DELETE"] as const)(
  "accepts a committed %s status when the server withholds the target node",
  async (method) => {
    const t = fixture(method);
    t.edit.mockResolvedValue({ ...t.receipt, result: { status: t.receipt.result!.status } });
    expect((await t.run()).state).toBe("committed");
    expect(t.saved()).toBeUndefined();
  },
);
it.each(["POST", "PATCH", "DELETE"] as const)(
  "replays an unknown %s with the same immutable intent after reload",
  async (method) => {
    const t = fixture(method);
    t.edit.mockRejectedValueOnce(new TypeError("network"));
    await expect(t.run()).rejects.toThrow("network");
    const restored = structuredClone(t.saved()!);
    expect(samePublicEdit(restored, t.original)).toBe(true);
    await t.run("check", restored);
    expect(t.edit.mock.calls.map(([intent]) => intent)).toEqual([
      t.original.intent,
      t.original.intent,
    ]);
  },
);
it("persists an Operation-Id and performs only lookup thereafter", async () => {
  const t = fixture();
  t.edit.mockRejectedValueOnce(new PublicError(503, 1, op));
  await expect(t.run()).rejects.toMatchObject({ status: 503 });
  expect(t.saved()?.operationId).toBe(op);
  t.lookup.mockResolvedValueOnce({ id: op, state: "claimed", result: null });
  await t.run("check");
  expect(t.saved()?.operationId).toBe(op);
  await t.run("check");
  expect(t.edit).toHaveBeenCalledOnce();
  expect(t.lookup).toHaveBeenCalledTimes(2);
  expect(t.lookup).toHaveBeenCalledWith(op, "session", expect.any(AbortSignal));
});
it.each([401, 403, 404, 409, 412, 429, 503])(
  "retains an unknown operation on %s without substituting a new key",
  async (status) => {
    const t = fixture();
    t.edit.mockRejectedValueOnce(new TypeError("network"));
    await expect(t.run()).rejects.toThrow();
    t.edit.mockRejectedValueOnce(new PublicError(status));
    await expect(t.run("check")).rejects.toMatchObject({ status });
    expect(t.saved()?.intent).toEqual(t.original.intent);
    expect(t.store.remove).not.toHaveBeenCalled();
  },
);
it("never resends a known operation even if lookup is denied", async () => {
  const t = fixture();
  await t.store.save({ ...t.original, operationId: op });
  t.lookup.mockRejectedValue(new PublicError(404));
  await expect(t.run("check")).rejects.toMatchObject({ status: 404 });
  expect(t.edit).not.toHaveBeenCalled();
  expect(t.saved()?.operationId).toBe(op);
});
it.each([400, 409, 413, 423, 429])(
  "clears a directly rejected first attempt (%s) so the user can correct it",
  async (status) => {
    const t = fixture();
    t.edit.mockRejectedValueOnce(new PublicError(status));
    await expect(t.run()).rejects.toMatchObject({ status });
    expect(t.saved()).toBeUndefined();
  },
);
it("retains the original request if saving a learned operation ID fails", async () => {
  const t = fixture();
  t.edit.mockRejectedValueOnce(new PublicError(503, 1, op));
  const save = t.store.save.getMockImplementation()!;
  t.store.save.mockImplementationOnce(save).mockRejectedValueOnce(new Error("disk"));
  await expect(t.run()).rejects.toThrow("disk");
  expect(t.saved()).toEqual(t.original);
  expect(t.store.remove).not.toHaveBeenCalled();
  await t.run("check");
  expect(t.edit).toHaveBeenCalledTimes(2);
  expect(t.edit.mock.calls[1]![0]).toEqual(t.original.intent);
});
it("does not accept a mismatched lookup receipt or release its original journal", async () => {
  const t = fixture("PATCH");
  await t.store.save({ ...t.original, operationId: op });
  t.lookup.mockResolvedValue({ ...t.receipt, id: `op_${"b".repeat(64)}` });
  await expect(t.run("check")).rejects.toThrow("操作の結果");
  expect(t.store.remove).not.toHaveBeenCalled();
  expect(t.edit).not.toHaveBeenCalled();
});
it("does not save a late receipt after logout", async () => {
  const t = fixture();
  t.edit.mockImplementation(async () => {
    t.client.close();
    return t.receipt;
  });
  await expect(t.run()).rejects.toMatchObject({ name: "AbortError" });
  expect(t.store.save).toHaveBeenCalledTimes(1);
  expect(t.store.remove).not.toHaveBeenCalled();
});
it("does not dispatch from a stale tab whose record was already removed or replaced", async () => {
  const t = fixture();
  await expect(t.run("check")).rejects.toThrow("更新されました");
  await t.store.save({ ...t.original, intent: { ...t.original.intent, key: "new-key" } });
  await expect(t.run("check")).rejects.toThrow("更新されました");
  expect(t.edit).not.toHaveBeenCalled();
});
it("rejects simultaneous tab work before any network request", async () => {
  const t = fixture();
  vi.stubGlobal("navigator", {
    locks: {
      request: async (_n: string, _o: object, callback: (lock: null) => unknown) => callback(null),
    },
  });
  await expect(t.run()).rejects.toThrow("別のタブ");
  expect(t.edit).not.toHaveBeenCalled();
});
it("rejects expired records before dispatch", async () => {
  const t = fixture(),
    expired = { ...t.original, expiresAt: Date.now() - 1 };
  await t.store.save(expired);
  await expect(t.run("check", expired)).rejects.toMatchObject({ status: 401 });
  expect(t.edit).not.toHaveBeenCalled();
  expect(t.lookup).not.toHaveBeenCalled();
});
it("keeps the learned operation ID if removing a terminal journal fails", async () => {
  const t = fixture();
  t.store.remove.mockRejectedValueOnce(new Error("disk"));
  await expect(t.run()).rejects.toThrow("disk");
  expect(t.saved()?.operationId).toBe(op);
  await t.run("check");
  expect(t.edit).toHaveBeenCalledOnce();
  expect(t.lookup).toHaveBeenCalledOnce();
});
it.each([
  (r: PublicEditRecord) => ({ ...r, secret: "hidden" }),
  (r: PublicEditRecord) => ({ ...r, shareId: "other" }),
  (r: PublicEditRecord) => ({ ...r, intent: { ...r.intent, sessionId: "other" } }),
  (r: PublicEditRecord) => ({ ...r, intent: { ...r.intent, suffix: "https://evil.invalid/" } }),
  (r: PublicEditRecord) => ({ ...r, intent: { ...r.intent, suffix: "/nodes/target?share=x" } }),
  (r: PublicEditRecord) => ({ ...r, intent: { ...r.intent, method: "PUT" } }),
  (r: PublicEditRecord) => ({
    ...r,
    intent: { ...r.intent, body: { name: "x", kind: "folder", parentId: "../outside" } },
  }),
  (r: PublicEditRecord) => ({
    ...r,
    intent: { ...r.intent, method: "DELETE", suffix: "/nodes/target", body: { revision: 0 } },
  }),
  (r: PublicEditRecord) => ({ ...r, operationId: "http://evil.invalid" }),
])("rejects unsafe restored records", (change) =>
  expect(validPublicEdit(change(record()))).toBe(false),
);
