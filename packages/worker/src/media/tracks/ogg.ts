import { ascii, type ImageReader, valid, view } from "../images/reader";
import { durationMs, opusConfiguration, type TrackMetadata, type TrackTags, tag } from "./common";
import { commentCover } from "./cover";
import { vorbisIdentification, vorbisSetup, vorbisTags } from "./vorbis";

function crc(bytes: Uint8Array) {
  let sum = 0;
  for (let i = 0; i < bytes.length; i++) {
    sum ^= (i >= 22 && i < 26 ? 0 : bytes[i]!) << 24;
    for (let b = 0; b < 8; b++) sum = (sum << 1) ^ (sum & 0x80000000 ? 0x04c11db7 : 0);
  }
  return sum >>> 0;
}
function comments(bytes: Uint8Array, tags: TrackTags, r: ImageReader) {
  valid(bytes.length >= 16 && ascii(bytes, 0, 8) === "OpusTags");
  const d = view(bytes),
    vendor = d.getUint32(8, true);
  let at = 12 + vendor;
  valid(at + 4 <= bytes.length);
  const count = d.getUint32(at, true);
  at += 4;
  valid(count <= 4096);
  for (let i = 0; i < count; i++) {
    r.step();
    valid(at + 4 <= bytes.length);
    const size = d.getUint32(at, true);
    at += 4;
    valid(at + size <= bytes.length);
    commentCover(bytes.subarray(at, at + size), tags);
    if (size <= 1100) {
      const field = bytes.subarray(at, at + size),
        equals = field.indexOf(61);
      if (equals > 0 && equals <= 64)
        tag(tags, ascii(field, 0, equals), field.subarray(equals + 1));
    }
    at += size;
  }
}

/** Ogg header packets may span pages. Verify lacing, continuation, sequence, serial and CRC. */
export async function oggTracks(r: ImageReader): Promise<TrackMetadata> {
  let at = 0,
    sequence = 0,
    serial: number | undefined,
    continued = false,
    packetBytes = 0,
    packets = 0,
    preSkip = 0,
    rate = 48000,
    channels = 0,
    headers = 2,
    modes = 0;
  let codec: "opus" | "vorbis" = "opus";
  let duration: number | null = null,
    lastGranule = 0n;
  const tags: TrackTags = {};
  let parts: Uint8Array[] = [];
  while (at < r.size) {
    r.step();
    valid(at < 2097152);
    const header = await r.read(at, 27),
      d = view(header);
    valid(ascii(header, 0, 4) === "OggS" && header[4] === 0 && (header[5]! & 0xf8) === 0);
    const flags = header[5]!,
      stream = d.getUint32(14, true),
      number = d.getUint32(18, true);
    valid(number === sequence++ && ((flags & 1) !== 0) === continued);
    if (serial === undefined) {
      valid(flags === 2);
      serial = stream;
    } else valid(stream === serial && !(flags & 2));
    const lacing = await r.read(at + 27, header[26]!);
    const payload = lacing.reduce((n, x) => n + x, 0),
      length = 27 + lacing.length + payload;
    valid(at + length <= Math.min(r.size, 2097152));
    const page = await r.read(at, length);
    valid(crc(page) === d.getUint32(22, true));
    let start = 27 + lacing.length;
    for (const size of lacing) {
      if (packets < headers) {
        r.step();
        valid((packetBytes += size) <= 1048576);
        parts.push(page.subarray(start, start + size));
      } else if (codec === "vorbis" && !continued) {
        valid(size > 0 && !(page[start]! & 1));
        const width = modes === 1 ? 0 : Math.ceil(Math.log2(modes));
        valid(((page[start]! >> 1) & (2 ** width - 1)) < modes);
      }
      start += size;
      continued = size === 255;
      if (!continued) {
        // Once headers are complete, lacing only counts packets; never allocate per sample.
        if (packets < headers) {
          const packet = new Uint8Array(packetBytes);
          let copied = 0;
          for (const part of parts) {
            packet.set(part, copied);
            copied += part.length;
          }
          if (packets === 0) {
            if (ascii(packet, 0, Math.min(8, packet.length)) === "OpusHead") {
              const config = opusConfiguration(packet);
              preSkip = config.preSkip;
            } else {
              const config = vorbisIdentification(packet);
              codec = "vorbis";
              channels = config.channels;
              rate = config.rate;
              headers = 3;
            }
            valid(at === 0 && lacing.length === 1);
          } else if (codec === "opus") comments(packet, tags, r);
          else if (packets === 1) vorbisTags(packet, tags, r);
          else modes = vorbisSetup(packet, channels, r);
          parts = [];
          packetBytes = 0;
        }
        packets++;
      }
    }
    const granule = d.getBigUint64(6, true);
    if (granule !== 0xffffffffffffffffn) {
      valid(granule >= lastGranule);
      lastGranule = granule;
    }
    at += length;
    if (flags & 4) {
      valid(
        at === r.size &&
          !continued &&
          packets > headers &&
          granule !== 0xffffffffffffffffn &&
          granule >= BigInt(preSkip),
      );
      valid(granule <= BigInt(Number.MAX_SAFE_INTEGER));
      duration = durationMs(Number(granule) - preSkip, rate);
      break;
    }
    if (packets >= headers && r.size > 2097152) break;
  }
  valid(packets >= headers && (at < r.size || duration !== null));
  return {
    media: { kind: "audio", container: "ogg", codec },
    width: null,
    height: null,
    durationMs: duration,
    ...tags,
  };
}
