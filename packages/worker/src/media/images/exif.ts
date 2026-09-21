export interface ExtractedImageMetadata {
  takenAt: number | null;
  orientation: number | null;
  cameraMake: string | null;
  cameraModel: string | null;
}

function read16(view: DataView, offset: number, littleEndian: boolean): number | null {
  return offset >= 0 && offset + 2 <= view.byteLength ? view.getUint16(offset, littleEndian) : null;
}

function read32(view: DataView, offset: number, littleEndian: boolean): number | null {
  return offset >= 0 && offset + 4 <= view.byteLength ? view.getUint32(offset, littleEndian) : null;
}

function ascii(view: DataView, offset: number, length: number): string | null {
  if (length < 1 || length > 256 || offset < 0 || offset + length > view.byteLength) return null;
  const bytes = new Uint8Array(view.buffer, view.byteOffset + offset, length);
  const end = bytes.indexOf(0);
  const value = new TextDecoder("ascii", { fatal: true })
    .decode(end < 0 ? bytes : bytes.slice(0, end))
    .trim();
  return value.length === 0 ? null : value.slice(0, 128);
}

function exifTimestamp(value: string | null): number | null {
  if (value === null) return null;
  const match = /^(\d{4}):(\d{2}):(\d{2}) (\d{2}):(\d{2}):(\d{2})$/u.exec(value);
  if (match === null) return null;
  const parts = match.slice(1).map(Number);
  if (parts.length !== 6 || parts.some((part) => !Number.isSafeInteger(part))) return null;
  const [year, month, day, hour, minute, second] = parts;
  if (
    year === undefined ||
    month === undefined ||
    day === undefined ||
    hour === undefined ||
    minute === undefined ||
    second === undefined ||
    month < 1 ||
    month > 12 ||
    day < 1 ||
    day > 31 ||
    hour > 23 ||
    minute > 59 ||
    second > 59
  ) {
    return null;
  }
  const timestamp = Date.UTC(year, month - 1, day, hour, minute, second);
  const date = new Date(timestamp);
  return date.getUTCFullYear() === year &&
    date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day
    ? timestamp
    : null;
}

interface IfdValues {
  orientation: number | null;
  date: string | null;
  make: string | null;
  model: string | null;
  exifOffset: number | null;
}

function readIfd(
  view: DataView,
  tiffStart: number,
  relativeOffset: number,
  littleEndian: boolean,
): IfdValues {
  const result: IfdValues = {
    orientation: null,
    date: null,
    make: null,
    model: null,
    exifOffset: null,
  };
  const start = tiffStart + relativeOffset;
  const count = read16(view, start, littleEndian);
  if (count === null || count > 256 || start + 2 + count * 12 > view.byteLength) return result;
  for (let index = 0; index < count; index += 1) {
    const entry = start + 2 + index * 12;
    const tag = read16(view, entry, littleEndian);
    const type = read16(view, entry + 2, littleEndian);
    const values = read32(view, entry + 4, littleEndian);
    const valueOffset = read32(view, entry + 8, littleEndian);
    if (tag === null || type === null || values === null || valueOffset === null) continue;
    const bytesPerValue = type === 3 ? 2 : type === 4 ? 4 : 1;
    const byteLength = values * bytesPerValue;
    const absolute = byteLength <= 4 ? entry + 8 : tiffStart + valueOffset;
    if (tag === 0x0112 && type === 3 && values === 1) {
      result.orientation = read16(view, absolute, littleEndian);
    } else if (tag === 0x010f && type === 2) {
      result.make = ascii(view, absolute, values);
    } else if (tag === 0x0110 && type === 2) {
      result.model = ascii(view, absolute, values);
    } else if ((tag === 0x0132 || tag === 0x9003) && type === 2) {
      result.date = ascii(view, absolute, values);
    } else if (tag === 0x8769 && type === 4 && values === 1) {
      result.exifOffset = valueOffset;
    }
  }
  return result;
}

export function extractExif(bytes: Uint8Array): ExtractedImageMetadata {
  const empty: ExtractedImageMetadata = {
    takenAt: null,
    orientation: null,
    cameraMake: null,
    cameraModel: null,
  };
  const length = Math.min(bytes.byteLength, 2 * 1024 * 1024);
  if (length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return empty;
  const view = new DataView(bytes.buffer, bytes.byteOffset, length);
  let offset = 2;
  while (offset + 4 <= length) {
    if (view.getUint8(offset) !== 0xff) return empty;
    const marker = view.getUint8(offset + 1);
    if (marker === 0xda || marker === 0xd9) break;
    const size = view.getUint16(offset + 2, false);
    if (size < 2 || offset + 2 + size > length) return empty;
    if (
      marker === 0xe1 &&
      size >= 14 &&
      view.getUint32(offset + 4, false) === 0x45786966 &&
      view.getUint16(offset + 8, false) === 0
    ) {
      const tiff = offset + 10;
      const byteOrder = view.getUint16(tiff, false);
      const littleEndian = byteOrder === 0x4949;
      if (!littleEndian && byteOrder !== 0x4d4d) return empty;
      if (read16(view, tiff + 2, littleEndian) !== 42) return empty;
      const first = read32(view, tiff + 4, littleEndian);
      if (first === null) return empty;
      const root = readIfd(view, tiff, first, littleEndian);
      const details =
        root.exifOffset === null
          ? root
          : { ...root, ...readIfd(view, tiff, root.exifOffset, littleEndian) };
      return {
        takenAt: exifTimestamp(details.date ?? root.date),
        orientation:
          root.orientation !== null && root.orientation >= 1 && root.orientation <= 8
            ? root.orientation
            : null,
        cameraMake: root.make,
        cameraModel: root.model,
      };
    }
    offset += size + 2;
  }
  return empty;
}
