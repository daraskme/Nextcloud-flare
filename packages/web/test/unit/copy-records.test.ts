import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  COPY_RECORDS_KEY,
  clearCopyRecords,
  forgetCopy,
  readCopyRecords,
  rememberCopy,
} from "../../src/features/copy/records";
import type { Operation } from "../../src/lib/api";

const account = { id: "actor", epoch: 1 },
  job = "copy_" + "a".repeat(64);
const operation: Operation = {
  id: "op_copy",
  state: "committed",
  result: { jobId: job, status: 202 },
};
const body = {
  name: "コピー",
  destinationParentId: "folder",
  destination: { spaceId: "space", share: { id: "share", version: 2 } },
};
let values: Map<string, string>;
beforeEach(() => {
  values = new Map();
  vi.stubGlobal("sessionStorage", {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
    removeItem: (key: string) => values.delete(key),
  });
  vi.stubGlobal("window", new EventTarget());
});
afterEach(() => vi.unstubAllGlobals());
it("retains the accepted identity and exact destination selection across replay", () => {
  rememberCopy(account, operation, body);
  rememberCopy(account, operation, body);
  expect(readCopyRecords(account)).toEqual([
    {
      id: job,
      accountId: "actor",
      epoch: 1,
      name: "コピー",
      destinationSpaceId: "space",
      destinationParentId: "folder",
      destinationShare: { id: "share", version: 2 },
    },
  ]);
  expect(readCopyRecords({ id: "other", epoch: 1 })).toEqual([]);
  expect(readCopyRecords({ id: "actor", epoch: 2 })).toEqual([]);
  forgetCopy(account, job);
  expect(readCopyRecords(account)).toEqual([]);
});
it("does not track synchronous copies and clears saved jobs on logout", () => {
  rememberCopy(account, { ...operation, result: { nodeId: "node", status: 201 } }, body);
  expect(values.has(COPY_RECORDS_KEY)).toBe(false);
  rememberCopy(account, operation, { ...body, destination: { spaceId: "space", share: null } });
  clearCopyRecords();
  expect(values.has(COPY_RECORDS_KEY)).toBe(false);
});
it("propagates failed storage instead of acknowledging a lost tracking record", () => {
  vi.spyOn(sessionStorage, "setItem").mockImplementation(() => {
    throw new Error("quota");
  });
  expect(() => rememberCopy(account, operation, body)).toThrow("copy_tracking_unavailable");
  expect(readCopyRecords(account)).toEqual([]);
});
it.each(["{", "null", "{}", JSON.stringify([{ id: "copy_bad" }])])(
  "ignores malformed local records: %s",
  (raw) => {
    values.set(COPY_RECORDS_KEY, raw);
    expect(readCopyRecords(account)).toEqual([]);
  },
);
it("rejects an incomplete accepted receipt before the pending intent can be cleared", () => {
  expect(() => rememberCopy(account, { ...operation, result: { status: 202 } }, body)).toThrow(
    "invalid_copy_receipt",
  );
  expect(() =>
    rememberCopy(account, operation, { ...body, destination: { spaceId: "space" } }),
  ).toThrow();
  expect(values.has(COPY_RECORDS_KEY)).toBe(false);
});
