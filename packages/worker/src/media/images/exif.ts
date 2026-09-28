import { ascii, IMAGE_METADATA_LIMITS, valid, view } from "./reader";

export interface ImageTags {
  orientation?: number;
  cameraMake?: string;
  cameraModel?: string;
  takenAt?: number;
}

/** Whitelist only IFD0 + Exif IFD fields. Never follow GPS, MakerNote, thumbnail or next-IFD links. */
export function imageExif(bytes: Uint8Array): ImageTags {
  try {
    valid(bytes.length >= 8 && bytes.length <= IMAGE_METADATA_LIMITS.exifBytes);
    const order = ascii(bytes, 0, 2),
      little = order === "II",
      data = view(bytes);
    valid(little || order === "MM");
    const u16 = (at: number) => {
      valid(at >= 0 && at + 2 <= bytes.length);
      return data.getUint16(at, little);
    };
    const u32 = (at: number) => {
      valid(at >= 0 && at + 4 <= bytes.length);
      return data.getUint32(at, little);
    };
    valid(u16(2) === 42);
    const tags: ImageTags = {};
    let exif: number | undefined, date: string | undefined, offset: string | undefined;
    const scan = (at: number, nested: boolean) => {
      valid(at >= 8);
      const count = u16(at);
      valid(count <= 256 && at + 2 + count * 12 + 4 <= bytes.length);
      const seen = new Set<number>();
      for (let i = 0; i < count; i++) {
        const entry = at + 2 + i * 12,
          tag = u16(entry);
        if (!(nested ? [0x9003, 0x9011] : [0x112, 0x10f, 0x110, 0x8769]).includes(tag)) continue;
        valid(!seen.has(tag));
        seen.add(tag);
        const type = u16(entry + 2),
          length = u32(entry + 4);
        if (!nested && tag === 0x112) {
          valid(type === 3 && length === 1);
          const orientation = u16(entry + 8);
          valid(orientation >= 1 && orientation <= 8);
          tags.orientation = orientation;
        } else if (!nested && tag === 0x8769) {
          valid(type === 4 && length === 1);
          exif = u32(entry + 8);
        } else {
          valid(type === 2 && length > 0 && length <= IMAGE_METADATA_LIMITS.fieldBytes);
          const start = length <= 4 ? entry + 8 : u32(entry + 8);
          valid(start >= 8 && start + length <= bytes.length && bytes[start + length - 1] === 0);
          const text = ascii(bytes, start, length - 1);
          valid(/^[\x20-\x7e]*$/.test(text));
          if (tag === 0x10f && text.trim()) tags.cameraMake = text.trim();
          if (tag === 0x110 && text.trim()) tags.cameraModel = text.trim();
          if (tag === 0x9003) date = text;
          if (tag === 0x9011) offset = text;
        }
      }
    };
    const first = u32(4);
    scan(first, false);
    if (exif !== undefined) {
      valid(exif !== first);
      scan(exif, true);
    }
    // EXIF wall time without an explicit UTC offset must not be invented as a UTC timestamp.
    if (
      date &&
      offset &&
      /^\d{4}:\d{2}:\d{2} \d{2}:\d{2}:\d{2}$/.test(date) &&
      /^[+-]\d{2}:\d{2}$/.test(offset)
    ) {
      const year = Number(date.slice(0, 4)),
        month = Number(date.slice(5, 7)),
        day = Number(date.slice(8, 10));
      const hour = Number(date.slice(11, 13)),
        minute = Number(date.slice(14, 16)),
        second = Number(date.slice(17, 19));
      const oh = Number(offset.slice(1, 3)),
        om = Number(offset.slice(4, 6));
      const local = Date.UTC(year, month - 1, day, hour, minute, second),
        check = new Date(local);
      if (
        year >= 1970 &&
        year <= 9999 &&
        check.getUTCFullYear() === year &&
        check.getUTCMonth() === month - 1 &&
        check.getUTCDate() === day &&
        hour < 24 &&
        minute < 60 &&
        second < 60 &&
        oh <= 14 &&
        om < 60 &&
        (oh < 14 || om === 0)
      ) {
        const utc = local - (offset[0] === "-" ? -1 : 1) * (oh * 60 + om) * 60000;
        if (utc >= 0) tags.takenAt = utc;
      }
    }
    return tags;
  } catch {
    return {};
  }
}
