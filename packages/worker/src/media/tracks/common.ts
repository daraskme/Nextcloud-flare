import {
  type Av1Configuration,
  av1CodecString,
  type MediaDescriptor,
} from "../../../../shared/src/media";
import { ascii, valid, view } from "../images/reader";

export const TRACK_METADATA_GENERATOR = "track-metadata-v1";
export const TRACK_METADATA_LIMITS = Object.freeze({
  bytes: 4194304,
  reads: 128,
  structures: 8192,
});
export interface TrackTags {
  title?: string;
  artist?: string;
  album?: string;
  trackNumber?: number;
  discNumber?: number;
}
export interface TrackMetadata extends TrackTags {
  media: Exclude<MediaDescriptor, { kind: "image" }>;
  width: number | null;
  height: number | null;
  durationMs: number | null;
}
export function av1Configuration(bytes: Uint8Array): Av1Configuration {
  valid(bytes.length >= 4 && bytes[0] === 0x81 && (bytes[3]! & 0xe0) === 0);
  valid((bytes[3]! & 0x10) !== 0 || (bytes[3]! & 15) === 0);
  const p = bytes[1]!,
    q = bytes[2]!;
  valid(!(q & 32) || (q & 64 && p >>> 5 === 2));
  const c: Av1Configuration = {
    profile: (p >>> 5) as 0 | 1 | 2,
    level: p & 31,
    tier: q & 128 ? "H" : "M",
    bitDepth: q & 32 ? 12 : q & 64 ? 10 : 8,
  };
  try {
    av1CodecString(c);
  } catch {
    valid(false);
  }
  return c;
}
/** Identification only; no packet decoding or claim that a native player supports this stream. */
export function opusConfiguration(bytes: Uint8Array, mp4 = false) {
  const base = mp4 ? 0 : 8;
  valid(
    bytes.length >= base + 11 &&
      (mp4 ? bytes[0] === 0 : ascii(bytes, 0, 8) === "OpusHead" && bytes[8] === 1),
  );
  const channels = bytes[base + 1]!,
    family = bytes[base + 10]!;
  valid(channels > 0 && [0, 1, 255].includes(family));
  if (family === 0) valid(channels <= 2 && bytes.length === base + 11);
  else {
    valid(bytes.length === base + 13 + channels && (family !== 1 || channels <= 8));
    const streams = bytes[base + 11]!,
      coupled = bytes[base + 12]!;
    valid(streams > 0 && coupled <= streams && streams + coupled <= 255);
    for (const x of bytes.subarray(base + 13)) valid(x === 255 || x < streams + coupled);
  }
  return { channels, preSkip: view(bytes).getUint16(base + 2, !mp4) };
}
export function durationMs(ticks: number, scale: number) {
  valid(Number.isFinite(ticks) && ticks >= 0 && Number.isFinite(scale) && scale > 0);
  const result = Math.round((ticks * 1000) / scale);
  valid(Number.isSafeInteger(result) && result >= 0);
  return result;
}
/** Store just bounded display tags; arbitrary metadata, GPS and embedded pictures are omitted. */
export function tag(tags: TrackTags, name: string, bytes: Uint8Array) {
  if (bytes.length > 1024) return;
  let value: string;
  try {
    value = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes).trim();
  } catch {
    return;
  }
  if (!value || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value)) return;
  const key = ({ TITLE: "title", ARTIST: "artist", ALBUM: "album" } as const)[
    name.toUpperCase() as "TITLE"
  ];
  if (key) tags[key] ??= value;
  else if (
    ["TRACKNUMBER", "DISCNUMBER", "TRACK", "DISC", "PART_NUMBER"].includes(name.toUpperCase())
  ) {
    const match = /^(\d{1,6})(?:\/\d{1,6})?$/.exec(value);
    if (match)
      tags[
        name.toUpperCase().startsWith("TRACK") || name.toUpperCase() === "PART_NUMBER"
          ? "trackNumber"
          : "discNumber"
      ] ??= Number(match[1]);
  }
}
