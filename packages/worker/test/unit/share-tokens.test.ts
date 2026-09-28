import { base64url } from "jose";
import { expect, it } from "vitest";
import { contentKeyRing } from "../../src/auth/contentTokens";
import { ShareTokens, shareCookieHeader, shareCookieValue } from "../../src/auth/shareTokens";
import { canonicalClientIp } from "../../src/do/controlShareUnlock";

async function fixture() {
  const key = base64url.encode(crypto.getRandomValues(new Uint8Array(32)));
  const ring = await contentKeyRing("v1", { v1: key });
  let now = 1800000000000;
  return {
    ring,
    key,
    clock: (value: number) => {
      now = value;
    },
    tokens: new ShareTokens(ring, "https://app.invalid", () => now),
  };
}
it("binds challenge and session cookies to distinct purposes, share, epoch and exact origin", async () => {
  const f = await fixture(),
    challenge = await f.tokens.challenge("share", 1);
  expect(await f.tokens.verifyChallenge(challenge.token, "share", 1)).toEqual(challenge.claims);
  await expect(f.tokens.verify(challenge.token, "share", 1)).rejects.toThrow();
  const claims = {
    ...challenge.claims,
    session_id: "session",
    share_version: 2,
    exp: challenge.claims.iat + 604800,
  };
  const token = await f.tokens.issue(claims);
  expect(await f.tokens.verify(token, "share", 1)).toEqual(claims);
  await expect(f.tokens.verifyChallenge(token, "share", 1)).rejects.toThrow();
  await expect(f.tokens.verify(token, "other", 1)).rejects.toThrow();
  await expect(f.tokens.verify(token, "share", 2)).rejects.toThrow();
  await expect(
    new ShareTokens(f.ring, "https://other.invalid", () => claims.iat * 1000).verify(
      token,
      "share",
      1,
    ),
  ).rejects.toThrow();
});
it("expires challenges at five minutes and refuses excessive or future session lifetimes", async () => {
  const f = await fixture(),
    c = await f.tokens.challenge("share", 1);
  f.clock(c.claims.exp * 1000 - 1);
  await f.tokens.verifyChallenge(c.token, "share", 1);
  f.clock(c.claims.exp * 1000);
  await expect(f.tokens.verifyChallenge(c.token, "share", 1)).rejects.toThrow();
  await expect(
    f.tokens.issue({
      ...c.claims,
      exp: c.claims.iat + 604801,
      session_id: "session",
      share_version: 1,
    }),
  ).rejects.toThrow();
  await expect(
    f.tokens.issue({
      ...c.claims,
      iat: c.claims.exp + 1,
      exp: c.claims.exp + 10,
      session_id: "session",
      share_version: 1,
    }),
  ).rejects.toThrow();
});
it("accepts a retained key and rejects unknown keys, tampering and noncanonical signatures", async () => {
  const f = await fixture(),
    c = await f.tokens.challenge("share", 1);
  const next = await contentKeyRing("v2", { v2: base64url.encode(new Uint8Array(32)), v1: f.key });
  await new ShareTokens(next, f.tokens.origin, f.tokens.now).verifyChallenge(c.token, "share", 1);
  await expect(
    new ShareTokens(
      { ...next, keys: new Map([["v2", next.keys.get("v2")!]]) },
      f.tokens.origin,
      f.tokens.now,
    ).verifyChallenge(c.token, "share", 1),
  ).rejects.toThrow();
  await expect(f.tokens.verifyChallenge(`A${c.token.slice(1)}`, "share", 1)).rejects.toThrow();
  const last = c.token.at(-1)!,
    alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
  await expect(
    f.tokens.verifyChallenge(
      c.token.slice(0, -1) + alphabet[alphabet.indexOf(last) + 1],
      "share",
      1,
    ),
  ).rejects.toThrow();
});
it("uses host-only secure HttpOnly cookies and rejects duplicate/oversized request cookies", () => {
  const cookie = shareCookieHeader("one", "token", 300);
  expect(cookie).toBe(
    "__Host-ncf_share_one=token; Secure; HttpOnly; SameSite=Lax; Path=/; Max-Age=300",
  );
  expect(shareCookieValue("__Host-ncf_share_other=no; __Host-ncf_share_one=token", "one")).toBe(
    "token",
  );
  expect(shareCookieValue(null, "one")).toBeNull();
  expect(() => shareCookieValue("__Host-ncf_share_one=a; __Host-ncf_share_one=b", "one")).toThrow();
  expect(() => shareCookieValue("a".repeat(32769), "one")).toThrow();
  expect(() => shareCookieHeader("../one", "x", 300)).toThrow();
  expect(() => shareCookieHeader("one", "x\r\nSet-Cookie: evil=y", 300)).toThrow();
});
it("normalizes equivalent IPv6 addresses and accepts canonical IPv4", () => {
  expect(canonicalClientIp("2001:0DB8:0:0:0:0:0:1")).toBe("2001:db8::1");
  expect(canonicalClientIp("2001:db8::1")).toBe("2001:db8::1");
  expect(canonicalClientIp("192.0.2.1")).toBe("192.0.2.1");
});
it.each([
  "",
  "host.example",
  "192.0.2.999",
  "192.000.2.1",
  "1.2.3.4, 5.6.7.8",
  "::1%lo",
  "[::1]",
  "1::2::3",
])("rejects invalid client IP %s", (ip) => expect(() => canonicalClientIp(ip)).toThrow());
