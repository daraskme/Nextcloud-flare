import { expect, it } from "vitest";
import { evaluateDavPutHttpPreconditions } from "../../src/dav/httpPreconditions";

const current = '"b-current"';
const check = (headers: Record<string, string>, etag: string | null = current) =>
  evaluateDavPutHttpPreconditions(new Headers(headers), etag);

it("strongly compares If-Match and accepts any matching list member", () => {
  expect(() => check({ "If-Match": '"b-old", "b-current"' })).not.toThrow();
  expect(() => check({ "If-Match": "*" })).not.toThrow();
  expect(() => check({ "If-Match": '"b-old"' })).toThrow("dav_precondition_failed");
  expect(() => check({ "If-Match": 'W/"b-current"' })).toThrow("dav_precondition_failed");
  expect(() => check({ "If-Match": "*" }, null)).toThrow("dav_precondition_failed");
});

it("weakly compares If-None-Match and protects create-only PUT", () => {
  expect(() => check({ "If-None-Match": "*" }, null)).not.toThrow();
  expect(() => check({ "If-None-Match": '"b-old"' })).not.toThrow();
  expect(() => check({ "If-None-Match": "*" })).toThrow("dav_precondition_failed");
  expect(() => check({ "If-None-Match": 'W/"b-current"' })).toThrow("dav_precondition_failed");
});

it("rejects malformed or unbounded validators before streaming", () => {
  for (const value of ['"unterminated', '"a",', '*, "b"', '"a" garbage'])
    expect(() => check({ "If-Match": value })).toThrow("invalid_dav_precondition");
  expect(() => check({ "If-Match": '"a"'.repeat(3000) })).toThrow("invalid_dav_precondition");
  expect(() => check({ "If-Match": Array.from({ length: 17 }, () => '"x"').join(",") })).toThrow(
    "invalid_dav_precondition",
  );
});
