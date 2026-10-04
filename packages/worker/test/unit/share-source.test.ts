import { expect, it } from "vitest";
import { shareSourceDigest, shareSourceScope } from "../../src/auth/shareSource";

it("canonicalizes exact IPv4 and IPv6 /64 without persisting the address", async () => {
  expect(shareSourceScope("192.0.2.12")).toBe("v4:192.0.2.12");
  expect(shareSourceScope("::ffff:192.0.2.12")).toBe("v4:192.0.2.12");
  expect(shareSourceScope("::ffff:198.51.100.2")).toBe("v4:198.51.100.2");
  expect(shareSourceScope("2001:db8:abcd:12::1")).toBe("v6:2001:0db8:abcd:0012");
  expect(shareSourceScope("2001:0db8:abcd:0012:ffff::2")).toBe("v6:2001:0db8:abcd:0012");
  expect(shareSourceScope("2001:db8:abcd:13::1")).toBe("v6:2001:0db8:abcd:0013");
  expect(shareSourceScope("192.0.2.999")).toBe("unknown");
  expect(shareSourceScope("2001:db8::1%eth0")).toBe("unknown");
  expect(shareSourceScope(null)).toBe("unknown");
  const key = await crypto.subtle.importKey(
    "raw",
    new Uint8Array(32).fill(7),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const first = await shareSourceDigest(key, "share-a", "2001:db8:abcd:12::1");
  expect(first).toMatch(/^[A-Za-z0-9_-]{43}$/);
  expect(first).toBe(await shareSourceDigest(key, "share-a", "2001:db8:abcd:12::2"));
  expect(first).not.toBe(await shareSourceDigest(key, "share-a", "2001:db8:abcd:13::1"));
  expect(first).not.toBe(await shareSourceDigest(key, "share-b", "2001:db8:abcd:12::1"));
});
