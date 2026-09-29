import { readFileSync } from "node:fs";
import { URL } from "node:url";
import { expect, it, vi } from "vitest";
import { mediaContentType, parsedMediaContentType } from "../../../shared/src/media";
import { inspectTracks } from "../../src/media/tracks/inspect";

const names = [
  "av1.mp4",
  "av1.webm",
  "av1-opus.mp4",
  "av1-opus.webm",
  "av1-10bit.mp4",
  "av1-10bit.webm",
  "opus.ogg",
  "opus.webm",
  "opus.mp4",
];
const bytes = (name: string) =>
  new Uint8Array(readFileSync(new URL(`../fixtures/tracks/${name}`, import.meta.url)));
const inspect = (b: Uint8Array) =>
  inspectTracks({ size: b.length, read: async (at, n) => b.slice(at, at + n) });
it("reads a 90-second low-bitrate Opus stream without spending metadata structures on audio packets", async () => {
  const b = bytes("long.opus");
  expect(b.length).toBeLessThan(2097152);
  expect(await inspect(b)).toMatchObject({
    media: { kind: "audio", codec: "opus" },
    durationMs: 90000,
  });
});
it.each(names)("extracts actual encoded tracks from %s", async (name) => {
  const result = await inspect(bytes(name));
  expect(result).not.toBeNull();
  expect(result!.durationMs).toBeGreaterThanOrEqual(2000);
  expect(result!.durationMs).toBeLessThan(2050);
  expect(result!.media.kind).toBe(name.startsWith("av1") ? "video" : "audio");
  if (result!.media.kind === "video") {
    expect(result).toMatchObject({
      width: 160,
      height: 90,
      media: {
        configuration: { profile: 0, bitDepth: name.includes("10bit") ? 10 : 8 },
        audio: name.includes("opus") ? "opus" : null,
      },
    });
  } else {
    expect(result).toMatchObject({
      title: "テスト曲",
      artist: "Local fixture",
      album: "Test album",
      trackNumber: 2,
    });
  }
  expect(mediaContentType(result!.media)).toMatch(/codecs="(?:av01\.|[Oo]pus)/);
  expect(parsedMediaContentType(mediaContentType(result!.media))).toEqual(result!.media);
});
it.each(names)("rejects truncated %s and never guesses from the filename", async (name) => {
  const b = bytes(name);
  expect(await inspect(b.slice(0, 32))).toBeNull();
});
it("rejects an unknown sample codec and a tampered Ogg page", async () => {
  const mp4 = bytes("av1-opus.mp4"),
    at = Buffer.from(mp4).indexOf("av01", 64);
  expect(at).toBeGreaterThan(64);
  mp4.set(new TextEncoder().encode("encv"), at);
  expect(await inspect(mp4)).toBeNull();
  const ogg = bytes("opus.ogg");
  ogg[30] = ogg[30]! ^ 1;
  expect(await inspect(ogg)).toBeNull();
});
it("treats transient source failures as retryable, and never buffers an unbounded object", async () => {
  await expect(
    inspectTracks({
      size: 100,
      read: async () => {
        throw new Error("R2 down");
      },
    }),
  ).rejects.toThrow("image_source_unavailable");
  const read = vi.fn(async (_at: number, length: number) => new Uint8Array(length));
  expect(await inspectTracks({ size: 10 ** 12, read })).toBeNull();
  expect(read.mock.calls.length).toBe(2);
  expect(read.mock.calls.every(([, length]) => length <= 32768)).toBe(true);
});

it.each([
  'video/mp4; codecs="av01.0.00M.08,opus"',
  'audio/webm; codecs="Opus"',
  'video/webm; codecs="av01.0.00M.12"',
  'video/webm; codecs="av01.0.00H.08"',
  'video/mp4; codecs="av01.0.00M.08"; x="y"',
  'video/mp4; codecs="av01.0.00M.08"\r\nX: value',
])("rejects noncanonical or unsafe media parameters: %s", (type) => {
  expect(parsedMediaContentType(type)).toBeNull();
});
it.each(names)("bounds reads and parsing of mutated %s headers", async (name) => {
  const original = bytes(name);
  for (let i = 0; i < 40; i++) {
    const b = original.slice();
    b[(i * 79) % Math.min(b.length, 2000)] = (i * 43) & 255;
    let reads = 0,
      total = 0;
    await inspectTracks({
      size: b.length,
      read: async (at, length) => {
        expect(Number.isSafeInteger(at) && at >= 0 && at + length <= b.length).toBe(true);
        expect(length).toBeLessThanOrEqual(32768);
        expect(++reads).toBeLessThanOrEqual(128);
        expect((total += length)).toBeLessThanOrEqual(4194304);
        return b.slice(at, at + length);
      },
    });
  }
});
it("jumps over a sparse 1GB mdat to trailing moov without reading the media payload", async () => {
  const b = bytes("av1.mp4"),
    d = new DataView(b.buffer);
  let at = 0;
  while (String.fromCharCode(...b.subarray(at + 4, at + 8)) !== "mdat") at += d.getUint32(at);
  const oldEnd = at + d.getUint32(at),
    gap = 1000000000 - d.getUint32(at);
  d.setUint32(at, 1000000000);
  const read = vi.fn(async (offset: number, length: number) => {
    const out = new Uint8Array(length);
    for (const segment of [
      { start: 0, data: b.subarray(0, oldEnd) },
      { start: oldEnd + gap, data: b.subarray(oldEnd) },
    ]) {
      const first = Math.max(offset, segment.start),
        last = Math.min(offset + length, segment.start + segment.data.length);
      if (first < last)
        out.set(segment.data.subarray(first - segment.start, last - segment.start), first - offset);
    }
    return out;
  });
  expect(await inspectTracks({ size: b.length + gap, read })).toMatchObject({
    width: 160,
    height: 90,
    durationMs: 2000,
  });
  expect(read.mock.calls.length).toBeLessThanOrEqual(4);
});
