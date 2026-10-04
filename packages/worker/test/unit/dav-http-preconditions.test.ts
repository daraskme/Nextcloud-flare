import { expect, it } from "vitest";
import {
  evaluateDavPutHttpPreconditions,
  evaluateDavReadHttpPreconditions,
} from "../../src/dav/httpPreconditions";

const current = '"b-current"';
const check = (headers: Record<string, string>, etag: string | null = current) =>
  evaluateDavPutHttpPreconditions(new Headers(headers), etag);

it("reads reject failing If-Match while leaving If-None-Match's 304 to the stream", () => {
  const read = (headers: Record<string, string>) =>
    evaluateDavReadHttpPreconditions(new Headers(headers), current, Date.UTC(2026, 0, 1));
  expect(() => read({ "If-Match": '"b-stale"', "If-None-Match": current })).toThrow(
    "dav_precondition_failed",
  );
  expect(() => read({ "If-Match": `W/${current}` })).toThrow("dav_precondition_failed");
  expect(() =>
    read({ "If-Match": '"b-stale", "b-current"', "If-None-Match": `W/${current}` }),
  ).not.toThrow();
  expect(() => read({ "If-None-Match": "*" })).not.toThrow();
  expect(() => read({ "If-None-Match": "malformed" })).toThrow("invalid_dav_precondition");
  expect(() => read({ "If-Unmodified-Since": "Sat, 01 Jan 2000 00:00:00 GMT" })).toThrow(
    "dav_precondition_failed",
  );
});

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

it("uses valid If-Unmodified-Since dates at HTTP second precision unless If-Match is present", () => {
  const modified = Date.UTC(2026, 0, 1, 12, 0, 0, 900);
  const dated = (headers: Record<string, string>) =>
    evaluateDavPutHttpPreconditions(new Headers(headers), current, modified);
  expect(() => dated({ "If-Unmodified-Since": "Thu, 01 Jan 2026 12:00:00 GMT" })).not.toThrow();
  expect(() => dated({ "If-Unmodified-Since": "Thu, 01 Jan 2026 11:59:59 GMT" })).toThrow(
    "dav_precondition_failed",
  );
  expect(() =>
    dated({ "If-Match": current, "If-Unmodified-Since": "Thu, 01 Jan 1970 00:00:00 GMT" }),
  ).not.toThrow();
  for (const date of [
    "",
    "tomorrow",
    "2020-01-01",
    "0",
    "Thu, 01 Jan 1970 00:00:00 +0000",
    "Tue, 31 Feb 1970 00:00:00 GMT",
    "Mon, 01 Jan 1970 24:00:00 GMT",
    "Bog, 01 Jan 1970 00:00:00 GMT",
  ])
    expect(() => dated({ "If-Unmodified-Since": date })).not.toThrow();
  expect(() => dated({ "If-Unmodified-Since": "Sunday, 06-Nov-94 08:49:37 GMT" })).toThrow(
    "dav_precondition_failed",
  );
  expect(() => dated({ "If-Unmodified-Since": "Thu Jan  1 00:00:00 1970" })).toThrow(
    "dav_precondition_failed",
  );
  expect(() => dated({ "If-Unmodified-Since": "Sat, 30 Jun 2012 23:59:60 GMT" })).toThrow(
    "dav_precondition_failed",
  );
});
