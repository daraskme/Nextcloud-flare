export const MEDIA_SNIFF_BYTES = 65_536;
const MAX_HEADER_BYTES = 4096;
export type MediaContainer =
  | { container: "avif"; animated: boolean }
  | { container: "mp4" | "webm" | "ogg" };

function ascii(bytes: Uint8Array, offset: number, length: number): string {
  return String.fromCharCode(...bytes.subarray(offset, offset + length));
}

function bmff(bytes: Uint8Array): MediaContainer | null {
  if (bytes.length < 16 || ascii(bytes, 4, 4) !== "ftyp") return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let length = view.getUint32(0);
  let header = 8;
  if (length === 1) {
    if (bytes.length < 24) return null;
    const extended = view.getBigUint64(8);
    if (extended > BigInt(MAX_HEADER_BYTES)) return null;
    length = Number(extended);
    header = 16;
  }
  if (length < header + 8 || length > bytes.length || length > MAX_HEADER_BYTES || length % 4 !== 0)
    return null;
  const brands = new Set([ascii(bytes, header, 4)]);
  // Skip the numeric minor_version field; arbitrary bytes there are not a brand.
  for (let at = header + 8; at < length; at += 4) brands.add(ascii(bytes, at, 4));
  if (brands.has("avif") || brands.has("avis"))
    return { container: "avif", animated: brands.has("avis") };
  if (["heic", "heix", "hevc", "hevx", "mif1", "msf1"].some((brand) => brands.has(brand)))
    return null;
  if (
    ["mp41", "mp42", "isom", "iso2", "iso6", "av01", "M4A ", "dash"].some((brand) =>
      brands.has(brand),
    )
  )
    return { container: "mp4" };
  return null;
}

function vint(bytes: Uint8Array, at: number, id = false): { value: number; length: number } | null {
  const first = bytes[at];
  if (!first) return null;
  let length = 1;
  let mask = 128;
  while (!(first & mask)) {
    mask >>= 1;
    length++;
  }
  if (length > (id ? 4 : 8) || at + length > bytes.length) return null;
  let value = id ? first : first & (mask - 1);
  let allOnes = (first & (mask - 1)) === mask - 1;
  for (let i = 1; i < length; i++) {
    const byte = bytes[at + i] ?? 0;
    value = value * 256 + byte;
    allOnes &&= byte === 255;
  }
  if (!Number.isSafeInteger(value) || (!id && allOnes)) return null;
  return { value, length };
}

function webm(bytes: Uint8Array): MediaContainer | null {
  if (bytes[0] !== 0x1a || bytes[1] !== 0x45 || bytes[2] !== 0xdf || bytes[3] !== 0xa3) return null;
  const size = vint(bytes, 4);
  if (!size) return null;
  let at = 4 + size.length;
  const end = at + size.value;
  if (end > bytes.length || end > MAX_HEADER_BYTES) return null;
  let docType: string | null = null;
  while (at < end) {
    const id = vint(bytes, at, true);
    if (!id) return null;
    at += id.length;
    const length = vint(bytes, at);
    if (!length) return null;
    at += length.length;
    if (at + length.value > end) return null;
    if (id.value === 0x4282) {
      if (docType !== null || length.value !== 4) return null;
      docType = ascii(bytes, at, length.value);
    }
    at += length.value;
  }
  return docType === "webm" ? { container: "webm" } : null;
}

/** Bounded container recognition, not a decoder or proof of the track codec.
 * Callers must inspect tracks before declaring AV1/Opus and keep existing auth/purpose delivery gates.
 */
export function sniffMediaContainer(prefix: Uint8Array): MediaContainer | null {
  if (prefix.byteLength > MEDIA_SNIFF_BYTES) throw new RangeError("media_sniff_budget_exceeded");
  const iso = bmff(prefix);
  if (iso) return iso;
  const ebml = webm(prefix);
  if (ebml) return ebml;
  if (prefix.length >= 27 && ascii(prefix, 0, 4) === "OggS" && prefix[4] === 0 && prefix[5] === 2) {
    const segments = prefix[26] ?? 0;
    if (segments === 0 || prefix.length < 27 + segments) return null;
    let pageLength = 27 + segments;
    for (let i = 0; i < segments; i++) pageLength += prefix[27 + i] ?? 0;
    if (pageLength <= prefix.length) return { container: "ogg" };
  }
  return null;
}
