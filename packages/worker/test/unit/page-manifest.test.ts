import { expect, it } from "vitest";
import { identifyPageImage, pageImageType } from "../../src/media/archive/pageImage";
import { encodePageManifest, type PageTarget } from "../../src/services/pageManifest";
import {
  manifestBudgetTargets,
  manifestContains,
  parseTargetManifest,
} from "../../src/services/targetManifest";

const target: PageTarget = {
  spaceId: "space",
  nodeId: "node",
  blobId: "blob",
  purpose: "page",
  size: 100,
  archiveId: "11111111-1111-1111-1111-111111111111",
  generator: "archive-index-v1",
  indexHash: "a".repeat(64),
  indexBytes: 1000,
  pageCount: 2,
  pageBytes: [70, 30],
};
const parse = (t: unknown, total = 100) =>
  parseTargetManifest(
    new TextEncoder().encode(JSON.stringify({ v: 4, targets: [t] })).buffer as ArrayBuffer,
    total,
  );
it("pins every page size to one book and shares a single generation budget identity", async () => {
  const encoded = await encodePageManifest(target),
    manifest = parseTargetManifest(
      new TextEncoder().encode(encoded.json).buffer as ArrayBuffer,
      encoded.totalBytes,
    );
  expect(await manifestBudgetTargets(manifest)).toEqual([
    { key: `page:archive_${target.archiveId}`, size: 100 },
  ]);
  expect(
    manifestContains(manifest, {
      spaceId: "space",
      nodeId: "node",
      blobId: "blob",
      purpose: "page",
    }),
  ).toBe(false);
  expect(Object.isFrozen(manifest.targets[0])).toBe(true);
});
it.each([
  { generator: "future" },
  { archiveId: "arbitrary" },
  { purpose: "content" },
  { indexHash: "f" },
  { indexBytes: 8388609 },
  { pageCount: 10001 },
  { pageCount: 3 },
  { pageBytes: [100] },
  { pageBytes: [-1, 101] },
  { pageBytes: [70.5, 29.5] },
  { pageBytes: [70, 31] },
  { size: 101 },
  { pageBytes: [null, 100] },
  { unknown: true },
  { nodeId: "../node" },
])("rejects an invalid generation or allowance: %j", (change) => {
  expect(() => parse({ ...target, ...change })).toThrow();
});
it("accepts 10,000 bounded pages without creating 10,000 DO budget targets", async () => {
  const t = {
    ...target,
    pageCount: 10000,
    pageBytes: Array(10000).fill(64 * 1024 * 1024),
    size: 10000 * 64 * 1024 * 1024,
  };
  expect(() => parse(t, t.size)).toThrow();
  t.pageBytes.fill(100);
  t.size = 1000000;
  expect(await manifestBudgetTargets(parse(t, t.size))).toHaveLength(1);
});
it.each(["GIF87a", "GIF89a"])("accepts %s and refuses SVG/HTML/MP4", (signature) => {
  expect(pageImageType(new TextEncoder().encode(signature))).toBe("image/gif");
  for (const s of ["<svg/>", "<html>", "GIF89", "", "RIFF0000WEBPxx"])
    expect(pageImageType(new TextEncoder().encode(s))).toBeNull();
});
it("keeps bounded prefix bytes intact and propagates errors after the prefix", async () => {
  let pulls = 0,
    cancelled = false;
  const chunk = new Uint8Array(65536);
  chunk.set([255, 216, 255]);
  const source = new ReadableStream<Uint8Array>(
    {
      pull(c) {
        if (pulls++ === 0) c.enqueue(chunk);
        else c.error(new Error("bad_crc"));
      },
      cancel() {
        cancelled = true;
      },
    },
    { highWaterMark: 0 },
  );
  const image = await identifyPageImage(source, 131072, async () => {});
  expect(image.mime).toBe("image/jpeg");
  expect(pulls).toBe(1);
  const reader = image.body.getReader();
  expect((await reader.read()).value).toEqual(chunk);
  await expect(reader.read()).rejects.toThrow("bad_crc");
  expect(cancelled).toBe(false);
});
