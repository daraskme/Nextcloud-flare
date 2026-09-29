import { ascii, type ImageReader, valid, view } from "../images/reader";
import { vorbisComments } from "./audioCommon";
import { TrackBits } from "./bits";
import type { TrackTags } from "./common";

function signature(bytes: Uint8Array, kind: number) {
  valid(bytes.length >= 7 && bytes[0] === kind && ascii(bytes, 1, 6) === "vorbis");
}
export function vorbisIdentification(bytes: Uint8Array) {
  signature(bytes, 1);
  valid(bytes.length === 30);
  const d = view(bytes),
    channels = bytes[11]!,
    rate = d.getUint32(12, true),
    small = bytes[28]! & 15,
    large = bytes[28]! >> 4;
  valid(
    d.getUint32(7, true) === 0 &&
      channels > 0 &&
      rate > 0 &&
      small >= 6 &&
      large <= 13 &&
      small <= large &&
      bytes[29]! & 1,
  );
  return { channels, rate };
}
export function vorbisTags(bytes: Uint8Array, tags: TrackTags, r: ImageReader) {
  signature(bytes, 3);
  const body = bytes.subarray(7);
  const end = vorbisComments(body, tags, r, false);
  valid(end < body.length && body[end]! & 1);
}
const ilog = (value: number) => (value ? Math.floor(Math.log2(value)) + 1 : 0);
/** Validate setup topology without allocating Huffman/VQ tables or decoding any audio. */
export function vorbisSetup(bytes: Uint8Array, channels: number, r: ImageReader) {
  signature(bytes, 5);
  const b = new TrackBits(bytes.subarray(7), true),
    books = b.read(8) + 1;
  const configs: { dimensions: number; entries: number; lookup: number }[] = [];
  let totalEntries = 0;
  for (let i = 0; i < books; i++) {
    r.step();
    valid(b.read(24) === 0x564342);
    const dimensions = b.read(16),
      entries = b.read(24),
      counts = new Array<number>(33).fill(0);
    valid(dimensions > 0 && entries > 0 && (totalEntries += entries) <= 65536);
    if (b.read(1)) {
      let length = b.read(5) + 1,
        current = 0;
      while (current < entries) {
        valid(length <= 32);
        const count = b.read(ilog(entries - current));
        valid(current + count <= entries);
        counts[length++] = count;
        current += count;
      }
    } else {
      const sparse = b.read(1);
      for (let j = 0; j < entries; j++)
        if (!sparse || b.read(1)) {
          const length = b.read(5) + 1;
          counts[length] = counts[length]! + 1;
        }
    }
    let slots = 1,
      used = 0;
    for (let j = 1; j <= 32; j++) {
      slots = slots * 2 - counts[j]!;
      used += counts[j]!;
      valid(slots >= 0);
    }
    valid(used > 0);
    const lookup = b.read(4);
    valid(lookup <= 2);
    if (lookup) {
      b.skip(64);
      const width = b.read(4) + 1;
      b.skip(1);
      let values = entries * dimensions;
      if (lookup === 1) {
        values = Math.floor(entries ** (1 / dimensions));
        while ((values + 1) ** dimensions <= entries) values++;
        while (values ** dimensions > entries) values--;
      }
      b.skip(values * width);
    }
    configs.push({ dimensions, entries, lookup });
  }
  const book = (number: number, vector = false) => {
    valid(number >= 0 && number < books);
    const config = configs[number]!;
    valid(!vector || config.lookup > 0);
    return config;
  };
  const times = b.read(6) + 1;
  for (let i = 0; i < times; i++) {
    r.step();
    valid(b.read(16) === 0);
  }
  const floors = b.read(6) + 1;
  for (let i = 0; i < floors; i++) {
    r.step();
    const type = b.read(16);
    valid(type <= 1);
    if (type === 0) {
      valid(b.read(8) > 0 && b.read(16) > 0 && b.read(16) > 0);
      b.skip(14);
      const count = b.read(4) + 1;
      for (let j = 0; j < count; j++) book(b.read(8), true);
    } else {
      const partitions = b.read(5),
        classes: number[] = [],
        widths: number[] = [];
      for (let j = 0; j < partitions; j++) classes.push(b.read(4));
      for (let j = 0; j <= Math.max(-1, ...classes); j++) {
        widths.push(b.read(3) + 1);
        const subclasses = b.read(2);
        if (subclasses) book(b.read(8));
        for (let k = 0; k < 2 ** subclasses; k++) {
          const index = b.read(8) - 1;
          if (index >= 0) book(index);
        }
      }
      b.skip(2);
      const range = b.read(4),
        points = new Set([0, 2 ** range]);
      for (const cls of classes)
        for (let j = 0; j < widths[cls]!; j++) {
          const point = b.read(range);
          valid(!points.has(point));
          points.add(point);
        }
    }
  }
  const residues = b.read(6) + 1;
  for (let i = 0; i < residues; i++) {
    r.step();
    valid(b.read(16) <= 2);
    const begin = b.read(24),
      end = b.read(24);
    valid(end >= begin);
    b.skip(24);
    const count = b.read(6) + 1,
      cls = book(b.read(8));
    valid(count ** cls.dimensions <= cls.entries);
    const cascade: number[] = [];
    for (let j = 0; j < count; j++) {
      const low = b.read(3);
      cascade.push(low + (b.read(1) ? b.read(5) * 8 : 0));
    }
    for (const passes of cascade)
      for (let j = 0; j < 8; j++) if (passes & (1 << j)) book(b.read(8), true);
  }
  const mappings = b.read(6) + 1;
  for (let i = 0; i < mappings; i++) {
    r.step();
    valid(b.read(16) === 0);
    const submaps = b.read(1) ? b.read(4) + 1 : 1;
    if (b.read(1)) {
      const count = b.read(8) + 1;
      for (let j = 0; j < count; j++) {
        const magnitude = b.read(ilog(channels - 1)),
          angle = b.read(ilog(channels - 1));
        valid(magnitude < channels && angle < channels && magnitude !== angle);
      }
    }
    valid(b.read(2) === 0);
    if (submaps > 1) for (let j = 0; j < channels; j++) valid(b.read(4) < submaps);
    for (let j = 0; j < submaps; j++) {
      b.skip(8);
      valid(b.read(8) < floors && b.read(8) < residues);
    }
  }
  const modes = b.read(6) + 1;
  for (let i = 0; i < modes; i++) {
    r.step();
    b.skip(1);
    valid(b.read(16) === 0 && b.read(16) === 0 && b.read(8) < mappings);
  }
  valid(b.read(1) === 1);
  b.padding();
  return modes;
}
