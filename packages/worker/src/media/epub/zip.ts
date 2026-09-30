const EOCD_SIGNATURE = 0x06054b50;
const CENTRAL_SIGNATURE = 0x02014b50;
const LOCAL_SIGNATURE = 0x04034b50;
const EOCD_BYTES = 22;
const CENTRAL_BYTES = 46;
const LOCAL_BYTES = 30;
const MAX_EOCD_SEARCH = 1_048_576;
const MAX_CENTRAL_BYTES = 8_388_608;
const MAX_ENTRIES = 1_000;
const MAX_ENTRY_BYTES = 16_777_216;
const MAX_TOTAL_BYTES = 134_217_728;
const MAX_PATH_BYTES = 1_024;
const MAX_COMPRESSION_RATIO = 200;
const ALLOWED_FLAGS = 0x0808;

export interface ZipObjectSource {
  readonly key: string;
  readonly size: number;
  readonly r2Etag: string;
}

export interface ZipEntry {
  readonly path: string;
  readonly method: 0 | 8;
  readonly flags: number;
  readonly crc32: number;
  readonly compressedSize: number;
  readonly size: number;
  readonly localHeaderOffset: number;
}

export class ZipFormatError extends Error {
  constructor(readonly code: string) {
    super(code);
  }
}

class ZipTransientError extends Error {}

function current(deadline: number): boolean {
  return Number.isSafeInteger(deadline) && Date.now() < deadline;
}

function uint16(bytes: Uint8Array, offset: number): number {
  return bytes[offset]! | (bytes[offset + 1]! << 8);
}

function uint32(bytes: Uint8Array, offset: number): number {
  return (
    (bytes[offset]! |
      (bytes[offset + 1]! << 8) |
      (bytes[offset + 2]! << 16) |
      (bytes[offset + 3]! << 24)) >>>
    0
  );
}

function checkedAdd(left: number, right: number): number {
  const value = left + right;
  if (!Number.isSafeInteger(value) || value < left) throw new ZipFormatError("offset_overflow");
  return value;
}

function matches(object: R2Object, source: ZipObjectSource): boolean {
  return object.size === source.size && object.etag === source.r2Etag;
}

async function range(
  bucket: R2Bucket,
  source: ZipObjectSource,
  offset: number,
  length: number,
  deadline: number,
): Promise<Uint8Array> {
  if (
    !current(deadline) ||
    !Number.isSafeInteger(offset) ||
    !Number.isSafeInteger(length) ||
    offset < 0 ||
    length < 0 ||
    checkedAdd(offset, length) > source.size
  )
    throw new ZipTransientError("source_unavailable");
  const object = await bucket.get(source.key, { range: { offset, length } });
  if (!current(deadline) || !object || !matches(object, source))
    throw new ZipTransientError("source_unavailable");
  if (
    !object.range ||
    !("offset" in object.range) ||
    !("length" in object.range) ||
    object.range.offset !== offset ||
    object.range.length !== length
  ) {
    void object.body.cancel().catch(() => undefined);
    throw new ZipTransientError("source_unavailable");
  }
  const bytes = new Uint8Array(await object.arrayBuffer());
  if (!current(deadline) || bytes.byteLength !== length)
    throw new ZipTransientError("source_unavailable");
  return bytes;
}

function decodePath(bytes: Uint8Array, flags: number): string {
  if (bytes.byteLength < 1 || bytes.byteLength > MAX_PATH_BYTES)
    throw new ZipFormatError("invalid_path");
  if ((flags & 0x0800) === 0 && bytes.some((byte) => byte > 0x7f))
    throw new ZipFormatError("unsupported_path_encoding");
  let path: string;
  try {
    path = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    throw new ZipFormatError("invalid_path");
  }
  if (
    path.includes("\0") ||
    path.includes("\\") ||
    path.startsWith("/") ||
    /^[A-Za-z]:/.test(path) ||
    path.normalize("NFC") !== path
  )
    throw new ZipFormatError("invalid_path");
  const segments = path.split("/");
  const pathSegments = path.endsWith("/") ? segments.slice(0, -1) : segments;
  if (
    pathSegments.length < 1 ||
    pathSegments.some((segment) => segment === "" || segment === "." || segment === "..")
  )
    throw new ZipFormatError("invalid_path");
  return path;
}

function validateEntry(entry: ZipEntry, centralOffset: number): void {
  if (
    (entry.flags & 1) !== 0 ||
    (entry.flags & ~ALLOWED_FLAGS) !== 0 ||
    (entry.method !== 0 && entry.method !== 8) ||
    entry.size > MAX_ENTRY_BYTES ||
    entry.compressedSize > MAX_ENTRY_BYTES ||
    (entry.size > 0 && entry.compressedSize === 0) ||
    (entry.method === 0 && entry.compressedSize !== entry.size) ||
    (entry.method === 8 &&
      entry.size > Math.max(1, entry.compressedSize) * MAX_COMPRESSION_RATIO) ||
    entry.localHeaderOffset >= centralOffset
  )
    throw new ZipFormatError("unsupported_entry");
}

export async function inspectZipDirectory(
  bucket: R2Bucket,
  source: ZipObjectSource,
  deadline: number,
): Promise<readonly ZipEntry[]> {
  if (
    !source.key ||
    source.key.length > 1_024 ||
    !Number.isSafeInteger(source.size) ||
    source.size < EOCD_BYTES ||
    source.size > 0xffffffff ||
    !source.r2Etag ||
    source.r2Etag.length > 256 ||
    !current(deadline)
  )
    throw new ZipTransientError("source_unavailable");
  const tailLength = Math.min(source.size, MAX_EOCD_SEARCH + EOCD_BYTES);
  const tailOffset = source.size - tailLength;
  const tail = await range(bucket, source, tailOffset, tailLength, deadline);
  let eocd = -1;
  for (let offset = tail.length - EOCD_BYTES; offset >= 0; offset -= 1) {
    if (uint32(tail, offset) !== EOCD_SIGNATURE) continue;
    const commentLength = uint16(tail, offset + 20);
    if (offset + EOCD_BYTES + commentLength === tail.length) {
      eocd = offset;
      break;
    }
  }
  if (eocd < 0) throw new ZipFormatError("missing_eocd");
  const disk = uint16(tail, eocd + 4);
  const centralDisk = uint16(tail, eocd + 6);
  const diskEntries = uint16(tail, eocd + 8);
  const entryCount = uint16(tail, eocd + 10);
  const centralSize = uint32(tail, eocd + 12);
  const centralOffset = uint32(tail, eocd + 16);
  const absoluteEocd = tailOffset + eocd;
  if (
    disk !== 0 ||
    centralDisk !== 0 ||
    diskEntries !== entryCount ||
    entryCount < 1 ||
    entryCount > MAX_ENTRIES ||
    entryCount === 0xffff ||
    centralSize > MAX_CENTRAL_BYTES ||
    centralSize === 0xffffffff ||
    centralOffset === 0xffffffff ||
    checkedAdd(centralOffset, centralSize) !== absoluteEocd
  )
    throw new ZipFormatError("unsupported_archive");
  const central =
    centralOffset >= tailOffset
      ? tail.subarray(centralOffset - tailOffset, centralOffset - tailOffset + centralSize)
      : await range(bucket, source, centralOffset, centralSize, deadline);
  if (central.byteLength !== centralSize) throw new ZipFormatError("invalid_central_directory");
  const entries: ZipEntry[] = [];
  const paths = new Set<string>();
  let totalBytes = 0;
  let offset = 0;
  while (offset < central.length) {
    if (entries.length >= entryCount || offset + CENTRAL_BYTES > central.length)
      throw new ZipFormatError("invalid_central_directory");
    if (uint32(central, offset) !== CENTRAL_SIGNATURE)
      throw new ZipFormatError("invalid_central_directory");
    const flags = uint16(central, offset + 8);
    const method = uint16(central, offset + 10);
    const crc32 = uint32(central, offset + 16);
    const compressedSize = uint32(central, offset + 20);
    const size = uint32(central, offset + 24);
    const nameLength = uint16(central, offset + 28);
    const extraLength = uint16(central, offset + 30);
    const commentLength = uint16(central, offset + 32);
    const diskStart = uint16(central, offset + 34);
    const externalAttributes = uint32(central, offset + 38);
    const localHeaderOffset = uint32(central, offset + 42);
    const end = checkedAdd(
      checkedAdd(checkedAdd(offset, CENTRAL_BYTES), nameLength),
      extraLength + commentLength,
    );
    if (end > central.length || diskStart !== 0)
      throw new ZipFormatError("invalid_central_directory");
    const path = decodePath(
      central.subarray(offset + CENTRAL_BYTES, offset + CENTRAL_BYTES + nameLength),
      flags,
    );
    const directory = path.endsWith("/") || (externalAttributes & 0x10) !== 0;
    if (!directory) {
      const entry: ZipEntry = {
        path,
        method: method as 0 | 8,
        flags,
        crc32,
        compressedSize,
        size,
        localHeaderOffset,
      };
      validateEntry(entry, centralOffset);
      if (paths.has(path)) throw new ZipFormatError("duplicate_path");
      paths.add(path);
      totalBytes = checkedAdd(totalBytes, size);
      if (totalBytes > MAX_TOTAL_BYTES) throw new ZipFormatError("archive_too_large");
      entries.push(Object.freeze(entry));
    }
    offset = end;
  }
  if (offset !== central.length || entries.length < 1 || entries.length > entryCount)
    throw new ZipFormatError("invalid_central_directory");
  return Object.freeze(entries);
}

interface LocalEntry {
  readonly dataOffset: number;
}

async function inspectLocalEntry(
  bucket: R2Bucket,
  source: ZipObjectSource,
  entry: ZipEntry,
  deadline: number,
): Promise<LocalEntry> {
  const fixed = await range(bucket, source, entry.localHeaderOffset, LOCAL_BYTES, deadline);
  if (uint32(fixed, 0) !== LOCAL_SIGNATURE) throw new ZipFormatError("invalid_local_header");
  const flags = uint16(fixed, 6);
  const method = uint16(fixed, 8);
  const crc32 = uint32(fixed, 14);
  const compressedSize = uint32(fixed, 18);
  const size = uint32(fixed, 22);
  const nameLength = uint16(fixed, 26);
  const extraLength = uint16(fixed, 28);
  if (nameLength < 1 || nameLength > MAX_PATH_BYTES)
    throw new ZipFormatError("invalid_local_header");
  const variable = await range(
    bucket,
    source,
    checkedAdd(entry.localHeaderOffset, LOCAL_BYTES),
    nameLength + extraLength,
    deadline,
  );
  const path = decodePath(variable.subarray(0, nameLength), flags);
  if (
    path !== entry.path ||
    flags !== entry.flags ||
    method !== entry.method ||
    ((flags & 0x0008) === 0 &&
      (crc32 !== entry.crc32 || compressedSize !== entry.compressedSize || size !== entry.size))
  )
    throw new ZipFormatError("central_local_mismatch");
  const dataOffset = checkedAdd(
    checkedAdd(entry.localHeaderOffset, LOCAL_BYTES),
    nameLength + extraLength,
  );
  if (checkedAdd(dataOffset, entry.compressedSize) > source.size)
    throw new ZipFormatError("invalid_local_header");
  return Object.freeze({ dataOffset });
}

async function inflate(
  compressed: Uint8Array,
  expectedSize: number,
  deadline: number,
): Promise<Uint8Array> {
  const stream = new Response(compressed).body;
  if (!stream) throw new ZipTransientError("source_unavailable");
  const reader = stream.pipeThrough(new DecompressionStream("deflate-raw")).getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      if (!current(deadline)) throw new ZipTransientError("source_unavailable");
      const next = await reader.read();
      if (next.done) break;
      size = checkedAdd(size, next.value.byteLength);
      if (size > expectedSize || size > MAX_ENTRY_BYTES)
        throw new ZipFormatError("entry_output_limit");
      chunks.push(next.value);
    }
  } finally {
    reader.releaseLock();
  }
  if (size !== expectedSize) throw new ZipFormatError("entry_size_mismatch");
  const output = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return output;
}

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return (crc ^ 0xffffffff) >>> 0;
}

export async function validateZipEntry(
  bucket: R2Bucket,
  source: ZipObjectSource,
  entry: ZipEntry,
  deadline: number,
): Promise<void> {
  await inspectLocalEntry(bucket, source, entry, deadline);
}

export async function readZipEntry(
  bucket: R2Bucket,
  source: ZipObjectSource,
  entry: ZipEntry,
  deadline: number,
): Promise<Uint8Array> {
  const local = await inspectLocalEntry(bucket, source, entry, deadline);
  const compressed = await range(bucket, source, local.dataOffset, entry.compressedSize, deadline);
  const output = entry.method === 0 ? compressed : await inflate(compressed, entry.size, deadline);
  if (output.byteLength !== entry.size || crc32(output) !== entry.crc32)
    throw new ZipFormatError("entry_crc_mismatch");
  return output;
}

export function isZipTransient(error: unknown): boolean {
  return error instanceof ZipTransientError;
}
