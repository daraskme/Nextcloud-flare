import { ascii, ImageFormatError, type ImageReader, valid, view } from "../images/reader";
import { AUDIO_HEAD_BYTES, head, vorbisComments } from "./audioCommon";
import { durationMs, type TrackMetadata, type TrackTags } from "./common";
import { flacCover } from "./cover";

/** STREAMINFO and bounded display comments, followed by a checked first audio frame header. */
export async function flacTracks(r: ImageReader): Promise<TrackMetadata> {
  valid(ascii(await head(r, 0, 4)) === "fLaC");
  let at = 4,
    info = false,
    comments = false,
    last = false;
  let rate = 0,
    channels = 0,
    bits = 0,
    samples = 0,
    maxBlock = 0;
  const tags: TrackTags = {};
  const pictures: { at: number; size: number }[] = [];
  while (!last) {
    r.step();
    const h = await head(r, at, 4),
      type = h[0]! & 127;
    const size = h[1]! * 65536 + h[2]! * 256 + h[3]!;
    last = !!(h[0]! & 128);
    at += 4;
    valid(type !== 127 && at + size <= Math.min(r.size, AUDIO_HEAD_BYTES));
    if (!info) valid(type === 0);
    if (type === 0) {
      valid(!info && size === 34);
      info = true;
      const b = await head(r, at, size),
        d = view(b);
      maxBlock = d.getUint16(2);
      valid(d.getUint16(0) >= 16 && maxBlock >= d.getUint16(0));
      const minFrame = b[4]! * 65536 + b[5]! * 256 + b[6]!,
        maxFrame = b[7]! * 65536 + b[8]! * 256 + b[9]!;
      valid(!minFrame || !maxFrame || minFrame <= maxFrame);
      const packed = d.getBigUint64(10);
      rate = Number(packed >> 44n);
      channels = Number((packed >> 41n) & 7n) + 1;
      bits = Number((packed >> 36n) & 31n) + 1;
      samples = Number(packed & 0xfffffffffn);
      valid(rate > 0 && bits >= 4);
    } else if (type === 4) {
      valid(!comments);
      comments = true;
      vorbisComments(await head(r, at, size), tags, r);
    } else if (type === 6) pictures.push({ at, size });
    at += size;
  }
  const b = await head(r, at, Math.min(32, r.size - at)),
    d = view(b);
  valid(b.length >= 6 && b[0] === 255 && (b[1]! & 254) === 248 && b[4] === 0);
  const block = b[2]! >> 4,
    sr = b[2]! & 15,
    channel = b[3]! >> 4,
    depth = (b[3]! >> 1) & 7;
  valid(block > 0 && sr < 15 && channel <= 10 && !(b[3]! & 1) && depth !== 3);
  valid((channel < 8 ? channel + 1 : 2) === channels);
  valid([bits, 8, 12, 0, 16, 20, 24, 32][depth] === bits);
  let p = 5;
  const take = (n: number) => {
    valid(p + n < b.length);
    const value = n === 1 ? b[p]! : d.getUint16(p);
    p += n;
    return value;
  };
  const blockSamples =
    block === 1
      ? 192
      : block < 6
        ? 576 * 2 ** (block - 2)
        : block === 6
          ? take(1) + 1
          : block === 7
            ? take(2) + 1
            : 256 * 2 ** (block - 8);
  valid(blockSamples <= maxBlock && (!samples || blockSamples <= samples));
  const frameRate =
    sr < 12
      ? [rate, 88200, 176400, 192000, 8000, 16000, 22050, 24000, 32000, 44100, 48000, 96000][sr]
      : sr === 12
        ? take(1) * 1000
        : take(2) * (sr === 14 ? 10 : 1);
  valid(frameRate === rate);
  let crc = 0;
  for (const byte of b.subarray(0, p)) {
    crc ^= byte;
    for (let i = 0; i < 8; i++) crc = ((crc << 1) ^ (crc & 128 ? 7 : 0)) & 255;
  }
  valid(b[p] === crc && at + p + 3 < r.size);
  // Spend only the remaining inspection budget after the audio identity is proven.
  for (const picture of pictures) {
    if (tags.cover?.type === 3) break;
    try {
      flacCover(await head(r, picture.at, picture.size), tags);
    } catch (error) {
      if (error instanceof ImageFormatError) break;
      throw error;
    }
  }
  return {
    media: { kind: "audio", container: "flac", codec: "flac" },
    width: null,
    height: null,
    durationMs: samples ? durationMs(samples, rate) : null,
    ...tags,
  };
}
