import { describe, expect, it } from "vitest";

import { parseDavUrl, validateDestination } from "../../src/dav/path.js";

describe("DAV path profile", () => {
  it("decodes path components exactly once", () => {
    expect(parseDavUrl("https://app.test.invalid/dav/a%20b/file.txt").segments).toEqual([
      "a b",
      "file.txt",
    ]);
    expect(() => parseDavUrl("https://app.test.invalid/dav/a%252fb")).toThrow("invalid");
    expect(() => parseDavUrl("https://app.test.invalid/dav/a%2fb")).toThrow("invalid");
  });

  it("restricts Destination to the configured HTTPS origin", () => {
    expect(
      validateDestination("https://app.test.invalid/dav/target", "https://app.test.invalid")
        .pathname,
    ).toBe("/dav/target");
    expect(() =>
      validateDestination("https://other.test.invalid/dav/target", "https://app.test.invalid"),
    ).toThrow("invalid");
  });
});
