import { assertImageInput } from "../../platform/images";
import { sniffMediaContainer } from "../sniff";

export const IMAGE_METADATA_GENERATOR = "image-metadata-v1";
const PNG = [137, 80, 78, 71, 13, 10, 26, 10] as const;

export interface ImageMetadata {
  readonly width: number;
  readonly height: number;
}

function ascii(bytes: Uint8Array, offset: number, length: number): string {
  return String.fromCharCode(...bytes.subarray(offset, offset + length));
}

function staticPng(bytes: Uint8Array): boolean {
  if (bytes.length < 33 || !PNG.every((byte, index) => bytes[index] === byte)) return false;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let offset = 8;
  while (offset + 12 <= bytes.length) {
    const length = view.getUint32(offset);
    const type = ascii(bytes, offset + 4, 4);
    if (length > bytes.length - offset - 12) return false;
    if (type === "acTL") return false;
    if (type === "IEND") return offset + 12 === bytes.length;
    offset += length + 12;
  }
  return false;
}

function staticWebp(bytes: Uint8Array): boolean {
  if (bytes.length < 20 || ascii(bytes, 0, 4) !== "RIFF" || ascii(bytes, 8, 4) !== "WEBP")
    return false;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.getUint32(4, true) + 8 !== bytes.length) return false;
  let offset = 12;
  while (offset + 8 <= bytes.length) {
    const type = ascii(bytes, offset, 4);
    const length = view.getUint32(offset + 4, true);
    if (length > bytes.length - offset - 8) return false;
    if (type === "ANIM" || type === "ANMF") return false;
    if (type === "VP8X" && length >= 1 && (bytes[offset + 8]! & 0x02) !== 0) return false;
    offset += 8 + length + (length & 1);
  }
  return offset === bytes.length;
}

function staticFormat(
  bytes: Uint8Array,
): "image/jpeg" | "image/png" | "image/webp" | "image/avif" | null {
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff)
    return "image/jpeg";
  if (staticPng(bytes)) return "image/png";
  if (staticWebp(bytes)) return "image/webp";
  const media = sniffMediaContainer(bytes.subarray(0, Math.min(bytes.length, 65_536)));
  return media?.container === "avif" && !media.animated ? "image/avif" : null;
}

export async function inspectImage(
  images: ImagesBinding,
  bytes: Uint8Array,
): Promise<ImageMetadata | null> {
  const expected = staticFormat(bytes);
  if (!expected) return null;
  const info = await images.info(new Blob([bytes]).stream());
  if (
    !("width" in info) ||
    !("height" in info) ||
    !("fileSize" in info) ||
    info.format !== expected ||
    info.fileSize !== bytes.byteLength
  )
    return null;
  assertImageInput(bytes.byteLength, info.width, info.height);
  return { width: info.width, height: info.height };
}
