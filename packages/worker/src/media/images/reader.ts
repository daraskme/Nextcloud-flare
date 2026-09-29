/** Random access to a fixed immutable object. Implementations must verify the exact range. */
export interface ImageSource {
  readonly size: number;
  read(offset: number, length: number): Promise<Uint8Array>;
}
export class ImageFormatError extends Error {
  constructor() {
    super("image_metadata_unavailable");
  }
}
export const IMAGE_METADATA_LIMITS = Object.freeze({
  bytes: 2 * 1024 * 1024,
  reads: 64,
  structures: 4096,
  fieldBytes: 1024,
  exifBytes: 65536,
});
export function valid(condition: unknown): asserts condition {
  if (!condition) throw new ImageFormatError();
}
export function ascii(bytes: Uint8Array, at = 0, length = bytes.length - at) {
  valid(length <= 4096 && at >= 0 && at + length <= bytes.length);
  return String.fromCharCode(...bytes.subarray(at, at + length));
}
export const view = (bytes: Uint8Array) =>
  new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

/** A four-page cache bounds memory and native GETs; skipped image payloads are never buffered. */
export class ImageReader {
  readonly size: number;
  #pages = new Map<number, Uint8Array>();
  #bytes = 0;
  #reads = 0;
  #structures = 0;
  constructor(
    private source: ImageSource,
    private limits: { bytes: number; reads: number; structures: number } = IMAGE_METADATA_LIMITS,
  ) {
    this.size = source.size;
    valid(Number.isSafeInteger(this.size) && this.size >= 0);
  }
  step() {
    valid(++this.#structures <= this.limits.structures);
  }
  /** ID3v1 is exactly 128 trailing bytes; do not fetch an entire distant cache page. */
  async readTail128(): Promise<Uint8Array> {
    if (this.size < 128) return new Uint8Array();
    valid(++this.#reads <= this.limits.reads && (this.#bytes += 128) <= this.limits.bytes);
    let bytes: Uint8Array;
    try {
      bytes = await this.source.read(this.size - 128, 128);
    } catch (cause) {
      throw new Error("image_source_unavailable", { cause });
    }
    if (bytes.length !== 128) throw new Error("image_source_length_mismatch");
    return bytes;
  }
  async read(offset: number, length: number): Promise<Uint8Array> {
    valid(
      Number.isSafeInteger(offset) &&
        Number.isSafeInteger(length) &&
        offset >= 0 &&
        length >= 0 &&
        length <= this.limits.bytes &&
        offset + length <= this.size,
    );
    const result = new Uint8Array(length);
    for (let copied = 0; copied < length; ) {
      const start = Math.floor((offset + copied) / 32768) * 32768;
      let page = this.#pages.get(start);
      if (!page) {
        const count = Math.min(32768, this.size - start);
        valid(++this.#reads <= this.limits.reads);
        valid((this.#bytes += count) <= this.limits.bytes);
        try {
          page = await this.source.read(start, count);
        } catch (cause) {
          throw new Error("image_source_unavailable", { cause });
        }
        // I/O failures are retryable; a malformed image is a terminal, non-image result.
        if (page.byteLength !== count) throw new Error("image_source_length_mismatch");
        if (this.#pages.size >= 4) this.#pages.delete(this.#pages.keys().next().value!);
        this.#pages.set(start, page);
      }
      const from = offset + copied - start;
      const count = Math.min(length - copied, page.length - from);
      result.set(page.subarray(from, from + count), copied);
      copied += count;
    }
    return result;
  }
}
