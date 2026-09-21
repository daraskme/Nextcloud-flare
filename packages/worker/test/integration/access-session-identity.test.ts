import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

import { accessSessionFingerprint, getOrCreateAccessSession } from "../../src/auth/sessions.js";
import { seedFoundation } from "../helpers/foundation.js";

describe("Access session identity", () => {
  it("binds one D1 session to iss, sub, iat and exp", async () => {
    await seedFoundation();
    const claims = { issuer: "issuer", subject: "subject", issuedAt: 1000, expiresAt: 2000 };
    const fingerprint = await accessSessionFingerprint(claims);
    const created = await getOrCreateAccessSession(env, "user", claims, 1_100_000);
    const repeated = await getOrCreateAccessSession(env, "user", claims, 1_100_001);
    expect(created.fingerprint).toBe(fingerprint);
    expect(repeated.id).toBe(created.id);
    expect(created.credentialId).toBe(`as:${created.id}`);
  });
});
