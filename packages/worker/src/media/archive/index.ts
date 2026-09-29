import {
  ARCHIVE_LIMITS,
  checkMethod,
  comparePaths,
  dataView,
  encodedName,
  entryPath,
  extraFields,
  imageCandidate,
  range,
  requireArchive,
  wide,
} from "./format";

export interface ArchiveSource {
  readonly size: number;
  read(offset: number, length: number): Promise<Uint8Array>;
  open(offset: number, length: number): Promise<ReadableStream<Uint8Array>>;
}

export interface ArchiveEntry {
  readonly path: string;
  readonly rawName: string;
  readonly method: number;
  readonly flags: number;
  readonly version: number;
  readonly crc32: number;
  readonly compressedSize: number;
  readonly size: number;
  readonly localOffset: number;
  readonly endOffset: number;
  readonly directory: boolean;
  readonly zip64: boolean;
}

export interface ArchiveIndex {
  readonly version: "archive-index-v1";
  readonly sourceSize: number;
  readonly centralOffset: number;
  readonly entries: readonly ArchiveEntry[];
  /** Ordinals in entries, sorted naturally. Not verified image MIME or bearer capabilities. */
  readonly pages: readonly number[];
}

export async function exactRead(
  source: ArchiveSource,
  offset: number,
  length: number,
): Promise<Uint8Array> {
  range(offset, length, source.size);
  if (length === 0) return new Uint8Array();
  const bytes = await source.read(offset, length);
  requireArchive(bytes.length === length, "archive_source_length_mismatch");
  return bytes;
}

async function directory(source: ArchiveSource) {
  requireArchive(Number.isSafeInteger(source.size) && source.size >= 22);
  const start = Math.max(0, source.size - ARCHIVE_LIMITS.tailBytes);
  const tail = await exactRead(source, start, source.size - start),
    view = dataView(tail);
  let end = -1;
  for (let at = tail.length - 22; at >= 0; at--) {
    if (
      view.getUint32(at, true) !== 0x06054b50 ||
      at + 22 + view.getUint16(at + 20, true) !== tail.length
    )
      continue;
    requireArchive(end === -1, "archive_ambiguous_end");
    end = at;
  }
  requireArchive(end >= 0);
  requireArchive(
    view.getUint16(end + 4, true) === 0 && view.getUint16(end + 6, true) === 0,
    "unsupported_archive_multidisk",
  );
  let count = view.getUint16(end + 10, true),
    size = view.getUint32(end + 12, true),
    offset = view.getUint32(end + 16, true);
  const diskCount = view.getUint16(end + 8, true);
  let boundary = start + end;
  const tailRead = async (at: number, length: number) => {
    range(at, length, source.size);
    return at >= start
      ? tail.subarray(at - start, at - start + length)
      : exactRead(source, at, length);
  };
  const locator = boundary >= 20 ? await tailRead(boundary - 20, 20) : new Uint8Array();
  if (locator.length === 20 && dataView(locator).getUint32(0, true) === 0x07064b50) {
    const loc = dataView(locator);
    requireArchive(
      loc.getUint32(4, true) === 0 && loc.getUint32(16, true) === 1,
      "unsupported_archive_multidisk",
    );
    const zipOffset = wide(loc, 8);
    range(zipOffset, 56, boundary - 20);
    requireArchive(zipOffset + 56 === boundary - 20);
    requireArchive(boundary - zipOffset <= ARCHIVE_LIMITS.tailBytes, "archive_end_limit");
    const zip = dataView(await tailRead(zipOffset, 56));
    requireArchive(
      zip.getUint32(0, true) === 0x06064b50 && wide(zip, 4) === 44,
      "unsupported_archive_zip64_record",
    );
    requireArchive(zipOffset + 56 === boundary - 20 && zip.getUint16(14, true) <= 45);
    requireArchive(
      zip.getUint32(16, true) === 0 && zip.getUint32(20, true) === 0,
      "unsupported_archive_multidisk",
    );
    const zipCount = wide(zip, 32),
      zipSize = wide(zip, 40),
      zipCentral = wide(zip, 48);
    requireArchive(wide(zip, 24) === zipCount && (diskCount === 0xffff || diskCount === zipCount));
    requireArchive(
      (count === 0xffff || count === zipCount) &&
        (size === 0xffffffff || size === zipSize) &&
        (offset === 0xffffffff || offset === zipCentral),
    );
    count = zipCount;
    size = zipSize;
    offset = zipCentral;
    boundary = zipOffset;
  } else {
    requireArchive(
      count !== 0xffff && diskCount !== 0xffff && size !== 0xffffffff && offset !== 0xffffffff,
      "archive_missing_zip64",
    );
    requireArchive(count === diskCount, "unsupported_archive_multidisk");
  }
  requireArchive(
    count <= ARCHIVE_LIMITS.entries && size <= ARCHIVE_LIMITS.centralBytes,
    "archive_index_limit",
  );
  range(offset, size, boundary);
  requireArchive(offset + size === boundary && size >= count * 46);
  return { count, offset, bytes: await tailRead(offset, size) };
}

/** Reads only bounded EOCD/central-directory ranges; local headers are checked when opened. */
export async function inspectArchive(source: ArchiveSource): Promise<ArchiveIndex> {
  const central = await directory(source),
    bytes = central.bytes,
    view = dataView(bytes);
  const entries: ArchiveEntry[] = [],
    paths = new Map<string, boolean>();
  let at = 0,
    total = 0,
    jsonBytes = 256;
  for (let i = 0; i < central.count; i++) {
    requireArchive(at + 46 <= bytes.length && view.getUint32(at, true) === 0x02014b50);
    const version = view.getUint16(at + 6, true),
      flags = view.getUint16(at + 8, true),
      method = view.getUint16(at + 10, true);
    checkMethod(flags, method, version);
    const nameLength = view.getUint16(at + 28, true),
      extraLength = view.getUint16(at + 30, true),
      commentLength = view.getUint16(at + 32, true);
    const next = at + 46 + nameLength + extraLength + commentLength;
    requireArchive(next <= bytes.length);
    const raw = bytes.subarray(at + 46, at + 46 + nameLength);
    const fields = extraFields(
      bytes.subarray(at + 46 + nameLength, at + 46 + nameLength + extraLength),
    );
    const path = entryPath(raw, flags, fields),
      isDirectory = path.endsWith("/"),
      key = isDirectory ? path.slice(0, -1) : path;
    requireArchive(!paths.has(key), "archive_duplicate_path");
    paths.set(key, isDirectory);
    let size = view.getUint32(at + 24, true),
      compressedSize = view.getUint32(at + 20, true),
      localOffset = view.getUint32(at + 42, true),
      disk = view.getUint16(at + 34, true);
    const zip64 = fields.has(1),
      extended = dataView(fields.get(1) ?? new Uint8Array());
    let cursor = 0;
    const nextWide = () => {
      const n = wide(extended, cursor);
      cursor += 8;
      return n;
    };
    if (size === 0xffffffff) size = nextWide();
    if (compressedSize === 0xffffffff) compressedSize = nextWide();
    if (localOffset === 0xffffffff) localOffset = nextWide();
    if (disk === 0xffff) {
      requireArchive(cursor + 4 <= extended.byteLength);
      disk = extended.getUint32(cursor, true);
      cursor += 4;
    }
    requireArchive(cursor === extended.byteLength && (!zip64 || version >= 45));
    requireArchive(disk === 0, "unsupported_archive_multidisk");
    const attrs = view.getUint32(at + 38, true),
      host = view.getUint16(at + 4, true) >>> 8,
      unixType = (attrs >>> 16) & 0xf000;
    requireArchive(
      (host !== 3 && host !== 19) || unixType === 0 || unixType === (isDirectory ? 0x4000 : 0x8000),
      "unsupported_archive_file_type",
    );
    requireArchive(!(attrs & 0x10) || isDirectory, "archive_directory_mismatch");
    total += size;
    requireArchive(
      size <= ARCHIVE_LIMITS.entryBytes &&
        compressedSize <= ARCHIVE_LIMITS.compressedBytes &&
        total <= ARCHIVE_LIMITS.totalBytes,
      "archive_size_limit",
    );
    requireArchive(
      (method !== 0 || compressedSize === size) &&
        (!isDirectory || (size === 0 && compressedSize === 0)),
      "archive_size_mismatch",
    );
    range(
      localOffset,
      30 + nameLength + compressedSize + (flags & 8 ? (zip64 ? 20 : 12) : 0),
      central.offset,
    );
    const entry: ArchiveEntry = {
      path,
      rawName: encodedName(raw),
      method,
      flags,
      version,
      crc32: view.getUint32(at + 16, true),
      compressedSize,
      size,
      localOffset,
      endOffset: central.offset,
      directory: isDirectory,
      zip64,
    };
    jsonBytes += new TextEncoder().encode(JSON.stringify(entry)).length + 8;
    requireArchive(jsonBytes <= ARCHIVE_LIMITS.indexBytes, "archive_index_limit");
    entries.push(entry);
    at = next;
  }
  requireArchive(at === bytes.length);
  for (const path of paths.keys()) {
    let slash = path.indexOf("/");
    while (slash !== -1) {
      requireArchive(paths.get(path.slice(0, slash)) !== false, "archive_path_conflict");
      slash = path.indexOf("/", slash + 1);
    }
  }
  const ordered = [...entries].sort((a, b) => a.localOffset - b.localOffset);
  for (let i = 0; i < ordered.length; i++) {
    const entry = ordered[i]!,
      endOffset = ordered[i + 1]?.localOffset ?? central.offset;
    range(
      entry.localOffset,
      30 +
        atob(entry.rawName).length +
        entry.compressedSize +
        (entry.flags & 8 ? (entry.zip64 ? 20 : 12) : 0),
      endOffset,
    );
    // Replace in the central order only after validating non-overlap in physical order.
    Object.assign(entry, { endOffset });
    Object.freeze(entry);
  }
  const pages = entries
    .map((entry, i) => ({ entry, i }))
    .filter(({ entry }) => !entry.directory && imageCandidate(entry.path))
    .sort((a, b) => comparePaths(a.entry.path, b.entry.path))
    .map(({ i }) => i);
  return Object.freeze({
    version: "archive-index-v1",
    sourceSize: source.size,
    centralOffset: central.offset,
    entries: Object.freeze(entries),
    pages: Object.freeze(pages),
  });
}
