import { expect, it } from "vitest";
import { inspectAudioObject } from "../../src/media/audio";
import { AUDIO_PREFIX_BYTES, AUDIO_TAIL_BYTES } from "../../src/media/audio/id3";

const text = new TextEncoder();

function synchsafe(value: number): Uint8Array {
  return Uint8Array.from([
    (value >> 21) & 0x7f,
    (value >> 14) & 0x7f,
    (value >> 7) & 0x7f,
    value & 0x7f,
  ]);
}

function audio(size: number): Uint8Array {
  const bytes = new Uint8Array(size);
  const value = text.encode("Bounded title");
  const body = Uint8Array.from([3, ...value]);
  bytes.set(text.encode("ID3"));
  bytes[3] = 4;
  bytes.set(synchsafe(10 + body.length), 6);
  bytes.set(text.encode("TIT2"), 10);
  bytes.set(synchsafe(body.length), 14);
  bytes.set(body, 20);
  return bytes;
}

function bucket(
  bytes: Uint8Array,
  calls: Array<{ offset: number; length: number }>,
  etag = "etag",
): R2Bucket {
  return {
    async get(_key: string, options: R2GetOptions) {
      const range = options.range;
      if (!range || !("offset" in range) || !("length" in range)) throw new Error("expected_range");
      calls.push({ offset: range.offset, length: range.length });
      const body = bytes.slice(range.offset, range.offset + range.length);
      return {
        size: bytes.length,
        etag,
        arrayBuffer: async () => body.buffer,
      } as unknown as R2ObjectBody;
    },
  } as unknown as R2Bucket;
}

it("reads only the first 2 MiB and final 128 bytes for a larger object", async () => {
  const bytes = audio(AUDIO_PREFIX_BYTES + 4096);
  const calls: Array<{ offset: number; length: number }> = [];
  expect(
    await inspectAudioObject(
      bucket(bytes, calls),
      {
        key: "audio",
        size: bytes.length,
        r2Etag: "etag",
      },
      Date.now() + 5000,
    ),
  ).toEqual({
    kind: "metadata",
    metadata: { title: "Bounded title", artist: null, album: null },
  });
  expect(calls).toEqual([
    { offset: 0, length: AUDIO_PREFIX_BYTES },
    { offset: bytes.length - AUDIO_TAIL_BYTES, length: AUDIO_TAIL_BYTES },
  ]);
});

it("uses one bounded range for a small object and treats missing identity as transient", async () => {
  const bytes = audio(512);
  const calls: Array<{ offset: number; length: number }> = [];
  expect(
    await inspectAudioObject(
      bucket(bytes, calls),
      {
        key: "audio",
        size: bytes.length,
        r2Etag: "etag",
      },
      Date.now() + 5000,
    ),
  ).toMatchObject({ kind: "metadata" });
  expect(calls).toEqual([{ offset: 0, length: bytes.length }]);

  expect(
    await inspectAudioObject(
      bucket(bytes, [], "other"),
      {
        key: "audio",
        size: bytes.length,
        r2Etag: "etag",
      },
      Date.now() + 5000,
    ),
  ).toEqual({ kind: "transient" });
  expect(
    await inspectAudioObject(
      { get: async () => null } as unknown as R2Bucket,
      { key: "audio", size: bytes.length, r2Etag: "etag" },
      Date.now() + 5000,
    ),
  ).toEqual({ kind: "transient" });
  expect(
    await inspectAudioObject(
      bucket(bytes, []),
      {
        key: "audio",
        size: bytes.length,
        r2Etag: "etag",
      },
      Date.now() - 1,
    ),
  ).toEqual({ kind: "transient" });
});

it("rejects malformed prefix declarations without reading the tail", async () => {
  const bytes = audio(AUDIO_PREFIX_BYTES + 4096);
  bytes[6] = 0x80;
  const calls: Array<{ offset: number; length: number }> = [];
  expect(
    await inspectAudioObject(
      bucket(bytes, calls),
      { key: "audio", size: bytes.length, r2Etag: "etag" },
      Date.now() + 5000,
    ),
  ).toEqual({ kind: "malformed" });
  expect(calls).toEqual([{ offset: 0, length: AUDIO_PREFIX_BYTES }]);
});
