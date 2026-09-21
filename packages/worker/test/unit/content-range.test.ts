import { describe, expect, it } from "vitest";

import { immutableBlobKey } from "../../src/services/blobs.js";

describe("immutable blob keys", () => {
  it("never derives an R2 key from a logical path", () => {
    expect(immutableBlobKey("owner", "blob_id")).toBe("u/owner/b/blob_id");
    expect(() => immutableBlobKey("owner/path", "blob")).toThrow();
    expect(() => immutableBlobKey("owner", "folder/blob")).toThrow();
  });
});
