import { describe, expect, it } from "vitest";

import { parseDavTimeout } from "../../src/dav/contract.js";

describe("DAV Timeout", () => {
  it("uses 600 seconds by default", () => {
    expect(parseDavTimeout(null)).toBe(600);
  });

  it("clamps finite and Infinite values to 3600 seconds", () => {
    expect(parseDavTimeout("Second-120")).toBe(120);
    expect(parseDavTimeout("Second-99999")).toBe(3600);
    expect(parseDavTimeout("Infinite")).toBe(3600);
  });
});
