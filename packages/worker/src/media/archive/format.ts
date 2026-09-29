/** Limits apply to imported books, independently of the smaller ZIP export limits. */
export const ARCHIVE_LIMITS = {
  tailBytes: 1_048_576,
  centralBytes: 8_388_608,
  indexBytes: 8_388_608,
  entries: 10_000,
  entryBytes: 67_108_864,
  compressedBytes: 67_108_864 + 65_536,
  totalBytes: 8_589_934_592,
  nameBytes: 1_024,
  depth: 64,
  chunkBytes: 65_536,
} as const;

export class ArchiveError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "ArchiveError";
  }
}

export function requireArchive(condition: unknown, code = "invalid_archive"): asserts condition {
  if (!condition) throw new ArchiveError(code);
}

export function dataView(bytes: Uint8Array): DataView {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}

export function wide(view: DataView, at: number): number {
  requireArchive(at >= 0 && at + 8 <= view.byteLength);
  const value = view.getBigUint64(at, true);
  requireArchive(value <= BigInt(Number.MAX_SAFE_INTEGER), "archive_integer_overflow");
  return Number(value);
}

export function range(offset: number, length: number, end: number): void {
  requireArchive(
    Number.isSafeInteger(offset) &&
      Number.isSafeInteger(length) &&
      Number.isSafeInteger(end) &&
      offset >= 0 &&
      length >= 0 &&
      offset <= end &&
      length <= end - offset,
    "archive_range_invalid",
  );
}

const crcTable = Uint32Array.from({ length: 256 }, (_, i) => {
  let crc = i;
  for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  return crc >>> 0;
});

/** Pass the previous, finalized CRC to continue across chunks. */
export function crc32(bytes: Uint8Array, previous = 0): number {
  let crc = previous ^ 0xffffffff;
  for (const byte of bytes) crc = (crc >>> 8) ^ crcTable[(crc ^ byte) & 255]!;
  return (crc ^ 0xffffffff) >>> 0;
}

export function extraFields(bytes: Uint8Array): Map<number, Uint8Array> {
  const fields = new Map<number, Uint8Array>(),
    view = dataView(bytes);
  for (let at = 0; at < bytes.length; ) {
    requireArchive(at + 4 <= bytes.length);
    const id = view.getUint16(at, true),
      size = view.getUint16(at + 2, true);
    requireArchive(at + 4 + size <= bytes.length && !fields.has(id));
    fields.set(id, bytes.subarray(at + 4, at + 4 + size));
    at += 4 + size;
  }
  // Encryption and patched records are not accepted even if the flags were cleared.
  for (const id of [0x0017, 0x9901, 0x000f])
    requireArchive(!fields.has(id), "unsupported_archive_feature");
  return fields;
}

export function checkMethod(flags: number, method: number, version: number): void {
  requireArchive((method === 0 || method === 8) && version <= 45, "unsupported_archive_method");
  requireArchive((flags & ~(0x0808 | (method === 8 ? 6 : 0))) === 0, "unsupported_archive_flags");
}

// ZIP's specified legacy encoding, not a guess based on the host locale.
const cp437 =
  "ÇüéâäàåçêëèïîìÄÅÉæÆôöòûùÿÖÜ¢£¥₧ƒ" +
  "áíóúñÑªº¿⌐¬½¼¡«»░▒▓│┤╡╢╖╕╣║╗╝╜╛┐" +
  "└┴┬├─┼╞╟╚╔╩╦╠═╬╧╨╤╥╙╘╒╓╫╪┘┌█▄▌▐▀" +
  "αßΓπΣσµτΦΘΩδ∞φε∩≡±≥≤⌠⌡÷≈°∙·√ⁿ²■ ";

function utf8(bytes: Uint8Array): string {
  try {
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    throw new ArchiveError("archive_name_encoding");
  }
}

export function safePath(value: string): string {
  const path = value.normalize("NFC"),
    parts = path.replace(/\/$/, "").split("/");
  requireArchive(
    path.length > 0 &&
      new TextEncoder().encode(path).length <= ARCHIVE_LIMITS.nameBytes &&
      !/[\\:\u0000-\u001f\u007f-\u009f]/u.test(path) &&
      parts.length <= ARCHIVE_LIMITS.depth &&
      parts.every((part) => part !== "" && part !== "." && part !== ".."),
    "archive_unsafe_path",
  );
  return path;
}

export function entryPath(raw: Uint8Array, flags: number, fields: Map<number, Uint8Array>): string {
  requireArchive(raw.length > 0 && raw.length <= ARCHIVE_LIMITS.nameBytes, "archive_unsafe_path");
  const decoded =
    flags & 0x800
      ? utf8(raw)
      : Array.from(raw, (b) => (b < 128 ? String.fromCharCode(b) : cp437[b - 128])).join("");
  // Reject a dangerous legacy spelling even when a Unicode override is present.
  const fallback = safePath(decoded),
    unicode = fields.get(0x7075);
  if (!unicode || unicode[0] !== 1) return fallback;
  requireArchive(unicode.length >= 5);
  if (dataView(unicode).getUint32(1, true) !== crc32(raw)) return fallback;
  const path = safePath(utf8(unicode.subarray(5)));
  requireArchive(!(flags & 0x800) || path === fallback, "archive_name_mismatch");
  requireArchive(path.endsWith("/") === fallback.endsWith("/"), "archive_name_mismatch");
  return path;
}

export function encodedName(raw: Uint8Array): string {
  return btoa(String.fromCharCode(...raw));
}

/** Locale-independent natural order; digit runs never pass through floating point. */
export function comparePaths(left: string, right: string): number {
  const a = left.match(/[0-9]+|[^0-9]+/g) ?? [],
    b = right.match(/[0-9]+|[^0-9]+/g) ?? [];
  for (let i = 0; i < Math.min(a.length, b.length); i++) {
    const x = a[i]!,
      y = b[i]!;
    if (x === y) continue;
    if (/^[0-9]/.test(x) && /^[0-9]/.test(y)) {
      const nx = x.replace(/^0+/, "") || "0",
        ny = y.replace(/^0+/, "") || "0";
      if (nx.length !== ny.length) return nx.length - ny.length;
      if (nx !== ny) return nx < ny ? -1 : 1;
      if (x.length !== y.length) return x.length - y.length;
    }
    return x < y ? -1 : 1;
  }
  return a.length - b.length;
}

/** A page candidate only. Delivery must inspect the actual image, not trust an extension. */
export function imageCandidate(path: string): string | null {
  const extension = path.slice(path.lastIndexOf(".") + 1).toLowerCase();
  switch (extension) {
    case "jpg":
    case "jpeg":
      return "image/jpeg";
    case "png":
      return "image/png";
    case "webp":
      return "image/webp";
    case "gif":
      return "image/gif";
    case "avif":
      return "image/avif";
    default:
      return null;
  }
}
