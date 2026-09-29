import { hex } from "../../platform/stream";
import {
  ARCHIVE_LIMITS,
  checkMethod,
  comparePaths,
  encodedName,
  entryPath,
  imageCandidate,
  range,
  requireArchive,
  safePath,
} from "./format";
import type { ArchiveEntry, ArchiveIndex } from "./index";

export const ARCHIVE_GENERATOR = "archive-index-v1";
export interface ArchiveOriginal {
  ownerId: string;
  blobId: string;
  key: string;
  size: number;
  etag: string;
}
export interface ArchiveIndexOutput {
  bytes: Uint8Array;
  sha256: string;
  entryCount: number;
  pageCount: number;
}
function record(value: unknown, keys: string): Record<string, unknown> {
  requireArchive(
    value && typeof value === "object" && !Array.isArray(value),
    "invalid_archive_index",
  );
  requireArchive(Object.keys(value).sort().join(",") === keys, "invalid_archive_index");
  return value as Record<string, unknown>;
}
const integer = (n: unknown, max = Number.MAX_SAFE_INTEGER): n is number =>
  typeof n === "number" && Number.isSafeInteger(n) && n >= 0 && n <= max;

export function archiveOriginal(value: unknown): ArchiveOriginal {
  const r = record(value, "blobId,etag,key,ownerId,size");
  requireArchive(
    typeof r.ownerId === "string" &&
      /^[A-Za-z0-9_-]{1,128}$/.test(r.ownerId) &&
      typeof r.blobId === "string" &&
      /^[A-Za-z0-9_-]{1,128}$/.test(r.blobId) &&
      r.key === `u/${r.ownerId}/b/${r.blobId}` &&
      integer(r.size) &&
      r.size >= 22 &&
      typeof r.etag === "string" &&
      r.etag.length > 0 &&
      r.etag.length <= 256,
    "invalid_archive_index",
  );
  return { ownerId: r.ownerId, blobId: r.blobId, key: r.key, size: r.size, etag: r.etag };
}

/** Validate persisted indices before any field can become an original-object Range. */
export function validateArchiveIndex(value: unknown, sourceSize: number): ArchiveIndex {
  const r = record(value, "centralOffset,entries,pages,sourceSize,version");
  requireArchive(
    r.version === ARCHIVE_GENERATOR &&
      integer(sourceSize) &&
      sourceSize >= 22 &&
      r.sourceSize === sourceSize &&
      integer(r.centralOffset) &&
      r.centralOffset <= sourceSize - 22 &&
      Array.isArray(r.entries) &&
      r.entries.length <= ARCHIVE_LIMITS.entries &&
      Array.isArray(r.pages),
    "invalid_archive_index",
  );
  const paths = new Map<string, boolean>();
  let total = 0;
  const entries = r.entries.map((value): ArchiveEntry => {
    const e = record(
      value,
      "compressedSize,crc32,directory,endOffset,flags,localOffset,method,path,rawName,size,version,zip64",
    );
    requireArchive(
      typeof e.path === "string" &&
        safePath(e.path) === e.path &&
        typeof e.rawName === "string" &&
        e.rawName.length <= 1368 &&
        integer(e.flags, 65535) &&
        integer(e.method, 65535) &&
        integer(e.version, 65535) &&
        integer(e.crc32, 0xffffffff) &&
        integer(e.size, ARCHIVE_LIMITS.entryBytes) &&
        integer(e.compressedSize, ARCHIVE_LIMITS.compressedBytes) &&
        integer(e.localOffset) &&
        integer(e.endOffset) &&
        typeof e.directory === "boolean" &&
        typeof e.zip64 === "boolean",
      "invalid_archive_index",
    );
    let name: Uint8Array;
    try {
      name = Uint8Array.from(atob(e.rawName), (c) => c.charCodeAt(0));
    } catch {
      throw new Error("invalid_archive_index");
    }
    requireArchive(
      name.length > 0 && name.length <= ARCHIVE_LIMITS.nameBytes && encodedName(name) === e.rawName,
      "invalid_archive_index",
    );
    checkMethod(e.flags, e.method, e.version);
    const fallback = entryPath(name, e.flags, new Map());
    requireArchive(!(e.flags & 0x800) || fallback === e.path, "invalid_archive_index");
    const key = e.path.replace(/\/$/, "");
    requireArchive(
      !paths.has(key) &&
        e.directory === e.path.endsWith("/") &&
        (!e.directory || (e.size === 0 && e.compressedSize === 0)) &&
        (e.method !== 0 || e.size === e.compressedSize) &&
        (!e.zip64 || e.version >= 45),
      "invalid_archive_index",
    );
    paths.set(key, e.directory);
    total += e.size;
    requireArchive(total <= ARCHIVE_LIMITS.totalBytes, "archive_size_limit");
    range(
      e.localOffset,
      30 + name.length + e.compressedSize + (e.flags & 8 ? (e.zip64 ? 20 : 12) : 0),
      e.endOffset,
    );
    range(e.endOffset, 0, r.centralOffset as number);
    return Object.freeze({
      path: e.path,
      rawName: e.rawName,
      method: e.method,
      flags: e.flags,
      version: e.version,
      crc32: e.crc32,
      compressedSize: e.compressedSize,
      size: e.size,
      localOffset: e.localOffset,
      endOffset: e.endOffset,
      directory: e.directory,
      zip64: e.zip64,
    });
  });
  for (const path of paths.keys()) {
    let slash = path.indexOf("/");
    while (slash !== -1) {
      requireArchive(paths.get(path.slice(0, slash)) !== false, "archive_path_conflict");
      slash = path.indexOf("/", slash + 1);
    }
  }
  const physical = [...entries].sort((a, b) => a.localOffset - b.localOffset);
  for (let i = 0; i < physical.length; i++)
    requireArchive(
      physical[i]!.endOffset === (physical[i + 1]?.localOffset ?? r.centralOffset),
      "invalid_archive_index",
    );
  const pages = entries
    .map((entry, i) => ({ entry, i }))
    .filter(({ entry }) => !entry.directory && imageCandidate(entry.path))
    .sort((a, b) => comparePaths(a.entry.path, b.entry.path))
    .map(({ i }) => i);
  requireArchive(
    r.pages.length === pages.length && r.pages.every((n, i) => n === pages[i]),
    "invalid_archive_index",
  );
  return Object.freeze({
    version: ARCHIVE_GENERATOR,
    sourceSize,
    centralOffset: r.centralOffset,
    entries: Object.freeze(entries),
    pages: Object.freeze(pages),
  });
}

export async function encodeArchiveIndex(
  index: ArchiveIndex,
  input: ArchiveOriginal,
): Promise<ArchiveIndexOutput> {
  const original = archiveOriginal(input),
    checked = validateArchiveIndex(index, original.size);
  const bytes = new TextEncoder().encode(JSON.stringify({ original, index: checked }));
  requireArchive(bytes.length <= ARCHIVE_LIMITS.indexBytes, "archive_index_limit");
  return {
    bytes,
    sha256: hex(await crypto.subtle.digest("SHA-256", bytes)),
    entryCount: checked.entries.length,
    pageCount: checked.pages.length,
  };
}

export async function decodeArchiveIndex(
  bytes: Uint8Array,
  original: ArchiveOriginal,
  sha256: string,
): Promise<ArchiveIndex> {
  requireArchive(
    bytes.length > 0 && bytes.length <= ARCHIVE_LIMITS.indexBytes && /^[a-f0-9]{64}$/.test(sha256),
    "invalid_archive_index",
  );
  requireArchive(
    hex(await crypto.subtle.digest("SHA-256", bytes)) === sha256,
    "archive_index_checksum_mismatch",
  );
  let decoded: unknown;
  try {
    decoded = JSON.parse(new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes));
  } catch {
    throw new Error("invalid_archive_index");
  }
  const r = record(decoded, "index,original");
  requireArchive(
    JSON.stringify(archiveOriginal(r.original)) === JSON.stringify(archiveOriginal(original)),
    "archive_index_source_mismatch",
  );
  return validateArchiveIndex(r.index, original.size);
}
