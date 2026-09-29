import type { MediaDescriptor } from "../../../../shared/src/media";
import { type ImageReader, valid, view } from "../images/reader";
import { TrackBits } from "./bits";

const RATES = [
  96000, 88200, 64000, 48000, 44100, 32000, 24000, 22050, 16000, 12000, 11025, 8000, 7350,
];
function frequency(b: TrackBits) {
  const index = b.read(4),
    rate = index === 15 ? b.read(24) : RATES[index];
  valid(rate !== undefined && rate > 0 && rate <= 768000);
  return rate;
}
function programChannels(b: TrackBits, rate: number) {
  b.skip(4);
  valid(b.read(2) === 1 && RATES[b.read(4)] === rate);
  const front = b.read(4),
    side = b.read(4),
    back = b.read(4),
    lfe = b.read(2),
    associated = b.read(3),
    coupled = b.read(4);
  if (b.read(1)) b.skip(4);
  if (b.read(1)) b.skip(4);
  if (b.read(1)) b.skip(3);
  let channels = lfe;
  for (let i = 0; i < front + side + back; i++) {
    channels += b.read(1) ? 2 : 1;
    b.skip(4);
  }
  b.skip(lfe * 4 + associated * 4 + coupled * 5);
  b.skip((8 - (b.position % 8)) % 8);
  b.skip(b.read(8) * 8);
  valid(channels > 0 && channels <= 32);
  return channels;
}
/** AAC-LC core, explicit or sync-extension SBR/PS; no dependent/encrypted streams. */
export function aacConfiguration(bytes: Uint8Array) {
  valid(bytes.length >= 2 && bytes.length <= 1024);
  const b = new TrackBits(bytes),
    declared = b.read(5),
    coreRate = frequency(b),
    layout = b.read(4);
  let objectType = declared,
    rate = coreRate,
    sbr = declared === 5 || declared === 29,
    ps = declared === 29;
  if (sbr) {
    rate = frequency(b);
    objectType = b.read(5);
  }
  valid(objectType === 2 && layout <= 7);
  b.read(1); // 960/1024 sample frame length does not change the native MIME.
  valid(b.read(1) === 0);
  const extension = b.read(1);
  const channels = layout ? [0, 1, 2, 3, 4, 5, 6, 8][layout]! : programChannels(b, coreRate);
  if (extension) valid(b.read(1) === 0);
  if (!sbr && b.remaining >= 16) {
    valid(b.read(11) === 0x2b7 && b.read(5) === 5);
    sbr = !!b.read(1);
    if (sbr) rate = frequency(b);
    if (b.remaining >= 12) {
      valid(b.read(11) === 0x548);
      ps = !!b.read(1);
    }
  }
  valid(!sbr || rate === coreRate || rate === coreRate * 2);
  valid(!ps || (sbr && channels === 1));
  b.padding();
  const profile: 2 | 5 | 29 = ps ? 29 : sbr ? 5 : 2;
  const media: Extract<MediaDescriptor, { codec: "aac" }> = {
    kind: "audio",
    container: "mp4",
    codec: "aac",
    objectType: profile,
  };
  return { media, channels, outputChannels: ps ? 2 : channels, rate, coreRate };
}
interface Descriptor {
  tag: number;
  start: number;
  end: number;
}
function descriptors(bytes: Uint8Array, start: number, end: number, r: ImageReader) {
  const all: Descriptor[] = [];
  while (start < end) {
    r.step();
    const tag = bytes[start++]!;
    let size = 0,
      finished = false;
    for (let i = 0; i < 4; i++) {
      valid(start < end);
      const byte = bytes[start++]!;
      size = size * 128 + (byte & 127);
      if (!(byte & 128)) {
        finished = true;
        break;
      }
    }
    valid(finished && start + size <= end);
    all.push({ tag, start, end: start + size });
    start += size;
  }
  return all;
}
export function aacEsds(bytes: Uint8Array, r: ImageReader) {
  valid(bytes.length >= 4 && view(bytes).getUint32(0) === 0);
  const root = descriptors(bytes, 4, bytes.length, r);
  valid(root.length === 1 && root[0]!.tag === 3);
  const es = root[0]!;
  valid(es.end - es.start >= 3 && !(bytes[es.start + 2]! & 224));
  const children = descriptors(bytes, es.start + 3, es.end, r);
  valid(children.length === 2 && children[0]!.tag === 4 && children[1]!.tag === 6);
  const decoder = children[0]!,
    sl = children[1]!;
  valid(sl.end - sl.start === 1 && bytes[sl.start] === 2);
  valid(
    decoder.end - decoder.start >= 13 &&
      bytes[decoder.start] === 64 &&
      bytes[decoder.start + 1] === 21,
  );
  const config = descriptors(bytes, decoder.start + 13, decoder.end, r);
  valid(config.length === 1 && config[0]!.tag === 5);
  return aacConfiguration(bytes.subarray(config[0]!.start, config[0]!.end));
}
