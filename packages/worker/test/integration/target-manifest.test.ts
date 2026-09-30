import { env } from "cloudflare:workers";
import { expect, it } from "vitest";
import {
  loadTargetManifest,
  stageTargetManifest,
  stageZipTargetManifest,
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
    const loaded = await loadTargetManifest(env.BLOBS, record);
    expect(loaded.v).toBe(1);
    if (loaded.v !== 1) throw new Error("unexpected_manifest");
    expect(loaded.targets.map((item) => item.nodeId)).toEqual(["node-a", "node-b"]);
    await env.BLOBS.put(record.ref, "{}");
    await expect(loadTargetManifest(env.BLOBS, record)).rejects.toThrow(/invalid_target_manifest/);
  } finally {
    await env.BLOBS.delete(record.ref);
  }
});

it("stages and hash-checks an ordered ZIP target set", async () => {
  const entries = [
    {
      path: "Folder/b.txt",
      rootId: "folder",
      spaceId: "space",
      nodeId: "node-b",
      blobId: "blob-b",
      size: 2,
      r2Etag: "etag-b",
    },
    {
      path: "Folder/a.txt",
      rootId: "folder",
      spaceId: "space",
      nodeId: "node-a",
      blobId: "blob-a",
      size: 1,
      r2Etag: "etag-a",
    },
  ];
  const record = await stageZipTargetManifest(env.BLOBS, entries, 300);
  try {
    const loaded = await loadTargetManifest(env.BLOBS, record);
    expect(loaded.v).toBe(2);
    if (loaded.v !== 2) throw new Error("unexpected_manifest");
    expect(loaded.entries.map((item) => item.path)).toEqual(["Folder/b.txt", "Folder/a.txt"]);
    expect(loaded.outputSize).toBe(300);
  } finally {
    await env.BLOBS.delete(record.ref);
  }
});
