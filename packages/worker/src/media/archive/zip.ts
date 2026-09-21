import { inflateSync } from "fflate";

const EOCD_LIMIT = 1024 * 1024;
const CENTRAL_LIMIT = 8 * 1024 * 1024;
const ENTRY_LIMIT = 5000;
const ENTRY_OUTPUT_LIMIT = 64 * 1024 * 1024;
const TOTAL_OUTPUT_LIMIT = 512 * 1024 * 1024;
const RATIO_LIMIT = 100;

export interface ZipEntry {
  entryId: string;
  path: string;
  method: 0 | 8;
  flags: number;
  compressedSize: number;
  uncompressedSize: number;
  localHeaderOffset: number;
  dataOffset: number;
  crc32: number;
  contentType: string;
}

function u16(bytes: Uint8Array, offset: number): number {
  if (offset < 0 || offset + 2 > bytes.byteLength) throw new Error("archive_truncated");
  return new DataView(bytes.buffer, bytes.byteOffset + offset, 2).getUint16(0, true);
}

function u32(bytes: Uint8Array, offset: number): number {
  if (offset < 0 || offset + 4 > bytes.byteLength) throw new Error("archive_truncated");
  return new DataView(bytes.buffer, bytes.byteOffset + offset, 4).getUint32(0, true);
}

export async function readR2Range(
  bucket: R2Bucket,
  key: string,
  offset: number,
  length: number,
  totalSize: number,
): Promise<Uint8Array> {
  if (
    !Number.isSafeInteger(offset) ||
    !Number.isSafeInteger(length) ||
    offset < 0 ||
    length < 0 ||
    offset + length > totalSize
  ) {
    throw new Error("archive_offset_invalid");
  }
  if (length === 0) return new Uint8Array();
  const object = await bucket.get(key, { range: { offset, length } });
  if (object === null) throw new Error("archive_source_missing");
  const bytes = new Uint8Array(await object.arrayBuffer());
  if (bytes.byteLength !== length) throw new Error("archive_range_inconsistent");
  return bytes;
}

function safePath(bytes: Uint8Array): string {
  let path: string;
  try {
    path = new TextDecoder("utf-8", { fatal: true }).decode(bytes).normalize("NFC");
  } catch {
    throw new Error("archive_path_invalid");
  }
  if (
    path.length === 0 ||
    path.length > 1024 ||
    path.startsWith("/") ||
    path.includes("\\") ||
    /\p{Cc}/u.test(path)
  ) {
    throw new Error("archive_path_invalid");
  }
  const segments = path.split("/");
  const directory = path.endsWith("/");
  if (
    segments.some((segment, index) => {
      if (directory && index === segments.length - 1) return false;
      return segment === "" || segment === "." || segment === "..";
    })
  ) {
    throw new Error("archive_path_invalid");
  }
  return path;
}

export function archiveContentType(path: string): string {
  const lower = path.toLowerCase();
  if (lower.endsWith(".jpg") || lower.endsWith(".jpeg")) return "image/jpeg";
  if (lower.endsWith(".png")) return "image/png";
  if (lower.endsWith(".gif")) return "image/gif";
  if (lower.endsWith(".webp")) return "image/webp";
  if (lower.endsWith(".avif")) return "image/avif";
  if (lower.endsWith(".xhtml") || lower.endsWith(".html") || lower.endsWith(".htm")) {
    return "application/xhtml+xml";
  }
  if (lower.endsWith(".css")) return "text/css";
  if (lower.endsWith(".opf") || lower.endsWith(".ncx") || lower.endsWith(".xml")) {
    return "application/xml";
  }
  return "application/octet-stream";
}

function eocdOffset(tail: Uint8Array): number {
  for (let offset = tail.byteLength - 22; offset >= 0; offset -= 1) {
    if (u32(tail, offset) === 0x06054b50) return offset;
  }
  throw new Error("unsupported_format");
}

async function validateLocalHeader(
  bucket: R2Bucket,
  key: string,
  totalSize: number,
  entry: Omit<ZipEntry, "dataOffset">,
): Promise<ZipEntry> {
  const fixed = await readR2Range(bucket, key, entry.localHeaderOffset, 30, totalSize);
  if (u32(fixed, 0) !== 0x04034b50) throw new Error("archive_header_mismatch");
  const flags = u16(fixed, 6);
  const method = u16(fixed, 8);
  const compressedSize = u32(fixed, 18);
  const uncompressedSize = u32(fixed, 22);
  const nameLength = u16(fixed, 26);
  const extraLength = u16(fixed, 28);
  if (
    flags !== entry.flags ||
    method !== entry.method ||
    compressedSize !== entry.compressedSize ||
    uncompressedSize !== entry.uncompressedSize ||
    u32(fixed, 14) !== entry.crc32
  ) {
    throw new Error("archive_header_mismatch");
  }
  const name = await readR2Range(bucket, key, entry.localHeaderOffset + 30, nameLength, totalSize);
  if (safePath(name) !== entry.path) throw new Error("archive_header_mismatch");
  const dataOffset = entry.localHeaderOffset + 30 + nameLength + extraLength;
  if (!Number.isSafeInteger(dataOffset) || dataOffset + entry.compressedSize > totalSize) {
    throw new Error("archive_offset_invalid");
  }
  return { ...entry, dataOffset };
}

export async function indexZipArchive(
  bucket: R2Bucket,
  key: string,
  totalSize: number,
): Promise<ZipEntry[]> {
  if (!Number.isSafeInteger(totalSize) || totalSize < 22) throw new Error("unsupported_format");
  const tailLength = Math.min(totalSize, EOCD_LIMIT);
  const tailOffset = totalSize - tailLength;
  const tail = await readR2Range(bucket, key, tailOffset, tailLength, totalSize);
  const relativeEocd = eocdOffset(tail);
  const disk = u16(tail, relativeEocd + 4);
  const centralDisk = u16(tail, relativeEocd + 6);
  const diskEntries = u16(tail, relativeEocd + 8);
  const entries = u16(tail, relativeEocd + 10);
  const centralSize = u32(tail, relativeEocd + 12);
  const centralOffset = u32(tail, relativeEocd + 16);
  const commentLength = u16(tail, relativeEocd + 20);
  if (
    disk !== 0 ||
    centralDisk !== 0 ||
    diskEntries !== entries ||
    entries > ENTRY_LIMIT ||
    centralSize > CENTRAL_LIMIT ||
    relativeEocd + 22 + commentLength > tail.byteLength ||
    centralOffset + centralSize > tailOffset + relativeEocd
  ) {
    throw new Error("unsupported_format");
  }
  const central = await readR2Range(bucket, key, centralOffset, centralSize, totalSize);
  const indexed: Omit<ZipEntry, "dataOffset">[] = [];
  let cursor = 0;
  let outputTotal = 0;
  for (let index = 0; index < entries; index += 1) {
    if (u32(central, cursor) !== 0x02014b50) throw new Error("archive_central_invalid");
    const flags = u16(central, cursor + 8);
    const method = u16(central, cursor + 10);
    const crc32 = u32(central, cursor + 16);
    const compressedSize = u32(central, cursor + 20);
    const uncompressedSize = u32(central, cursor + 24);
    const nameLength = u16(central, cursor + 28);
    const extraLength = u16(central, cursor + 30);
    const commentLengthEntry = u16(central, cursor + 32);
    const diskStart = u16(central, cursor + 34);
    const localHeaderOffset = u32(central, cursor + 42);
    const end = cursor + 46 + nameLength + extraLength + commentLengthEntry;
    if (
      end > central.byteLength ||
      diskStart !== 0 ||
      (method !== 0 && method !== 8) ||
      (flags & ~0x0806) !== 0 ||
      (flags & 0x0001) !== 0 ||
      (flags & 0x0008) !== 0 ||
      compressedSize === 0xffffffff ||
      uncompressedSize === 0xffffffff ||
      localHeaderOffset === 0xffffffff ||
      uncompressedSize > ENTRY_OUTPUT_LIMIT ||
      (uncompressedSize > 1024 * 1024 &&
        (compressedSize === 0 || uncompressedSize > compressedSize * RATIO_LIMIT))
    ) {
      throw new Error("unsupported_format");
    }
    outputTotal += uncompressedSize;
    if (!Number.isSafeInteger(outputTotal) || outputTotal > TOTAL_OUTPUT_LIMIT) {
      throw new Error("archive_output_limit");
    }
    const path = safePath(central.subarray(cursor + 46, cursor + 46 + nameLength));
    indexed.push({
      entryId: `entry_${index.toString().padStart(6, "0")}`,
      path,
      method,
      flags,
      compressedSize,
      uncompressedSize,
      localHeaderOffset,
      crc32,
      contentType: archiveContentType(path),
    });
    cursor = end;
  }
  if (cursor !== central.byteLength) throw new Error("archive_central_invalid");
  const result: ZipEntry[] = [];
  for (const entry of indexed) {
    result.push(await validateLocalHeader(bucket, key, totalSize, entry));
  }
  return result;
}

const crcTable = new Uint32Array(256).map((_, index) => {
  let value = index;
  for (let bit = 0; bit < 8; bit += 1)
    value = (value & 1) === 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  return value >>> 0;
});

export function crc32(bytes: Uint8Array): number {
  let value = 0xffffffff;
  for (const byte of bytes) value = (value >>> 8) ^ (crcTable[(value ^ byte) & 0xff] ?? 0);
  return (value ^ 0xffffffff) >>> 0;
}

export async function extractZipEntry(
  bucket: R2Bucket,
  key: string,
  totalSize: number,
  entry: ZipEntry,
  outputLimit = ENTRY_OUTPUT_LIMIT,
): Promise<Uint8Array> {
  if (entry.uncompressedSize > outputLimit) throw new Error("archive_output_limit");
  const compressed = await readR2Range(
    bucket,
    key,
    entry.dataOffset,
    entry.compressedSize,
    totalSize,
  );
  let output: Uint8Array;
  try {
    output = entry.method === 0 ? compressed : inflateSync(compressed);
  } catch {
    throw new Error("archive_deflate_invalid");
  }
  if (output.byteLength !== entry.uncompressedSize || crc32(output) !== entry.crc32) {
    throw new Error("archive_crc_mismatch");
  }
  return output;
}

export const zipLimits = {
  eocdBytes: EOCD_LIMIT,
  centralBytes: CENTRAL_LIMIT,
  entries: ENTRY_LIMIT,
  entryOutputBytes: ENTRY_OUTPUT_LIMIT,
  totalOutputBytes: TOTAL_OUTPUT_LIMIT,
  compressionRatio: RATIO_LIMIT,
} as const;
