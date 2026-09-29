import { zipSync } from "fflate";
import { describe, expect, it, vi } from "vitest";
import { openArchiveEntry } from "../../src/media/archive/entry";
import { ARCHIVE_LIMITS, crc32 } from "../../src/media/archive/format";
import { inspectArchive } from "../../src/media/archive/index";
import {
  archiveFixture,
  archiveText,
  concat,
  extra,
  fixtureCrc,
  memoryArchive,
} from "../fixtures/archive";

const checkpoint = async () => {};

async function extract(bytes: Uint8Array, ordinal = 0) {
  const source = memoryArchive(bytes),
    index = await inspectArchive(source);
  return new Uint8Array(
    await new Response(await openArchiveEntry(source, index, ordinal, checkpoint)).arrayBuffer(),
  );
}

it("matches the independent CRC-32 vector across arbitrary chunk boundaries", () => {
  expect(crc32(archiveText)).toBe(0xcbf43926);
  expect(crc32(archiveText.subarray(4), crc32(archiveText.subarray(0, 4)))).toBe(0xcbf43926);
  expect(crc32(new Uint8Array())).toBe(0);
});

describe.each([false, true])("ZIP64 end=%s", (zipEnd) => {
  it.each([false, true])("extracts stored and deflated entries, local ZIP64=%s", async (zip64) => {
    for (const descriptor of [undefined, "signed", "unsigned"] as const) {
      const fixture = archiveFixture(
        [
          { zip64, ...(descriptor ? { descriptor } : {}) },
          { zip64, method: 8, name: "p2.png", ...(descriptor ? { descriptor } : {}) },
        ],
        zipEnd,
      );
      expect(await extract(fixture.bytes, 0)).toEqual(archiveText);
      expect(await extract(fixture.bytes, 1)).toEqual(archiveText);
    }
  });
});

it("reads third-party UTF-8 stored/deflated ZIPs and allows empty files/archives", async () => {
  const bytes = zipSync({
    "日本語/1.png": [archiveText, { level: 0 }],
    "日本語/2.png": archiveText,
    "empty.txt": new Uint8Array(),
  });
  expect(await extract(bytes)).toEqual(archiveText);
  expect(await extract(bytes, 1)).toEqual(archiveText);
  expect(await extract(bytes, 2)).toEqual(new Uint8Array());
  expect((await inspectArchive(memoryArchive(archiveFixture([]).bytes))).entries).toEqual([]);
});

it("sorts image candidates naturally without locale/number precision dependence", async () => {
  const names = [
    "p10.AVIF",
    "p2.jpg",
    "p01.png",
    "p1.png",
    "p9007199254740993.gif",
    "p9007199254740992.webp",
    "evil.svg",
    "a.xhtml",
    "folder/",
    "x.constructor",
    "x.__proto__",
  ];
  const index = await inspectArchive(
    memoryArchive(
      archiveFixture(
        names.map((name) => ({
          name,
          ...(name.endsWith("/") ? { content: new Uint8Array() } : {}),
        })),
      ).bytes,
    ),
  );
  expect(index.pages.map((n) => index.entries[n]!.path)).toEqual([
    "p1.png",
    "p01.png",
    "p2.jpg",
    "p10.AVIF",
    "p9007199254740992.webp",
    "p9007199254740993.gif",
  ]);
  expect(
    Object.isFrozen(index) && Object.isFrozen(index.entries) && Object.isFrozen(index.entries[0]),
  ).toBe(true);
});

it("accepts CP437 and CRC-validated Unicode path extras", async () => {
  const rawName = new Uint8Array([0x82, 0x2e, 0x6a, 0x70, 0x67]);
  expect(
    (await inspectArchive(memoryArchive(archiveFixture([{ rawName, flags: 0 }]).bytes))).entries[0]!
      .path,
  ).toBe("é.jpg");
  const name = new TextEncoder().encode("日本語.jpg"),
    info = new Uint8Array(5 + name.length);
  info[0] = 1;
  new DataView(info.buffer).setUint32(1, fixtureCrc(rawName), true);
  info.set(name, 5);
  const fixture = archiveFixture([{ rawName, flags: 0, extra: extra(0x7075, info) }]);
  expect((await inspectArchive(memoryArchive(fixture.bytes))).entries[0]!.path).toBe("日本語.jpg");
  expect(await extract(fixture.bytes)).toEqual(archiveText);
  info[1] = info[1]! ^ 1;
  expect(
    (
      await inspectArchive(
        memoryArchive(archiveFixture([{ rawName, flags: 0, extra: extra(0x7075, info) }]).bytes),
      )
    ).entries[0]!.path,
  ).toBe("é.jpg");
});

it.each([
  "../x.jpg",
  "/x.jpg",
  "C:/x.jpg",
  "x\\y.jpg",
  "./x.jpg",
  "a//x.jpg",
  "a/../x.jpg",
  "a\u0000.jpg",
  "a\u0085.jpg",
  "a".repeat(1025),
  `${"a/".repeat(64)}x.jpg`,
])("rejects unsafe path %j", async (name) => {
  await expect(inspectArchive(memoryArchive(archiveFixture([{ name }]).bytes))).rejects.toThrow(
    "archive_unsafe_path",
  );
});

it.each([
  ["é.jpg", "e\u0301.jpg"],
  ["x.jpg", "x.jpg"],
  ["x", "x/"],
  ["x", "x/y.jpg"],
  ["x/y.jpg", "x"],
])("rejects duplicate or conflicting normalized paths %j", async (a, b) => {
  await expect(
    inspectArchive(
      memoryArchive(
        archiveFixture(
          [a, b].map((name) => ({
            name,
            ...(name.endsWith("/") ? { content: new Uint8Array() } : {}),
          })),
        ).bytes,
      ),
    ),
  ).rejects.toThrow(/archive_(duplicate_path|path_conflict)/);
});

it.each([1, 0x40, 0x2000, 0x10, 0x8000, 2])("rejects unsupported STORE flags %i", async (flags) => {
  await expect(inspectArchive(memoryArchive(archiveFixture([{ flags }]).bytes))).rejects.toThrow(
    "unsupported_archive_flags",
  );
});

it.each([9, 12, 14, 99])("rejects compression method %i", async (method) => {
  await expect(inspectArchive(memoryArchive(archiveFixture([{ method }]).bytes))).rejects.toThrow(
    "unsupported_archive_method",
  );
});

it("rejects malformed UTF-8 and Unix symlinks", async () => {
  await expect(
    inspectArchive(
      memoryArchive(archiveFixture([{ rawName: new Uint8Array([0xc0, 0xaf]) }]).bytes),
    ),
  ).rejects.toThrow("archive_name_encoding");
  const f = archiveFixture(),
    v = new DataView(f.bytes.buffer),
    at = f.centralOffset;
  v.setUint16(at + 4, 0x0314, true);
  v.setUint32(at + 38, 0xa1ff0000, true);
  await expect(inspectArchive(memoryArchive(f.bytes))).rejects.toThrow(
    "unsupported_archive_file_type",
  );
});

it("bounds EOCD and central reads without opening original data", async () => {
  const f = archiveFixture([{ content: new Uint8Array(2 * ARCHIVE_LIMITS.tailBytes) }]);
  const source = memoryArchive(f.bytes);
  await inspectArchive(source);
  expect(source.reads).toEqual([
    [f.bytes.length - ARCHIVE_LIMITS.tailBytes, ARCHIVE_LIMITS.tailBytes],
  ]);
  expect(source.opens).toEqual([]);
});

it("rejects over-limit directory counts and sizes before fetching the directory", async () => {
  for (const type of ["count", "size"]) {
    const f = archiveFixture(),
      view = new DataView(f.bytes.buffer),
      source = memoryArchive(f.bytes);
    if (type === "count") {
      view.setUint16(f.endOffset + 8, 10001, true);
      view.setUint16(f.endOffset + 10, 10001, true);
    } else view.setUint32(f.endOffset + 12, ARCHIVE_LIMITS.centralBytes + 1, true);
    await expect(inspectArchive(source)).rejects.toThrow("archive_index_limit");
    expect(source.reads).toHaveLength(1);
  }
});

it("rejects entry/aggregate expansion limits before opening bodies", async () => {
  await expect(
    inspectArchive(
      memoryArchive(archiveFixture([{ method: 8, size: ARCHIVE_LIMITS.entryBytes + 1 }]).bytes),
    ),
  ).rejects.toThrow("archive_size_limit");
  await expect(
    inspectArchive(
      memoryArchive(
        archiveFixture(
          Array.from({ length: 129 }, (_, n) => ({
            name: `${n}.png`,
            method: 8,
            size: ARCHIVE_LIMITS.entryBytes,
          })),
        ).bytes,
      ),
    ),
  ).rejects.toThrow("archive_size_limit");
});

it.each(["wide", "multidisk", "central", "locator", "missing", "record"])(
  "rejects malformed ZIP64 %s",
  async (kind) => {
    const f = archiveFixture([{ zip64: true }], true),
      v = new DataView(f.bytes.buffer),
      zip = f.endOffset - 76;
    if (kind === "wide") v.setBigUint64(zip + 48, 2n ** 53n, true);
    if (kind === "multidisk") v.setUint32(zip + 16, 1, true);
    if (kind === "central") v.setBigUint64(zip + 48, BigInt(f.centralOffset + 1), true);
    if (kind === "locator") v.setBigUint64(f.endOffset - 12, BigInt(f.endOffset), true);
    if (kind === "missing") v.setUint32(f.endOffset - 20, 0, true);
    if (kind === "record") v.setBigUint64(zip + 4, 45n, true);
    await expect(inspectArchive(memoryArchive(f.bytes))).rejects.toThrow();
  },
);

it("rejects truncated/ambiguous EOCD and conflicting local offsets", async () => {
  const f = archiveFixture([{}, { name: "p2.jpg" }]);
  await expect(inspectArchive(memoryArchive(f.bytes.slice(0, -1)))).rejects.toThrow();
  new DataView(f.bytes.buffer).setUint32(f.offsets[1]!.central + 42, 0, true);
  await expect(inspectArchive(memoryArchive(f.bytes))).rejects.toThrow("archive_range_invalid");
  const one = archiveFixture(),
    comment = concat(one.bytes, one.bytes.subarray(one.endOffset));
  new DataView(comment.buffer).setUint16(one.endOffset + 20, 22, true);
  await expect(inspectArchive(memoryArchive(comment))).rejects.toThrow("archive_ambiguous_end");
});

it.each(["flags", "method", "size", "crc", "name", "extra", "version", "descriptor"])(
  "rejects local/central %s mismatch before opening data",
  async (kind) => {
    const f = archiveFixture([{ descriptor: "signed" }]),
      source = memoryArchive(f.bytes),
      index = await inspectArchive(source),
      v = new DataView(f.bytes.buffer);
    if (kind === "flags") v.setUint16(6, 0x800, true);
    if (kind === "method") v.setUint16(8, 8, true);
    if (kind === "size") v.setUint32(22, 10, true);
    if (kind === "crc") v.setUint32(14, 1, true);
    if (kind === "name") f.bytes[30] = 0x78;
    if (kind === "extra") v.setUint16(28, 65535, true);
    if (kind === "version") v.setUint16(4, 45, true);
    if (kind === "descriptor") v.setUint32(f.offsets[0]!.descriptor + 4, 1, true);
    await expect(openArchiveEntry(source, index, 0, checkpoint)).rejects.toThrow();
    expect(source.opens).toEqual([]);
  },
);

it("errors on late CRC failure and truncated DEFLATE rather than reporting success", async () => {
  await expect(extract(archiveFixture([{ crc: 1 }]).bytes)).rejects.toThrow("archive_crc_mismatch");
  await expect(
    extract(archiveFixture([{ method: 8, compressed: new Uint8Array([0x03]) }]).bytes),
  ).rejects.toThrow();
});

it("rejects a forged output size before delivering the oversize decoder chunk", async () => {
  const f = archiveFixture([{ method: 8, content: new Uint8Array(1_048_576), size: 1 }]),
    source = memoryArchive(f.bytes),
    index = await inspectArchive(source);
  const reader = (await openArchiveEntry(source, index, 0, checkpoint)).getReader();
  await expect(reader.read()).rejects.toThrow("archive_output_size_mismatch");
});

it("rechecks authority between output chunks and cancels the upstream on failure", async () => {
  const content = new Uint8Array(131072),
    f = archiveFixture([{ content }]),
    source = memoryArchive(f.bytes),
    index = await inspectArchive(source),
    cancel = vi.fn();
  source.open = async () =>
    new ReadableStream({
      start(controller) {
        controller.enqueue(content);
      },
      cancel,
    });
  let valid = true;
  const reader = (
    await openArchiveEntry(source, index, 0, async () => {
      if (!valid) throw new Error("revoked");
    })
  ).getReader();
  expect((await reader.read()).value?.length).toBe(65536);
  valid = false;
  await expect(reader.read()).rejects.toThrow("revoked");
  expect(cancel).toHaveBeenCalledOnce();
});

it("propagates consumer cancellation without opening another entry", async () => {
  const f = archiveFixture(),
    source = memoryArchive(f.bytes),
    index = await inspectArchive(source),
    cancel = vi.fn();
  source.open = async () => new ReadableStream({ cancel });
  const body = await openArchiveEntry(source, index, 0, checkpoint);
  await body.cancel("closed");
  expect(cancel).toHaveBeenCalledWith("closed");
});

it("accepts the 10,000-entry boundary and bounds the serialized index independently of the directory", async () => {
  const empty = new Uint8Array();
  const regular = archiveFixture(
    Array.from({ length: 10000 }, (_, n) => ({ name: `${n}.jpg`, content: empty })),
  );
  const index = await inspectArchive(memoryArchive(regular.bytes));
  expect(index.entries).toHaveLength(10000);
  expect(new TextEncoder().encode(JSON.stringify(index)).length).toBeLessThanOrEqual(
    ARCHIVE_LIMITS.indexBytes,
  );
  const long = archiveFixture(
    Array.from({ length: 4500 }, (_, n) => ({
      name: `${"a".repeat(900)}${n}.jpg`,
      content: empty,
    })),
  );
  expect(long.endOffset - long.centralOffset).toBeLessThan(ARCHIVE_LIMITS.centralBytes);
  await expect(inspectArchive(memoryArchive(long.bytes))).rejects.toThrow("archive_index_limit");
});

it("accepts an 8 GiB declared total without reading any entry bodies", async () => {
  const source = memoryArchive(
    archiveFixture(
      Array.from({ length: 128 }, (_, n) => ({
        name: `${n}.png`,
        method: 8,
        size: ARCHIVE_LIMITS.entryBytes,
      })),
    ).bytes,
  );
  expect((await inspectArchive(source)).entries.reduce((n, entry) => n + entry.size, 0)).toBe(
    ARCHIVE_LIMITS.totalBytes,
  );
  expect(source.opens).toEqual([]);
});

it("fetches a large central directory as one bounded second range", async () => {
  const f = archiveFixture(
    Array.from({ length: 6000 }, (_, n) => ({
      name: `${"a".repeat(250)}${n}.jpg`,
      content: new Uint8Array(),
    })),
  );
  const source = memoryArchive(f.bytes),
    index = await inspectArchive(source);
  expect(index.entries).toHaveLength(6000);
  expect(source.reads).toEqual([
    [f.bytes.length - ARCHIVE_LIMITS.tailBytes, ARCHIVE_LIMITS.tailBytes],
    [f.centralOffset, f.endOffset - f.centralOffset],
  ]);
  expect(source.opens).toEqual([]);
});

it("reads safe ZIP64 offsets beyond 4 GiB without truncating them to 32 bits", async () => {
  const f = archiveFixture([{ zip64: true }], true),
    v = new DataView(f.bytes.buffer),
    base = 2 ** 32 + 123;
  const rawLength = v.getUint16(f.centralOffset + 28, true),
    end = f.endOffset - 76;
  v.setBigUint64(f.centralOffset + 46 + rawLength + 4 + 16, BigInt(base), true);
  v.setBigUint64(end + 48, BigInt(base + f.centralOffset), true);
  v.setBigUint64(f.endOffset - 12, BigInt(base + end), true);
  const source = {
    size: base + f.bytes.length,
    async read(offset: number, length: number) {
      const result = new Uint8Array(length),
        from = Math.max(offset, base),
        to = Math.min(offset + length, base + f.bytes.length);
      if (to > from) result.set(f.bytes.subarray(from - base, to - base), from - offset);
      return result;
    },
    async open(offset: number, length: number) {
      return new Response(f.bytes.slice(offset - base, offset - base + length)).body!;
    },
  };
  const index = await inspectArchive(source);
  expect(index.entries[0]!.localOffset).toBe(base);
  expect(index.centralOffset).toBe(base + f.centralOffset);
  expect(
    new Uint8Array(
      await new Response(await openArchiveEntry(source, index, 0, checkpoint)).arrayBuffer(),
    ),
  ).toEqual(archiveText);
});

it.each([false, true])("handles CRC equal to descriptor signature (ZIP64=%s)", async (zip64) => {
  for (const descriptor of ["signed", "unsigned"] as const) {
    const source = memoryArchive(
        archiveFixture([{ descriptor, zip64, crc: 0x08074b50 }], zip64).bytes,
      ),
      index = await inspectArchive(source);
    const stream = await openArchiveEntry(source, index, 0, checkpoint);
    // Both descriptor interpretations are resolved correctly; the actual payload CRC is wrong.
    await expect(new Response(stream).arrayBuffer()).rejects.toThrow("archive_crc_mismatch");
  }
});

it.each(["short", "unsafe"])("rejects %s source lengths", async (kind) => {
  const source = memoryArchive(archiveFixture().bytes);
  if (kind === "short") source.read = async () => new Uint8Array(1);
  else Object.assign(source, { size: Number.MAX_SAFE_INTEGER + 1 });
  await expect(inspectArchive(source)).rejects.toThrow();
});

it.each([0x0017, 0x9901, 0x000f])("rejects hidden encryption/patch extra field %i", async (id) => {
  await expect(
    inspectArchive(memoryArchive(archiveFixture([{ extra: extra(id, new Uint8Array()) }]).bytes)),
  ).rejects.toThrow("unsupported_archive_feature");
});

it("rejects truncated or repeated extra fields", async () => {
  for (const metadata of [
    new Uint8Array([1]),
    concat(extra(42, new Uint8Array()), extra(42, new Uint8Array())),
  ]) {
    await expect(
      inspectArchive(memoryArchive(archiveFixture([{ extra: metadata }]).bytes)),
    ).rejects.toThrow();
  }
});

it("rejects a local header which overlaps another entry through its extra data", async () => {
  const f = archiveFixture([{}, { name: "two.jpg" }]),
    source = memoryArchive(f.bytes),
    index = await inspectArchive(source);
  new DataView(f.bytes.buffer).setUint16(28, 1, true);
  await expect(openArchiveEntry(source, index, 0, checkpoint)).rejects.toThrow(
    "archive_range_invalid",
  );
});
