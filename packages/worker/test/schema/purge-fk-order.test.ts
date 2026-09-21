import { describe, expect, it } from "vitest";

import { purgeOrder } from "../../src/services/purgeOrder.js";

describe("purge FK order contract", () => {
  it("starts with membership and ends with nodes", () => {
    expect(purgeOrder[0]).toBe("trash_members");
    expect(purgeOrder.at(-1)).toBe("nodes");
    expect(purgeOrder.indexOf("share_grants")).toBeLessThan(purgeOrder.indexOf("shares"));
    expect(purgeOrder.indexOf("upload_parts")).toBeLessThan(purgeOrder.indexOf("uploads"));
  });
});
