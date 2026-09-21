import { describe, expect, it } from "vitest";

import { canStartSinglePut } from "../../src/services/singleUpload.js";

describe("single upload unknown result", () => {
  it("never reuses a staging key after the first attempt started", () => {
    expect(canStartSinglePut("created", false)).toBe(true);
    expect(canStartSinglePut("created", true)).toBe(false);
    expect(canStartSinglePut("receiving", true)).toBe(false);
  });
});
