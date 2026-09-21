import { describe, expect, it } from "vitest";

import { classifyBatchFailure } from "../../src/services/mutationOutcome.js";

describe("batch failure classification", () => {
  it("classifies SQL and explicit batch rejection as rolled back", () => {
    expect(classifyBatchFailure({ kind: "statement", error: new Error("constraint") })).toBe(
      "rollback-confirmed",
    );
    expect(classifyBatchFailure({ kind: "batch-rejected", error: new Error("rejected") })).toBe(
      "rollback-confirmed",
    );
  });

  it("classifies response loss and timeout as commit-unknown", () => {
    expect(classifyBatchFailure({ kind: "network", error: new Error("lost") })).toBe(
      "commit-unknown",
    );
    expect(classifyBatchFailure({ kind: "timeout", error: new Error("timeout") })).toBe(
      "commit-unknown",
    );
  });
});
