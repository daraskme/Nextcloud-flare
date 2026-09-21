const FIELD_LIMIT = 1024;
const COVER_LIMIT = 20_000_000;

export interface AudioCover {
  mime: "image/jpeg" | "image/png" | "image/webp";
  bytes: Uint8Array;
}

export interface AudioMetadata {
  title: string | null;
  artist: string | null;
  album: string | null;
  trackNo: number | null;
  discNo: number | null;
  durationMs: number | null;
  codec: string;
  bitrate: number | null;
  cover: AudioCover | null;
}

export interface AudioParseInput {
  name: string;
  size: number;
  head: Uint8Array;
  tail: Uint8Array;
  mp4Window?: Uint8Array;
}

function u16be(bytes: Uint8Array, offset: number): number {
  if (offset < 0 || offset + 2 > bytes.byteLength) throw new Error("audio_metadata_truncated");
  return new DataView(bytes.buffer, bytes.byteOffset + offset, 2).getUint16(0, false);
}

function u24be(bytes: Uint8Array, offset: number): number {
  if (offset < 0 || offset + 3 > bytes.byteLength) throw new Error("audio_metadata_truncated");
  return ((bytes[offset] ?? 0) << 16) | ((bytes[offset + 1] ?? 0) << 8) | (bytes[offset + 2] ?? 0);
}

function u32be(bytes: Uint8Array, offset: number): number {
  if (offset < 0 || offset + 4 > bytes.byteLength) throw new Error("audio_metadata_truncated");
  return new DataView(bytes.buffer, bytes.byteOffset + offset, 4).getUint32(0, false);
}

function u32le(bytes: Uint8Array, offset: number): number {
  if (offset < 0 || offset + 4 > bytes.byteLength) throw new Error("audio_metadata_truncated");
  return new DataView(bytes.buffer, bytes.byteOffset + offset, 4).getUint32(0, true);
}

function safeBigInt(value: bigint): number | null {
  return value <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(value) : null;
}

function ascii(bytes: Uint8Array, offset: number, length: number): string {
  if (offset < 0 || offset + length > bytes.byteLength) return "";
  return String.fromCharCode(...bytes.subarray(offset, offset + length));
}

function find(bytes: Uint8Array, needle: string, start = 0): number {
  const target = Array.from(needle, (character) => character.charCodeAt(0));
  outer: for (let offset = start; offset + target.length <= bytes.byteLength; offset += 1) {
    for (let index = 0; index < target.length; index += 1) {
      if (bytes[offset + index] !== target[index]) continue outer;
    }
    return offset;
  }
  return -1;
}

function field(value: string): string | null {
  const normalized = value.replaceAll("\u0000", "").trim().normalize("NFC");
  if (normalized === "") return null;
  return Array.from(normalized).slice(0, FIELD_LIMIT).join("");
}

function numberField(value: string | null): number | null {
  if (value === null) return null;
  const number = Number(/^\s*(\d{1,6})/u.exec(value)?.[1]);
  return Number.isSafeInteger(number) && number >= 0 ? number : null;
}

function decodeUtf16Be(bytes: Uint8Array): string {
  const swapped = new Uint8Array(bytes.byteLength - (bytes.byteLength % 2));
  for (let index = 0; index < swapped.byteLength; index += 2) {
    swapped[index] = bytes[index + 1] ?? 0;
    swapped[index + 1] = bytes[index] ?? 0;
  }
  return new TextDecoder("utf-16le").decode(swapped);
}

function decodeId3Text(bytes: Uint8Array): string | null {
  if (bytes.byteLength < 2) return null;
  const encoding = bytes[0];
  const content = bytes.subarray(1);
  try {
    if (encoding === 0) {
      return field(new TextDecoder("windows-1252").decode(content));
    }
    if (encoding === 1) {
      if (content[0] === 0xff && content[1] === 0xfe) {
        return field(new TextDecoder("utf-16le").decode(content.subarray(2)));
      }
      if (content[0] === 0xfe && content[1] === 0xff)
        return field(decodeUtf16Be(content.subarray(2)));
      return field(new TextDecoder("utf-16le").decode(content));
    }
    if (encoding === 2) return field(decodeUtf16Be(content));
    if (encoding === 3) return field(new TextDecoder("utf-8", { fatal: true }).decode(content));
  } catch {
    return null;
  }
  return null;
}

function synchsafe(bytes: Uint8Array, offset: number): number {
  if (offset < 0 || offset + 4 > bytes.byteLength) throw new Error("audio_metadata_truncated");
  const values = bytes.subarray(offset, offset + 4);
  if (values.some((value) => value > 0x7f)) throw new Error("id3_size_invalid");
  return (
    ((values[0] ?? 0) << 21) | ((values[1] ?? 0) << 14) | ((values[2] ?? 0) << 7) | (values[3] ?? 0)
  );
}

function id3Cover(frame: Uint8Array): AudioCover | null {
  if (frame.byteLength < 8) return null;
  const encoding = frame[0] ?? 0;
  const mimeEnd = frame.indexOf(0, 1);
  if (mimeEnd < 2) return null;
  const mimeValue = ascii(frame, 1, mimeEnd - 1).toLowerCase();
  const mime = mimeValue.includes("png") ? "image/png" : "image/jpeg";
  let cursor = mimeEnd + 2;
  if (encoding === 0 || encoding === 3) {
    const end = frame.indexOf(0, cursor);
    cursor = end < 0 ? frame.byteLength : end + 1;
  } else {
    while (cursor + 1 < frame.byteLength) {
      if (frame[cursor] === 0 && frame[cursor + 1] === 0) {
        cursor += 2;
        break;
      }
      cursor += 2;
    }
  }
  const bytes = frame.subarray(cursor);
  return bytes.byteLength > 0 && bytes.byteLength <= COVER_LIMIT ? { mime, bytes } : null;
}

function mp3Metadata(input: AudioParseInput): AudioMetadata {
  const bytes = input.head;
  let cursor = 0;
  let title: string | null = null;
  let artist: string | null = null;
  let album: string | null = null;
  let track: string | null = null;
  let disc: string | null = null;
  let cover: AudioCover | null = null;
  if (ascii(bytes, 0, 3) === "ID3") {
    const version = bytes[3] ?? 0;
    const tagSize = synchsafe(bytes, 6);
    if (tagSize > 2 * 1024 * 1024 || tagSize + 10 > bytes.byteLength) {
      throw new Error("id3_size_invalid");
    }
    cursor = 10;
    const end = 10 + tagSize;
    while (cursor + 10 <= end) {
      const id = ascii(bytes, cursor, 4);
      if (!/^[A-Z0-9]{4}$/u.test(id)) break;
      const size = version === 4 ? synchsafe(bytes, cursor + 4) : u32be(bytes, cursor + 4);
      if (size < 1 || cursor + 10 + size > end) throw new Error("id3_frame_invalid");
      const value = bytes.subarray(cursor + 10, cursor + 10 + size);
      if (id === "TIT2") title = decodeId3Text(value);
      else if (id === "TPE1") artist = decodeId3Text(value);
      else if (id === "TALB") album = decodeId3Text(value);
      else if (id === "TRCK") track = decodeId3Text(value);
      else if (id === "TPOS") disc = decodeId3Text(value);
      else if (id === "APIC") cover = id3Cover(value);
      cursor += 10 + size;
    }
    cursor = end;
  }
  let bitrate: number | null = null;
  for (let offset = cursor; offset + 4 <= bytes.byteLength; offset += 1) {
    const header = u32be(bytes, offset);
    if (header >>> 21 !== 0x7ff) continue;
    const version = (header >>> 19) & 0x3;
    const layer = (header >>> 17) & 0x3;
    const bitrateIndex = (header >>> 12) & 0xf;
    if (version !== 3 || layer !== 1 || bitrateIndex < 1 || bitrateIndex > 14) continue;
    const bitrates = [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320];
    bitrate = (bitrates[bitrateIndex] ?? 0) * 1000;
    break;
  }
  const durationMs =
    bitrate === null || bitrate === 0 ? null : Math.round((input.size * 8 * 1000) / bitrate);
  return {
    title,
    artist,
    album,
    trackNo: numberField(track),
    discNo: numberField(disc),
    durationMs,
    codec: "mp3",
    bitrate,
    cover,
  };
}

interface VorbisFields {
  title: string | null;
  artist: string | null;
  album: string | null;
  trackNo: number | null;
  discNo: number | null;
  picture: string | null;
}

function vorbisComments(bytes: Uint8Array, offset: number): VorbisFields {
  const empty: VorbisFields = {
    title: null,
    artist: null,
    album: null,
    trackNo: null,
    discNo: null,
    picture: null,
  };
  if (offset + 8 > bytes.byteLength) return empty;
  const vendorLength = u32le(bytes, offset);
  let cursor = offset + 4 + vendorLength;
  if (cursor + 4 > bytes.byteLength) return empty;
  const count = Math.min(u32le(bytes, cursor), 1024);
  cursor += 4;
  const values = new Map<string, string>();
  for (let index = 0; index < count; index += 1) {
    if (cursor + 4 > bytes.byteLength) break;
    const length = u32le(bytes, cursor);
    cursor += 4;
    if (length > 64 * 1024 || cursor + length > bytes.byteLength) break;
    const value = new TextDecoder().decode(bytes.subarray(cursor, cursor + length));
    cursor += length;
    const separator = value.indexOf("=");
    if (separator > 0)
      values.set(value.slice(0, separator).toUpperCase(), value.slice(separator + 1));
  }
  return {
    title: field(values.get("TITLE") ?? ""),
    artist: field(values.get("ARTIST") ?? ""),
    album: field(values.get("ALBUM") ?? ""),
    trackNo: numberField(field(values.get("TRACKNUMBER") ?? "")),
    discNo: numberField(field(values.get("DISCNUMBER") ?? "")),
    picture: values.get("METADATA_BLOCK_PICTURE") ?? null,
  };
}

function flacPicture(bytes: Uint8Array): AudioCover | null {
  if (bytes.byteLength < 32) return null;
  let cursor = 4;
  const mimeLength = u32be(bytes, cursor);
  cursor += 4;
  if (mimeLength > 128 || cursor + mimeLength + 4 > bytes.byteLength) return null;
  const mimeValue = ascii(bytes, cursor, mimeLength).toLowerCase();
  cursor += mimeLength;
  const descriptionLength = u32be(bytes, cursor);
  cursor += 4 + descriptionLength;
  if (cursor + 20 > bytes.byteLength) return null;
  cursor += 16;
  const length = u32be(bytes, cursor);
  cursor += 4;
  if (length < 1 || length > COVER_LIMIT || cursor + length > bytes.byteLength) return null;
  const mime = mimeValue.includes("png") ? "image/png" : "image/jpeg";
  return { mime, bytes: bytes.subarray(cursor, cursor + length) };
}

function flacMetadata(input: AudioParseInput): AudioMetadata {
  const bytes = input.head;
  if (ascii(bytes, 0, 4) !== "fLaC") throw new Error("unsupported_format");
  let cursor = 4;
  let durationMs: number | null = null;
  let comments: VorbisFields = vorbisComments(new Uint8Array(), 0);
  let cover: AudioCover | null = null;
  while (cursor + 4 <= bytes.byteLength) {
    const marker = bytes[cursor] ?? 0;
    const last = (marker & 0x80) !== 0;
    const type = marker & 0x7f;
    const length = u24be(bytes, cursor + 1);
    cursor += 4;
    if (length > 2 * 1024 * 1024 || cursor + length > bytes.byteLength) {
      throw new Error("flac_metadata_invalid");
    }
    const block = bytes.subarray(cursor, cursor + length);
    if (type === 0 && block.byteLength >= 18) {
      const packed = new DataView(block.buffer, block.byteOffset + 10, 8).getBigUint64(0, false);
      const sampleRate = Number((packed >> 44n) & 0xfffffn);
      const totalSamples = safeBigInt(packed & 0xfffffffffn);
      if (sampleRate > 0 && totalSamples !== null)
        durationMs = Math.round((totalSamples * 1000) / sampleRate);
    } else if (type === 4) comments = vorbisComments(block, 0);
    else if (type === 6) cover = flacPicture(block);
    cursor += length;
    if (last) break;
  }
  const bitrate =
    durationMs === null || durationMs === 0
      ? null
      : Math.round((input.size * 8 * 1000) / durationMs);
  return { ...comments, durationMs, codec: "flac", bitrate, cover };
}

function base64Picture(value: string | null): AudioCover | null {
  if (value === null || value.length > 8 * 1024 * 1024) return null;
  try {
    const binary = atob(value);
    const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
    return flacPicture(bytes);
  } catch {
    return null;
  }
}

function lastOggGranule(bytes: Uint8Array): number | null {
  for (let offset = bytes.byteLength - 27; offset >= 0; offset -= 1) {
    if (ascii(bytes, offset, 4) !== "OggS") continue;
    const value = new DataView(bytes.buffer, bytes.byteOffset + offset + 6, 8).getBigUint64(
      0,
      true,
    );
    return safeBigInt(value);
  }
  return null;
}

function oggMetadata(input: AudioParseInput): AudioMetadata {
  const opusHead = find(input.head, "OpusHead");
  const opusTags = find(input.head, "OpusTags");
  const vorbisHead = find(input.head, String.fromCharCode(1) + "vorbis");
  const vorbisTags = find(input.head, String.fromCharCode(3) + "vorbis");
  const opus = opusHead >= 0;
  if (!opus && vorbisHead < 0) throw new Error("unsupported_format");
  const comments = opus
    ? vorbisComments(input.head, opusTags < 0 ? input.head.byteLength : opusTags + 8)
    : vorbisComments(input.head, vorbisTags < 0 ? input.head.byteLength : vorbisTags + 7);
  const sampleRate = opus ? 48_000 : u32le(input.head, vorbisHead + 12);
  const granule = lastOggGranule(input.tail);
  const durationMs =
    granule === null || sampleRate <= 0 ? null : Math.round((granule * 1000) / sampleRate);
  const bitrate =
    durationMs === null || durationMs === 0
      ? null
      : Math.round((input.size * 8 * 1000) / durationMs);
  return {
    ...comments,
    durationMs,
    codec: opus ? "opus" : "vorbis",
    bitrate,
    cover: base64Picture(comments.picture),
  };
}

interface Atom {
  type: string;
  payload: number;
  end: number;
  parent: string | null;
}

const containers = new Set(["moov", "udta", "meta", "ilst", "trak", "mdia", "minf", "stbl"]);

function atoms(bytes: Uint8Array): Atom[] {
  const result: Atom[] = [];
  const walk = (start: number, end: number, parent: string | null, depth: number): void => {
    if (depth > 12) throw new Error("mp4_atom_depth");
    let cursor = start;
    while (cursor + 8 <= end) {
      let size = u32be(bytes, cursor);
      const type = ascii(bytes, cursor + 4, 4);
      let header = 8;
      if (size === 1) {
        if (cursor + 16 > end) throw new Error("mp4_atom_invalid");
        const wide = new DataView(bytes.buffer, bytes.byteOffset + cursor + 8, 8).getBigUint64(
          0,
          false,
        );
        const safe = safeBigInt(wide);
        if (safe === null) throw new Error("mp4_atom_invalid");
        size = safe;
        header = 16;
      } else if (size === 0) size = end - cursor;
      if (size < header || cursor + size > end) throw new Error("mp4_atom_invalid");
      const payload = cursor + header;
      const atom = { type, payload, end: cursor + size, parent };
      result.push(atom);
      if (containers.has(type))
        walk(type === "meta" ? payload + 4 : payload, atom.end, type, depth + 1);
      cursor += size;
    }
  };
  walk(0, bytes.byteLength, null, 0);
  return result;
}

function mp4Text(bytes: Uint8Array, atom: Atom): string | null {
  const data = atoms(bytes.subarray(atom.payload, atom.end)).find((child) => child.type === "data");
  if (data === undefined || data.payload + 8 > data.end) return null;
  return field(
    new TextDecoder().decode(
      bytes.subarray(atom.payload + data.payload + 8, atom.payload + data.end),
    ),
  );
}

function mp4Data(bytes: Uint8Array, atom: Atom): Uint8Array | null {
  const nested = bytes.subarray(atom.payload, atom.end);
  const data = atoms(nested).find((child) => child.type === "data");
  return data === undefined || data.payload + 8 > data.end
    ? null
    : nested.subarray(data.payload + 8, data.end);
}

function mp4Metadata(input: AudioParseInput): AudioMetadata {
  const bytes = input.mp4Window ?? input.head;
  const parsed = atoms(bytes);
  let durationMs: number | null = null;
  const mvhd = parsed.find((atom) => atom.type === "mvhd");
  if (mvhd !== undefined) {
    const version = bytes[mvhd.payload] ?? 0;
    if (version === 0 && mvhd.payload + 20 <= mvhd.end) {
      const timescale = u32be(bytes, mvhd.payload + 12);
      const duration = u32be(bytes, mvhd.payload + 16);
      if (timescale > 0) durationMs = Math.round((duration * 1000) / timescale);
    } else if (version === 1 && mvhd.payload + 32 <= mvhd.end) {
      const timescale = u32be(bytes, mvhd.payload + 20);
      const duration = safeBigInt(
        new DataView(bytes.buffer, bytes.byteOffset + mvhd.payload + 24, 8).getBigUint64(0, false),
      );
      if (timescale > 0 && duration !== null)
        durationMs = Math.round((duration * 1000) / timescale);
    }
  }
  const tag = (type: string) => parsed.find((atom) => atom.parent === "ilst" && atom.type === type);
  const titleAtom = tag("©nam");
  const artistAtom = tag("©ART") ?? tag("aART");
  const albumAtom = tag("©alb");
  const trackData = tag("trkn");
  const discData = tag("disk");
  const coverAtom = tag("covr");
  const coverBytes = coverAtom === undefined ? null : mp4Data(bytes, coverAtom);
  const cover: AudioCover | null =
    coverBytes === null || coverBytes.byteLength > COVER_LIMIT
      ? null
      : {
          mime: coverBytes[0] === 0x89 ? "image/png" : "image/jpeg",
          bytes: coverBytes,
        };
  const trackBytes = trackData === undefined ? null : mp4Data(bytes, trackData);
  const discBytes = discData === undefined ? null : mp4Data(bytes, discData);
  const codec = find(bytes, "alac") >= 0 ? "alac" : find(bytes, "Opus") >= 0 ? "opus" : "aac";
  const bitrate =
    durationMs === null || durationMs === 0
      ? null
      : Math.round((input.size * 8 * 1000) / durationMs);
  return {
    title: titleAtom === undefined ? null : mp4Text(bytes, titleAtom),
    artist: artistAtom === undefined ? null : mp4Text(bytes, artistAtom),
    album: albumAtom === undefined ? null : mp4Text(bytes, albumAtom),
    trackNo: trackBytes === null || trackBytes.byteLength < 4 ? null : u16be(trackBytes, 2),
    discNo: discBytes === null || discBytes.byteLength < 4 ? null : u16be(discBytes, 2),
    durationMs,
    codec,
    bitrate,
    cover,
  };
}

function wavMetadata(input: AudioParseInput): AudioMetadata {
  const bytes = input.head;
  if (ascii(bytes, 0, 4) !== "RIFF" || ascii(bytes, 8, 4) !== "WAVE") {
    throw new Error("unsupported_format");
  }
  let cursor = 12;
  let byteRate = 0;
  let dataSize = 0;
  let codec = "pcm";
  let title: string | null = null;
  let artist: string | null = null;
  let album: string | null = null;
  let trackNo: number | null = null;
  while (cursor + 8 <= bytes.byteLength) {
    const type = ascii(bytes, cursor, 4);
    const size = u32le(bytes, cursor + 4);
    const start = cursor + 8;
    const end = start + size;
    if (end > bytes.byteLength) break;
    if (type === "fmt " && size >= 16) {
      const format = new DataView(bytes.buffer, bytes.byteOffset + start, 2).getUint16(0, true);
      byteRate = u32le(bytes, start + 8);
      codec = format === 1 ? "pcm" : format === 3 ? "ieee-float" : `wav-${format}`;
    } else if (type === "data") dataSize = size;
    else if (type === "LIST" && ascii(bytes, start, 4) === "INFO") {
      let info = start + 4;
      while (info + 8 <= end) {
        const key = ascii(bytes, info, 4);
        const length = u32le(bytes, info + 4);
        const value = field(new TextDecoder().decode(bytes.subarray(info + 8, info + 8 + length)));
        if (key === "INAM") title = value;
        else if (key === "IART") artist = value;
        else if (key === "IPRD") album = value;
        else if (key === "ITRK") trackNo = numberField(value);
        info += 8 + length + (length % 2);
      }
    }
    cursor = end + (size % 2);
  }
  const durationMs = byteRate > 0 && dataSize > 0 ? Math.round((dataSize * 1000) / byteRate) : null;
  return {
    title,
    artist,
    album,
    trackNo,
    discNo: null,
    durationMs,
    codec,
    bitrate: byteRate > 0 ? byteRate * 8 : null,
    cover: null,
  };
}

export function parseAudioMetadata(input: AudioParseInput): AudioMetadata {
  if (
    !Number.isSafeInteger(input.size) ||
    input.size < 1 ||
    input.head.byteLength > 4 * 1024 * 1024
  ) {
    throw new Error("audio_input_invalid");
  }
  const ext = input.name.slice(input.name.lastIndexOf(".") + 1).toLowerCase();
  if (ascii(input.head, 0, 3) === "ID3" || ext === "mp3") return mp3Metadata(input);
  if (ascii(input.head, 0, 4) === "fLaC" || ext === "flac") return flacMetadata(input);
  if (ascii(input.head, 0, 4) === "OggS" || ext === "ogg" || ext === "opus") {
    return oggMetadata(input);
  }
  if (ascii(input.head, 0, 4) === "RIFF" || ext === "wav") return wavMetadata(input);
  if (["m4a", "mp4", "m4b"].includes(ext) || find(input.head, "ftyp") >= 0) {
    return mp4Metadata(input);
  }
  throw new Error("unsupported_format");
}

export const audioLimits = {
  headBytes: 2 * 1024 * 1024,
  tailBytes: 128,
  mp4WindowBytes: 4 * 1024 * 1024,
  coverBytes: COVER_LIMIT,
  fieldScalars: FIELD_LIMIT,
} as const;
