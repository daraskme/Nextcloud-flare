import { describe, expect, it } from "vitest";

import { assertImageInputSize } from "../../src/media/images/limits.js";

describe("Images input boundary", () => {
  it("accepts the documented 20,000,000 byte boundary", () => {
    expect(() => assertImageInputSize(20_000_000)).not.toThrow();
  });

  it("rejects one byte above the service boundary", () => {
    expect(() => assertImageInputSize(20_000_001)).toThrow(RangeError);
  });
});
