import { describe, expect, it } from "vitest";
import { expectedPartBytes, multipartPlan, UPLOAD_LIMITS } from "../../src/do/uploadPlan";

const MIB = 1024 * 1024;
describe("multipart geometry", () => {
  it("fixes equal non-final parts and exact small tails without adding an empty part", () => {
    const exact = multipartPlan(128 * MIB);
    expect(exact.partCount).toBe(2);
    expect(expectedPartBytes(exact, 2)).toBe(64 * MIB);
    const tail = multipartPlan(128 * MIB + 1);
    expect(tail.partCount).toBe(3);
    expect(expectedPartBytes(tail, 3)).toBe(1);
    expect(expectedPartBytes(multipartPlan(1), 1)).toBe(1);
  });

  it("supports the 500 GiB limit and exactly 10,000 parts", () => {
    expect(multipartPlan(UPLOAD_LIMITS.bytes).partCount).toBe(8000);
    expect(multipartPlan(8 * MIB * 10_000, 8 * MIB).partCount).toBe(10_000);
    expect(() => multipartPlan(8 * MIB * 10_000 + 1, 8 * MIB)).toThrow(/part_limit/);
  });

  it.each([0, -1, 1.5, Number.NaN, Infinity, UPLOAD_LIMITS.bytes + 1])(
    "rejects invalid declared size %s; zero bytes use single PUT",
    (bytes) => {
      expect(() => multipartPlan(bytes)).toThrow(/invalid_multipart_plan/);
    },
  );
  it.each([8 * MIB - 1, 90 * MIB + 1, 8 * MIB + 0.5, Number.NaN])(
    "rejects invalid part geometry %s",
    (bytes) => {
      expect(() => multipartPlan(128 * MIB, bytes)).toThrow(/invalid_multipart_plan/);
    },
  );
  it.each([0, -1, 2, 1.5, Number.NaN])("rejects out-of-range part %s", (part) => {
    expect(() => expectedPartBytes(multipartPlan(1), part)).toThrow(/invalid_part_number/);
  });
});
