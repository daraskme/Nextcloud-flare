import { strToU8, zipSync } from "fflate";
import { expect, it } from "vitest";
import { inspectEpubObject } from "../../src/media/epub/index";
import { inspectZipDirectory, readZipEntry, type ZipObjectSource } from "../../src/media/epub/zip";

function epub(extra: Record<string, Uint8Array | [Uint8Array, { level: 0 }]> = {}): Uint8Array {
  return zipSync({
    mimetype: [strToU8("application/epub+zip"), { level: 0 }],
    "META-INF/": new Uint8Array(),
    "META-INF/container.xml": strToU8(
      `<?xml version="1.0"?><container version="1.0"><rootfiles>
        <rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/>
      </rootfiles></container>`,
    ),
    "OEBPS/": new Uint8Array(),
    "OEBPS/content.opf": strToU8(
      `<?xml version="1.0"?><package version="3.0" unique-identifier="book">
        <metadata><dc:title>Bounded Book</dc:title><dc:creator>Safe Author</dc:creator>
          <meta property="belongs-to-collection">Series One</meta>
        </metadata>
        <manifest>
          <item id="chapter" href="chapter.xhtml" media-type="application/xhtml+xml"/>
          <item id="cover" href="cover.png" media-type="image/png" properties="cover-image"/>
        </manifest>
        <spine><itemref idref="chapter"/></spine>
      </package>`,
    ),
    "OEBPS/chapter.xhtml": strToU8("<html><body>Chapter one</body></html>"),
    "OEBPS/cover.png": [Uint8Array.from([1, 2, 3, 4]), { level: 0 }],
    ...extra,
  });
}

function bucket(
  bytes: Uint8Array,
  calls: Array<{ offset: number; length: number }> = [],
): R2Bucket {
  return {
    async get(_key: string, options: R2GetOptions) {
      const range = options.range;
      if (!range || !("offset" in range) || !("length" in range)) throw new Error("expected_range");
      calls.push({ offset: range.offset, length: range.length });
      const body = bytes.slice(range.offset, range.offset + range.length);
      return {
        size: bytes.length,
        etag: "epub-etag",
        range: { offset: range.offset, length: body.length },
        arrayBuffer: async () => body.buffer,
      } as unknown as R2ObjectBody;
    },
  } as unknown as R2Bucket;
}

function source(bytes: Uint8Array): ZipObjectSource {
  return { key: "book", size: bytes.length, r2Etag: "epub-etag" };
}

function findSignature(bytes: Uint8Array, signature: readonly number[]): number {
  for (let index = 0; index <= bytes.length - signature.length; index += 1) {
    if (signature.every((value, offset) => bytes[index + offset] === value)) return index;
  }
  throw new Error("signature_not_found");
}

it("builds a bounded publication index from the central directory and required entries", async () => {
  const bytes = epub();
  const calls: Array<{ offset: number; length: number }> = [];
  const inspected = await inspectEpubObject(bucket(bytes, calls), source(bytes), Date.now() + 5000);
  expect(inspected).toMatchObject({
    kind: "indexed",
    index: {
      metadata: { title: "Bounded Book", author: "Safe Author", series: "Series One" },
    },
  });
  if (inspected.kind !== "indexed") throw new Error("expected_index");
  expect(inspected.index.entries).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ path: "mimetype", mime: "application/octet-stream", size: 20 }),
      expect.objectContaining({
        path: "META-INF/container.xml",
        mime: "application/xml",
        size: 181,
      }),
    ]),
  );
  expect(inspected.index.spine).toHaveLength(1);
  expect(inspected.index.coverToken).toBe(
    inspected.index.entries.find((entry) => entry.path === "OEBPS/cover.png")?.token,
  );
  expect(calls.every((call) => call.length <= 8_388_608)).toBe(true);
});

it.each([
  [
    "encrypted",
    (bytes: Uint8Array) => {
      const central = findSignature(bytes, [0x50, 0x4b, 0x01, 0x02]);
      bytes[central + 8] = (bytes[central + 8] ?? 0) | 1;
    },
  ],
  [
    "zip64",
    (bytes: Uint8Array) => {
      const eocd = findSignature(bytes, [0x50, 0x4b, 0x05, 0x06]);
      bytes[eocd + 10] = 0xff;
      bytes[eocd + 11] = 0xff;
    },
  ],
] as const)(
  "fails closed for %s archives before extracting publication content",
  async (_name, mutate) => {
    const bytes = epub().slice();
    mutate(bytes);
    expect(await inspectEpubObject(bucket(bytes), source(bytes), Date.now() + 5000)).toMatchObject({
      kind: "unsupported",
    });
  },
);

it("rejects path traversal and excessive compression ratios", async () => {
  const traversal = epub({ "../escape": strToU8("outside") });
  expect(
    await inspectEpubObject(bucket(traversal), source(traversal), Date.now() + 5000),
  ).toMatchObject({ kind: "malformed" });

  const bomb = epub({ "OEBPS/bomb.bin": new Uint8Array(2_000_000) });
  expect(await inspectEpubObject(bucket(bomb), source(bomb), Date.now() + 5000)).toMatchObject({
    kind: "unsupported",
  });
});

it("rejects scripted spine documents even when the manifest omits scripted properties", async () => {
  const bytes = epub({
    "OEBPS/chapter.xhtml": strToU8("<html><body onload='run()'>Chapter</body></html>"),
  });
  expect(await inspectEpubObject(bucket(bytes), source(bytes), Date.now() + 5000)).toEqual({
    kind: "unsupported",
    code: "unsupported_scripted_epub",
  });
});

it("validates local headers and CRC before returning an indexed entry", async () => {
  const bytes = epub().slice();
  const entries = await inspectZipDirectory(bucket(bytes), source(bytes), Date.now() + 5000);
  const cover = entries.find((entry) => entry.path === "OEBPS/cover.png");
  if (!cover) throw new Error("missing_cover");
  const local = cover.localHeaderOffset;
  const nameBytes = (bytes[local + 26] ?? 0) | ((bytes[local + 27] ?? 0) << 8);
  const extraBytes = (bytes[local + 28] ?? 0) | ((bytes[local + 29] ?? 0) << 8);
  const dataOffset = local + 30 + nameBytes + extraBytes;
  bytes[dataOffset] = (bytes[dataOffset] ?? 0) ^ 0xff;
  await expect(
    readZipEntry(bucket(bytes), source(bytes), cover, Date.now() + 5000),
  ).rejects.toThrow("entry_crc_mismatch");
});

it("treats R2 identity changes and expired deadlines as transient", async () => {
  const bytes = epub();
  expect(
    await inspectEpubObject(
      bucket(bytes),
      { key: "book", size: bytes.length, r2Etag: "other" },
      Date.now() + 5000,
    ),
  ).toMatchObject({ kind: "transient" });
  expect(await inspectEpubObject(bucket(bytes), source(bytes), Date.now() - 1)).toMatchObject({
    kind: "transient",
  });
});
