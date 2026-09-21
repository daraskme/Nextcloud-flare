import { describe, expect, it } from "vitest";

import { reconcileExpiredSingle } from "../../src/services/singleUpload.js";

describe("expired single upload reconciliation", () => {
  it("moves a present object to orphan accounting without releasing reservation", () => {
    expect(reconcileExpiredSingle(true)).toEqual({
      uploadState: "failed",
      blobState: "orphan",
      releaseReservation: false,
    });
  });

  it("expires and releases reservation only after an absent head at deadline", () => {
    expect(reconcileExpiredSingle(false)).toEqual({
      uploadState: "expired",
      blobState: null,
      releaseReservation: true,
    });
  });
});
