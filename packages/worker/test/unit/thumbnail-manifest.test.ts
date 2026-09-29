import { expect, it } from "vitest";
import {
  encodeTargetManifest,
  manifestBudgetTargets,
  manifestContains,
  parseTargetManifest,
} from "../../src/services/targetManifest";
import {
  encodeThumbnailManifest,
  type ThumbnailTarget,
} from "../../src/services/thumbnailManifest";

const target = (extra: Partial<ThumbnailTarget> = {}): ThumbnailTarget => ({
  spaceId: "space",
  nodeId: "node",
  blobId: "source",
  purpose: "thumb",
  size: 70,
  imageId: "00000000-0000-0000-0000-000000000001",
  variant: "sm",
  generator: "image-webp-v1",
  ...extra,
});
const parse = (value: unknown, total = 70) =>
  parseTargetManifest(new TextEncoder().encode(JSON.stringify(value)).buffer as ArrayBuffer, total);
it("encodes canonical generation-bound manifests independently of input order", async () => {
  const a = target(),
    b = target({ variant: "md", imageId: "00000000-0000-0000-0000-000000000002", size: 90 });
  const x = await encodeThumbnailManifest([a, b]),
    y = await encodeThumbnailManifest([b, a]);
  expect(x).toEqual(y);
  expect(x.totalBytes).toBe(160);
  expect(x.hash).toMatch(/^[a-f0-9]{64}$/);
  const manifest = parse(JSON.parse(x.json), 160);
  expect(manifest.v).toBe(3);
  expect(await manifestBudgetTargets(manifest)).toEqual([
    { key: "thumb:image_" + b.imageId, size: 90 },
    { key: "thumb:image_" + a.imageId, size: 70 },
  ]);
  expect(manifestContains(manifest, a)).toBe(false);
});
it.each([
  { purpose: "content" },
  { variant: "huge" },
  { generator: "client-thumb" },
  { imageId: "../../x" },
  { blobId: "a/b" },
  { size: 0 },
  { size: 12582913 },
  { size: 1.5 },
  { secret: "not allowed" },
])("rejects a malformed thumbnail target %j", (extra) => {
  const row = { ...target(), ...extra };
  expect(() => parse({ v: 3, targets: [row] }, row.size)).toThrow();
});
it("rejects missing fields, duplicates, ambiguous generations and mismatched totals", () => {
  const { imageId: _id, ...missing } = target();
  for (const value of [
    { v: 3, targets: [] },
    { v: 3, targets: [missing] },
    { v: 3, targets: [target()], extra: 1 },
  ])
    expect(() => parse(value)).toThrow();
  expect(() => parse({ v: 3, targets: [target(), target()] }, 140)).toThrow();
  expect(() =>
    parse({ v: 3, targets: [target(), target({ nodeId: "alias", variant: "md" })] }, 140),
  ).toThrow();
  expect(() => parse({ v: 3, targets: [target()] }, 71)).toThrow();
});
it("COW aliases share the same generation budget key, while variants remain distinct", async () => {
  const encoded = await encodeThumbnailManifest([target(), target({ nodeId: "alias" })]);
  const keys = await manifestBudgetTargets(parse(JSON.parse(encoded.json), 140));
  expect(new Set(keys.map((t) => t.key)).size).toBe(1);
});
it("retains the original v1 format for old target manifests", async () => {
  const { imageId: _id, variant: _variant, generator: _generator, ...old } = target();
  const encoded = await encodeTargetManifest([old]);
  expect(parse(JSON.parse(encoded.json))).toEqual({ v: 1, targets: [old] });
});
