import type { Env } from "../env.js";

// Browsers reject `__Host-` prefixed cookies over plain http (even on localhost), so the
// loopback-only development environment uses the unprefixed name for every session cookie.
export function hostCookieName(env: Env, name: string): string {
  return env.ENVIRONMENT === "development" && env.APP_ORIGIN.startsWith("http://")
    ? name
    : `__Host-${name}`;
}
