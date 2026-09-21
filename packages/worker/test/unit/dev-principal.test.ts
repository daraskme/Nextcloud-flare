import { describe, expect, it } from "vitest";

import { authenticateAccessUser } from "../../src/auth/httpAuth.js";
import type { Env } from "../../src/env.js";

const developmentEnv = {
  ENVIRONMENT: "development",
  DEV_PRINCIPAL_EMAIL: "dev@example.invalid",
} as Env;

describe("development principal boundary", () => {
  it("fails closed away from loopback even when the environment is mislabeled development", async () => {
    await expect(
      authenticateAccessUser(developmentEnv, new Request("https://production.example/api/v1/me")),
    ).rejects.toThrow("development_principal_forbidden");
  });

  it.each(["/s/share", "/api/v1/public/shares/share"])(
    "never applies the development principal to public route %s",
    async (path) => {
      await expect(
        authenticateAccessUser(developmentEnv, new Request(`http://127.0.0.1${path}`)),
      ).rejects.toThrow("access_token_required");
    },
  );

  it("fails closed on a production environment at loopback", async () => {
    await expect(
      authenticateAccessUser(
        { ...developmentEnv, ENVIRONMENT: "production" },
        new Request("http://127.0.0.1/api/v1/me"),
      ),
    ).rejects.toThrow("development_principal_forbidden");
  });
});
