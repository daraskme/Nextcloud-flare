import { LIMITS } from "@next-cloud-flare/shared/limits";
import { Zip, ZipPassThrough } from "fflate";

export interface StoreEntry {
  readonly name: string;
  readonly size: number;
  readonly directory?: boolean;
  readonly open: () => Promise<ReadableStream<Uint8Array>>;
}

function file(source: Pick<StoreEntry, "name" | "directory">): ZipPassThrough {
  const entry = new ZipPassThrough(source.name);
  // Fixed metadata for both the measurement pass and actual serialization.
  entry.mtime = new Date(2000, 0, 1, 0, 0, 0);
  entry.os = 0;
  entry.attrs = source.directory ? 0x10 : 0;
  return entry;
}

function inspectEntries(entries: readonly StoreEntry[]): {
  entries: readonly StoreEntry[];
  size: number;
} {
  if (entries.length > LIMITS.zipEntries) throw new RangeError("zip_entry_limit");
  const names = new Map<string, boolean>();
  let payloadBytes = 0;
  // Snapshot the inputs so metadata cannot change after dry-run.
  const snapshot = entries.map((entry) => {
    const name = entry.name.normalize("NFC");
    const directory = entry.directory === true;
    const path = directory && name.endsWith("/") ? name.slice(0, -1) : name;
    const nameBytes = new TextEncoder().encode(name).byteLength;
    if (
      !path ||
      (directory && !name.endsWith("/")) ||
      nameBytes > 1_024 ||
      /[\\:]/.test(name) ||
      Array.from(name).some(
        (character) =>
          character.charCodeAt(0) < 32 ||
          character.charCodeAt(0) === 127 ||
          (character.length === 1 &&
            character.charCodeAt(0) >= 0xd800 &&
            character.charCodeAt(0) <= 0xdfff),
      ) ||
      path.split("/").some((part) => !part || part === "." || part === "..") ||
      names.has(path)
    ) {
      throw new RangeError("invalid_zip_name");
    }
    if (
      !Number.isSafeInteger(entry.size) ||
      entry.size < 0 ||
      entry.size > LIMITS.zipBytes ||
      (directory && entry.size !== 0)
    ) {
      throw new RangeError("zip_size_limit");
    }
    names.set(path, directory);
    payloadBytes += entry.size;
    return Object.freeze({ name, directory, size: entry.size, open: entry.open });
  });
  // A file must not also be the parent directory of another entry, in either order.
  for (const path of names.keys()) {
    const parts = path.split("/");
    parts.pop();
    while (parts.length) {
      if (names.get(parts.join("/")) === false) throw new RangeError("invalid_zip_name");
      parts.pop();
    }
  }
  let overhead = 0;
  const measure = new Zip((error, data) => {
    if (error) throw error;
    overhead += data.byteLength;
  });
  for (const entry of snapshot) {
    const stream = file(entry);
    measure.add(stream);
    stream.push(new Uint8Array(), true);
  }
  measure.end();
  // STORE sizes/offsets/CRC are fixed-width fields. Empty payloads measure all framing.
  const size = overhead + payloadBytes;
  if (size > LIMITS.zipBytes || overhead > LIMITS.streamQueueBytes / 2) {
    throw new RangeError("zip_size_limit");
  }
  return { entries: snapshot, size };
}

export function storeZipSize(entries: readonly StoreEntry[]): number {
  return inspectEntries(entries).size;
}

/** Bounded STORE serializer; callers provide current authority, pinned blobs and a budget lease. */
export function storeZip(entries: readonly StoreEntry[]): {
  size: number;
  body: ReadableStream<Uint8Array>;
} {
  const plan = inspectEntries(entries);
  const queue: Uint8Array[] = [];
  let queuedBytes = 0;
  let emittedBytes = 0;
  let index = 0;
  let ended = false;
  let cancelled = false;
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  let current: ZipPassThrough | undefined;
  let currentBytes = 0;
  let expected = 0;
  let pending: Uint8Array | undefined;
  let offset = 0;
  const zip = new Zip((error, data, final) => {
    if (error) throw error;
    if (data.byteLength) {
      queuedBytes += data.byteLength;
      if (queuedBytes > LIMITS.streamQueueBytes) throw new RangeError("zip_queue_limit");
      queue.push(data);
    }
    if (final) ended = true;
  });

  const stop = async (reason: unknown) => {
    cancelled = true;
    zip.terminate();
    queue.length = 0;
    pending = undefined;
    const active = reader;
    reader = undefined;
    if (active) {
      try {
        await active.cancel(reason);
      } finally {
        active.releaseLock();
      }
    }
  };

  const body = new ReadableStream<Uint8Array>(
    {
      async pull(controller) {
        try {
          while (!cancelled && queue.length === 0 && !ended) {
            if (!reader) {
              const entry = plan.entries[index++];
              if (!entry) {
                zip.end();
                break;
              }
              if (entry.directory) {
                const directory = file(entry);
                zip.add(directory);
                directory.push(new Uint8Array(), true);
                continue;
              }
              const source = await entry.open();
              if (cancelled) {
                await source.cancel();
                return;
              }
              reader = source.getReader();
              current = file(entry);
              currentBytes = 0;
              expected = entry.size;
              zip.add(current);
            }
            if (!pending) {
              const next = await reader.read();
              if (cancelled) return;
              if (next.done) {
                if (currentBytes !== expected) throw new RangeError("zip_entry_size_mismatch");
                current?.push(new Uint8Array(), true);
                reader.releaseLock();
                reader = undefined;
                current = undefined;
                continue;
              }
              if (next.value.byteLength > LIMITS.streamQueueBytes)
                throw new RangeError("zip_input_chunk_limit");
              currentBytes += next.value.byteLength;
              if (currentBytes > expected) throw new RangeError("zip_entry_size_mismatch");
              pending = next.value;
              offset = 0;
            }
            const part = pending.subarray(offset, offset + LIMITS.streamChunkBytes);
            current?.push(part);
            offset += part.byteLength;
            if (offset === pending.byteLength) pending = undefined;
          }
          if (cancelled) return;
          const chunk = queue.shift();
          if (chunk) {
            queuedBytes -= chunk.byteLength;
            emittedBytes += chunk.byteLength;
            controller.enqueue(chunk);
          } else if (ended) {
            if (emittedBytes !== plan.size) throw new Error("zip_dry_run_mismatch");
            controller.close();
          }
        } catch (error) {
          await stop(error);
          controller.error(error);
        }
      },
      cancel: stop,
    },
    { highWaterMark: 0 },
  );
  return { size: plan.size, body };
}
