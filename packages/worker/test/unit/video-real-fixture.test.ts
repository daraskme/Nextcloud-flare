import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { inspectVideoObject } from "../../src/media/video";

const fixturePath = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../fixtures/av1-opus-32x24.webm",
);

it("parses real AV1 and Opus tracks from a compact WebM fixture", async () => {
  const bytes = new Uint8Array(await readFile(fixturePath));
  const ranges: Array<{ offset: number; length: number }> = [];
  const bucket = {
    async get(_key: string, options: R2GetOptions) {
      const range = options.range;
      if (!range || !("offset" in range) || !("length" in range)) throw new Error("expected_range");
      ranges.push({ offset: range.offset, length: range.length });
      const body = bytes.slice(range.offset, range.offset + range.length);
      return {
        size: bytes.length,
        etag: "fixture-etag",
        arrayBuffer: async () => body.buffer,
      } as unknown as R2ObjectBody;
    },
  } as unknown as R2Bucket;

  expect(
    await inspectVideoObject(
      bucket,
      { key: "fixture.webm", size: bytes.length, r2Etag: "fixture-etag" },
      Date.now() + 5000,
    ),
  ).toEqual({
    kind: "metadata",
    metadata: {
      container: "webm",
      width: 32,
      height: 24,
      durationMs: 1008,
      configuration: { profile: 0, level: 0, tier: "M", bitDepth: 8 },
      audio: "opus",
    },
  });
  expect(ranges).toEqual([{ offset: 0, length: bytes.length }]);
});
