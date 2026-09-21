import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

import { bootstrapOwner, disableUser } from "../../src/auth/bootstrap.js";
import { applyFoundationMigration } from "../helpers/foundation.js";

const first = {
  identity: { issuer: "iss", subject: "owner", email: "owner@test.invalid" },
  allowedEmails: ["owner@test.invalid"],
  allowedIdentities: [],
  userId: "owner",
  spaceId: "owner-space",
  rootNodeId: "owner-root",
} as const;

describe("owner bootstrap", () => {
  it("allows exactly one allowlisted bootstrap and protects the last admin", async () => {
    await applyFoundationMigration();
    await bootstrapOwner(env, first);
    await expect(
      bootstrapOwner(env, {
        ...first,
        identity: { issuer: "iss", subject: "second", email: "second@test.invalid" },
        allowedEmails: ["second@test.invalid"],
        userId: "second",
        spaceId: "second-space",
        rootNodeId: "second-root",
      }),
    ).rejects.toThrow();
    await expect(disableUser(env, "owner")).rejects.toThrow();
    const users = await env.DB.prepare("SELECT id FROM users ORDER BY id").all();
    expect(users.results).toEqual([{ id: "owner" }]);
  });
});
