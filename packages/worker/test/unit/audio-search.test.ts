import { expect, it } from "vitest";
import { searchName, searchText } from "../../../shared/src/names";
import { AUDIO_SEARCH_LIMITS, AUDIO_SEARCH_VERSION, audioSearchTags } from "../../src/search/audio";

it("normalizes effective audio fields without applying filename restrictions", () => {
  const tags = { title: 'ｶﾀｶﾅ: Straße / "A"', artist: "ＡＲＴＩＳＴ", album: "作品?*" };
  const result = audioSearchTags(tags);
  expect(result.textNorm).toBe('かたかな: strasse / "a"\nartist\n作品?*');
  expect(result.tokens).toContain("かた たか かな");
  expect(result.version).toBe(AUDIO_SEARCH_VERSION);
  expect(JSON.parse(result.source)).toEqual([tags.title, tags.artist, tags.album]);
  expect(() => searchName(tags.title)).toThrow("invalid_name");
  expect(searchName("カタカナStraße")).toEqual(searchText("カタカナStraße"));
});
it("keeps missing values and field boundaries distinct", () => {
  expect(audioSearchTags({ title: null, artist: null, album: null })).toMatchObject({
    textNorm: "",
    tokens: "",
    source: "[null,null,null]",
  });
  const tags = audioSearchTags({ title: "ab", artist: null, album: "cd" });
  expect(tags.textNorm).toBe("ab\ncd");
  expect(tags.textNorm).not.toContain("bc");
  expect(tags.tokens.split(" ")).not.toContain("bc");
  expect(audioSearchTags({ title: "x", artist: null, album: null }).tokens).toBe("x");
});
it.each(["a".repeat(1025), "😀".repeat(257), "\ud800", 1, undefined])(
  "rejects invalid or unbounded fields: %j",
  (title) => {
    expect(() => audioSearchTags({ title: title as string, artist: null, album: null })).toThrow(
      "invalid_audio_search_tags",
    );
  },
);
it("allows bounded Unicode compatibility expansion without truncating valid metadata", () => {
  const text = "ﷺ".repeat(341);
  const result = audioSearchTags({ title: text, artist: text, album: text });
  const bytes = (v: string) => new TextEncoder().encode(v).length;
  expect(bytes(text)).toBe(1023);
  expect(bytes(result.textNorm)).toBeGreaterThan(30000);
  expect(bytes(result.textNorm)).toBeLessThanOrEqual(AUDIO_SEARCH_LIMITS.textBytes);
  expect(bytes(result.tokens)).toBeLessThanOrEqual(AUDIO_SEARCH_LIMITS.tokenBytes);
  expect(result.textNorm.split("\n")).toEqual(Array(3).fill(searchText(text).textNorm));
});
