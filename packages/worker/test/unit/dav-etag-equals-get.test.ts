import { describe, expect, it } from "vitest";

import { davEtag } from "../../src/dav/contract.js";

describe("DAV validators", () => {
  it("uses the content GET ETag for files", () => {
    expect(davEtag("node", 7, "blob")).toBe('"b-blob"');
  });

  it("uses node revision for collections", () => {
    expect(davEtag("node", 7)).toBe('"c-node-7"');
  });
});
