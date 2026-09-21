import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";

import { createFolder } from "../../src/services/fsMutation.js";
import { createFolderInput, seedClaimedOperation, seedFoundation } from "../helpers/foundation.js";

beforeEach(async () => {
  await seedFoundation();
  await seedClaimedOperation("revoked");
});

describe("revoked permit", () => {
  it("cannot be committed by an old worker", async () => {
    await expect(createFolder(env, createFolderInput)).rejects.toThrow();
    await expect(
      env.DB.prepare("SELECT id FROM nodes WHERE id='folder'").first(),
    ).resolves.toBeNull();
  });
});
