import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";

import { lookupOperation } from "../../src/services/operations.js";
import { seedClaimedOperation, seedFoundation } from "../helpers/foundation.js";

beforeEach(async () => {
  await seedFoundation();
  await seedClaimedOperation();
});

describe("operation lookup", () => {
  it("returns a result only to the creating credential", async () => {
    await expect(lookupOperation(env, "operation", "as:session")).resolves.toMatchObject({
      state: "claimed",
    });
    await expect(lookupOperation(env, "operation", "as:other")).resolves.toBeNull();
  });
});
