import { describe, expect, it, vi } from "vitest";
import { classifyBatchFailure, commitUnknownResponse, reconcileCommit } from "../../src/db/outcome";

describe("commit outcome", () => {
  it.each([
    undefined,
    "timeout",
    new Error("network"),
    new Error("D1_ERROR: database overloaded"),
    new Error("D1_ERROR: SQL execution timed out"),
  ])("treats ambiguous error as unknown", (error) => {
    expect(classifyBatchFailure(error)).toBe("commit_unknown");
  });
  it("does not equate a still-claimed row to failure", async () => {
    const read = vi.fn(async () => ({
      state: "claimed" as const,
      result_json: null,
      error_code: null,
    }));
    expect(await reconcileCommit(read)).toEqual({ kind: "commit_unknown" });
    expect(read).toHaveBeenCalledTimes(3);
  });
  it("stops a stuck primary lookup within the total time budget", async () => {
    vi.useFakeTimers();
    try {
      const result = reconcileCommit(() => new Promise(() => {}));
      await vi.advanceTimersByTimeAsync(5_000);
      expect(await result).toEqual({ kind: "commit_unknown" });
    } finally {
      vi.useRealTimers();
    }
  });
  it("preserves the operation identifier for reconciliation", async () => {
    const response = commitUnknownResponse("op-123");
    expect(response.status).toBe(503);
    expect(response.headers.get("Operation-Id")).toBe("op-123");
    expect(response.headers.get("Retry-After")).toBe("1");
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
  });
});
