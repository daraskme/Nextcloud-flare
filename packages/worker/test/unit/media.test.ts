import {
  type Av1Configuration,
  av1CodecString,
  avifPreviewSource,
  type MediaDescriptor,
  mediaContentType,
  playbackSupport,
} from "@next-cloud-flare/shared/media";
import { expect, it, vi } from "vitest";
import { MEDIA_SNIFF_BYTES, sniffMediaContainer } from "../../src/media/sniff";

function ftyp(major: string, compatible: string[] = [], extended = false) {
  const header = extended ? 16 : 8;
  const bytes = new Uint8Array(header + 8 + compatible.length * 4);
  const view = new DataView(bytes.buffer);
  view.setUint32(0, extended ? 1 : bytes.length);
  bytes.set(new TextEncoder().encode("ftyp"), 4);
  if (extended) view.setBigUint64(8, BigInt(bytes.length));
  bytes.set(new TextEncoder().encode(major), header);
  compatible.forEach((brand, i) => bytes.set(new TextEncoder().encode(brand), header + 8 + i * 4));
  return bytes;
}

it.each([false, true])(
  "recognizes AVIF brands in bounded ftyp (extended=%s) independently of extensions",
  (extended) => {
    expect(sniffMediaContainer(ftyp("avif", ["mif1", "miaf"], extended))).toEqual({
      container: "avif",
      animated: false,
    });
    expect(sniffMediaContainer(ftyp("mif1", ["avif"], extended))).toEqual({
      container: "avif",
      animated: false,
    });
    expect(sniffMediaContainer(ftyp("avis", ["avif", "msf1"], extended))).toEqual({
      container: "avif",
      animated: true,
    });
    expect(sniffMediaContainer(ftyp("heic", ["mif1"], extended))).toBeNull();
  },
);

it("does not confuse minor-version/payload strings with compatible brands or infer AV1 from MP4", () => {
  const bytes = ftyp("xxxx");
  bytes.set(new TextEncoder().encode("avif"), 12);
  expect(sniffMediaContainer(bytes)).toBeNull();
  expect(sniffMediaContainer(new TextEncoder().encode("<svg>avif OpusHead av01</svg>"))).toBeNull();
  expect(sniffMediaContainer(ftyp("isom", ["av01"]))).toEqual({ container: "mp4" });
});

it("rejects truncated, overflowing and oversized ftyp declarations", () => {
  const valid = ftyp("avif", ["mif1"]);
  for (let i = 0; i < valid.length; i++)
    expect(sniffMediaContainer(valid.subarray(0, i))).toBeNull();
  for (const size of [0, 8, 17, 4097, 0xffffffff]) {
    const bytes = valid.slice();
    new DataView(bytes.buffer).setUint32(0, size);
    expect(sniffMediaContainer(bytes)).toBeNull();
  }
  const extended = ftyp("avif", [], true);
  new DataView(extended.buffer).setBigUint64(8, 2n ** 63n);
  expect(sniffMediaContainer(extended)).toBeNull();
});

it("recognizes WebM only from an in-bounds EBML DocType, not arbitrary strings or Matroska", () => {
  const webm = Uint8Array.from([0x1a, 0x45, 0xdf, 0xa3, 0x87, 0x42, 0x82, 0x84, 119, 101, 98, 109]);
  expect(sniffMediaContainer(webm)).toEqual({ container: "webm" });
  for (let i = 0; i < webm.length; i++) expect(sniffMediaContainer(webm.subarray(0, i))).toBeNull();
  const unknownSize = webm.slice();
  unknownSize[4] = 0xff;
  expect(sniffMediaContainer(unknownSize)).toBeNull();
  const outsideHeader = webm.slice();
  outsideHeader[4] = 0x80;
  expect(sniffMediaContainer(outsideHeader)).toBeNull();
  const matroska = Uint8Array.from([
    0x1a,
    0x45,
    0xdf,
    0xa3,
    0x8b,
    0x42,
    0x82,
    0x88,
    ...new TextEncoder().encode("matroska"),
  ]);
  expect(sniffMediaContainer(matroska)).toBeNull();
  const duplicate = Uint8Array.from([...webm, ...webm.subarray(5)]);
  duplicate[4] = 0x8e;
  expect(sniffMediaContainer(duplicate)).toBeNull();
});

it("requires a complete Ogg BOS page and leaves the track codec to the bounded parser", () => {
  const bytes = new Uint8Array(47);
  bytes.set(new TextEncoder().encode("OggS"));
  bytes[5] = 2;
  bytes[26] = 1;
  bytes[27] = 19;
  bytes.set(new TextEncoder().encode("OpusHead"), 28);
  expect(sniffMediaContainer(bytes)).toEqual({ container: "ogg" });
  expect(sniffMediaContainer(bytes.subarray(0, 46))).toBeNull();
  bytes[5] = 1;
  expect(sniffMediaContainer(bytes)).toBeNull();
  bytes[5] = 2;
  bytes[4] = 1;
  expect(sniffMediaContainer(bytes)).toBeNull();
});

it("keeps the prefix budget fixed and treats arbitrary short data as non-media", () => {
  expect(() => sniffMediaContainer(new Uint8Array(MEDIA_SNIFF_BYTES + 1))).toThrow(
    "media_sniff_budget_exceeded",
  );
  for (let n = 0; n < 256; n++) expect(sniffMediaContainer(new Uint8Array(n).fill(n))).toBeNull();
});

const configuration: Av1Configuration = { profile: 0, level: 8, tier: "M", bitDepth: 10 };
const video: MediaDescriptor = {
  kind: "video",
  container: "webm",
  codec: "av1",
  configuration,
  audio: "opus",
};

it.each([
  [{ kind: "image", codec: "avif" }, "image/avif"],
  [video, 'video/webm; codecs="av01.0.08M.10,opus"'],
  [{ ...video, container: "mp4" }, 'video/mp4; codecs="av01.0.08M.10,Opus"'],
  [{ ...video, audio: null }, 'video/webm; codecs="av01.0.08M.10"'],
  [{ kind: "audio", container: "ogg", codec: "opus" }, 'audio/ogg; codecs="opus"'],
  [{ kind: "audio", container: "webm", codec: "opus" }, 'audio/webm; codecs="opus"'],
  [{ kind: "audio", container: "mp4", codec: "opus" }, 'audio/mp4; codecs="Opus"'],
] as const)("uses container-specific MIME and codec strings for %o", (media, expected) => {
  expect(mediaContentType(media)).toBe(expected);
});

it("preserves AV1 bit depth and level without assuming 8-bit SDR", () => {
  expect(av1CodecString({ profile: 0, level: 0, tier: "M", bitDepth: 8 })).toBe("av01.0.00M.08");
  expect(av1CodecString({ profile: 2, level: 13, tier: "H", bitDepth: 12 })).toBe("av01.2.13H.12");
  expect(av1CodecString({ profile: 2, level: 31, tier: "M", bitDepth: 12 })).toBe("av01.2.31M.12");
  for (const invalid of [
    { profile: 3 },
    { level: 24 },
    { level: 0.5 },
    { bitDepth: 12 },
    { tier: "H", level: 0 },
  ])
    expect(() => av1CodecString({ ...configuration, ...invalid } as Av1Configuration)).toThrow();
});

it.each(["", "maybe", "probably"] as const)(
  "checks the actual AV1/Opus combination through canPlayType (%s)",
  (answer) => {
    const canPlayType = vi.fn(() => answer);
    expect(playbackSupport(video, { canPlayType })).toBe(answer || "unsupported");
    expect(canPlayType).toHaveBeenCalledExactlyOnceWith(
      "video",
      'video/webm; codecs="av01.0.08M.10,opus"',
    );
  },
);

it("does not claim decoding success when the native probe fails or when testing an image", () => {
  const canPlayType = vi.fn(() => {
    throw new Error("unavailable");
  });
  expect(playbackSupport(video, { canPlayType })).toBe("unknown");
  canPlayType.mockClear();
  expect(playbackSupport({ kind: "image", codec: "avif" }, { canPlayType })).toBe("unknown");
  expect(canPlayType).not.toHaveBeenCalled();
});

it("keeps AVIF detail previews available without generating or downloading all full-size grid images", () => {
  for (const status of ["pending", "unsupported", "failed"] as const) {
    expect(avifPreviewSource(status, "detail")).toBe("original");
    expect(avifPreviewSource(status, "grid")).toBe("placeholder");
  }
  expect(avifPreviewSource("ready", "grid")).toBe("derivative");
});
