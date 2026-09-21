import { describe, expect, it } from "vitest";

import {
  escapeLike,
  ftsBigramQuery,
  normalizeSearchText,
  searchBigrams,
} from "../../src/search/normalize.js";

describe("search normalization", () => {
  it("normalizes compatibility forms, casefold exceptions, and katakana", () => {
    expect(normalizeSearchText(" ＣＡＦÉ  カタログ  Straße Σς ")).toBe("café かたろぐ strasse σσ");
  });

  it("quotes bigrams and escapes LIKE metacharacters", () => {
    expect(searchBigrams("abcd")).toEqual(["ab", "bc", "cd"]);
    expect(ftsBigramQuery('a"b')).toBe('"a""" AND """b"');
    expect(escapeLike("100%_ok\\")).toBe("100\\%\\_ok\\\\");
  });
});
