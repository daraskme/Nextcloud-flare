import { expect, it } from "vitest";
import { assertImageInput } from "../../src/platform/images";
import { parseRange } from "../../src/platform/range";
import { validateLength } from "../../src/platform/stream";

it.each([
  ["bytes=0-0", { kind: "range", offset: 0, length: 1 }],
  ["bytes=2-", { kind: "range", offset: 2, length: 8 }],
  ["bytes=-3", { kind: "range", offset: 7, length: 3 }],
  ["bytes=0-999", { kind: "range", offset: 0, length: 10 }],
  ["bytes=-999", { kind: "range", offset: 0, length: 10 }],
  ["bytes=10-", { kind: "unsatisfiable" }],
  ["bytes=8-2", { kind: "unsatisfiable" }],
  ["bytes=-0", { kind: "unsatisfiable" }],
  ["bytes=-", { kind: "unsatisfiable" }],
  ["bytes=9007199254740992-", { kind: "unsatisfiable" }],
  ["bytes=0-1,4-5", { kind: "full" }],
  [null, { kind: "full" }],
])("normalizes %s", (header, expected) => {
  expect(parseRange(header, 10)).toEqual(expected);
});
it("rejects any range on a zero-byte object", () => {
  expect(parseRange("bytes=0-", 0)).toEqual({ kind: "unsatisfiable" });
});
it("uses the exact decimal Images size boundary", () => {
  expect(() => assertImageInput(20_000_000, 10_000, 4_000)).not.toThrow();
  expect(() => assertImageInput(20_000_001, 10_000, 4_000)).toThrow();
  expect(() => assertImageInput(1, 12_001, 1)).toThrow();
  expect(() => assertImageInput(1, 10_000, 4_001)).toThrow();
});
it.each([-1, NaN, Infinity, 1.5, 95_000_001])("rejects invalid transfer length %s", (size) => {
  expect(() => validateLength(size)).toThrow();
});
