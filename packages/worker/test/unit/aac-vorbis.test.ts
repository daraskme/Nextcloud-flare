import { readFileSync } from "node:fs";
import { URL } from "node:url";
import { expect, it, vi } from "vitest";
import { mediaContentType, parsedMediaContentType } from "../../../shared/src/media";
import { ImageReader } from "../../src/media/images/reader";
import { aacConfiguration } from "../../src/media/tracks/aac";
import { inspectTracks } from "../../src/media/tracks/inspect";
import { vorbisSetup } from "../../src/media/tracks/vorbis";

const names = ["tone.m4a", "tone-pce.m4a", "tone.ogg", "tone-stereo.ogg"];
const bytes = (name: string) =>
  new Uint8Array(readFileSync(new URL(`../fixtures/tracks/${name}`, import.meta.url)));
const inspect = (b: Uint8Array) =>
  inspectTracks({ size: b.length, read: async (at, n) => b.slice(at, at + n) });
function bits(...fields: [number, number][]) {
  const values = fields.flatMap(([value, width]) =>
    Array.from({ length: width }, (_, i) => (value >>> (width - i - 1)) & 1),
  );
  const out = new Uint8Array(Math.ceil(values.length / 8));
  values.forEach((value, i) => {
    out[i >> 3] = out[i >> 3]! | (value << (7 - (i & 7)));
  });
  return out;
}
it.each(names)("extracts actual %s headers, tags, duration and canonical MIME", async (name) => {
  const result = await inspect(bytes(name));
  const mime = name.endsWith("m4a")
    ? 'audio/mp4; codecs="mp4a.40.2"'
    : 'audio/ogg; codecs="vorbis"';
  expect(result).toMatchObject({
    durationMs: 2000,
    title: "テスト曲",
    artist: "Local fixture",
    album: "Test album",
    trackNumber: 2,
  });
  expect(mediaContentType(result!.media)).toBe(mime);
  expect(parsedMediaContentType(mime)).toEqual(result!.media);
  expect(parsedMediaContentType(`${mime}; other=1`)).toBeNull();
});
it.each([5, 29] as const)("parses explicit AAC object type %s without declaring it LC", (type) => {
  const config = aacConfiguration(
    bits([type, 5], [7, 4], [type === 29 ? 1 : 2, 4], [4, 4], [2, 5], [0, 3]),
  );
  expect(config).toMatchObject({
    media: { objectType: type },
    coreRate: 22050,
    rate: 44100,
    outputChannels: 2,
  });
  expect(mediaContentType(config.media)).toBe(`audio/mp4; codecs="mp4a.40.${type}"`);
});
it("parses sync extension SBR/PS and refuses invalid core/extension/dependency fields", () => {
  const base: [number, number][] = [
    [2, 5],
    [7, 4],
    [1, 4],
    [0, 3],
  ];
  expect(
    aacConfiguration(bits(...base, [0x2b7, 11], [5, 5], [1, 1], [4, 4], [0x548, 11], [1, 1])),
  ).toMatchObject({ media: { objectType: 29 }, rate: 44100, outputChannels: 2 });
  for (const invalid of [
    bits([1, 5], [3, 4], [2, 4], [0, 3]),
    bits([2, 5], [13, 4], [2, 4], [0, 3]),
    bits([2, 5], [3, 4], [8, 4], [0, 3]),
    bits([2, 5], [3, 4], [2, 4], [2, 3]),
    bits(...base, [0x2b7, 11], [5, 5], [0, 1], [0x548, 11], [1, 1]),
  ])
    expect(() => aacConfiguration(invalid)).toThrow();
});
it("rejects encrypted/external MP4 descriptors, reserved object types and config mismatches", async () => {
  for (const name of ["tone.m4a", "tone-pce.m4a"]) {
    const original = bytes(name),
      raw = Buffer.from(original),
      sample = raw.indexOf("mp4a"),
      es = raw.indexOf("esds");
    for (const [at, value] of [
      [sample, 101],
      [es + 15, 64],
      [es + 21, 105],
      [sample + 21, 8],
      [es + 8, 128],
    ]) {
      const b = original.slice();
      b[at!] = value!;
      expect(await inspect(b), `${name}:${at}`).toBeNull();
    }
  }
});
function packets(file: Uint8Array) {
  const result: Uint8Array[] = [],
    parts: Uint8Array[] = [];
  for (let at = 0; at < file.length; ) {
    const lacing = file.subarray(at + 27, at + 27 + file[at + 26]!);
    at += 27 + lacing.length;
    for (const size of lacing) {
      parts.push(file.subarray(at, at + size));
      at += size;
      if (size < 255) {
        result.push(new Uint8Array(Buffer.concat(parts)));
        parts.length = 0;
      }
    }
  }
  return result;
}
function oggPage(
  sequence: number,
  flags: number,
  lacing: number[],
  payload: Uint8Array,
  granule = 0n,
) {
  const page = new Uint8Array(27 + lacing.length + payload.length),
    d = new DataView(page.buffer);
  page.set(new TextEncoder().encode("OggS"));
  page[5] = flags;
  d.setBigUint64(6, granule, true);
  d.setUint32(14, 123, true);
  d.setUint32(18, sequence, true);
  page[26] = lacing.length;
  page.set(lacing, 27);
  page.set(payload, 27 + lacing.length);
  let crc = 0;
  for (const value of page) {
    crc ^= value << 24;
    for (let bit = 0; bit < 8; bit++) crc = (crc << 1) ^ (crc & 0x80000000 ? 0x04c11db7 : 0);
  }
  d.setUint32(22, crc >>> 0, true);
  return page;
}
it("accepts a Vorbis setup continued across pages and rejects missing continuation or headers", async () => {
  const [id, comment, setup, audio] = packets(bytes("tone.ogg")) as [
      Uint8Array,
      Uint8Array,
      Uint8Array,
      Uint8Array,
    ],
    lace = (size: number) => [...new Array(Math.floor(size / 255)).fill(255), size % 255],
    prefix = [oggPage(0, 2, lace(id.length), id), oggPage(1, 0, lace(comment.length), comment)],
    make = (flags: number) =>
      new Uint8Array(
        Buffer.concat([
          ...prefix,
          oggPage(2, 0, [255], setup.subarray(0, 255), 0xffffffffffffffffn),
          oggPage(3, flags, lace(setup.length - 255), setup.subarray(255)),
          oggPage(4, 4, lace(audio.length), audio, 96000n),
        ]),
      );
  expect(await inspect(make(1))).toMatchObject({
    media: { codec: "vorbis" },
    title: "テスト曲",
    durationMs: 2000,
  });
  expect(await inspect(make(0))).toBeNull();
  expect(
    await inspect(
      new Uint8Array(Buffer.concat([...prefix, oggPage(2, 4, lace(audio.length), audio, 96000n)])),
    ),
  ).toBeNull();
  expect(await inspect(new Uint8Array(Buffer.concat([make(1), bytes("tone.ogg")])))).toBeNull();
});
it.each(["tone.ogg", "tone-stereo.ogg"])(
  "checks %s setup beyond its Ogg checksum without allocating decode tables",
  (name) => {
    const setup = packets(bytes(name))[2]!;
    const reader = () => new ImageReader({ size: 0, read: async () => new Uint8Array() });
    expect(vorbisSetup(setup, name.includes("stereo") ? 2 : 1, reader())).toBeGreaterThan(0);
    for (const mutate of [
      (b: Uint8Array) => {
        b[0] = 1;
      },
      (b: Uint8Array) => {
        b[8] = 0;
      },
      (b: Uint8Array) => {
        b[11] = 0;
        b[12] = 0;
      },
      (b: Uint8Array) => {
        b[13] = 255;
        b[14] = 255;
        b[15] = 255;
      },
      (b: Uint8Array) => {
        b[b.length - 1] = 0;
      },
    ]) {
      const invalid = setup.slice();
      mutate(invalid);
      expect(() => vorbisSetup(invalid, name.includes("stereo") ? 2 : 1, reader())).toThrow();
    }
    expect(() => vorbisSetup(setup.slice(0, -1), 1, reader())).toThrow();
  },
);
it.each(names)("rejects truncated %s and bounds mutations and I/O failures", async (name) => {
  const original = bytes(name);
  expect(await inspect(original.slice(0, 40))).toBeNull();
  for (let i = 0; i < 30; i++) {
    const b = original.slice();
    b[(i * 71) % Math.min(4096, b.length)] = (i * 31) & 255;
    let reads = 0,
      total = 0;
    await inspectTracks({
      size: b.length,
      read: async (at, n) => {
        expect(at >= 0 && at + n <= b.length).toBe(true);
        expect(++reads).toBeLessThanOrEqual(128);
        expect((total += n)).toBeLessThanOrEqual(4194304);
        return b.slice(at, at + n);
      },
    });
  }
  await expect(
    inspectTracks({
      size: original.length,
      read: async () => {
        throw new Error("R2 down");
      },
    }),
  ).rejects.toThrow("image_source_unavailable");
});
it("keeps a large Ogg's duration unknown without reading distant audio pages", async () => {
  const b = bytes("tone.ogg"),
    read = vi.fn(async (at: number, n: number) => {
      const out = new Uint8Array(n);
      out.set(b.subarray(at, Math.min(at + n, b.length)));
      return out;
    });
  expect(await inspectTracks({ size: 10 ** 9, read })).toMatchObject({
    media: { codec: "vorbis" },
    durationMs: null,
    title: "テスト曲",
  });
  expect(read.mock.calls.reduce((n, [, size]) => n + size, 0)).toBeLessThanOrEqual(65536);
});
