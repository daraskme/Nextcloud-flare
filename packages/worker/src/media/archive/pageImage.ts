import { sniffMediaContainer } from "../sniff";

/** Bounded MIME recognition (not image decoding). WHATWG image patterns plus AVIF ftyp.
 * https://mimesniff.spec.whatwg.org/#matching-an-image-type-pattern
 */
export function pageImageType(bytes: Uint8Array): string | null {
  const starts = (pattern: readonly number[]) => pattern.every((n, i) => bytes[i] === n);
  const ascii = (at: number, length: number) =>
    String.fromCharCode(...bytes.subarray(at, at + length));
  if (starts([0xff, 0xd8, 0xff])) return "image/jpeg";
  if (starts([0x89, 0x50, 0x4e, 0x47, 13, 10, 26, 10])) return "image/png";
  if (ascii(0, 6) === "GIF87a" || ascii(0, 6) === "GIF89a") return "image/gif";
  if (ascii(0, 4) === "RIFF" && ascii(8, 6) === "WEBPVP") return "image/webp";
  if (sniffMediaContainer(bytes.subarray(0, 4096))?.container === "avif") return "image/avif";
  return null;
}

/** Hold at most 4 KiB plus one bounded archive chunk; preserve CRC errors and cancellation. */
export async function identifyPageImage(
  input: ReadableStream<Uint8Array>,
  size: number,
  checkpoint: () => Promise<void>,
) {
  const reader = input.getReader(),
    chunks: Uint8Array[] = [];
  let length = 0,
    ended = false,
    closed = false;
  const stop = (reason?: unknown) => {
    if (closed) return;
    closed = true;
    void reader
      .cancel(reason)
      .catch(() => undefined)
      .finally(() => reader.releaseLock());
  };
  try {
    while (length < Math.min(size, 4096)) {
      await checkpoint();
      const next = await reader.read();
      if (next.done) {
        ended = true;
        break;
      }
      chunks.push(next.value);
      length += next.value.length;
    }
    const prefix = new Uint8Array(Math.min(length, 4096));
    let at = 0;
    for (const chunk of chunks) {
      const part = chunk.subarray(0, prefix.length - at);
      prefix.set(part, at);
      at += part.length;
    }
    const mime = pageImageType(prefix);
    if (!mime) throw new Error("archive_page_not_image");
    // Small entries must also finish their CRC check before HEAD/304 can report success.
    if (length === size) {
      const next = await reader.read();
      if (!next.done) throw new Error("archive_output_size_mismatch");
      ended = true;
    }
    await checkpoint();
    return {
      mime,
      body: new ReadableStream<Uint8Array>(
        {
          async pull(controller) {
            try {
              await checkpoint();
              if (closed) return;
              const chunk = chunks.shift();
              if (chunk) {
                controller.enqueue(chunk);
                return;
              }
              if (ended) {
                closed = true;
                reader.releaseLock();
                controller.close();
                return;
              }
              const next = await reader.read();
              await checkpoint();
              if (closed) return;
              if (next.done) {
                closed = true;
                reader.releaseLock();
                controller.close();
              } else controller.enqueue(next.value);
            } catch (error) {
              if (!closed) {
                stop(error);
                controller.error(error);
              }
            }
          },
          cancel: stop,
        },
        { highWaterMark: 0 },
      ),
    };
  } catch (error) {
    stop(error);
    throw error;
  }
}
