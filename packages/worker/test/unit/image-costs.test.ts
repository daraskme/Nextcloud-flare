import { expect, it } from "vitest";
import {
  type ImageTransformGrant,
  imageOutputJson,
  imageTransformValues,
  validateImageTransformGrant,
} from "../../src/db/imageTransform";

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
