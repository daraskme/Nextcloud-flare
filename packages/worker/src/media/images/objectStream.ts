import { LIMITS } from "@next-cloud-flare/shared/limits";
import type { ImageObject } from "./r2Source";

/** Full immutable image input; authority is rechecked for every bounded piece delivered. */
export async function openImageObject(
  bucket: R2Bucket,
  object: ImageObject,
  signal: AbortSignal,
  authorize: () => Promise<void>,
): Promise<ReadableStream<Uint8Array>> {
  if (
    !Number.isSafeInteger(object.size) ||
    object.size < 1 ||
    object.size > LIMITS.imageBytes ||
    !object.key ||
    !object.etag
  )
    throw new Error("invalid_image_object");
  signal.throwIfAborted();
  let body: R2ObjectBody | undefined,
    reader: ReadableStreamDefaultReader<Uint8Array> | undefined,
    controller: ReadableStreamDefaultController<Uint8Array> | undefined,
    closed = false;
  let rejectStop!: (error: unknown) => void;
  const stopped = new Promise<never>((_, reject) => {
    rejectStop = reject;
  });
  const cancel = (reason?: unknown) => {
    if (reader) void reader.cancel(reason).catch(() => undefined);
    else void body?.body.cancel(reason).catch(() => undefined);
  };
  const close = () => {
    closed = true;
    signal.removeEventListener("abort", abort);
    reader?.releaseLock();
  };
  const abort = () => {
    cancel(signal.reason);
    if (!closed) controller?.error(signal.reason);
    rejectStop(signal.reason);
    // An unresolved GET still has its own completion handler to discard a late body.
  };
  const open = async () => {
    await authorize();
    signal.throwIfAborted();
    const response = await bucket.get(object.key, { onlyIf: { etagMatches: object.etag } });
    if (response && "body" in response) body = response;
    try {
      signal.throwIfAborted();
      if (
        !body ||
        body.key !== object.key ||
        body.size !== object.size ||
        body.etag !== object.etag ||
        (body.range !== undefined &&
          (!("offset" in body.range) ||
            body.range.offset !== 0 ||
            body.range.length !== object.size))
      )
        throw new Error("image_source_changed");
      await authorize();
      signal.throwIfAborted();
      reader = body.body.getReader();
      let bytes = 0,
        reads = 0,
        pending: Uint8Array = new Uint8Array(),
        offset = 0;
      return new ReadableStream<Uint8Array>(
        {
          start(value) {
            controller = value;
          },
          async pull(target) {
            try {
              await authorize();
              signal.throwIfAborted();
              while (offset === pending.length) {
                if (++reads > 4096) throw new Error("image_source_chunk_limit");
                const next = await reader!.read();
                signal.throwIfAborted();
                if (next.done) {
                  if (bytes !== object.size) throw new Error("image_source_length_mismatch");
                  await authorize();
                  signal.throwIfAborted();
                  target.close();
                  close();
                  return;
                }
                pending = next.value;
                offset = 0;
                if (bytes + pending.length > object.size)
                  throw new Error("image_source_length_mismatch");
              }
              await authorize();
              signal.throwIfAborted();
              const part = pending.subarray(offset, offset + 65536);
              offset += part.length;
              bytes += part.length;
              target.enqueue(part);
            } catch (error) {
              if (!closed) target.error(error);
              cancel(error);
              close();
            }
          },
          cancel(reason) {
            cancel(reason);
            close();
          },
        },
        { highWaterMark: 0 },
      );
    } catch (error) {
      cancel(error);
      close();
      throw error;
    }
  };
  signal.addEventListener("abort", abort, { once: true });
  try {
    return await Promise.race([open(), stopped]);
  } catch (error) {
    cancel(error);
    close();
    throw error;
  }
}
