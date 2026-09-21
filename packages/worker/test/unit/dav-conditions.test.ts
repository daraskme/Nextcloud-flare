import { describe, expect, it } from "vitest";

import { evaluateDavIf, parseDavIf } from "../../src/dav/conditions.js";

describe("DAV If header", () => {
  it("evaluates conditions as AND within lists and OR between lists", () => {
    const parsed = parseDavIf('(<opaquelocktoken:one> ["b-one"]) (Not <opaquelocktoken:two>)');
    const contexts = new Map([
      [
        "https://app.test.invalid/dav/file",
        { etag: '"b-one"', lockTokens: new Set(["opaquelocktoken:one"]) },
      ],
    ]);
    expect(evaluateDavIf(parsed, "https://app.test.invalid/dav/file", contexts)).toBe(true);
    expect(parsed.submittedTokens).toEqual(new Set(["opaquelocktoken:one", "opaquelocktoken:two"]));
  });

  it("supports tagged resources and rejects excessive lists", () => {
    const parsed = parseDavIf(
      '<https://app.test.invalid/dav/a> (["c-a-1"]) <https://app.test.invalid/dav/b> (Not ["c-b-2"])',
    );
    const contexts = new Map([
      ["https://app.test.invalid/dav/a", { etag: '"c-a-1"', lockTokens: new Set<string>() }],
      ["https://app.test.invalid/dav/b", { etag: '"c-b-1"', lockTokens: new Set<string>() }],
    ]);
    expect(evaluateDavIf(parsed, "unused", contexts)).toBe(true);
    expect(() => parseDavIf(Array.from({ length: 17 }, () => '(["x"])').join(" "))).toThrow(
      "limit",
    );
  });
});
