import { assertImageInput } from "../../platform/images";
import { sniffMediaContainer } from "../sniff";

interface Box {
  type: string;
  start: number;
  end: number;
  data: number;
}

const META_BUDGET = 1_000_000;

function box(bytes: Uint8Array, at: number, end: number): Box | null {
  if (at + 8 > end) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let size = view.getUint32(at);
  let header = 8;
  if (size === 1) {
    if (at + 16 > end) return null;
    const large = view.getBigUint64(at + 8);
    if (large > BigInt(Number.MAX_SAFE_INTEGER)) return null;
    size = Number(large);
    header = 16;
  }
  if (size < header || size > end - at) return null;
  return {
    type: String.fromCharCode(...bytes.subarray(at + 4, at + 8)),
    start: at,
    data: at + header,
    end: at + size,
  };
}

function boxes(bytes: Uint8Array, start: number, end: number): Box[] | null {
  const result: Box[] = [];
  for (let at = start; at < end; ) {
    if (result.length >= 1024) return null;
    const entry = box(bytes, at, end);
    if (!entry) return null;
    result.push(entry);
    at = entry.end;
  }
  return result;
}

function one(entries: Box[], type: string): Box | null {
  const found = entries.filter((entry) => entry.type === type);
  return found.length === 1 ? found[0]! : null;
}

function number(bytes: Uint8Array, at: number, size: number, end: number): number | null {
  if (size < 0 || size > 8 || at + size > end) return null;
  let value = 0;
  for (let i = 0; i < size; i++) value = value * 256 + bytes[at + i]!;
  return Number.isSafeInteger(value) ? value : null;
}

function full(bytes: Uint8Array, entry: Box, version: number): number | null {
  if (entry.data + 4 > entry.end || bytes[entry.data] !== version) return null;
  return entry.data + 4;
}

function framedAv1(bytes: Uint8Array, start: number, end: number): boolean {
  let at = start;
  let sequence = false;
  let frame = false;
  let count = 0;
  while (at < end) {
    if (++count > 1024) return false;
    const header = bytes[at++]!;
    const type = (header >> 3) & 15;
    if ((header & 0x81) !== 0 || (header & 2) === 0 || type === 0 || type > 8) return false;
    if ((header & 4) !== 0) {
      if (at >= end || (bytes[at++]! & 7) !== 0) return false;
    }
    let size = 0;
    let factor = 1;
    let complete = false;
    for (let i = 0; i < 8 && at < end; i++) {
      const part = bytes[at++]!;
      size += (part & 127) * factor;
      if (!Number.isSafeInteger(size)) return false;
      if ((part & 128) === 0) {
        complete = true;
        break;
      }
      factor *= 128;
    }
    if (!complete || size === 0 || size > end - at) return false;
    if (type === 1) sequence = true;
    if (type === 6) frame = true;
    at += size;
  }
  return sequence && frame;
}

/** Validate the primary still AV1 item without depending on the Images decoder. */
export function inspectAvif(bytes: Uint8Array): { width: number; height: number } | null {
  if (bytes.byteLength > 20_000_000) return null;
  const brand = sniffMediaContainer(bytes.subarray(0, Math.min(bytes.length, 65_536)));
  if (brand?.container !== "avif" || brand.animated) return null;
  const top = boxes(bytes, 0, bytes.length);
  if (!top || top[0]?.type !== "ftyp" || top.some((entry) => entry.type === "moov")) return null;
  const meta = one(top, "meta");
  const mdat = one(top, "mdat");
  if (!meta || !mdat || meta.end - meta.start > META_BUDGET) return null;
  const metaStart = full(bytes, meta, 0);
  if (metaStart === null || bytes[meta.data + 1] || bytes[meta.data + 2] || bytes[meta.data + 3])
    return null;
  const entries = boxes(bytes, metaStart, meta.end);
  if (!entries) return null;
  const pitm = one(entries, "pitm");
  const iinf = one(entries, "iinf");
  const iloc = one(entries, "iloc");
  const iprp = one(entries, "iprp");
  if (!pitm || !iinf || !iloc || !iprp) return null;
  const pitmVersion = bytes[pitm.data];
  const pitmStart = pitmVersion === 0 ? full(bytes, pitm, 0) : full(bytes, pitm, 1);
  const idSize = pitmVersion === 0 ? 2 : 4;
  if (pitmStart === null || pitmStart + idSize !== pitm.end) return null;
  const primary = number(bytes, pitmStart, idSize, pitm.end);
  if (!primary) return null;

  const iinfVersion = bytes[iinf.data];
  const iinfStart = iinfVersion === 0 ? full(bytes, iinf, 0) : full(bytes, iinf, 1);
  const countSize = iinfVersion === 0 ? 2 : 4;
  if (iinfStart === null) return null;
  const itemCount = number(bytes, iinfStart, countSize, iinf.end);
  if (itemCount === null || itemCount > 1024) return null;
  const items = boxes(bytes, iinfStart + countSize, iinf.end);
  if (!items || items.length !== itemCount) return null;
  const primaryItems = items.filter((item) => {
    if (item.type !== "infe") return false;
    const v = bytes[item.data];
    const start = v === 2 ? full(bytes, item, 2) : v === 3 ? full(bytes, item, 3) : null;
    const width = v === 2 ? 2 : 4;
    return (
      start !== null &&
      start + width + 6 <= item.end &&
      number(bytes, start, width, item.end) === primary &&
      String.fromCharCode(...bytes.subarray(start + width + 2, start + width + 6)) === "av01"
    );
  });
  if (primaryItems.length !== 1) return null;

  // Only file-offset extents inside the single mdat are accepted. Construction methods,
  // external data references and zero-length extents need a different validator.
  const locVersion = bytes[iloc.data];
  if (locVersion === undefined || locVersion > 2) return null;
  const locStart =
    locVersion === 0
      ? full(bytes, iloc, 0)
      : locVersion === 1
        ? full(bytes, iloc, 1)
        : full(bytes, iloc, 2);
  if (locStart === null || locStart + 4 > iloc.end) return null;
  const offsetSize = bytes[locStart]! >> 4;
  const lengthSize = bytes[locStart]! & 15;
  const baseSize = bytes[locStart + 1]! >> 4;
  const indexSize = bytes[locStart + 1]! & 15;
  if (offsetSize > 8 || lengthSize < 1 || lengthSize > 8 || baseSize > 8 || indexSize > 8)
    return null;
  const locCountSize = locVersion < 2 ? 2 : 4;
  let at = locStart + 2;
  const locCount = number(bytes, at, locCountSize, iloc.end);
  if (locCount === null || locCount > 1024) return null;
  at += locCountSize;
  let primaryExtent: { start: number; end: number } | null = null;
  for (let i = 0; i < locCount; i++) {
    const itemIdSize = locVersion < 2 ? 2 : 4;
    const itemId = number(bytes, at, itemIdSize, iloc.end);
    if (itemId === null) return null;
    at += itemIdSize;
    if (locVersion > 0) {
      const method = number(bytes, at, 2, iloc.end);
      if (method === null || (itemId === primary && method !== 0)) return null;
      at += 2;
    }
    const reference = number(bytes, at, 2, iloc.end);
    if (reference === null || (itemId === primary && reference !== 0)) return null;
    at += 2;
    const base = number(bytes, at, baseSize, iloc.end);
    if (base === null) return null;
    at += baseSize;
    const extentCount = number(bytes, at, 2, iloc.end);
    if (extentCount === null || extentCount > 1024) return null;
    at += 2;
    for (let j = 0; j < extentCount; j++) {
      if (locVersion > 0 && indexSize) at += indexSize;
      const offset = number(bytes, at, offsetSize, iloc.end);
      at += offsetSize;
      const length = number(bytes, at, lengthSize, iloc.end);
      at += lengthSize;
      if (offset === null || length === null) return null;
      if (itemId === primary) {
        const absolute = base + offset;
        if (
          !length ||
          !Number.isSafeInteger(absolute) ||
          absolute < mdat.data ||
          absolute > mdat.end - length
        )
          return null;
        if (primaryExtent) return null;
        primaryExtent = { start: absolute, end: absolute + length };
      }
    }
  }
  if (
    at !== iloc.end ||
    !primaryExtent ||
    !framedAv1(bytes, primaryExtent.start, primaryExtent.end)
  )
    return null;

  const properties = boxes(bytes, iprp.data, iprp.end);
  if (!properties) return null;
  const ipco = one(properties, "ipco");
  const ipma = one(properties, "ipma");
  if (!ipco || !ipma) return null;
  const propertyList = boxes(bytes, ipco.data, ipco.end);
  if (!propertyList || propertyList.length > 127) return null;
  const ipmaVersion = bytes[ipma.data];
  const ipmaStart = ipmaVersion === 0 ? full(bytes, ipma, 0) : full(bytes, ipma, 1);
  if (
    ipmaStart === null ||
    ipmaStart + 4 > ipma.end ||
    bytes[ipma.data + 1] ||
    bytes[ipma.data + 2] ||
    bytes[ipma.data + 3]
  )
    return null;
  const associationCount = number(bytes, ipmaStart, 4, ipma.end);
  if (associationCount === null || associationCount > 1024) return null;
  at = ipmaStart + 4;
  let width: number | null = null;
  let height: number | null = null;
  let av1Config = false;
  let primaryAssociations = 0;
  for (let i = 0; i < associationCount; i++) {
    const itemSize = ipmaVersion === 0 ? 2 : 4;
    const itemId = number(bytes, at, itemSize, ipma.end);
    if (itemId === null || at + itemSize + 1 > ipma.end) return null;
    at += itemSize;
    const count = bytes[at++]!;
    if (itemId === primary) primaryAssociations++;
    for (let j = 0; j < count; j++) {
      const association = number(bytes, at, 1, ipma.end);
      if (association === null) return null;
      at++;
      if (itemId !== primary) continue;
      const essential = (association & 128) !== 0;
      const index = association & 127;
      const property = propertyList[index - 1];
      if (!property) return null;
      if (property.type === "ispe") {
        const start = full(bytes, property, 0);
        if (start === null || start + 8 !== property.end || width !== null) return null;
        width = number(bytes, start, 4, property.end);
        height = number(bytes, start + 4, 4, property.end);
      } else if (property.type === "av1C") {
        if (av1Config || property.end - property.data < 4 || bytes[property.data] !== 0x81)
          return null;
        av1Config = true;
      } else if (essential) return null;
    }
  }
  if (at !== ipma.end || primaryAssociations !== 1 || !av1Config || !width || !height) return null;
  assertImageInput(bytes.length, width, height);
  return { width, height };
}
