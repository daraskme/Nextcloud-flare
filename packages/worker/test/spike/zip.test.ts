import { expect, it } from "vitest";
import { type StoreEntry, storeZip, storeZipSize } from "../../src/platform/storeZip";
import { bytesSource, drain } from "../fixtures/streams";

function entry(name: string, content: string): StoreEntry {
  const bytes = new TextEncoder().encode(content);
  return { name, size: bytes.length, open: async () => new Blob([bytes]).stream() };
}

it("dry-run equals emitted STORE bytes, including Unicode names and descriptors", async () => {
  const entries = [entry("empty", ""), entry("資料/日本語.txt", "123456789")];
  const zip = storeZip(entries);
  const bytes = new Uint8Array(await new Response(zip.body).arrayBuffer());
  expect(bytes.length).toBe(storeZipSize(entries));
  expect(bytes.length).toBe(zip.size);
  const view = new DataView(bytes.buffer);
  let offset = 0;
  for (const item of entries) {
    expect(view.getUint32(offset, true)).toBe(0x04034b50);
    expect(view.getUint16(offset + 8, true)).toBe(0); // STORE
    expect(view.getUint16(offset + 6, true) & 8).toBe(8); // descriptor
    const nameLength = view.getUint16(offset + 26, true);
    const extraLength = view.getUint16(offset + 28, true);
    expect(new TextDecoder().decode(bytes.subarray(offset + 30, offset + 30 + nameLength))).toBe(
      item.name,
    );
    offset += 30 + nameLength + extraLength + item.size;
    expect(view.getUint32(offset, true)).toBe(0x08074b50);
    expect(view.getUint32(offset + 4, true)).toBe(item.size === 0 ? 0 : 0xcbf43926); // independent CRC vector
    expect(view.getUint32(offset + 8, true)).toBe(item.size);
    expect(view.getUint32(offset + 12, true)).toBe(item.size);
    offset += 16;
  }
  expect(view.getUint32(offset, true)).toBe(0x02014b50); // central directory
  const eocd = bytes.length - 22;
  expect(view.getUint32(eocd, true)).toBe(0x06054b50);
  expect(view.getUint16(eocd + 10, true)).toBe(2);
  expect(view.getUint32(eocd + 16, true)).toBe(offset);
});

it("supports empty archives and 1,000 entries without opening sources during sizing", async () => {
  expect(await drain(storeZip([]).body)).toBe(22);
  let opened = 0;
  const entries = Array.from({ length: 1_000 }, (_, index) => ({
    name: `file-${index}`,
    size: 1,
    open: async () => {
      opened++;
      return bytesSource(1).body;
    },
  }));
  const size = storeZipSize(entries);
  expect(opened).toBe(0);
  expect(await drain(storeZip(entries).body)).toBe(size);
  expect(opened).toBe(1_000);
});

it("does not open the next entry on cancellation and stops the current source", async () => {
  let cancelled = false;
  let nextOpened = false;
  const source = bytesSource(10_000_000, 97, () => {
    cancelled = true;
  });
  const result = storeZip([
    { name: "one", size: 10_000_000, open: async () => source.body },
    {
      name: "two",
      size: 1,
      open: async () => {
        nextOpened = true;
        return bytesSource(1).body;
      },
    },
  ]);
  const reader = result.body.getReader();
  await reader.read();
  expect(source.produced()).toBeLessThanOrEqual(65_536);
  await reader.cancel();
  expect(cancelled).toBe(true);
  expect(nextOpened).toBe(false);
});

it.each([0, 2])(
  "aborts the archive when entry bytes differ from declared length (%i)",
  async (actual) => {
    const result = storeZip([
      { name: "wrong", size: 1, open: async () => bytesSource(actual).body },
    ]);
    await expect(drain(result.body)).rejects.toThrow(/zip_entry_size_mismatch/);
  },
);

it("accepts the exact non-ZIP64 limit, and rejects one extra byte", () => {
  const empty = entry("x", "");
  const overhead = storeZipSize([empty]);
  expect(storeZipSize([{ ...empty, size: 4_294_967_295 - overhead }])).toBe(4_294_967_295);
  expect(() => storeZipSize([{ ...empty, size: 4_294_967_296 - overhead }])).toThrow();
});

it.each(["../x", "x/../y", "/x", "x\\y", "C:/file", "x//y", "x\u0000y"])(
  "rejects unsafe name %s",
  (name) => {
    expect(() => storeZipSize([entry(name, "")])).toThrow(/invalid_zip_name/);
  },
);
