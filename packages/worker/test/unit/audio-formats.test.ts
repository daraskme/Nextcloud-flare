import { readFileSync } from "node:fs";
import { URL } from "node:url";
import { expect, it, vi } from "vitest";
import { mediaContentType, parsedMediaContentType } from "../../../shared/src/media";
import { inspectTracks } from "../../src/media/tracks/inspect";

const bytes = (name: string) =>
  new Uint8Array(readFileSync(new URL(`../fixtures/tracks/tone.${name}`, import.meta.url)));
const inspect = (b: Uint8Array) =>
  inspectTracks({ size: b.length, read: async (at, n) => b.slice(at, at + n) });
const encoded = new TextEncoder();
const join = (...parts: Uint8Array[]) => {
  const out = new Uint8Array(parts.reduce((n, b) => n + b.length, 0));
  let at = 0;
  for (const b of parts) {
    out.set(b, at);
    at += b.length;
  }
  return out;
};
const safe = (n: number) => new Uint8Array([n >>> 21, (n >>> 14) & 127, (n >>> 7) & 127, n & 127]);
const uint = (n: number) => new Uint8Array([n >>> 24, (n >>> 16) & 255, (n >>> 8) & 255, n & 255]);
function mpeg() {
  const b = bytes("mp3");
  return b.slice(10 + b.subarray(6, 10).reduce((n, x) => n * 128 + x, 0));
}
function id3(version: number, data: Uint8Array, flags = 0, frameFlags = 0) {
  const field = join(
    encoded.encode(version === 2 ? "TT2" : "TIT2"),
    version === 2
      ? uint(data.length).slice(1)
      : version === 4
        ? safe(data.length)
        : uint(data.length),
    version === 2 ? new Uint8Array() : new Uint8Array([0, frameFlags]),
    data,
  );
  return join(
    encoded.encode("ID3"),
    new Uint8Array([version, 0, flags]),
    safe(field.length),
    field,
    mpeg(),
  );
}
it.each(["mp3", "flac", "wav"])(
  "extracts and normalizes real %s audio and bounded tags",
  async (name) => {
    const result = await inspect(bytes(name));
    expect(result).toMatchObject({
      media: { kind: "audio", codec: name === "wav" ? "pcm" : name },
      title: "テスト曲",
      artist: "Local fixture",
      album: "Test album",
      trackNumber: 2,
      width: null,
      height: null,
    });
    expect(result!.durationMs).toBeGreaterThanOrEqual(2000);
    expect(result!.durationMs).toBeLessThan(2100);
    const mime = mediaContentType(result!.media);
    expect(mime).toBe(`audio/${name === "mp3" ? "mpeg" : name}`);
    expect(parsedMediaContentType(mime)).toEqual(result!.media);
    expect(parsedMediaContentType(`${mime}; codecs="arbitrary"`)).toBeNull();
  },
);
it.each([2, 3, 4])(
  "reads ID3v2.%s Latin-1 and applies the UTF-8 field limit after decoding",
  async (version) => {
    expect(await inspect(id3(version, new Uint8Array([0, 67, 97, 102, 233, 0])))).toMatchObject({
      title: "Café",
    });
    const large = new Uint8Array(602).fill(233);
    large[0] = 0;
    large[601] = 0;
    expect((await inspect(id3(version, large)))?.title).toBeUndefined();
  },
);
it.each(["mpeg2", "mpeg25"])(
  "identifies real MPEG layer III %s and computes bounded frame duration",
  async (version) => {
    const b = new Uint8Array(
      readFileSync(new URL(`../fixtures/tracks/tone-${version}.mp3`, import.meta.url)),
    );
    const result = await inspect(b);
    expect(result?.media).toEqual({ kind: "audio", codec: "mp3", container: "mp3" });
    expect(result?.durationMs).toBeGreaterThanOrEqual(2000);
    expect(result?.durationMs).toBeLessThan(2200);
    if (version === "mpeg2") expect(result?.title).toBe("テスト曲");
  },
);
it("handles ID3 extended headers and matching v2.4 footers without interpreting their contents as frames", async () => {
  for (const version of [3, 4]) {
    const base = id3(version, new Uint8Array([0, 65]));
    const frame = base.slice(10, 22);
    const ext =
      version === 3
        ? new Uint8Array([0, 0, 0, 6, 0, 0, 0, 0, 0, 0])
        : new Uint8Array([0, 0, 0, 6, 1, 0]);
    const header = join(
      encoded.encode("ID3"),
      new Uint8Array([version, 0, 64]),
      safe(ext.length + frame.length),
    );
    expect(await inspect(join(header, ext, frame, mpeg()))).toMatchObject({ title: "A" });
  }
  const header = join(encoded.encode("ID3"), new Uint8Array([4, 0, 16]), safe(12));
  const footer = header.slice();
  footer.set(encoded.encode("3DI"));
  const frame = id3(4, new Uint8Array([0, 65])).slice(10, 22);
  expect(await inspect(join(header, frame, footer, mpeg()))).toMatchObject({ title: "A" });
  footer[9] = 13;
  expect(await inspect(join(header, frame, footer, mpeg()))).toBeNull();
});
it("reverses ID3v2.3 whole-tag unsynchronization before using frame sizes", async () => {
  const frame = join(encoded.encode("TIT2"), uint(4), new Uint8Array([0, 0, 0, 65, 255, 0, 224]));
  const header = join(encoded.encode("ID3"), new Uint8Array([3, 0, 128]), safe(frame.length));
  expect(await inspect(join(header, frame, mpeg()))).toMatchObject({ title: "Aÿà" });
});
it("reads UTF-16 BOM/UTF-8, reverses unsynchronization and omits encrypted display frames", async () => {
  expect(await inspect(id3(3, new Uint8Array([1, 255, 254, 0x66, 0x66, 0, 0])))).toMatchObject({
    title: "晦",
  });
  expect(await inspect(id3(4, join(new Uint8Array([3]), encoded.encode("曲"))))).toMatchObject({
    title: "曲",
  });
  expect(await inspect(id3(4, new Uint8Array([0, 65, 255, 0, 224]), 0, 2))).toMatchObject({
    title: "Aÿà",
  });
  expect((await inspect(id3(4, new Uint8Array([0, 65]), 0, 4)))?.title).toBeUndefined();
  const malformed = id3(4, new Uint8Array([3, 255]));
  expect((await inspect(malformed))?.title).toBeUndefined();
});
it("reads ID3v1 through an exact 128-byte tail and keeps v2 tags authoritative", async () => {
  const tail = new Uint8Array(128);
  tail.set(encoded.encode("TAGFallback"));
  tail[126] = 7;
  expect(await inspect(join(mpeg(), tail))).toMatchObject({ title: "Fallback", trackNumber: 7 });
  expect(await inspect(join(bytes("mp3"), tail))).toMatchObject({
    title: "テスト曲",
    trackNumber: 2,
  });
  const original = mpeg(),
    size = 10 ** 9;
  const read = vi.fn(async (at: number, n: number) => {
    const out = new Uint8Array(n);
    if (at < original.length) out.set(original.subarray(at, Math.min(at + n, original.length)));
    if (at === size - 128) out.set(tail);
    return out;
  });
  expect(await inspectTracks({ size, read })).toMatchObject({
    title: "Fallback",
    durationMs: null,
  });
  expect(read.mock.calls.filter(([at]) => at > 2097152)).toEqual([[size - 128, 128]]);
  expect(read.mock.calls.reduce((n, [, size]) => n + size, 0)).toBeLessThanOrEqual(2097280);
});
it("rejects truncated/tag-only/false-sync MP3 and invalid frame lengths", async () => {
  const b = bytes("mp3");
  for (const invalid of [
    b.slice(0, 32),
    id3(4, new Uint8Array([0, 65])).slice(0, 22),
    new Uint8Array(100).fill(255),
  ])
    expect(await inspect(invalid)).toBeNull();
  const raw = mpeg();
  raw[2] = 0;
  expect(await inspect(raw)).toBeNull();
  const oversized = b.slice();
  oversized.set(safe(3 * 1024 * 1024), 6);
  expect(await inspect(oversized)).toBeNull();
  const badSize = b.slice();
  badSize[6] = 128;
  expect(await inspect(badSize)).toBeNull();
});
it("checks FLAC STREAMINFO, metadata extents and first-frame CRC", async () => {
  const b = bytes("flac");
  for (const mutate of [
    (x: Uint8Array) => {
      x[4] = 1;
    },
    (x: Uint8Array) => {
      x[7] = 33;
    },
    (x: Uint8Array) => {
      x[8] = 0;
      x[9] = 0;
    },
    (x: Uint8Array) => {
      x[18] = 0;
      x[19] = 0;
      x[20] = x[20]! & 15;
    },
    (x: Uint8Array) => {
      let at = 4;
      for (;;) {
        const last = x[at]! & 128;
        const n = x[at + 1]! * 65536 + x[at + 2]! * 256 + x[at + 3]!;
        at += 4 + n;
        if (last) break;
      }
      x[at + 5] = x[at + 5]! ^ 1;
    },
  ]) {
    const invalid = b.slice();
    mutate(invalid);
    expect(await inspect(invalid)).toBeNull();
  }
  expect(await inspect(b.slice(0, 42))).toBeNull();
});
it("validates WAV codec, byte rate, alignment, chunk extent and exact RIFF size", async () => {
  const b = bytes("wav"),
    fmt = Buffer.from(b).indexOf("fmt ") + 8;
  for (const offset of [4, fmt, fmt + 8, fmt + 12]) {
    const invalid = b.slice();
    invalid[offset] = invalid[offset]! ^ 8;
    expect(await inspect(invalid)).toBeNull();
  }
  expect(await inspect(b.slice(0, 32))).toBeNull();
  expect(await inspect(b.slice(0, -1))).toBeNull();
});
it("skips a sparse 1GB PCM payload and calculates duration without fetching it", async () => {
  const b = bytes("wav"),
    at = Buffer.from(b).indexOf("data"),
    size = 1000000000,
    d = new DataView(b.buffer);
  d.setUint32(at + 4, size, true);
  d.setUint32(4, at + size, true);
  const read = vi.fn(async (offset: number, n: number) => {
    const out = new Uint8Array(n);
    if (offset < at + 8) out.set(b.subarray(offset, Math.min(offset + n, at + 8)));
    return out;
  });
  expect(await inspectTracks({ size: at + 8 + size, read })).toMatchObject({
    durationMs: Math.round((size / 96000) * 1000),
  });
  expect(read.mock.calls).toEqual([
    [0, 32768],
    [32768, 32768],
  ]);
});
it("accepts PCM extensible and IEEE float WAVE and rejects an unrelated subtype GUID", async () => {
  const original = bytes("wav"),
    at = Buffer.from(original).indexOf("fmt "),
    oldSize = new DataView(original.buffer).getUint32(at + 4, true);
  const fmt = new Uint8Array(40),
    d = new DataView(fmt.buffer);
  fmt.set(original.subarray(at + 8, at + 24));
  d.setUint16(0, 65534, true);
  d.setUint16(16, 22, true);
  d.setUint16(18, 16, true);
  d.setUint32(20, 4, true);
  d.setUint32(24, 1, true);
  fmt.set([0, 0, 16, 0, 128, 0, 0, 170, 0, 56, 155, 113], 28);
  const size = new Uint8Array(4);
  new DataView(size.buffer).setUint32(0, 40, true);
  const ext = join(original.subarray(0, at + 4), size, fmt, original.subarray(at + 8 + oldSize));
  new DataView(ext.buffer).setUint32(4, ext.length - 8, true);
  expect(await inspect(ext)).toMatchObject({ durationMs: 2000, media: { codec: "pcm" } });
  ext[at + 8 + 28] = 1;
  expect(await inspect(ext)).toBeNull();
  // Four seconds of silent IEEE float samples; no conversion or guessed data length.
  const f = join(
    encoded.encode("RIFF"),
    new Uint8Array(4),
    encoded.encode("WAVEfmt "),
    new Uint8Array([16, 0, 0, 0]),
    new Uint8Array(16),
    encoded.encode("data"),
    new Uint8Array(4),
    new Uint8Array(128000),
  );
  const v = new DataView(f.buffer);
  v.setUint32(4, f.length - 8, true);
  v.setUint16(20, 3, true);
  v.setUint16(22, 1, true);
  v.setUint32(24, 8000, true);
  v.setUint32(28, 32000, true);
  v.setUint16(32, 4, true);
  v.setUint16(34, 32, true);
  v.setUint32(40, 128000, true);
  expect(await inspect(f)).toMatchObject({ durationMs: 4000, media: { codec: "pcm" } });
});
it.each(["mp3", "flac", "wav"])(
  "bounds mutated %s input and propagates source failures",
  async (name) => {
    const original = bytes(name);
    for (let i = 0; i < 50; i++) {
      const b = original.slice();
      b[(i * 31) % Math.min(b.length, 4096)] = (i * 43) & 255;
      let reads = 0,
        total = 0;
      await inspectTracks({
        size: b.length,
        read: async (at, n) => {
          expect(at >= 0 && at + n <= b.length).toBe(true);
          expect(n).toBeLessThanOrEqual(32768);
          expect(++reads).toBeLessThanOrEqual(65);
          expect((total += n)).toBeLessThanOrEqual(2097280);
          return b.slice(at, at + n);
        },
      });
    }
    await expect(
      inspectTracks({
        size: original.length,
        read: async () => {
          throw new Error("R2 unavailable");
        },
      }),
    ).rejects.toThrow("image_source_unavailable");
  },
);
