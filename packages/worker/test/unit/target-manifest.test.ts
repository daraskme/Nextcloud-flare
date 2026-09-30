import { createHash } from "node:crypto";
import { expect, it } from "vitest";
import {
  encodeTargetManifest,
  parseTargetManifest,
  type TargetEntry,
} from "../../src/services/targetManifest";

const entry = (nodeId: string): TargetEntry => ({
  spaceId: "space",
  nodeId,
  blobId: `blob-${nodeId}`,
  purpose: "content",
  size: 3,
});

it("encodes the same target set to stable bounded bytes and a SHA-256 digest", async () => {
  const first = await encodeTargetManifest([entry("z"), entry("a")]);
  const second = await encodeTargetManifest([entry("a"), entry("z")]);
  expect(first).toEqual(second);
  expect(first.json).toBe(
    '{"v":1,"targets":[{"spaceId":"space","nodeId":"a","blobId":"blob-a","purpose":"content","size":3},{"spaceId":"space","nodeId":"z","blobId":"blob-z","purpose":"content","size":3}]}',
  );
  expect(first.hash).toBe(createHash("sha256").update(first.json).digest("hex"));
  expect(first.totalBytes).toBe(6);
  expect(
    parseTargetManifest(
      new TextEncoder().encode(first.json).buffer as ArrayBuffer,
      first.totalBytes,
    ),
  ).toEqual({
    v: 1,
    targets: [entry("a"), entry("z")],
  });
});

it("accepts 1,000 distinct targets and rejects a duplicate or larger set", async () => {
  const thousand = Array.from({ length: 1000 }, (_, i) => entry(`n${i}`));
  const encoded = await encodeTargetManifest(thousand);
  expect(encoded.totalBytes).toBe(3000);
  expect(new TextEncoder().encode(encoded.json).byteLength).toBeLessThanOrEqual(1_048_576);
  await expect(encodeTargetManifest([...thousand, entry("extra")])).rejects.toThrow(
    /invalid_target_manifest/,
  );
  await expect(encodeTargetManifest([entry("a"), entry("a")])).rejects.toThrow(
    /invalid_target_manifest/,
  );
});

it("rejects empty, malformed and oversized targets before publication", async () => {
  await expect(encodeTargetManifest([])).rejects.toThrow(/invalid_target_manifest/);
  await expect(encodeTargetManifest([{ ...entry("a"), size: -1 }])).rejects.toThrow(
    /invalid_target_manifest/,
  );
  await expect(encodeTargetManifest([{ ...entry("a"), nodeId: "x".repeat(129) }])).rejects.toThrow(
    /invalid_target_manifest/,
  );
  await expect(encodeTargetManifest([{ ...entry("a"), size: 536_870_912_001 }])).rejects.toThrow(
    /invalid_target_manifest/,
  );
});
