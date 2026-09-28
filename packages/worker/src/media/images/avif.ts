import { av1CodecString } from "@next-cloud-flare/shared/media";
import { ascii, ImageReader, valid, view } from "./reader";

interface Box {
  type: string;
  start: number;
  end: number;
}
function boxes(bytes: Uint8Array, start: number, end: number, reader: ImageReader) {
  const result: Box[] = [],
    data = view(bytes);
  for (let at = start; at < end; ) {
    reader.step();
    valid(at + 8 <= end);
    let size = data.getUint32(at),
      header = 8;
    if (size === 1) {
      valid(at + 16 <= end);
      const wide = data.getBigUint64(at + 8);
      valid(wide <= BigInt(end - at));
      size = Number(wide);
      header = 16;
    }
    if (size === 0) size = end - at;
    valid(size >= header && at + size <= end);
    result.push({ type: ascii(bytes, at + 4, 4), start: at + header, end: at + size });
    at += size;
  }
  return result;
}
function one(list: Box[], type: string) {
  const found = list.filter((b) => b.type === type);
  valid(found.length === 1);
  return found[0]!;
}
const transforms = [
  [1, 0, 0, 1],
  [-1, 0, 0, 1],
  [-1, 0, 0, -1],
  [1, 0, 0, -1],
  [0, 1, 1, 0],
  [0, -1, 1, 0],
  [0, -1, -1, 0],
  [0, 1, -1, 0],
];
function compose(a: number[], b: number[]) {
  return [
    a[0]! * b[0]! + a[1]! * b[2]!,
    a[0]! * b[1]! + a[1]! * b[3]!,
    a[2]! * b[0]! + a[3]! * b[2]!,
    a[2]! * b[1]! + a[3]! * b[3]!,
  ];
}

/** Select the primary item's properties, never an arbitrary ispe belonging to a thumbnail/alpha. */
export async function avifDimensions(reader: ImageReader) {
  let metadata: Uint8Array | undefined;
  for (let at = 0; at < reader.size; ) {
    reader.step();
    const head = await reader.read(at, 8),
      data = view(head);
    let size = data.getUint32(0),
      header = 8;
    if (size === 1) {
      const wide = view(await reader.read(at + 8, 8)).getBigUint64(0);
      valid(wide <= BigInt(reader.size - at));
      size = Number(wide);
      header = 16;
    }
    if (size === 0) size = reader.size - at;
    valid(size >= header && at + size <= reader.size);
    if (ascii(head, 4, 4) === "meta") {
      valid(!metadata && size - header <= 1024 * 1024);
      metadata = await reader.read(at + header, size - header);
    }
    at += size;
  }
  valid(metadata && metadata.length >= 4 && view(metadata).getUint32(0) === 0);
  const bytes = metadata,
    data = view(bytes),
    all = boxes(bytes, 4, bytes.length, reader);
  const pitm = one(all, "pitm"),
    pv = bytes[pitm.start];
  valid((pv === 0 || pv === 1) && pitm.end - pitm.start === (pv === 0 ? 6 : 8));
  valid((data.getUint32(pitm.start) & 0xffffff) === 0);
  const primary = pv === 0 ? data.getUint16(pitm.start + 4) : data.getUint32(pitm.start + 4);
  const iinf = one(all, "iinf"),
    iv = bytes[iinf.start];
  valid(iinf.end - iinf.start >= 6 && (iv === 0 || iv === 1));
  valid((data.getUint32(iinf.start) & 0xffffff) === 0);
  const entries = boxes(bytes, iinf.start + (iv === 0 ? 6 : 8), iinf.end, reader);
  valid(
    entries.length === (iv === 0 ? data.getUint16(iinf.start + 4) : data.getUint32(iinf.start + 4)),
  );
  const items = new Map<number, string>();
  for (const entry of entries) {
    const version = bytes[entry.start],
      base = version === 2 ? 2 : 4;
    valid(
      entry.type === "infe" &&
        (version === 2 || version === 3) &&
        entry.end - entry.start >= 4 + base + 7,
    );
    const id = base === 2 ? data.getUint16(entry.start + 4) : data.getUint32(entry.start + 4);
    valid(!items.has(id) && data.getUint16(entry.start + 4 + base) === 0);
    items.set(id, ascii(bytes, entry.start + 6 + base, 4));
  }
  const iprp = one(all, "iprp"),
    props = boxes(bytes, iprp.start, iprp.end, reader);
  const ipco = one(props, "ipco"),
    properties = boxes(bytes, ipco.start, ipco.end, reader);
  const associated = new Map<number, Box[]>();
  valid(props.some((p) => p.type === "ipma"));
  for (const ipma of props.filter((p) => p.type === "ipma")) {
    valid(ipma.end - ipma.start >= 8);
    const flags = data.getUint32(ipma.start),
      version = flags >>> 24;
    valid(version <= 1 && (flags & 0xfffffe) === 0);
    let at = ipma.start + 8;
    const count = data.getUint32(ipma.start + 4);
    valid(count <= 4096);
    for (let n = 0; n < count; n++) {
      reader.step();
      valid(at + (version === 0 ? 3 : 5) <= ipma.end);
      const id = version === 0 ? data.getUint16(at) : data.getUint32(at);
      at += version === 0 ? 2 : 4;
      const length = bytes[at++]!,
        list: Box[] = [];
      valid(items.has(id) && !associated.has(id));
      for (let p = 0; p < length; p++) {
        const wide = (flags & 1) !== 0;
        valid(at + (wide ? 2 : 1) <= ipma.end);
        const index = wide ? data.getUint16(at) & 0x7fff : bytes[at]! & 0x7f;
        at += wide ? 2 : 1;
        if (index === 0) continue;
        valid(index <= properties.length && !list.includes(properties[index - 1]!));
        list.push(properties[index - 1]!);
      }
      associated.set(id, list);
    }
    valid(at === ipma.end);
  }
  const checkAv1 = (id: number) => {
    valid(items.get(id) === "av01");
    const config = one(associated.get(id) ?? [], "av1C");
    valid(config.end - config.start >= 4 && bytes[config.start] === 0x81);
    const p = bytes[config.start + 1]!,
      q = bytes[config.start + 2]!;
    valid((q & 0x20) === 0 || ((q & 0x40) !== 0 && p >>> 5 === 2));
    try {
      av1CodecString({
        profile: (p >>> 5) as 0 | 1 | 2,
        level: p & 31,
        tier: q & 128 ? "H" : "M",
        bitDepth: q & 32 ? 12 : q & 64 ? 10 : 8,
      });
    } catch {
      valid(false);
    }
  };
  if (items.get(primary) === "grid") {
    const iref = one(all, "iref"),
      version = bytes[iref.start];
    valid(iref.end - iref.start >= 4 && (version === 0 || version === 1));
    const width = version === 0 ? 2 : 4;
    const uint = (at: number) => (width === 2 ? data.getUint16(at) : data.getUint32(at));
    const links = boxes(bytes, iref.start + 4, iref.end, reader).filter((b) => b.type === "dimg");
    const match = links.filter((b) => {
      valid(b.end - b.start >= width + 2);
      return uint(b.start) === primary;
    });
    valid(match.length === 1);
    const link = match[0]!,
      count = data.getUint16(link.start + width);
    valid(count > 0 && count <= 256 && link.end - link.start === width + 2 + count * width);
    for (let i = 0; i < count; i++) checkAv1(uint(link.start + width + 2 + i * width));
  } else checkAv1(primary);
  const primaryProps = associated.get(primary) ?? [],
    ispe = one(primaryProps, "ispe");
  valid(ispe.end - ispe.start === 12 && data.getUint32(ispe.start) === 0);
  let transform = transforms[0]!;
  const seen = new Set<string>();
  for (const p of primaryProps) {
    if (p.type !== "irot" && p.type !== "imir") continue;
    valid(!seen.has(p.type) && p.end - p.start === 1);
    seen.add(p.type);
    const value = bytes[p.start]!;
    valid(value <= (p.type === "irot" ? 3 : 1));
    transform = compose(
      p.type === "irot" ? transforms[[0, 7, 2, 5][value]!]! : transforms[value === 0 ? 1 : 3]!,
      transform,
    );
  }
  return {
    width: data.getUint32(ispe.start + 4),
    height: data.getUint32(ispe.start + 8),
    orientation: transforms.findIndex((m) => m.every((n, i) => n === transform[i])) + 1,
  };
}
