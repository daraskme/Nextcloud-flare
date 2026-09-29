import { expect, it } from "vitest";
import {
  type ImageTransformGrant,
  type ImageTransformTerminal,
  imageOutputJson,
  imageTerminalJson,
  imageTransformValues,
  validateImageTransformGrant,
} from "../../src/db/imageTransform";
import type { ImageTransformFailureReceipt } from "../../src/media/images/failure";

const grant = (): ImageTransformGrant => ({
  id: crypto.randomUUID(),
  token: crypto.randomUUID(),
  epoch: 1,
  ownerId: "owner",
  blobId: "blob",
  outboxId: "event",
  claimToken: crypto.randomUUID(),
  variant: "sm",
  generator: "image-webp-v1",
  startedAt: 1000,
  deadline: 5000,
  expiresAt: 25000,
  source: {
    nodeId: "node",
    parentId: "parent",
    key: "u/owner/b/blob",
    etag: "etag",
    size: 99,
    width: 16,
    height: 12,
  },
});
it("canonicalizes the full immutable identity independently of object key order", () => {
  const g = grant();
  expect(() => validateImageTransformGrant(g)).not.toThrow();
  expect(imageTransformValues(g)).toEqual(
    imageTransformValues({
      ...g,
      source: {
        height: 12,
        width: 16,
        size: 99,
        etag: "etag",
        key: "u/owner/b/blob",
        parentId: "parent",
        nodeId: "node",
      },
    }),
  );
});
it.each([
  ["epoch", 0],
  ["id", "bad"],
  ["token", "bad"],
  ["claimToken", "bad"],
  ["ownerId", "../owner"],
  ["variant", "constructor"],
  ["variant", "xl"],
  ["generator", "user-supplied"],
  ["deadline", 1000],
  ["deadline", 6001],
  ["expiresAt", 4999],
  ["expiresAt", 26001],
] as const)("rejects invalid %s = %s", (field, value) => {
  expect(() =>
    validateImageTransformGrant({ ...grant(), [field]: value } as ImageTransformGrant),
  ).toThrow("invalid_image_transform");
});
it.each([
  ["key", "u/other/b/blob"],
  ["nodeId", ""],
  ["etag", ""],
  ["size", 0],
  ["size", 20_000_001],
  ["width", 257],
  ["height", NaN],
  ["height", 1.5],
] as const)("rejects invalid source %s = %s", (field, value) => {
  const g = grant();
  expect(() =>
    validateImageTransformGrant({
      ...g,
      source: { ...g.source, [field]: value },
    } as ImageTransformGrant),
  ).toThrow("invalid_image_transform");
});
it.each([
  { bytes: 0 },
  { bytes: 12 * 1024 * 1024 + 1 },
  { width: 17 },
  { height: 13 },
  { sha256: "invented" },
])("rejects invalid completion %j", (change) => {
  expect(() =>
    imageOutputJson(grant(), {
      bytes: 68,
      width: 16,
      height: 12,
      sha256: "a".repeat(64),
      ...change,
    }),
  ).toThrow("invalid_image_transform_output");
});

it.each([
  ["failed", null, null],
  ["failed", null, { kind: "binding_rejected", code: 9529 }],
  ["failed", null, { kind: "binding_rejected", code: "9520" }],
  ["failed", null, { kind: "output_rejected", code: 9520 }],
  ["failed", null, { kind: "invented", code: null }],
  ["not_started", null, { kind: "binding_rejected", code: 9520 }],
  ["succeeded", null, { kind: "output_rejected", code: null }],
  ["unknown", null, null],
])("rejects invalid terminal failure %j %j %j", (state, output, failure) => {
  expect(() =>
    imageTerminalJson(
      grant(),
      state as ImageTransformTerminal,
      output as null,
      failure as ImageTransformFailureReceipt,
    ),
  ).toThrow();
});
it("canonicalizes only bounded failure facts, excluding native error bodies", () => {
  expect(
    imageTerminalJson(grant(), "failed", null, {
      kind: "binding_rejected",
      code: 9520,
      message: "PRIVATE",
    } as ImageTransformFailureReceipt),
  ).toEqual({ output: null, failure: '{"kind":"binding_rejected","code":9520}' });
  expect(
    imageTerminalJson(grant(), "failed", null, { kind: "output_rejected", code: null }),
  ).toEqual({ output: null, failure: '{"kind":"output_rejected","code":null}' });
});

it("binds cover costs to the exact embedded bytes without limiting the full audio to 20 MB", () => {
  const g = grant();
  g.generator = "audio-cover-webp-v1";
  g.source.size = 100_000_000;
  g.source.cover = { bytes: 999, sha256: "a".repeat(64) };
  expect(() => validateImageTransformGrant(g)).not.toThrow();
  const json = imageTransformValues(g)[9];
  expect(JSON.parse(json as string)).toMatchObject({ size: 100_000_000, cover: g.source.cover });
  g.source.cover.sha256 = "b".repeat(64);
  expect(imageTransformValues(g)[9]).not.toBe(json);
  for (const cover of [
    undefined,
    { bytes: 0, sha256: "a".repeat(64) },
    { bytes: 20_000_001, sha256: "a".repeat(64) },
    { bytes: 999, sha256: "bad" },
  ])
    expect(() => {
      const source = { ...g.source };
      if (cover) source.cover = cover;
      else delete source.cover;
      validateImageTransformGrant({ ...g, source });
    }).toThrow();
  expect(() => validateImageTransformGrant({ ...g, variant: "lg" })).toThrow();
  expect(() => validateImageTransformGrant({ ...g, source: { ...g.source, size: 998 } })).toThrow();
  expect(() =>
    validateImageTransformGrant({
      ...g,
      generator: "image-webp-v1",
      source: { ...g.source, size: 999 },
    }),
  ).toThrow();
});
