import { ARCHIVE_LIMITS, range, requireArchive } from "./format";
import type { ArchiveSource } from "./index";

export interface ArchiveObject {
  readonly key: string;
  readonly size: number;
  readonly etag: string;
}

export interface ArchiveReadBudget {
  reads: number;
  bytes: number;
  readonly maxReads: number;
  readonly maxBytes: number;
}

/** Conditional ranges only. The caller owns the deadline, authority and invocation budget. */
export function archiveObjectSource(
  bucket: R2Bucket,
  sourceObject: ArchiveObject,
  signal: AbortSignal,
  authorize: () => Promise<void>,
  budget: ArchiveReadBudget,
): ArchiveSource {
  const object = Object.freeze({ ...sourceObject });
  requireArchive(
    object.key && object.etag && Number.isSafeInteger(object.size) && object.size >= 22,
  );
  for (const n of [budget.reads, budget.bytes, budget.maxReads, budget.maxBytes])
    requireArchive(Number.isSafeInteger(n) && n >= 0, "archive_budget_invalid");
  const checkpoint = async () => {
    signal.throwIfAborted();
    await authorize();
    signal.throwIfAborted();
  };
  const open = async (offset: number, length: number): Promise<ReadableStream<Uint8Array>> => {
    range(offset, length, object.size);
    requireArchive(length > 0 && length <= ARCHIVE_LIMITS.compressedBytes, "archive_range_limit");
    let body: R2ObjectBody | undefined, reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    let controller: ReadableStreamDefaultController<Uint8Array> | undefined,
      closed = false;
    let rejectStopped!: (reason: unknown) => void;
    const stopped = new Promise<never>((_, reject) => {
      rejectStopped = reject;
    });
    const cancelBody = (reason?: unknown) => {
      if (reader) {
        const active = reader;
        reader = undefined;
        void active
          .cancel(reason)
          .catch(() => undefined)
          .finally(() => active.releaseLock());
      } else void body?.body.cancel(reason).catch(() => undefined);
    };
    const finish = () => {
      closed = true;
      signal.removeEventListener("abort", abort);
    };
    const abort = () => {
      cancelBody(signal.reason);
      if (!closed) controller?.error(signal.reason);
      rejectStopped(signal.reason);
      finish();
    };
    const run = async () => {
      try {
        await checkpoint();
        requireArchive(
          budget.reads < budget.maxReads && length <= budget.maxBytes - budget.bytes,
          "archive_read_budget_exceeded",
        );
        budget.reads++;
        budget.bytes += length;
        const response = await bucket.get(object.key, {
          onlyIf: { etagMatches: object.etag },
          range: { offset, length },
        });
        if (response && "body" in response) body = response;
        signal.throwIfAborted();
        requireArchive(
          body &&
            body.key === object.key &&
            body.size === object.size &&
            body.etag === object.etag &&
            body.range &&
            "offset" in body.range &&
            body.range.offset === offset &&
            body.range.length === length,
          "archive_source_changed",
        );
        await checkpoint();
        reader = body.body.getReader();
        let count = 0,
          chunks = 0,
          position = 0;
        let pending: Uint8Array = new Uint8Array();
        return new ReadableStream<Uint8Array>(
          {
            start(value) {
              controller = value;
            },
            async pull(target) {
              try {
                await checkpoint();
                if (closed) return;
                while (position === pending.length) {
                  requireArchive(++chunks <= 131_072, "archive_chunk_limit");
                  const next = await reader!.read();
                  await checkpoint();
                  if (closed) return;
                  if (next.done) {
                    requireArchive(count === length, "archive_source_length_mismatch");
                    reader!.releaseLock();
                    reader = undefined;
                    finish();
                    target.close();
                    return;
                  }
                  requireArchive(
                    next.value.length <= length - count,
                    "archive_source_length_mismatch",
                  );
                  pending = next.value;
                  position = 0;
                }
                const part = pending.subarray(position, position + ARCHIVE_LIMITS.chunkBytes);
                position += part.length;
                count += part.length;
                target.enqueue(part);
              } catch (error) {
                if (!closed) target.error(error);
                cancelBody(error);
                finish();
              }
            },
            cancel(reason) {
              cancelBody(reason);
              finish();
            },
          },
          { highWaterMark: 0 },
        );
      } catch (error) {
        // Also disposes a GET which resolves after the timeout won the race.
        cancelBody(error);
        finish();
        throw error;
      }
    };
    signal.addEventListener("abort", abort, { once: true });
    return Promise.race([run(), stopped]);
  };
  return {
    size: object.size,
    open,
    async read(offset, length) {
      requireArchive(length <= ARCHIVE_LIMITS.centralBytes, "archive_range_limit");
      const body = await open(offset, length),
        reader = body.getReader();
      const bytes = new Uint8Array(length);
      let count = 0;
      try {
        for (;;) {
          const next = await reader.read();
          if (next.done) break;
          bytes.set(next.value, count);
          count += next.value.length;
        }
        await checkpoint();
        return bytes;
      } finally {
        void reader.cancel().catch(() => undefined);
        reader.releaseLock();
      }
    },
  };
}
