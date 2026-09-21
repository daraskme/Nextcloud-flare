import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";

import { createFolder } from "../../src/services/fsMutation.js";
import { createFolderInput, seedClaimedOperation, seedFoundation } from "../helpers/foundation.js";

beforeEach(async () => {
  await seedFoundation();
  await seedClaimedOperation();
  await env.DB.prepare("UPDATE sessions SET revoked_at=?1 WHERE id='session'")
    .bind(Date.now())
    .run();
});

describe("credential revoked at commit", () => {
  it("rolls back even when operation and permit remain claimed/open", async () => {
    await expect(createFolder(env, createFolderInput)).rejects.toThrow();
    await expect(
      env.DB.prepare("SELECT id FROM nodes WHERE id='folder'").first(),
    ).resolves.toBeNull();
  });
});
