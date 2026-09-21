import { describe, expect, it } from "vitest";

import { requiresDavPutPrecondition } from "../../src/dav/contract.js";

describe("DAV PUT precondition", () => {
  it("requires If-Match or a submitted lock token for an existing resource", () => {
    expect(requiresDavPutPrecondition(true, null, false)).toBe(true);
    expect(requiresDavPutPrecondition(true, '"etag"', false)).toBe(false);
    expect(requiresDavPutPrecondition(true, null, true)).toBe(false);
    expect(requiresDavPutPrecondition(false, null, false)).toBe(false);
  });
});
