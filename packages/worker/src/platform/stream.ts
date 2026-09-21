import { LIMITS } from "@next-cloud-flare/shared/limits";

export function validateLength(bytes: number): void {
  if (!Number.isSafeInteger(bytes) || bytes < 0) throw new RangeError("invalid_length");
  if (bytes > LIMITS.requestBytes) throw new RangeError("payload_too_large");
}

export function hex(buffer: ArrayBuffer): string {
  return Array.from(new Uint8Array(buffer), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** One producer feeds both sinks in lockstep; no tee or whole-body buffering. */
export async function consumeKnownLength<T>(
  source: ReadableStream<Uint8Array>,
  expectedBytes: number,
  consume: (body: ReadableStream<Uint8Array>) => Promise<T>,
): Promise<{ value: T; bytes: number; sha256: string }> {
  validateLength(expectedBytes);
  const fixed = new FixedLengthStream(expectedBytes);
  const writer = fixed.writable.getWriter();
  const digest = new crypto.DigestStream("SHA-256");
  const hashWriter = digest.getWriter();
  const abort = new AbortController();
  let bytes = 0;
  const stop = (reason: unknown) => {
    abort.abort(reason);
    // Conditional R2 rejection can return without locking or reading the stream.
    if (!fixed.readable.locked) void fixed.readable.cancel(reason).catch(() => {});
    void writer.abort(reason).catch(() => {});
    void hashWriter.abort(reason).catch(() => {});
  };
  const producer = source
    .pipeTo(
      new WritableStream<Uint8Array>({
        async write(chunk) {
          bytes += chunk.byteLength;
          if (bytes > expectedBytes) throw new RangeError("invalid_length");
          for (let offset = 0; offset < chunk.byteLength; offset += LIMITS.streamChunkBytes) {
            const part = chunk.subarray(offset, offset + LIMITS.streamChunkBytes);
            await hashWriter.write(part);
            await writer.write(part);
          }
        },
        async close() {
          if (bytes !== expectedBytes) throw new RangeError("invalid_length");
          await writer.close();
          await hashWriter.close();
        },
        abort: stop,
      }),
      { signal: abort.signal },
    )
    .catch((error) => {
      stop(error);
      throw error;
    });
  const consumer = Promise.resolve()
    .then(() => consume(fixed.readable))
    .catch((error) => {
      stop(error);
      throw error;
    });
  // Attach all rejection handlers immediately, including the digest's abort rejection.
  const results = await Promise.allSettled([producer, consumer, digest.digest]);
  writer.releaseLock();
  hashWriter.releaseLock();
  const failure = results.find((result) => result.status === "rejected");
  if (failure?.status === "rejected") throw failure.reason;
  const value = results[1];
  const hash = results[2];
  if (value.status !== "fulfilled" || hash.status !== "fulfilled") throw new Error("stream_failed");
  return { value: value.value, bytes, sha256: hex(hash.value) };
}

/** Probe primitive only. Upload admission and durable ledger are implemented in Phase 3. */
export function putImmutableProbe(
  bucket: R2Bucket,
  key: string,
  body: ReadableStream<Uint8Array>,
  size: number,
) {
  return consumeKnownLength(body, size, async (stream) => {
    const object = await bucket.put(key, stream, { onlyIf: { etagDoesNotMatch: "*" } });
    if (object === null) throw new Error("precondition_failed");
    return object;
  });
}
