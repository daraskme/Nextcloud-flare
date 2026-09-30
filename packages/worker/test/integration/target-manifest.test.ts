import { env } from "cloudflare:workers";
import { expect, it } from "vitest";
import {
  loadTargetManifest,
  stageTargetManifest,
  type TargetEntry,
} from "../../src/services/targetManifest";

it("stages a hash-pinned target set in R2 and rejects a changed object", async () => {
  const targets: TargetEntry[] = [
    { spaceId: "space", nodeId: "node-b", blobId: "blob-b", purpose: "content", size: 2 },
    { spaceId: "space", nodeId: "node-a", blobId: "blob-a", purpose: "content", size: 1 },
  ];
  const record = await stageTargetManifest(env.BLOBS, targets);
  try {
    expect(record.ref).toBe(`target-sets/${record.id}`);
    expect(record.totalBytes).toBe(3);
    expect(
      (await loadTargetManifest(env.BLOBS, record)).targets.map((item) => item.nodeId),
    ).toEqual(["node-a", "node-b"]);
    await env.BLOBS.put(record.ref, "{}");
    await expect(loadTargetManifest(env.BLOBS, record)).rejects.toThrow(/invalid_target_manifest/);
  } finally {
    await env.BLOBS.delete(record.ref);
  }
});
