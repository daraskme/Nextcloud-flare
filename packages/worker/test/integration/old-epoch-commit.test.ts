import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";

import { createFolder } from "../../src/services/fsMutation.js";
import { createFolderInput, seedClaimedOperation, seedFoundation } from "../helpers/foundation.js";

beforeEach(async () => {
  await seedFoundation();
  await seedClaimedOperation();
  await env.DB.prepare("UPDATE control SET epoch=2 WHERE singleton=1").run();
});

describe("old epoch worker", () => {
  it("cannot commit after the recovery epoch advances", async () => {
    await expect(createFolder(env, createFolderInput)).rejects.toThrow();
    await expect(
      env.DB.prepare("SELECT id FROM nodes WHERE id='folder'").first(),
    ).resolves.toBeNull();
  });
});
