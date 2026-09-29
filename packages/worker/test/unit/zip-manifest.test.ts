import { expect, it } from "vitest";
import { storeZip } from "../../src/platform/storeZip";
import { manifestBudgetTargets, parseTargetManifest } from "../../src/services/targetManifest";
import { encodeZipManifest, type ZipSnapshot } from "../../src/services/zipManifest";

function snapshot(): ZipSnapshot {
  return {
    spaceId: "space",
    rootNodeId: "root",
    rootRevision: 1,
    treeGeneration: 1,
    entries: [
      { nodeId: "folder", revision: 1, path: "資料/", kind: "folder", blobId: null, size: 0 },
      {
        nodeId: "file",
        revision: 2,
        path: "資料/日本語.txt",
        kind: "file",
        blobId: "blob",
        size: 3,
      },
      { nodeId: "empty", revision: 1, path: "empty/", kind: "folder", blobId: null, size: 0 },
    ],
  };
}
const parse = (encoded: Awaited<ReturnType<typeof encodeZipManifest>>) =>
  parseTargetManifest(
    new TextEncoder().encode(encoded.json).buffer as ArrayBuffer,
    encoded.totalBytes,
  );

it("binds the exact STORE wire size, paths, empty folders and real blob targets", async () => {
  const value = snapshot(),
    encoded = await encodeZipManifest(value);
  const reversed = await encodeZipManifest({ ...value, entries: [...value.entries].reverse() });
  expect(encoded).toEqual(reversed);
  const manifest = parse(encoded);
  expect(manifest.v).toBe(2);
  if (manifest.v !== 2) throw new Error("expected_zip_manifest");
  expect(manifest.targets).toEqual([
    { spaceId: "space", nodeId: "file", blobId: "blob", purpose: "zip", size: 3 },
  ]);
  const result = storeZip(
    manifest.zip.entries.map((entry) => ({
      name: entry.path,
      size: entry.size,
      directory: entry.kind === "folder",
      open: async () => new Blob(["abc"]).stream(),
    })),
  );
  const bytes = await new Response(result.body).arrayBuffer();
  expect(bytes.byteLength).toBe(encoded.totalBytes);
  expect(bytes.byteLength).toBeGreaterThan(3);
  expect(Object.isFrozen(manifest.zip.entries)).toBe(true);
});

it("funds empty archives and keeps archive identity stable across unrelated revisions and aliases", async () => {
  const value = snapshot();
  const original = parse(await encodeZipManifest(value));
  const changed = parse(
    await encodeZipManifest({
      ...value,
      treeGeneration: 500,
      rootRevision: 7,
      rootNodeId: "other-root",
      entries: value.entries.map((entry) => ({
        ...entry,
        revision: 8,
        nodeId: `${entry.nodeId}-copy`,
      })),
    }),
  );
  expect(await manifestBudgetTargets(original)).toEqual(await manifestBudgetTargets(changed));
  const empty = await encodeZipManifest({ ...value, entries: [] });
  expect(empty.totalBytes).toBe(22);
  expect((await manifestBudgetTargets(parse(empty)))[0]?.size).toBe(22);
});

it("separates different archive bytes from raw blob allowances", async () => {
  const value = snapshot();
  const before = await manifestBudgetTargets(parse(await encodeZipManifest(value)));
  const after = await manifestBudgetTargets(
    parse(
      await encodeZipManifest({
        ...value,
        entries: value.entries.map((entry) =>
          entry.kind === "file" ? { ...entry, path: "資料/renamed" } : entry,
        ),
      }),
    ),
  );
  expect(before[0]?.key).not.toBe(after[0]?.key);
  expect(before[0]?.key).toMatch(/^zip:archive:[a-f0-9]{64}$/);
  expect(
    await manifestBudgetTargets({
      v: 1,
      targets: [{ spaceId: "space", nodeId: "file", blobId: "blob", purpose: "zip", size: 3 }],
    }),
  ).toEqual([{ key: "zip:blob", size: 3 }]);
});

it.each(["size", "target", "path", "order", "version", "serializer", "extra"])(
  "rejects tampered %s instead of granting bytes from redundant metadata",
  async (change) => {
    const encoded = await encodeZipManifest(snapshot()),
      value = JSON.parse(encoded.json);
    if (change === "size") value.outputBytes++;
    if (change === "target") value.targets[0].size++;
    if (change === "path") value.zip.entries[2].path = "../escape";
    if (change === "order") value.zip.entries.reverse();
    if (change === "version") value.v = 3;
    if (change === "serializer") value.serializer = "deflate-v1";
    if (change === "extra") value.secret = true;
    expect(() => parse({ ...encoded, json: JSON.stringify(value) })).toThrow(
      /invalid_(zip|target|thumbnail)_manifest/,
    );
  },
);

it.each([
  "duplicate-node",
  "duplicate-path",
  "missing-folder",
  "folder-payload",
  "root-member",
  "unnormalized",
  "unsafe",
  "limit",
])("rejects invalid snapshot %s", async (change) => {
  const value = snapshot(),
    entries = [...value.entries];
  if (change === "duplicate-node") entries[2] = { ...entries[2]!, nodeId: "file" };
  if (change === "duplicate-path") entries[2] = { ...entries[2]!, path: "資料/" };
  if (change === "missing-folder") entries.splice(0, 1);
  if (change === "folder-payload") entries[0] = { ...entries[0]!, size: 1 };
  if (change === "root-member") entries[0] = { ...entries[0]!, nodeId: "root" };
  if (change === "unnormalized") entries[2] = { ...entries[2]!, path: "e\u0301/" };
  if (change === "unsafe") entries[2] = { ...entries[2]!, path: "../" };
  if (change === "limit") entries[1] = { ...entries[1]!, size: 4_294_967_295 };
  await expect(encodeZipManifest({ ...value, entries })).rejects.toThrow(/invalid_zip_manifest/);
});

it("accepts 1,000 entries and rejects a larger snapshot", async () => {
  const entries = Array.from({ length: 1_000 }, (_, i) => ({
    nodeId: `n${i}`,
    revision: 1,
    path: `n${i}`,
    kind: "file" as const,
    blobId: "shared-blob",
    size: 1,
  }));
  const value = { ...snapshot(), entries };
  expect(parse(await encodeZipManifest(value)).targets.length).toBe(1_000);
  await expect(
    encodeZipManifest({
      ...value,
      entries: [...entries, { ...entries[0]!, nodeId: "extra", path: "extra" }],
    }),
  ).rejects.toThrow(/invalid_zip_manifest/);
});
