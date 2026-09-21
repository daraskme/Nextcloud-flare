import { describe, expect, it } from "vitest";

import { assertUploadTransition, canTransitionUpload } from "@ncf/shared";

describe("upload completing state", () => {
  it("rejects abort once completion starts", () => {
    expect(canTransitionUpload("completing", "aborted")).toBe(false);
    expect(() => assertUploadTransition("completing", "aborted")).toThrow();
  });

  it("allows only completed or failed terminal transitions", () => {
    expect(canTransitionUpload("completing", "completed")).toBe(true);
    expect(canTransitionUpload("completing", "failed")).toBe(true);
  });
});
