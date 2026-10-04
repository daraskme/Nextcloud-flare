export const AUDIO_PREFIX_BYTES = 2 * 1024 * 1024;
export const AUDIO_TAIL_BYTES = 128;
export const AUDIO_TEXT_BYTES = 1024;
export const AUDIO_ID3_FRAME_LIMIT = 1024;

export interface AudioMetadata {
  readonly title: string | null;
  readonly artist: string | null;
  readonly album: string | null;
}

export type AudioParseResult =
  | { readonly kind: "metadata"; readonly metadata: AudioMetadata }
  | { readonly kind: "unsupported" }
  | { readonly kind: "malformed" };

export type AudioPrefixResult =
  | { readonly kind: "metadata"; readonly metadata: AudioMetadata }
  | { readonly kind: "unsupported" }
  | {
      readonly kind: "tail";
      readonly metadata: AudioMetadata | null;
      readonly hasMpegFrame: boolean;
    }
  | { readonly kind: "malformed" };

const encoder = new TextEncoder();

function ascii(bytes: Uint8Array, offset: number, length: number): string {
  return String.fromCharCode(...bytes.subarray(offset, offset + length));
}

function synchsafe(bytes: Uint8Array, offset: number): number | null {
  if (offset < 0 || offset + 4 > bytes.length) return null;
  let value = 0;
  for (let i = 0; i < 4; i++) {
    const byte = bytes[offset + i];
    if (byte === undefined || (byte & 0x80) !== 0) return null;
    value = value * 128 + byte;
  }
  return Number.isSafeInteger(value) ? value : null;
}

function uint32(bytes: Uint8Array, offset: number): number | null {
  if (offset < 0 || offset + 4 > bytes.length) return null;
  return new DataView(bytes.buffer, bytes.byteOffset + offset, 4).getUint32(0);
}

function decodeUtf16(bytes: Uint8Array, encoding: "utf-16le" | "utf-16be"): string {
  if (bytes.length % 2 !== 0) throw new Error("invalid_id3_text");
  return new TextDecoder(encoding, { fatal: true, ignoreBOM: true }).decode(bytes);
}

function decodedText(bytes: Uint8Array, version: 3 | 4): string | null {
  const encoding = bytes[0];
  if (encoding === undefined) throw new Error("invalid_id3_text");
  let payload = bytes.subarray(1);
  let value: string;
  if (encoding === 0) {
    if (payload.at(-1) === 0) payload = payload.subarray(0, -1);
    if (payload.includes(0)) throw new Error("invalid_id3_text");
    value = String.fromCharCode(...payload);
  } else if (encoding === 1) {
    if (payload.length >= 2 && payload.at(-1) === 0 && payload.at(-2) === 0)
      payload = payload.subarray(0, -2);
    if (payload.length < 2) throw new Error("invalid_id3_text");
    const bom = (payload[0] ?? 0) * 256 + (payload[1] ?? 0);
    if (bom === 0xfffe) value = decodeUtf16(payload.subarray(2), "utf-16le");
    else if (bom === 0xfeff) value = decodeUtf16(payload.subarray(2), "utf-16be");
    else throw new Error("invalid_id3_text");
  } else if (version === 4 && encoding === 2) {
    if (payload.length >= 2 && payload.at(-1) === 0 && payload.at(-2) === 0)
      payload = payload.subarray(0, -2);
    value = decodeUtf16(payload, "utf-16be");
  } else if (version === 4 && encoding === 3) {
    if (payload.at(-1) === 0) payload = payload.subarray(0, -1);
    value = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(payload);
  } else {
    throw new Error("invalid_id3_text");
  }
  value = value.trim().normalize("NFC");
  if (!value) return null;
  if (/[\p{Cc}\p{Cs}]/u.test(value) || encoder.encode(value).byteLength > AUDIO_TEXT_BYTES)
    throw new Error("invalid_id3_text");
  return value;
}

function id3v1Field(bytes: Uint8Array): string | null {
  let end = bytes.length;
  while (end > 0 && (bytes[end - 1] === 0 || bytes[end - 1] === 32)) end--;
  const value = String.fromCharCode(...bytes.subarray(0, end))
    .trim()
    .normalize("NFC");
  if (!value) return null;
  if (/[\p{Cc}\p{Cs}]/u.test(value) || encoder.encode(value).byteLength > AUDIO_TEXT_BYTES)
    throw new Error("invalid_id3v1_text");
  return value;
}

function id3v1(tail: Uint8Array): AudioMetadata | null {
  if (tail.length !== AUDIO_TAIL_BYTES || ascii(tail, 0, 3) !== "TAG") return null;
  return {
    title: id3v1Field(tail.subarray(3, 33)),
    artist: id3v1Field(tail.subarray(33, 63)),
    album: id3v1Field(tail.subarray(63, 93)),
  };
}

const BITRATE_MPEG1_L3 = [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320];
const BITRATE_MPEG2_L3 = [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160];
const SAMPLE_RATES = [44_100, 48_000, 32_000];

function mpegLayer3Frame(bytes: Uint8Array, offset: number) {
  const first = bytes[offset];
  const second = bytes[offset + 1];
  const third = bytes[offset + 2];
  const fourth = bytes[offset + 3];
  if (
    first !== 0xff ||
    second === undefined ||
    third === undefined ||
    fourth === undefined ||
    (second & 0xe0) !== 0xe0 ||
    (second & 0x06) !== 0x02
  )
    return null;
  const version = (second >> 3) & 3;
  const bitrateIndex = third >> 4;
  const rateIndex = (third >> 2) & 3;
  if (version === 1 || bitrateIndex === 0 || bitrateIndex === 15 || rateIndex === 3) return null;
  const bitrate = (version === 3 ? BITRATE_MPEG1_L3 : BITRATE_MPEG2_L3)[bitrateIndex];
  const rate = SAMPLE_RATES[rateIndex]! / (version === 3 ? 1 : version === 2 ? 2 : 4);
  if (!bitrate) return null;
  const length =
    Math.floor(((version === 3 ? 144 : 72) * bitrate * 1000) / rate) + ((third >> 1) & 1);
  return { version, rateIndex, length };
}

function hasRawMpegFrames(bytes: Uint8Array): boolean {
  const first = mpegLayer3Frame(bytes, 0);
  if (!first || first.length < 4) return false;
  const next = mpegLayer3Frame(bytes, first.length);
  return next !== null && next.version === first.version && next.rateIndex === first.rateIndex;
}

function knownNonMp3(bytes: Uint8Array): boolean {
  // Encrypted payloads can coincidentally contain MPEG sync bytes or an ID3v1 tail.
  // The container magic is sufficient to exclude media parsing; it does not attest encryption.
  if (bytes.length >= 8 && ascii(bytes, 0, 8) === "NCFENC1\0") return true;
  if (sniffMediaContainer(bytes.subarray(0, Math.min(bytes.length, MEDIA_SNIFF_BYTES))))
    return true;
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return true;
  if (bytes.length >= 8 && ascii(bytes, 0, 8) === "\x89PNG\r\n\x1a\n") return true;
  if (bytes.length >= 12 && ascii(bytes, 0, 4) === "RIFF" && ascii(bytes, 8, 4) === "WEBP")
    return true;
  return false;
}

function parseV2(prefix: Uint8Array, totalBytes: number): AudioMetadata {
  if (prefix.length < 10) throw new Error("truncated_id3");
  const major = prefix[3];
  if (major !== 3 && major !== 4) throw new Error("unsupported_id3_version");
  if (prefix[4] !== 0 || prefix[5] !== 0) throw new Error("unsupported_id3_flags");
  const tagSize = synchsafe(prefix, 6);
  if (tagSize === null) throw new Error("invalid_id3_size");
  const end = 10 + tagSize;
  if (
    !Number.isSafeInteger(end) ||
    end > AUDIO_PREFIX_BYTES ||
    end > prefix.length ||
    end > totalBytes
  )
    throw new Error("invalid_id3_size");
  const values: Record<"TIT2" | "TPE1" | "TALB", string | null> = {
    TIT2: null,
    TPE1: null,
    TALB: null,
  };
  let frames = 0;
  let offset = 10;
  while (offset < end) {
    if (prefix[offset] === 0) {
      for (let at = offset; at < end; at++)
        if (prefix[at] !== 0) throw new Error("invalid_id3_padding");
      offset = end;
      break;
    }
    if (offset + 10 > end) throw new Error("truncated_id3_frame");
    const id = ascii(prefix, offset, 4);
    if (!/^[A-Z0-9]{4}$/.test(id)) throw new Error("invalid_id3_frame");
    const size = major === 4 ? synchsafe(prefix, offset + 4) : uint32(prefix, offset + 4);
    if (size === null || size === 0 || prefix[offset + 8] !== 0 || prefix[offset + 9] !== 0)
      throw new Error("invalid_id3_frame");
    const body = offset + 10;
    const next = body + size;
    if (!Number.isSafeInteger(next) || next > end || next <= body)
      throw new Error("invalid_id3_frame");
    frames++;
    if (frames > AUDIO_ID3_FRAME_LIMIT) throw new Error("too_many_id3_frames");
    if (id === "TIT2" || id === "TPE1" || id === "TALB") {
      if (size > AUDIO_TEXT_BYTES * 4 + 3) throw new Error("invalid_id3_text");
      const value = decodedText(prefix.subarray(body, next), major);
      if (values[id] === null && value !== null) values[id] = value;
    }
    offset = next;
  }
  if (offset !== end) throw new Error("invalid_id3_offset");
  return { title: values.TIT2, artist: values.TPE1, album: values.TALB };
}

function complete(metadata: AudioMetadata, fallback: AudioMetadata | null): AudioMetadata {
  return {
    title: metadata.title ?? fallback?.title ?? null,
    artist: metadata.artist ?? fallback?.artist ?? null,
    album: metadata.album ?? fallback?.album ?? null,
  };
}

export function parseId3Prefix(prefix: Uint8Array, totalBytes: number): AudioPrefixResult {
  if (
    !Number.isSafeInteger(totalBytes) ||
    totalBytes < 0 ||
    prefix.byteLength !== Math.min(totalBytes, AUDIO_PREFIX_BYTES)
  )
    return { kind: "malformed" };
  try {
    if (knownNonMp3(prefix)) return { kind: "unsupported" };
    if (prefix.length >= 3 && ascii(prefix, 0, 3) === "ID3") {
      const metadata = parseV2(prefix, totalBytes);
      if (metadata.title && metadata.artist && metadata.album)
        return { kind: "metadata", metadata };
      return { kind: "tail", metadata, hasMpegFrame: true };
    }
    return { kind: "tail", metadata: null, hasMpegFrame: hasRawMpegFrames(prefix) };
  } catch {
    return { kind: "malformed" };
  }
}

export function parseId3Tail(
  prefix: Extract<AudioPrefixResult, { kind: "tail" }>,
  tail: Uint8Array,
  totalBytes: number,
): AudioParseResult {
  if (
    !Number.isSafeInteger(totalBytes) ||
    totalBytes < 0 ||
    tail.byteLength !== Math.min(totalBytes, AUDIO_TAIL_BYTES)
  )
    return { kind: "malformed" };
  try {
    const fallback = id3v1(tail);
    if (!prefix.metadata && !prefix.hasMpegFrame && !fallback) return { kind: "unsupported" };
    return {
      kind: "metadata",
      metadata: complete(prefix.metadata ?? { title: null, artist: null, album: null }, fallback),
    };
  } catch {
    return { kind: "malformed" };
  }
}

export function parseId3Metadata(
  prefix: Uint8Array,
  tail: Uint8Array,
  totalBytes: number,
): AudioParseResult {
  const parsed = parseId3Prefix(prefix, totalBytes);
  return parsed.kind === "tail" ? parseId3Tail(parsed, tail, totalBytes) : parsed;
}

import { MEDIA_SNIFF_BYTES, sniffMediaContainer } from "../sniff";
