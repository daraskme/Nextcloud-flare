import { LIMITS } from "@next-cloud-flare/shared/limits";
import type { Av1Configuration } from "@next-cloud-flare/shared/media";
import { MEDIA_SNIFF_BYTES, sniffMediaContainer } from "../sniff";

export const VIDEO_METADATA_GENERATOR = "video-av1-metadata-v1";
export const VIDEO_METADATA_BYTES = 4 * 1024 * 1024;

export interface VideoMetadata {
  readonly container: "mp4" | "webm";
  readonly width: number;
  readonly height: number;
  readonly durationMs: number | null;
  readonly configuration: Av1Configuration;
  readonly audio: "opus" | null;
}

export interface VideoObjectSource {
  readonly key: string;
  readonly size: number;
  readonly r2Etag: string;
}

export type VideoInspection =
  | { readonly kind: "metadata"; readonly metadata: VideoMetadata }
  | { readonly kind: "not-video" | "unsupported" | "malformed" | "oversized" | "transient" };

class InvalidVideo extends Error {
  constructor(readonly kind: "unsupported" | "malformed" | "oversized") {
    super(kind);
  }
}

interface Box {
  readonly type: string;
  readonly start: number;
  readonly payload: number;
  readonly end: number;
}

interface Element {
  readonly id: number;
  readonly payload: number;
  readonly end: number;
}

const textDecoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

function current(deadline: number): boolean {
  return Number.isSafeInteger(deadline) && Date.now() < deadline;
}

function matches(object: R2Object, source: VideoObjectSource): boolean {
  return object.size === source.size && object.etag === source.r2Etag;
}

async function range(
  bucket: R2Bucket,
  source: VideoObjectSource,
  offset: number,
  length: number,
  deadline: number,
): Promise<Uint8Array | null> {
  if (!current(deadline) || offset < 0 || length < 1 || offset + length > source.size) return null;
  const object = await bucket.get(source.key, { range: { offset, length } });
  if (!current(deadline) || !object || !matches(object, source)) return null;
  const bytes = new Uint8Array(await object.arrayBuffer());
  return current(deadline) && bytes.byteLength === length ? bytes : null;
}

function ascii(bytes: Uint8Array, offset: number, length: number): string {
  return String.fromCharCode(...bytes.subarray(offset, offset + length));
}

function uint(bytes: Uint8Array, offset: number, length: number): number {
  if (length < 1 || length > 6 || offset < 0 || offset + length > bytes.length)
    throw new InvalidVideo("malformed");
  let value = 0;
  for (let index = 0; index < length; index++) value = value * 256 + (bytes[offset + index] ?? 0);
  if (!Number.isSafeInteger(value)) throw new InvalidVideo("malformed");
  return value;
}

function boxes(bytes: Uint8Array, start: number, end: number): Box[] {
  if (start < 0 || end > bytes.length || start > end) throw new InvalidVideo("malformed");
  const result: Box[] = [];
  let offset = start;
  while (offset < end) {
    if (result.length >= 4096 || offset + 8 > end) throw new InvalidVideo("malformed");
    let size = uint(bytes, offset, 4);
    const type = ascii(bytes, offset + 4, 4);
    let header = 8;
    if (size === 1) {
      if (offset + 16 > end) throw new InvalidVideo("malformed");
      size = uint(bytes, offset + 8, 6) * 65_536 + uint(bytes, offset + 14, 2);
      header = 16;
    } else if (size === 0) {
      size = end - offset;
    }
    if (size < header || !Number.isSafeInteger(offset + size) || offset + size > end)
      throw new InvalidVideo("malformed");
    result.push({ type, start: offset, payload: offset + header, end: offset + size });
    offset += size;
  }
  return result;
}

function child(parent: Box, bytes: Uint8Array, type: string): Box | null {
  const matches = boxes(bytes, parent.payload, parent.end).filter((box) => box.type === type);
  if (matches.length > 1) throw new InvalidVideo("malformed");
  return matches[0] ?? null;
}

function av1Configuration(bytes: Uint8Array, offset: number, end: number): Av1Configuration {
  if (end - offset < 4 || bytes[offset] !== 0x81) throw new InvalidVideo("malformed");
  const fields = bytes[offset + 1] ?? 0;
  const depth = bytes[offset + 2] ?? 0;
  const profile = (fields >> 5) as 0 | 1 | 2;
  const level = fields & 0x1f;
  const tier = (depth & 0x80) === 0 ? "M" : "H";
  const highBitDepth = (depth & 0x40) !== 0;
  const twelveBit = (depth & 0x20) !== 0;
  const bitDepth = highBitDepth ? (twelveBit ? 12 : 10) : 8;
  if (
    profile > 2 ||
    (level > 23 && level !== 31) ||
    (twelveBit && !highBitDepth) ||
    (bitDepth === 12 && profile !== 2) ||
    (tier === "H" && level < 8) ||
    (depth & 0x10) !== 0
  )
    throw new InvalidVideo("unsupported");
  return { profile, level, tier, bitDepth };
}

function mp4Duration(bytes: Uint8Array, mvhd: Box): number | null {
  const version = bytes[mvhd.payload];
  const timescaleOffset = mvhd.payload + (version === 1 ? 20 : 12);
  const durationOffset = timescaleOffset + 4;
  const durationLength = version === 1 ? 8 : 4;
  if ((version !== 0 && version !== 1) || durationOffset + durationLength > mvhd.end)
    throw new InvalidVideo("malformed");
  const timescale = uint(bytes, timescaleOffset, 4);
  if (timescale === 0) throw new InvalidVideo("malformed");
  let duration: number;
  if (durationLength === 8) {
    const high = uint(bytes, durationOffset, 4);
    const low = uint(bytes, durationOffset + 4, 4);
    duration = high * 4_294_967_296 + low;
  } else {
    duration = uint(bytes, durationOffset, 4);
  }
  const milliseconds = Math.round((duration * 1000) / timescale);
  return Number.isSafeInteger(milliseconds) && milliseconds >= 0 ? milliseconds : null;
}

function mp4SampleEntry(
  bytes: Uint8Array,
  trak: Box,
):
  | {
      kind: "video";
      width: number;
      height: number;
      configuration: Av1Configuration;
    }
  | {
      kind: "audio";
      codec: "opus";
    }
  | {
      kind: "other";
    } {
  const mdia = child(trak, bytes, "mdia");
  const hdlr = mdia ? child(mdia, bytes, "hdlr") : null;
  if (!mdia || !hdlr || hdlr.payload + 12 > hdlr.end) throw new InvalidVideo("malformed");
  const handler = ascii(bytes, hdlr.payload + 8, 4);
  if (handler !== "vide" && handler !== "soun") return { kind: "other" };
  const minf = child(mdia, bytes, "minf");
  const stbl = minf ? child(minf, bytes, "stbl") : null;
  const stsd = stbl ? child(stbl, bytes, "stsd") : null;
  if (!stsd || stsd.payload + 8 > stsd.end) throw new InvalidVideo("malformed");
  const count = uint(bytes, stsd.payload + 4, 4);
  if (count !== 1) throw new InvalidVideo("unsupported");
  const entries = boxes(bytes, stsd.payload + 8, stsd.end);
  const entry = entries[0];
  if (!entry || entries.length !== 1) throw new InvalidVideo("malformed");
  if (handler === "soun") {
    if (entry.type !== "Opus") throw new InvalidVideo("unsupported");
    return { kind: "audio", codec: "opus" };
  }
  if (entry.type !== "av01" || entry.payload + 78 > entry.end)
    throw new InvalidVideo("unsupported");
  const width = uint(bytes, entry.payload + 24, 2);
  const height = uint(bytes, entry.payload + 26, 2);
  const av1c = boxes(bytes, entry.payload + 78, entry.end).find((box) => box.type === "av1C");
  if (!av1c) throw new InvalidVideo("malformed");
  return {
    kind: "video",
    width,
    height,
    configuration: av1Configuration(bytes, av1c.payload, av1c.end),
  };
}

function parseMp4(bytes: Uint8Array): VideoMetadata {
  const top = boxes(bytes, 0, bytes.length);
  const ftyp = top.find((box) => box.type === "ftyp");
  const moov = top.find((box) => box.type === "moov");
  if (!ftyp || !moov || top.filter((box) => box.type === "moov").length !== 1)
    throw new InvalidVideo("malformed");
  const mvhd = child(moov, bytes, "mvhd");
  if (!mvhd) throw new InvalidVideo("malformed");
  let video: Extract<ReturnType<typeof mp4SampleEntry>, { kind: "video" }> | null = null;
  let audio: "opus" | null = null;
  for (const trak of boxes(bytes, moov.payload, moov.end).filter((box) => box.type === "trak")) {
    const entry = mp4SampleEntry(bytes, trak);
    if (entry.kind === "video") {
      if (video) throw new InvalidVideo("unsupported");
      video = entry;
    } else if (entry.kind === "audio") {
      if (audio) throw new InvalidVideo("unsupported");
      audio = entry.codec;
    }
  }
  if (!video) throw new InvalidVideo("unsupported");
  validateDimensions(video.width, video.height);
  return {
    container: "mp4",
    width: video.width,
    height: video.height,
    durationMs: mp4Duration(bytes, mvhd),
    configuration: video.configuration,
    audio,
  };
}

function vint(
  bytes: Uint8Array,
  offset: number,
  id: boolean,
): { value: number; length: number; unknown: boolean } {
  const first = bytes[offset];
  if (!first) throw new InvalidVideo("malformed");
  let length = 1;
  let mask = 0x80;
  while ((first & mask) === 0) {
    mask >>= 1;
    length++;
  }
  if (length > (id ? 4 : 8) || offset + length > bytes.length) throw new InvalidVideo("malformed");
  let value = id ? first : first & (mask - 1);
  let unknown = !id && (first & (mask - 1)) === mask - 1;
  for (let index = 1; index < length; index++) {
    const byte = bytes[offset + index] ?? 0;
    value = value * 256 + byte;
    unknown &&= byte === 255;
  }
  if (!Number.isSafeInteger(value)) throw new InvalidVideo("oversized");
  return { value, length, unknown };
}

function elements(bytes: Uint8Array, start: number, end: number): Element[] {
  const result: Element[] = [];
  let offset = start;
  while (offset < end) {
    if (result.length >= 4096) throw new InvalidVideo("oversized");
    const id = vint(bytes, offset, true);
    const size = vint(bytes, offset + id.length, false);
    const payload = offset + id.length + size.length;
    const elementEnd = size.unknown ? end : payload + size.value;
    if (payload > end || elementEnd > end || elementEnd < payload)
      throw new InvalidVideo("malformed");
    result.push({ id: id.value, payload, end: elementEnd });
    offset = elementEnd;
    if (size.unknown) break;
  }
  return result;
}

function segmentMetadataElements(bytes: Uint8Array, segment: Element): Element[] {
  const result: Element[] = [];
  let offset = segment.payload;
  while (offset < segment.end) {
    if (result.length >= 4096) throw new InvalidVideo("oversized");
    const id = vint(bytes, offset, true);
    const size = vint(bytes, offset + id.length, false);
    const payload = offset + id.length + size.length;
    if (id.value === 0x1f43b675) break;
    const itemEnd = size.unknown ? segment.end : payload + size.value;
    if (payload > segment.end || itemEnd > segment.end || itemEnd < payload)
      throw new InvalidVideo("oversized");
    result.push({ id: id.value, payload, end: itemEnd });
    offset = itemEnd;
    if (size.unknown) break;
  }
  return result;
}

function element(parent: Element, bytes: Uint8Array, id: number): Element | null {
  const matches = elements(bytes, parent.payload, parent.end).filter((item) => item.id === id);
  if (matches.length > 1) throw new InvalidVideo("malformed");
  return matches[0] ?? null;
}

function float(bytes: Uint8Array, item: Element): number {
  const view = new DataView(bytes.buffer, bytes.byteOffset + item.payload, item.end - item.payload);
  if (view.byteLength === 4) return view.getFloat32(0);
  if (view.byteLength === 8) return view.getFloat64(0);
  throw new InvalidVideo("malformed");
}

function parseWebm(bytes: Uint8Array): VideoMetadata {
  const top = elements(bytes, 0, bytes.length);
  if (top[0]?.id !== 0x1a45dfa3) throw new InvalidVideo("malformed");
  const segment = top.find((item) => item.id === 0x18538067);
  if (!segment) throw new InvalidVideo("malformed");
  const segmentItems = segmentMetadataElements(bytes, segment);
  const info = segmentItems.find((item) => item.id === 0x1549a966) ?? null;
  const tracks = segmentItems.find((item) => item.id === 0x1654ae6b) ?? null;
  if (!tracks) throw new InvalidVideo("malformed");
  let video: { width: number; height: number; configuration: Av1Configuration } | undefined;
  let audio: "opus" | null = null;
  for (const track of elements(bytes, tracks.payload, tracks.end).filter(
    (item) => item.id === 0xae,
  )) {
    const type = element(track, bytes, 0x83);
    const codec = element(track, bytes, 0x86);
    if (!type || !codec) throw new InvalidVideo("malformed");
    const trackType = uint(bytes, type.payload, type.end - type.payload);
    const codecId = textDecoder.decode(bytes.subarray(codec.payload, codec.end));
    if (trackType === 1) {
      if (video || codecId !== "V_AV1") throw new InvalidVideo("unsupported");
      const dimensions = element(track, bytes, 0xe0);
      const width = dimensions ? element(dimensions, bytes, 0xb0) : null;
      const height = dimensions ? element(dimensions, bytes, 0xba) : null;
      const privateData = element(track, bytes, 0x63a2);
      if (!width || !height || !privateData) throw new InvalidVideo("malformed");
      video = {
        width: uint(bytes, width.payload, width.end - width.payload),
        height: uint(bytes, height.payload, height.end - height.payload),
        configuration: av1Configuration(bytes, privateData.payload, privateData.end),
      };
    } else if (trackType === 2) {
      if (audio || codecId !== "A_OPUS") throw new InvalidVideo("unsupported");
      audio = "opus";
    }
  }
  if (!video) throw new InvalidVideo("unsupported");
  validateDimensions(video.width, video.height);
  const scaleElement = info ? element(info, bytes, 0x2ad7b1) : null;
  const durationElement = info ? element(info, bytes, 0x4489) : null;
  const scale = scaleElement
    ? uint(bytes, scaleElement.payload, scaleElement.end - scaleElement.payload)
    : 1_000_000;
  const durationValue = durationElement ? float(bytes, durationElement) : null;
  const durationMs =
    durationValue !== null && Number.isFinite(durationValue) && durationValue >= 0
      ? Math.round((durationValue * scale) / 1_000_000)
      : null;
  return {
    container: "webm",
    width: video.width,
    height: video.height,
    durationMs: durationMs !== null && Number.isSafeInteger(durationMs) ? durationMs : null,
    configuration: video.configuration,
    audio,
  };
}

function validateDimensions(width: number, height: number): void {
  if (
    width < 1 ||
    height < 1 ||
    width > LIMITS.imageDimension ||
    height > LIMITS.imageDimension ||
    width * height > LIMITS.imagePixels
  )
    throw new InvalidVideo("oversized");
}

function mp4MetadataWindow(prefix: Uint8Array): Uint8Array | null {
  let offset = 0;
  let ftyp: Uint8Array | null = null;
  while (offset + 8 <= prefix.length) {
    const size = uint(prefix, offset, 4);
    const type = ascii(prefix, offset + 4, 4);
    if (size < 8 || size > VIDEO_METADATA_BYTES || offset + size > prefix.length) return null;
    if (type === "ftyp") ftyp = prefix.subarray(offset, offset + size);
    if (type === "moov" && ftyp) {
      const moov = prefix.subarray(offset, offset + size);
      const result = new Uint8Array(ftyp.length + moov.length);
      result.set(ftyp);
      result.set(moov, ftyp.length);
      return result;
    }
    offset += size;
  }
  return null;
}

function tailMoov(tail: Uint8Array): Uint8Array | null {
  for (let type = 4; type + 4 <= tail.length; type++) {
    if (ascii(tail, type, 4) !== "moov") continue;
    const start = type - 4;
    const size = uint(tail, start, 4);
    if (size >= 8 && size <= VIDEO_METADATA_BYTES && start + size <= tail.length)
      return tail.subarray(start, start + size);
  }
  return null;
}

export async function inspectVideoObject(
  bucket: R2Bucket,
  source: VideoObjectSource,
  deadline: number,
): Promise<VideoInspection> {
  if (
    !source.key ||
    source.key.length > 1024 ||
    !Number.isSafeInteger(source.size) ||
    source.size < 0 ||
    !source.r2Etag ||
    source.r2Etag.length > 256 ||
    !current(deadline)
  )
    return { kind: "transient" };
  if (source.size === 0) {
    try {
      const object = await bucket.head(source.key);
      return current(deadline) && object && matches(object, source)
        ? { kind: "not-video" }
        : { kind: "transient" };
    } catch {
      return { kind: "transient" };
    }
  }
  let prefix: Uint8Array | null;
  try {
    const prefixLength = Math.min(source.size, VIDEO_METADATA_BYTES);
    prefix = await range(bucket, source, 0, prefixLength, deadline);
  } catch {
    return { kind: "transient" };
  }
  if (!prefix) return { kind: "transient" };
  try {
    const sniffed = sniffMediaContainer(
      prefix.subarray(0, Math.min(prefix.length, MEDIA_SNIFF_BYTES)),
    );
    if (sniffed?.container !== "mp4" && sniffed?.container !== "webm") return { kind: "not-video" };
    if (sniffed.container === "webm") return { kind: "metadata", metadata: parseWebm(prefix) };
    const window = mp4MetadataWindow(prefix);
    if (window) return { kind: "metadata", metadata: parseMp4(window) };
    if (source.size <= VIDEO_METADATA_BYTES) return { kind: "malformed" };
    const tailLength = Math.min(source.size, VIDEO_METADATA_BYTES);
    let tail: Uint8Array | null;
    try {
      tail = await range(bucket, source, source.size - tailLength, tailLength, deadline);
    } catch {
      return { kind: "transient" };
    }
    if (!tail) return { kind: "transient" };
    const moov = tailMoov(tail);
    if (!moov) return { kind: "oversized" };
    const combined = new Uint8Array(8 + moov.length);
    combined.set([0, 0, 0, 8, 102, 116, 121, 112]);
    combined.set(moov, 8);
    return { kind: "metadata", metadata: parseMp4(combined) };
  } catch (error) {
    if (error instanceof InvalidVideo) return { kind: error.kind };
    return { kind: "malformed" };
  }
}
