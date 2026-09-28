import { expect, it } from "vitest";
import { assertDavPutConditions, davEtag } from "../../src/dav/etag";

it("derives stable DAV file and collection validators", () => {
  expect(davEtag({ id: "file", kind: "file", revision: 9, current_blob_id: "blob_1" })).toBe(
    '"b-blob_1"',
  );
  expect(davEtag({ id: "folder", kind: "folder", revision: 9, current_blob_id: null })).toBe(
    '"c-folder-9"',
  );
  expect(davEtag({ id: "root", kind: "root", revision: 1, current_blob_id: null })).toBe(
    '"c-root-1"',
  );
});

it("rejects malformed DAV validator inputs", () => {
  expect(() => davEtag({ id: "file", kind: "file", revision: 1, current_blob_id: null })).toThrow(
    "invalid_dav_etag",
  );
  expect(() =>
    davEtag({ id: "folder", kind: "folder", revision: 1, current_blob_id: "blob" }),
  ).toThrow("invalid_dav_etag");
  expect(() =>
    davEtag({ id: "bad/id", kind: "folder", revision: 0, current_blob_id: null }),
  ).toThrow("invalid_dav_etag");
});

it.each([
  ["If-Match", '"old", "current"', '"current"', null],
  ["If-Match", 'W/"current"', '"current"', "dav_precondition_failed"],
  ["If-Match", "*", null, "dav_precondition_failed"],
  ["If-None-Match", "*", null, null],
  ["If-None-Match", 'W/"current"', '"current"', "dav_precondition_failed"],
  ["If-Match", '"old",*', '"current"', "invalid_dav_if"],
  ["If-Match", '"current" trailing', '"current"', "invalid_dav_if"],
  ["If-Match", '"a,b", "current"', '"current"', null],
])("evaluates HTTP PUT %s: %s", (header, value, etag, error) => {
  const run = () => assertDavPutConditions(new Headers({ [header!]: value! }), etag);
  if (error) expect(run).toThrow(error);
  else expect(run).not.toThrow();
});
