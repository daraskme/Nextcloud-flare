import { describe, expect, it } from "vitest";

import { issueCsrfToken, verifyCsrfToken } from "../../src/auth/csrf.js";

describe("session-bound CSRF", () => {
  it("issues without a prior token and permits safe re-use within one session", async () => {
    const token = await issueCsrfToken("test-csrf-key", "session", 1000);
    await expect(verifyCsrfToken("test-csrf-key", token, "session", 2000)).resolves.toBe(true);
    await expect(verifyCsrfToken("test-csrf-key", token, "session", 2000)).resolves.toBe(true);
  });

  it("rejects another session and an expired token", async () => {
    const token = await issueCsrfToken("test-csrf-key", "session", 1000);
    await expect(verifyCsrfToken("test-csrf-key", token, "other", 2000)).resolves.toBe(false);
    await expect(
      verifyCsrfToken("test-csrf-key", token, "session", 1000 + 60 * 60 * 1000),
    ).resolves.toBe(false);
  });
});
