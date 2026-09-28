import { IMAGE_METADATA_LIMITS, type ImageSource } from "./reader";

export interface ImageReadBudget {
  reads: number;
  bytes: number;
}
export interface ImageObject {
  key: string;
  size: number;
  etag: string;
}

/** Conditional native ranges with bounded memory, exact length, a deadline and late-body cancellation. */
export function imageObjectSource(
  bucket: R2Bucket,
  object: ImageObject,
  signal: AbortSignal,
  authorize: () => Promise<void>,
  budget: ImageReadBudget,
): ImageSource {
  return {
    size: object.size,
    async read(offset, length) {
      if (
        !Number.isSafeInteger(offset) ||
        !Number.isSafeInteger(length) ||
        offset < 0 ||
        length <= 0 ||
        length > 32768 ||
        offset + length > object.size
      )
        throw new Error("invalid_image_range");
      let body: R2ObjectBody | undefined,
        reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
      let rejectStop!: (reason: unknown) => void;
      const stopped = new Promise<never>((_, reject) => {
        rejectStop = reject;
      });
      const abort = () => {
        rejectStop(signal.reason);
        if (reader) void reader.cancel(signal.reason).catch(() => undefined);
        else void body?.body.cancel(signal.reason).catch(() => undefined);
      };
      const run = async () => {
        signal.throwIfAborted();
        await authorize();
        signal.throwIfAborted();
        if (
          budget.reads >= IMAGE_METADATA_LIMITS.reads ||
          budget.bytes + length > IMAGE_METADATA_LIMITS.bytes
        )
          throw new Error("image_invocation_budget_exceeded");
        budget.reads++;
        budget.bytes += length;
        const response = await bucket.get(object.key, {
          onlyIf: { etagMatches: object.etag },
          range: { offset, length },
        });
        if (response && "body" in response) body = response;
        signal.throwIfAborted();
        if (
          !body ||
          body.key !== object.key ||
          body.size !== object.size ||
          body.etag !== object.etag ||
          !body.range ||
          !("offset" in body.range) ||
          body.range.offset !== offset ||
          body.range.length !== length
        )
          throw new Error("image_source_changed");
        reader = body.body.getReader();
        const bytes = new Uint8Array(length);
        let count = 0;
        for (;;) {
          const next = await reader.read();
          signal.throwIfAborted();
          if (next.done) break;
          if (count + next.value.length > length) throw new Error("image_source_length_mismatch");
          bytes.set(next.value, count);
          count += next.value.length;
        }
        if (count !== length) throw new Error("image_source_length_mismatch");
        await authorize();
        signal.throwIfAborted();
        return bytes;
      };
      signal.addEventListener("abort", abort, { once: true });
      try {
        return await Promise.race([
          run().finally(() => {
            if (reader) {
              void reader.cancel().catch(() => undefined);
              reader.releaseLock();
            } else void body?.body.cancel().catch(() => undefined);
          }),
          stopped,
        ]);
      } finally {
        signal.removeEventListener("abort", abort);
      }
    },
  };
}
