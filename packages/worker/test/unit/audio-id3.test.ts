import { expect, it } from "vitest";
import {
  AUDIO_ID3_FRAME_LIMIT,
  AUDIO_PREFIX_BYTES,
  AUDIO_TAIL_BYTES,
  parseId3Metadata,
} from "../../src/media/audio/id3";

const text = new TextEncoder();

function synchsafe(value: number): Uint8Array {
  return Uint8Array.from([
    (value >> 21) & 0x7f,
    (value >> 14) & 0x7f,
    (value >> 7) & 0x7f,
    value & 0x7f,
  ]);
}

function frame(id: string, value: string, version: 3 | 4, encoding = 3): Uint8Array {
  const ascii = [...text.encode(value)];
  const utf16le = ascii.flatMap((byte) => [byte, 0]);
  const utf16be = ascii.flatMap((byte) => [0, byte]);
  const body =
    encoding === 1
      ? Uint8Array.from([1, 0xff, 0xfe, ...utf16le])
      : encoding === 2
        ? Uint8Array.from([2, ...utf16be])
        : Uint8Array.from([encoding, ...text.encode(value)]);
  const result = new Uint8Array(10 + body.length);
  result.set(text.encode(id));
  if (version === 4) result.set(synchsafe(body.length), 4);
  else new DataView(result.buffer).setUint32(4, body.length);
  result.set(body, 10);
  return result;
}

function tagged(
  version: 3 | 4,
  frames: readonly Uint8Array[],
  fallback?: { title: string; artist: string; album: string },
): { prefix: Uint8Array; tail: Uint8Array; size: number } {
  const payload = frames.reduce((length, item) => length + item.length, 0);
  const size = 10 + payload + 4 + (fallback ? AUDIO_TAIL_BYTES : 0);
  const bytes = new Uint8Array(size);
  bytes.set(text.encode("ID3"));
  bytes[3] = version;
  bytes.set(synchsafe(payload), 6);
  let offset = 10;
  for (const item of frames) {
    bytes.set(item, offset);
    offset += item.length;
  }
  bytes.set([0xff, 0xfb, 0x90, 0x64], 10 + payload);
  if (fallback) {
    const at = size - AUDIO_TAIL_BYTES;
    bytes.set(text.encode("TAG"), at);
    bytes.set(text.encode(fallback.title), at + 3);
    bytes.set(text.encode(fallback.artist), at + 33);
    bytes.set(text.encode(fallback.album), at + 63);
  }
  return {
    prefix: bytes.subarray(0, Math.min(size, AUDIO_PREFIX_BYTES)),
    tail: bytes.subarray(size - Math.min(size, AUDIO_TAIL_BYTES)),
    size,
  };
}

it.each([3, 4] as const)("extracts bounded ID3v2.%s text frames from bytes", (version) => {
  const bytes = tagged(version, [
    frame("TIT2", "Title", version, version === 3 ? 1 : 3),
    frame("TPE1", "Artist", version, version === 3 ? 0 : 2),
    frame("TALB", "Album", version, version === 3 ? 0 : 3),
  ]);
  expect(parseId3Metadata(bytes.prefix, bytes.tail, bytes.size)).toEqual({
    kind: "metadata",
    metadata: { title: "Title", artist: "Artist", album: "Album" },
  });
});

it("fills missing v2 values from the final 128-byte ID3v1 tag", () => {
  const bytes = tagged(4, [frame("TIT2", "Modern", 4)], {
    title: "Legacy",
    artist: "Fallback Artist",
    album: "Fallback Album",
  });
  expect(parseId3Metadata(bytes.prefix, bytes.tail, bytes.size)).toEqual({
    kind: "metadata",
    metadata: { title: "Modern", artist: "Fallback Artist", album: "Fallback Album" },
  });
});

it("accepts ID3v1 fallback without a filename or MIME hint", () => {
  const bytes = new Uint8Array(AUDIO_TAIL_BYTES);
  bytes.set(text.encode("TAG"));
  bytes.set(text.encode("Title"), 3);
  bytes.set(text.encode("Artist"), 33);
  bytes.set(text.encode("Album"), 63);
  expect(parseId3Metadata(bytes, bytes, bytes.length)).toEqual({
    kind: "metadata",
    metadata: { title: "Title", artist: "Artist", album: "Album" },
  });
});

it("rejects malformed, truncated, oversized and unsupported ID3 declarations", () => {
  const valid = tagged(4, [frame("TIT2", "Title", 4)]);
  for (let length = 0; length < 10; length++) {
    const prefix = valid.prefix.subarray(0, length);
    expect(parseId3Metadata(prefix, prefix, length).kind).toBe(
      length >= 3 ? "malformed" : "unsupported",
    );
  }
  const badSynchsafe = valid.prefix.slice();
  badSynchsafe[6] = 0x80;
  expect(parseId3Metadata(badSynchsafe, valid.tail, valid.size).kind).toBe("malformed");
  const unsupportedFlags = valid.prefix.slice();
  unsupportedFlags[5] = 0x80;
  expect(parseId3Metadata(unsupportedFlags, valid.tail, valid.size).kind).toBe("malformed");
  const oversized = new Uint8Array(AUDIO_PREFIX_BYTES);
  oversized.set(text.encode("ID3"));
  oversized[3] = 4;
  oversized.set(synchsafe(AUDIO_PREFIX_BYTES), 6);
  expect(
    parseId3Metadata(oversized, oversized.subarray(-AUDIO_TAIL_BYTES), AUDIO_PREFIX_BYTES).kind,
  ).toBe("malformed");
});

it("rejects invalid frame sizes, encodings, field limits and excessive frame counts", () => {
  const invalidEncoding = tagged(4, [frame("TIT2", "Title", 4, 4)]);
  expect(
    parseId3Metadata(invalidEncoding.prefix, invalidEncoding.tail, invalidEncoding.size).kind,
  ).toBe("malformed");
  const tooLong = tagged(4, [frame("TIT2", "a".repeat(1025), 4)]);
  expect(parseId3Metadata(tooLong.prefix, tooLong.tail, tooLong.size).kind).toBe("malformed");
  const frames = Array.from({ length: AUDIO_ID3_FRAME_LIMIT + 1 }, () => frame("TXXX", "x", 4));
  const crowded = tagged(4, frames);
  expect(parseId3Metadata(crowded.prefix, crowded.tail, crowded.size).kind).toBe("malformed");
  const overflowing = tagged(4, [frame("TIT2", "Title", 4)]);
  overflowing.prefix.set(synchsafe(127), 14);
  expect(parseId3Metadata(overflowing.prefix, overflowing.tail, overflowing.size).kind).toBe(
    "malformed",
  );
});

it("treats arbitrary bytes as unsupported and enforces exact bounded input windows", () => {
  const bytes = new Uint8Array(4096);
  expect(parseId3Metadata(bytes, bytes.subarray(-AUDIO_TAIL_BYTES), bytes.length).kind).toBe(
    "unsupported",
  );
  expect(
    parseId3Metadata(bytes.subarray(0, 100), bytes.subarray(-AUDIO_TAIL_BYTES), bytes.length).kind,
  ).toBe("malformed");
});
