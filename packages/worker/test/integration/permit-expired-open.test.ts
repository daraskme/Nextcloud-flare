import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";

import { createFolder } from "../../src/services/fsMutation.js";
import { createFolderInput, seedClaimedOperation, seedFoundation } from "../helpers/foundation.js";

beforeEach(async () => {
  await seedFoundation();
  await seedClaimedOperation("open", Date.now() - 1000);
});

describe("expired open permit", () => {
  it("fails the D1-time commit predicate with no mutation side effects", async () => {
    await expect(createFolder(env, createFolderInput)).rejects.toThrow();
    await expect(
      env.DB.prepare("SELECT id FROM nodes WHERE id='folder'").first(),
    ).resolves.toBeNull();
    const root = await env.DB.prepare("SELECT revision FROM nodes WHERE id='root'").first<{
      revision: number;
    }>();
    expect(root?.revision).toBe(1);
  });
});
