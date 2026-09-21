import { describe, expect, it } from "vitest";

import { hostCookieName } from "../../src/auth/cookies.js";
import type { Env } from "../../src/env.js";

function env(environment: string, appOrigin: string): Env {
  return { ENVIRONMENT: environment, APP_ORIGIN: appOrigin } as Env;
}

describe("session cookie prefix", () => {
  it("drops __Host- only for plain-http development origins", () => {
    expect(hostCookieName(env("development", "http://localhost:5173"), "ncf_cs")).toBe("ncf_cs");
  });

  it("keeps __Host- for https development, test and production", () => {
    expect(hostCookieName(env("development", "https://dev.example.invalid"), "ncf_cs")).toBe(
      "__Host-ncf_cs",
    );
    expect(hostCookieName(env("test", "http://localhost:8787"), "ncf_cs")).toBe("__Host-ncf_cs");
    expect(hostCookieName(env("production", "http://app.example.invalid"), "ncf_cs")).toBe(
      "__Host-ncf_cs",
    );
  });
});
