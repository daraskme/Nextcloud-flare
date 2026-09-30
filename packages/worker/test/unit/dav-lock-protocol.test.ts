import { expect, it } from "vitest";
import { parseDavLockDepth, parseDavTimeout } from "../../src/dav/lockProtocol";

it("normalizes DAV LOCK Depth", () => {
  expect(parseDavLockDepth(null)).toBe("infinity");
  expect(parseDavLockDepth("0")).toBe("0");
  expect(parseDavLockDepth("Infinity")).toBe("infinity");
  for (const value of ["1", "0 ", "infinite", "-1"])
    expect(() => parseDavLockDepth(value)).toThrow("invalid_dav_lock_depth");
});

it("bounds DAV Timeout and honors the first supported preference", () => {
  expect(parseDavTimeout(null)).toBe(600);
  expect(parseDavTimeout("Second-1")).toBe(1);
  expect(parseDavTimeout("Second-3600")).toBe(3600);
  expect(parseDavTimeout("Second-9999999999")).toBe(3600);
  expect(parseDavTimeout("Infinite")).toBe(3600);
  expect(parseDavTimeout("unknown, Second-120, Infinite")).toBe(120);
  for (const value of [
    "",
    "Second-0",
    "Second--1",
    "Second-1.5",
    "unknown",
    "a,b,c,d,e",
    "x".repeat(257),
  ])
    expect(() => parseDavTimeout(value)).toThrow("invalid_dav_timeout");
});
