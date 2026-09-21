const SNIFF_LENGTH = 64;

function startsWith(bytes: Uint8Array, signature: number[], offset = 0): boolean {
  if (bytes.length < offset + signature.length) return false;
  return signature.every((value, index) => bytes[offset + index] === value);
}

function ascii(bytes: Uint8Array, text: string, offset = 0): boolean {
  return startsWith(bytes, Array.from(text, (char) => char.charCodeAt(0)), offset);
}

export function sniffMime(bytes: Uint8Array): string | null {
  if (startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return "image/png";
  if (startsWith(bytes, [0xff, 0xd8, 0xff])) return "image/jpeg";
  if (ascii(bytes, "GIF87a") || ascii(bytes, "GIF89a")) return "image/gif";
  if (ascii(bytes, "RIFF") && ascii(bytes, "WEBP", 8)) return "image/webp";
  if (ascii(bytes, "RIFF") && ascii(bytes, "WAVE", 8)) return "audio/wav";
  if (ascii(bytes, "RIFF") && ascii(bytes, "AVI ", 8)) return "video/x-msvideo";
  if (startsWith(bytes, [0x42, 0x4d])) return "image/bmp";
  if (ascii(bytes, "%PDF-")) return "application/pdf";
  if (ascii(bytes, "fLaC")) return "audio/flac";
  if (ascii(bytes, "ID3")) return "audio/mpeg";
  if (bytes.length >= 2 && bytes[0] === 0xff && ((bytes[1] ?? 0) & 0xe6) === 0xe2) return "audio/mpeg";
  if (ascii(bytes, "OggS")) {
    if (ascii(bytes, "OpusHead", 28)) return "audio/opus";
    return "audio/ogg";
  }
  if (ascii(bytes, "ftyp", 4)) {
    const brand = String.fromCharCode(...bytes.subarray(8, 12));
    if (brand === "M4A " || brand === "M4B ") return "audio/mp4";
    if (brand.startsWith("qt")) return "video/quicktime";
    if (brand === "avif" || brand === "avis") return "image/avif";
    if (brand === "heic" || brand === "heix" || brand === "mif1") return "image/heic";
    return "video/mp4";
  }
  if (startsWith(bytes, [0x1a, 0x45, 0xdf, 0xa3])) return "video/webm";
  if (ascii(bytes, "PK\u0003\u0004")) {
    if (ascii(bytes, "mimetypeapplication/epub+zip", 30)) return "application/epub+zip";
    return "application/zip";
  }
  if (ascii(bytes, "Rar!\u001a\u0007")) return "application/vnd.rar";
  if (startsWith(bytes, [0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c])) return "application/x-7z-compressed";
  if (startsWith(bytes, [0x1f, 0x8b])) return "application/gzip";
  return null;
}

export async function sniffObjectMime(bucket: R2Bucket, key: string): Promise<string | null> {
  try {
    const object = await bucket.get(key, { range: { offset: 0, length: SNIFF_LENGTH } });
    if (object === null) return null;
    return sniffMime(new Uint8Array(await object.arrayBuffer()));
  } catch {
    return null;
  }
}

export function resolveBlobMime(sniffed: string | null, declared: string | undefined): string {
  if (sniffed !== null) return sniffed;
  const candidate = declared?.trim().toLowerCase();
  if (candidate === undefined || candidate === "" || candidate === "application/octet-stream") {
    return "application/octet-stream";
  }
  if (!/^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/u.test(candidate)) return "application/octet-stream";
  const passive =
    ((candidate.startsWith("image/") && candidate !== "image/svg+xml") ||
      candidate.startsWith("audio/") ||
      candidate.startsWith("video/") ||
      candidate === "text/plain" ||
      candidate === "text/markdown" ||
      candidate === "text/csv" ||
      candidate === "application/json" ||
      candidate === "application/pdf" ||
      candidate === "application/zip" ||
      candidate === "application/epub+zip") &&
    !candidate.includes("xml");
  return passive ? candidate : "application/octet-stream";
}
