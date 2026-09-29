import { readFileSync } from "node:fs";
import { URL } from "node:url";
import { expect, it } from "vitest";
import { inspectImage } from "../../src/media/images/inspect";
import type { TrackTags } from "../../src/media/tracks/common";
import {
  AUDIO_COVER_BYTES,
  commentCover,
  flacCover,
  id3Cover,
  offerCover,
} from "../../src/media/tracks/cover";
import { inspectTracks } from "../../src/media/tracks/inspect";

const png = new Uint8Array(
  readFileSync(new URL("../fixtures/images/pattern.png", import.meta.url)),
);
const source = (bytes: Uint8Array) => ({
  size: bytes.length,
  read: async (at: number, n: number) => bytes.slice(at, at + n),
});
const enc = new TextEncoder(),
  u = (n: number) => new Uint8Array([n >>> 24, (n >>> 16) & 255, (n >>> 8) & 255, n & 255]);
const join = (...parts: Uint8Array[]) => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
};
const picture = (
  bytes: Uint8Array = png,
  type = 3,
  mime = "image/png",
  description: Uint8Array = new Uint8Array(),
) =>
  join(
    u(type),
    u(mime.length),
    enc.encode(mime),
    u(description.length),
    description,
    u(99999),
    u(99999),
    u(32),
    u(0),
    u(bytes.length),
    bytes,
  );

it.each(["mp3", "flac", "m4a", "opus", "ogg"])(
  "extracts the exact embedded picture from an independently muxed %s without changing audio identity",
  async (extension) => {
    const bytes = new Uint8Array(
      readFileSync(new URL(`../fixtures/tracks/cover.${extension}`, import.meta.url)),
    );
    const reads: { at: number; n: number }[] = [];
    const result = await inspectTracks({
      size: bytes.length,
      read: async (at, n) => {
        reads.push({ at, n });
        return bytes.slice(at, at + n);
      },
    });
    expect(result?.media.kind).toBe("audio");
    expect(result?.width).toBeNull();
    expect(result?.height).toBeNull();
    expect(result?.cover?.bytes).toEqual(png);
    expect(result!.durationMs).toBeGreaterThan(1900);
    expect(await inspectImage(source(result!.cover!.bytes))).toMatchObject({ mime: "image/png" });
    expect(reads.reduce((n, r) => n + r.n, 0)).toBeLessThanOrEqual(
      extension === "m4a" ? 4194304 : 2097280,
    );
  },
);
it("prefers the first front cover, copies its bytes and ignores other picture purposes", () => {
  const tags: TrackTags = {};
  offerCover(tags, new Uint8Array([1]), 4);
  expect(tags.cover).toBeUndefined();
  const bytes = new Uint8Array([2]);
  offerCover(tags, bytes, 0);
  bytes[0] = 9;
  expect(tags.cover!.bytes[0]).toBe(2);
  offerCover(tags, new Uint8Array([3]), 3);
  offerCover(tags, new Uint8Array([4]), 3);
  offerCover(tags, new Uint8Array([5]), 0);
  expect(tags.cover!.bytes[0]).toBe(3);
});
it.each([2, 3, 4])(
  "reads ID3v2.%s picture descriptions without retaining text or following URLs",
  (version) => {
    for (const encoding of version === 4 ? [0, 1, 2, 3] : [0, 1]) {
      const tags: TrackTags = {};
      const mime = enc.encode(version === 2 ? "PNG" : "image/png\0");
      const text =
        encoding === 1 || encoding === 2
          ? new Uint8Array([255, 254, 65, 0, 0, 0])
          : enc.encode("caption\0");
      id3Cover(
        join(new Uint8Array([encoding]), mime, new Uint8Array([3]), text, png),
        tags,
        version,
      );
      expect(tags.cover?.bytes).toEqual(png);
    }
    const tags: TrackTags = { title: "Preserved" };
    id3Cover(
      join(
        new Uint8Array([0]),
        enc.encode(version === 2 ? "-->" : "-->\0"),
        new Uint8Array([3, 0]),
        enc.encode("https://example.invalid/picture"),
      ),
      tags,
      version,
    );
    expect(tags).toEqual({ title: "Preserved" });
  },
);
it("ignores corrupt or overlong optional picture fields while keeping display tags", () => {
  const tags: TrackTags = { title: "Preserved" };
  for (const bytes of [
    picture().slice(0, -1),
    join(picture(), u(0)),
    picture(png, 3, "image/png", new Uint8Array(4097)),
    picture(enc.encode("file:///secret"), 3, "-->"),
    new Uint8Array(3),
  ])
    flacCover(bytes, tags);
  id3Cover(
    join(
      new Uint8Array([3]),
      enc.encode("image/png\0"),
      new Uint8Array([3]),
      new Uint8Array(4097).fill(65),
      png,
    ),
    tags,
    4,
  );
  offerCover(tags, new Uint8Array(AUDIO_COVER_BYTES + 1), 3);
  expect(tags).toEqual({ title: "Preserved" });
});
it("accepts canonical base64 picture comments and rejects malformed text and external pictures", () => {
  const tags: TrackTags = {},
    prefix = "METADATA_BLOCK_PICTURE=";
  const encoded = Buffer.from(picture()).toString("base64");
  for (const value of [
    "AA=A",
    "A===",
    "????",
    encoded + " ",
    Buffer.from(picture(enc.encode("https://example.invalid"), 3, "-->")).toString("base64"),
  ])
    commentCover(enc.encode(prefix + value), tags);
  expect(tags.cover).toBeUndefined();
  commentCover(enc.encode(prefix.toLowerCase() + encoded), tags);
  expect(tags.cover?.bytes).toEqual(png);
});
