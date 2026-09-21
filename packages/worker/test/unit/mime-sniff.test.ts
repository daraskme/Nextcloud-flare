import { describe, expect, it } from "vitest";

import { resolveBlobMime, sniffMime } from "../../src/services/mimeSniff.js";

function bytes(...parts: (number[] | string)[]): Uint8Array {
  const out: number[] = [];
  for (const part of parts) {
    if (typeof part === "string") out.push(...Array.from(part, (c) => c.charCodeAt(0)));
    else out.push(...part);
  }
  return new Uint8Array(out);
}

describe("sniffMime", () => {
  it("recognises the media formats used by gallery, bookshelf and audio", () => {
    expect(sniffMime(bytes([0x89], "PNG", [0x0d, 0x0a, 0x1a, 0x0a], "...."))).toBe("image/png");
    expect(sniffMime(bytes([0xff, 0xd8, 0xff, 0xe0]))).toBe("image/jpeg");
    expect(sniffMime(bytes("RIFF", [1, 2, 3, 4], "WEBPVP8 "))).toBe("image/webp");
    expect(sniffMime(bytes("fLaC", [0, 0, 0, 0x22]))).toBe("audio/flac");
    expect(sniffMime(bytes("ID3", [4, 0, 0, 0, 0, 0, 0]))).toBe("audio/mpeg");
    expect(sniffMime(bytes([0xff, 0xfb, 0x90, 0x00]))).toBe("audio/mpeg");
    expect(sniffMime(bytes([0, 0, 0, 0x18], "ftypM4A ", [0, 0, 0, 0]))).toBe("audio/mp4");
    expect(sniffMime(bytes([0, 0, 0, 0x18], "ftypisom", [0, 0, 0, 0]))).toBe("video/mp4");
    expect(sniffMime(bytes("%PDF-1.7"))).toBe("application/pdf");
    expect(sniffMime(bytes("PK", [3, 4], [0, 0, 0, 0]))).toBe("application/zip");
    expect(sniffMime(bytes("Rar!", [0x1a, 0x07, 0x01, 0x00]))).toBe("application/vnd.rar");
    expect(sniffMime(bytes([0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c]))).toBe(
      "application/x-7z-compressed",
    );
  });

  it("recognises the EPUB mimetype entry stored first and uncompressed", () => {
    // local file header (30 bytes) + name "mimetype" (8) + data
    const header = bytes("PK", [3, 4], new Array(22).fill(0), [8, 0], [0, 0]);
    const epub = bytes([...header], "mimetype", "application/epub+zip");
    expect(sniffMime(epub)).toBe("application/epub+zip");
  });

  it("returns null for unknown or empty content", () => {
    expect(sniffMime(new Uint8Array())).toBeNull();
    expect(sniffMime(bytes("hello world"))).toBeNull();
  });
});

describe("resolveBlobMime", () => {
  it("prefers sniffed content over the declared type", () => {
    expect(resolveBlobMime("image/png", "text/html")).toBe("image/png");
  });

  it("only trusts passive declared types when sniffing fails", () => {
    expect(resolveBlobMime(null, "text/plain")).toBe("text/plain");
    expect(resolveBlobMime(null, "Application/JSON")).toBe("application/json");
    expect(resolveBlobMime(null, "text/html")).toBe("application/octet-stream");
    expect(resolveBlobMime(null, "image/svg+xml")).toBe("application/octet-stream");
    expect(resolveBlobMime(null, "application/xhtml+xml")).toBe("application/octet-stream");
    expect(resolveBlobMime(null, undefined)).toBe("application/octet-stream");
    expect(resolveBlobMime(null, "not a mime")).toBe("application/octet-stream");
  });
});
