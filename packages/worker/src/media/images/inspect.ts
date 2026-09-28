import { sniffMediaContainer } from "../sniff";
import { avifDimensions } from "./avif";
import { type ImageTags, imageExif } from "./exif";
import { ascii, ImageFormatError, ImageReader, type ImageSource, valid, view } from "./reader";

export const IMAGE_METADATA_GENERATOR = "image-metadata-v1";
export interface ImageMetadata extends ImageTags {
  mime: "image/jpeg" | "image/png" | "image/webp" | "image/avif";
  width: number;
  height: number;
  animated: boolean;
}
export function pngCrc(bytes: Uint8Array) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}
async function png(r: ImageReader): Promise<ImageMetadata> {
  let width = 0,
    height = 0,
    animated = false,
    image = false,
    ended = false;
  let tags: ImageTags = {},
    exif = false;
  for (let at = 8; at < r.size; ) {
    r.step();
    const header = await r.read(at, 8),
      size = view(header).getUint32(0),
      type = ascii(header, 4, 4);
    valid(size <= 0x7fffffff && at + 12 + size <= r.size && /^[A-Za-z]{4}$/.test(type));
    valid(width || (type === "IHDR" && at === 8));
    if (type === "eXIf" && size > 65536) {
      valid(!exif);
      exif = true;
    } else if (["IHDR", "eXIf", "acTL", "IEND"].includes(type)) {
      valid(size <= 65536);
      const body = await r.read(at + 4, size + 8),
        bytes = body.subarray(4, 4 + size);
      valid(pngCrc(body.subarray(0, size + 4)) === view(body).getUint32(size + 4));
      if (type === "IHDR") {
        valid(at === 8 && size === 13);
        width = view(bytes).getUint32(0);
        height = view(bytes).getUint32(4);
        const depths: Record<number, number[]> = {
          0: [1, 2, 4, 8, 16],
          2: [8, 16],
          3: [1, 2, 4, 8],
          4: [8, 16],
          6: [8, 16],
        };
        valid(
          depths[bytes[9]!]?.includes(bytes[8]!) &&
            bytes[10] === 0 &&
            bytes[11] === 0 &&
            bytes[12]! <= 1,
        );
      } else if (type === "eXIf") {
        valid(!exif);
        exif = true;
        tags = imageExif(bytes);
      } else if (type === "acTL") {
        valid(!animated && !image && size === 8 && view(bytes).getUint32(0) > 0);
        animated = true;
      } else {
        valid(size === 0 && image && at + 12 === r.size);
        ended = true;
      }
    } else if (type === "IDAT") image ||= size > 0;
    else if ((header[4]! & 32) === 0) valid(type === "PLTE");
    at += size + 12;
  }
  valid(ended);
  return { mime: "image/png", width, height, animated, ...tags };
}
async function jpeg(r: ImageReader): Promise<ImageMetadata> {
  let at = 2,
    width = 0,
    height = 0,
    tags: ImageTags = {},
    exif = false;
  for (;;) {
    r.step();
    const prefix = await r.read(at++, 1);
    valid(prefix[0] === 255);
    let marker = (await r.read(at++, 1))[0]!;
    while (marker === 255) {
      r.step();
      marker = (await r.read(at++, 1))[0]!;
    }
    valid(
      marker !== 0 && marker !== 0xd8 && marker !== 0xd9 && !(marker >= 0xd0 && marker <= 0xd7),
    );
    const length = view(await r.read(at, 2)).getUint16(0);
    valid(length >= 2 && at + length <= r.size);
    if (marker === 0xda) {
      valid(width && height && length >= 6 && at + length < r.size);
      return { mime: "image/jpeg", width, height, animated: false, ...tags };
    }
    if ([0xc0, 0xc1, 0xc2].includes(marker)) {
      valid(!width && length >= 8);
      const body = await r.read(at + 2, length - 2),
        components = body[5]!;
      valid(
        [8, 12].includes(body[0]!) &&
          components > 0 &&
          components <= 4 &&
          length === 8 + 3 * components,
      );
      height = view(body).getUint16(1);
      width = view(body).getUint16(3);
    } else if (marker === 0xe1 && length >= 8) {
      if (ascii(await r.read(at + 2, 6)) === "Exif\0\0") {
        valid(!exif);
        exif = true;
        tags = imageExif(await r.read(at + 8, length - 8));
      }
    } else if (marker >= 0xc0 && marker <= 0xcf) valid([0xc4, 0xc8, 0xcc].includes(marker));
    at += length;
  }
}
async function webp(r: ImageReader): Promise<ImageMetadata> {
  const header = await r.read(0, 12);
  valid(view(header).getUint32(4, true) + 8 === r.size);
  let width = 0,
    height = 0,
    animated = false,
    image = false,
    extended = false,
    exif = false;
  let tags: ImageTags = {};
  for (let at = 12; at < r.size; ) {
    r.step();
    const head = await r.read(at, 8),
      size = view(head).getUint32(4, true),
      type = ascii(head, 0, 4);
    valid(at + 8 + size + (size % 2) <= r.size);
    const bytes = await r.read(at + 8, Math.min(size, 16)),
      data = view(bytes);
    if (type === "VP8X") {
      valid(
        at === 12 &&
          !extended &&
          size === 10 &&
          (bytes[0]! & 0xc1) === 0 &&
          bytes[1] === 0 &&
          bytes[2] === 0 &&
          bytes[3] === 0,
      );
      extended = true;
      animated = (bytes[0]! & 2) !== 0;
      width = 1 + bytes[4]! + bytes[5]! * 256 + bytes[6]! * 65536;
      height = 1 + bytes[7]! + bytes[8]! * 256 + bytes[9]! * 65536;
    } else if (type === "VP8 " || type === "VP8L") {
      valid(!image && !animated);
      let w: number, h: number;
      if (type === "VP8 ") {
        valid(size >= 10 && (bytes[0]! & 1) === 0 && ascii(bytes, 3, 3) === "\x9d\x01\x2a");
        w = data.getUint16(6, true) & 0x3fff;
        h = data.getUint16(8, true) & 0x3fff;
      } else {
        valid(size >= 5 && bytes[0] === 0x2f && (bytes[4]! & 0xe0) === 0);
        const packed = data.getUint32(1, true);
        w = 1 + (packed & 0x3fff);
        h = 1 + ((packed >>> 14) & 0x3fff);
      }
      valid(!extended || (width === w && height === h));
      width = w;
      height = h;
      image = true;
    } else if (type === "ANMF") {
      valid(extended && animated && size >= 24);
      image = true;
    } else if (type === "EXIF") {
      valid(extended && !exif);
      exif = true;
      if (size <= 65536) {
        const data = await r.read(at + 8, size);
        tags = imageExif(size >= 6 && ascii(data, 0, 6) === "Exif\0\0" ? data.subarray(6) : data);
      }
    }
    if (size % 2) valid((await r.read(at + 8 + size, 1))[0] === 0);
    at += 8 + size + (size % 2);
  }
  valid(image);
  return { mime: "image/webp", width, height, animated, ...tags };
}

/** Header metadata, not a decoder or an instruction to transform. No client MIME/extension input. */
export async function inspectImage(source: ImageSource): Promise<ImageMetadata | null> {
  try {
    const r = new ImageReader(source);
    if (r.size < 12) return null;
    const head = await r.read(0, Math.min(r.size, 4096));
    let result: ImageMetadata;
    if (ascii(head, 0, 8) === "\x89PNG\r\n\x1a\n") result = await png(r);
    else if (head[0] === 255 && head[1] === 216) result = await jpeg(r);
    else if (ascii(head, 0, 4) === "RIFF" && ascii(head, 8, 4) === "WEBP") result = await webp(r);
    else {
      const container = sniffMediaContainer(head);
      if (container?.container !== "avif") return null;
      result = { mime: "image/avif", animated: container.animated, ...(await avifDimensions(r)) };
    }
    valid(
      Number.isSafeInteger(result.width) &&
        result.width > 0 &&
        Number.isSafeInteger(result.height) &&
        result.height > 0,
    );
    return Object.freeze(result);
  } catch (error) {
    if (error instanceof ImageFormatError || error instanceof RangeError) return null;
    throw error;
  }
}
