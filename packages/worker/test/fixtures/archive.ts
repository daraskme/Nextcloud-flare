import { deflateSync } from "fflate";
import type { ArchiveSource } from "../../src/media/archive/index";

export const archiveText = new TextEncoder().encode("123456789");

export function fixtureCrc(bytes: Uint8Array): number {
  let value = -1;
  for (const byte of bytes) {
    value ^= byte;
    for (let bit = 0; bit < 8; bit++) value = (value >>> 1) ^ (value & 1 ? 0xedb88320 : 0);
  }
  return (value ^ -1) >>> 0;
}

export function concat(...parts: Uint8Array[]): Uint8Array {
  const result = new Uint8Array(parts.reduce((n, part) => n + part.length, 0));
  let at = 0;
  for (const part of parts) {
    result.set(part, at);
    at += part.length;
  }
  return result;
}

export function extra(id: number, content: Uint8Array): Uint8Array {
  const bytes = new Uint8Array(content.length + 4),
    view = new DataView(bytes.buffer);
  view.setUint16(0, id, true);
  view.setUint16(2, content.length, true);
  bytes.set(content, 4);
  return bytes;
}

export interface ArchiveFixtureEntry {
  name?: string;
  rawName?: Uint8Array;
  content?: Uint8Array;
  compressed?: Uint8Array;
  method?: number;
  flags?: number;
  zip64?: boolean;
  descriptor?: "signed" | "unsigned";
  size?: number;
  extra?: Uint8Array;
  crc?: number;
}

export function archiveFixture(items: ArchiveFixtureEntry[] = [{}], zip64End = false) {
  const locals: Uint8Array[] = [],
    centrals: Uint8Array[] = [];
  const offsets: { local: number; central: number; data: number; descriptor: number }[] = [];
  let offset = 0,
    centralAt = 0;
  for (const item of items) {
    const raw = item.rawName ?? new TextEncoder().encode(item.name ?? "page1.jpg"),
      content = item.content ?? archiveText;
    const method = item.method ?? 0,
      compressed = item.compressed ?? (method === 8 ? deflateSync(content) : content);
    const flags = (item.flags ?? 0x800) | (item.descriptor ? 8 : 0),
      size = item.size ?? content.length;
    const crc = item.crc ?? fixtureCrc(content),
      version = item.zip64 ? 45 : 20;
    const z64 = new Uint8Array(24),
      zv = new DataView(z64.buffer);
    zv.setBigUint64(0, BigInt(size), true);
    zv.setBigUint64(8, BigInt(compressed.length), true);
    zv.setBigUint64(16, BigInt(offset), true);
    const le = concat(
      item.zip64 ? extra(1, z64.subarray(0, 16)) : new Uint8Array(),
      item.extra ?? new Uint8Array(),
    );
    const ce = concat(
      item.zip64 ? extra(1, z64) : new Uint8Array(),
      item.extra ?? new Uint8Array(),
    );
    const local = new Uint8Array(30 + raw.length + le.length),
      lv = new DataView(local.buffer);
    lv.setUint32(0, 0x04034b50, true);
    lv.setUint16(4, version, true);
    lv.setUint16(6, flags, true);
    lv.setUint16(8, method, true);
    lv.setUint32(14, item.descriptor ? 0 : crc, true);
    lv.setUint32(18, item.zip64 ? 0xffffffff : item.descriptor ? 0 : compressed.length, true);
    lv.setUint32(22, item.zip64 ? 0xffffffff : item.descriptor ? 0 : size, true);
    lv.setUint16(26, raw.length, true);
    lv.setUint16(28, le.length, true);
    local.set(raw, 30);
    local.set(le, 30 + raw.length);
    const dd = new Uint8Array(
      item.descriptor ? (item.zip64 ? 20 : 12) + (item.descriptor === "signed" ? 4 : 0) : 0,
    );
    if (item.descriptor) {
      const dv = new DataView(dd.buffer),
        at = item.descriptor === "signed" ? 4 : 0;
      if (at) dv.setUint32(0, 0x08074b50, true);
      dv.setUint32(at, crc, true);
      if (item.zip64) {
        dv.setBigUint64(at + 4, BigInt(compressed.length), true);
        dv.setBigUint64(at + 12, BigInt(size), true);
      } else {
        dv.setUint32(at + 4, compressed.length, true);
        dv.setUint32(at + 8, size, true);
      }
    }
    const central = new Uint8Array(46 + raw.length + ce.length),
      cv = new DataView(central.buffer);
    cv.setUint32(0, 0x02014b50, true);
    cv.setUint16(4, 20, true);
    cv.setUint16(6, version, true);
    cv.setUint16(8, flags, true);
    cv.setUint16(10, method, true);
    cv.setUint32(16, crc, true);
    cv.setUint32(20, item.zip64 ? 0xffffffff : compressed.length, true);
    cv.setUint32(24, item.zip64 ? 0xffffffff : size, true);
    cv.setUint16(28, raw.length, true);
    cv.setUint16(30, ce.length, true);
    cv.setUint32(42, item.zip64 ? 0xffffffff : offset, true);
    central.set(raw, 46);
    central.set(ce, 46 + raw.length);
    offsets.push({
      local: offset,
      central: centralAt,
      data: offset + local.length,
      descriptor: offset + local.length + compressed.length,
    });
    locals.push(local, compressed, dd);
    centrals.push(central);
    offset += local.length + compressed.length + dd.length;
    centralAt += central.length;
  }
  const central = concat(...centrals),
    zEnd = new Uint8Array(zip64End ? 76 : 0);
  if (zip64End) {
    const zv = new DataView(zEnd.buffer);
    zv.setUint32(0, 0x06064b50, true);
    zv.setBigUint64(4, 44n, true);
    zv.setUint16(12, 45, true);
    zv.setUint16(14, 45, true);
    zv.setBigUint64(24, BigInt(items.length), true);
    zv.setBigUint64(32, BigInt(items.length), true);
    zv.setBigUint64(40, BigInt(central.length), true);
    zv.setBigUint64(48, BigInt(offset), true);
    zv.setUint32(56, 0x07064b50, true);
    zv.setBigUint64(64, BigInt(offset + central.length), true);
    zv.setUint32(72, 1, true);
  }
  const end = new Uint8Array(22),
    ev = new DataView(end.buffer);
  ev.setUint32(0, 0x06054b50, true);
  ev.setUint16(8, zip64End ? 0xffff : items.length, true);
  ev.setUint16(10, zip64End ? 0xffff : items.length, true);
  ev.setUint32(12, zip64End ? 0xffffffff : central.length, true);
  ev.setUint32(16, zip64End ? 0xffffffff : offset, true);
  for (const item of offsets) item.central += offset;
  const bytes = concat(...locals, central, zEnd, end);
  return { bytes, offsets, centralOffset: offset, endOffset: bytes.length - 22 };
}

export function memoryArchive(
  bytes: Uint8Array,
): ArchiveSource & { reads: [number, number][]; opens: [number, number][] } {
  const reads: [number, number][] = [],
    opens: [number, number][] = [];
  return {
    size: bytes.length,
    reads,
    opens,
    async read(offset, length) {
      reads.push([offset, length]);
      return bytes.slice(offset, offset + length);
    },
    async open(offset, length) {
      opens.push([offset, length]);
      return new ReadableStream({
        start(controller) {
          controller.enqueue(bytes.slice(offset, offset + length));
          controller.close();
        },
      });
    },
  };
}
