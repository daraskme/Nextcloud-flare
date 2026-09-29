import { ascii, ImageFormatError, type ImageReader, valid, view } from "../images/reader";
import { AUDIO_HEAD_BYTES, head, textTag } from "./audioCommon";
import { durationMs, type TrackMetadata, type TrackTags } from "./common";
import { AUDIO_COVER_BYTES, id3Cover, optionalCover } from "./cover";

function syncsafe(b: Uint8Array, at: number) {
  valid(at + 4 <= b.length);
  let value = 0;
  for (const byte of b.subarray(at, at + 4)) {
    valid(byte < 128);
    value = value * 128 + byte;
  }
  return value;
}
function unsync(b: Uint8Array) {
  const out = new Uint8Array(b.length);
  let n = 0;
  for (let i = 0; i < b.length; i++) {
    out[n++] = b[i]!;
    if (b[i] === 255 && b[i + 1] === 0) i++;
  }
  return out.subarray(0, n);
}
function textFrame(tags: TrackTags, key: string, b: Uint8Array, version: number) {
  if (b.length < 2 || b.length > 2049) return;
  const encoding = b[0]!,
    data = b.subarray(1);
  if (encoding > (version === 4 ? 3 : 1)) return;
  try {
    let text: string;
    if (encoding === 0) text = ascii(data);
    else if (encoding === 3)
      text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(data);
    else {
      if (data.length % 2) return;
      let order = "utf-16be",
        offset = 0;
      if (encoding === 1) {
        if (data[0] === 255 && data[1] === 254) order = "utf-16le";
        else if (data[0] !== 254 || data[1] !== 255) return;
        offset = 2;
      }
      text = new TextDecoder(order, { fatal: true, ignoreBOM: false }).decode(
        data.subarray(offset),
      );
    }
    textTag(tags, key, text);
  } catch {
    /* Ignore malformed display text, never decode arbitrary metadata. */
  }
}
async function id3(r: ImageReader, tags: TrackTags) {
  const header = await head(r, 0, 10);
  if (ascii(header, 0, 3) !== "ID3") return 0;
  const version = header[3]!,
    flags = header[5]!,
    size = syncsafe(header, 6);
  valid([2, 3, 4].includes(version) && header[4] !== 255);
  valid((flags & (version === 4 ? 15 : version === 3 ? 31 : 63)) === 0);
  valid(version !== 2 || !(flags & 64)); // v2.2 whole-tag compression is unsupported.
  const footer = version === 4 && flags & 16 ? 10 : 0;
  valid(10 + size + footer <= Math.min(r.size, AUDIO_HEAD_BYTES));
  let bytes = await head(r, 10, size);
  if (footer) {
    const end = await head(r, 10 + size, 10);
    valid(ascii(end, 0, 3) === "3DI" && end.subarray(3).every((v, i) => v === header[i + 3]));
  }
  if (version < 4 && flags & 128) bytes = unsync(bytes);
  const d = view(bytes);
  let at = 0;
  if (version >= 3 && flags & 64) {
    valid(bytes.length >= 6);
    if (version === 3) {
      const n = d.getUint32(0);
      valid((n === 6 || n === 10) && n + 4 <= bytes.length);
      valid(d.getUint16(4) === (n === 10 ? 32768 : 0));
      valid(d.getUint32(6) <= bytes.length - n - 4);
      at = n + 4;
    } else {
      const n = syncsafe(bytes, 0);
      valid(n >= 6 && n <= bytes.length && bytes[4] === 1 && (bytes[5]! & 143) === 0);
      at = 6;
      for (const [bit, length] of [
        [64, 0],
        [32, 5],
        [16, 1],
      ] as const)
        if (bytes[5]! & bit) {
          valid(at < n && bytes[at++] === length && at + length <= n);
          at += length;
        }
      valid(at === n);
    }
  }
  const keys: Record<string, string> = {
    TIT2: "TITLE",
    TT2: "TITLE",
    TPE1: "ARTIST",
    TP1: "ARTIST",
    TALB: "ALBUM",
    TAL: "ALBUM",
    TRCK: "TRACK",
    TRK: "TRACK",
    TPOS: "DISC",
    TPA: "DISC",
  };
  while (at < bytes.length) {
    r.step();
    if (bytes[at] === 0) {
      valid(bytes.subarray(at).every((v) => v === 0));
      break;
    }
    const short = version === 2,
      headerSize = short ? 6 : 10;
    valid(at + headerSize <= bytes.length);
    const name = ascii(bytes, at, short ? 3 : 4);
    valid(/^[A-Z0-9]+$/.test(name));
    const length = short
      ? bytes[at + 3]! * 65536 + bytes[at + 4]! * 256 + bytes[at + 5]!
      : version === 4
        ? syncsafe(bytes, at + 4)
        : d.getUint32(at + 4);
    const status = short ? 0 : bytes[at + 8]!,
      format = short ? 0 : bytes[at + 9]!;
    valid(
      short ||
        ((status & (version === 4 ? 143 : 31)) === 0 &&
          (format & (version === 4 ? 176 : 31)) === 0),
    );
    at += headerSize;
    valid(length > 0 && at + length <= bytes.length);
    const key = keys[name];
    const picture = name === "APIC" || name === "PIC";
    if (
      ((key && length <= 4096) || (picture && length <= AUDIO_COVER_BYTES)) &&
      !(format & (version === 4 ? 12 : 192))
    ) {
      const parse = () => {
        let data = bytes.subarray(at, at + length);
        if (version === 4 && (format & 2 || flags & 128)) data = unsync(data);
        if (format & (version === 4 ? 64 : 32)) data = data.subarray(1);
        if (version === 4 && format & 1) {
          const count = syncsafe(data, 0);
          data = data.subarray(4);
          valid(data.length === count);
        }
        if (picture) id3Cover(data, tags, version);
        else textFrame(tags, key!, data, version);
      };
      if (picture) optionalCover(parse);
      else parse();
    }
    at += length;
  }
  return 10 + size + footer;
}
function frame(bytes: Uint8Array) {
  valid(bytes.length >= 4 && bytes[0] === 255 && (bytes[1]! & 224) === 224);
  const version = (bytes[1]! >> 3) & 3,
    index = bytes[2]! >> 4,
    sampling = (bytes[2]! >> 2) & 3;
  valid(
    version !== 1 &&
      (bytes[1]! & 6) === 2 &&
      index > 0 &&
      index < 15 &&
      sampling < 3 &&
      (bytes[3]! & 3) !== 2,
  );
  const rate = [44100, 48000, 32000][sampling]! / (version === 3 ? 1 : version === 2 ? 2 : 4);
  const bitrate = (
    version === 3
      ? [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320]
      : [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160]
  )[index]!;
  const length =
    Math.floor(((version === 3 ? 144000 : 72000) * bitrate) / rate) + ((bytes[2]! >> 1) & 1);
  return { version, rate, length, samples: version === 3 ? 1152 : 576, mono: bytes[3]! >> 6 === 3 };
}
export async function mp3Tracks(r: ImageReader): Promise<TrackMetadata> {
  const tags: TrackTags = {},
    start = await id3(r, tags);
  const tail = await r.readTail128();
  const v1 = tail.length === 128 && ascii(tail, 0, 3) === "TAG";
  if (v1) {
    for (const [key, offset] of [
      ["TITLE", 3],
      ["ARTIST", 33],
      ["ALBUM", 63],
    ] as const)
      textTag(tags, key, ascii(tail, offset, 30));
    if (tail[125] === 0 && tail[126]) tags.trackNumber ??= tail[126];
  }
  const end = r.size - (v1 ? 128 : 0),
    first = frame(await head(r, start, 4));
  let at = start;
  for (let i = 0; i < 3; i++) {
    const f = frame(await head(r, at, 4));
    valid(f.version === first.version && f.rate === first.rate && at + f.length <= end);
    at += f.length;
  }
  const bytes = await head(r, start, first.length),
    d = view(bytes);
  const xing = 4 + (first.version === 3 ? (first.mono ? 17 : 32) : first.mono ? 9 : 17);
  let duration: number | null = null;
  if (xing + 16 <= bytes.length && ["Xing", "Info"].includes(ascii(bytes, xing, 4))) {
    const flags = d.getUint32(xing + 4);
    if ((flags & 3) === 3 && (flags & ~15) === 0) {
      const count = d.getUint32(xing + 8),
        size = d.getUint32(xing + 12);
      // Header counts are usable only when they describe this exact stream extent.
      if (size === end - start && count >= 2 && count <= Math.floor(size / 24))
        duration = durationMs(count * first.samples, first.rate);
    }
  }
  if (duration === null) {
    at = start;
    let count = 0;
    try {
      while (at + 4 <= Math.min(end, AUDIO_HEAD_BYTES) && count < 4096) {
        const f = frame(await head(r, at, 4));
        valid(f.version === first.version && f.rate === first.rate && at + f.length <= end);
        at += f.length;
        count++;
      }
      if (at === end) duration = durationMs(count * first.samples, first.rate);
    } catch (error) {
      if (!(error instanceof ImageFormatError)) throw error;
    }
  }
  return {
    media: { kind: "audio", container: "mp3", codec: "mp3" },
    width: null,
    height: null,
    durationMs: duration,
    ...tags,
  };
}
