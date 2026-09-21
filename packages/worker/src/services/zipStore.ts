import { Zip, ZipPassThrough } from "fflate";

export interface StoreZipEntry {
  name: string;
  bytes: Uint8Array;
}

export interface StoreZipResult {
  bytes: Uint8Array;
  size: number;
}

export interface StoreZipMetadata {
  name: string;
  size: number;
}

export interface StoreZipSource extends StoreZipMetadata {
  stream: () => Promise<ReadableStream<Uint8Array>>;
}

const ZIP_INPUT_CHUNK = 256 * 1024;

export function serializeStoreZip(entries: readonly StoreZipEntry[]): StoreZipResult {
  const chunks: Uint8Array[] = [];
  let size = 0;
  let failure: Error | undefined;
  const zip = new Zip((error, data) => {
    if (error !== null) {
      failure = error;
      return;
    }
    chunks.push(data);
    size += data.byteLength;
  });

  for (const entry of entries) {
    const file = new ZipPassThrough(entry.name);
    zip.add(file);
    file.push(entry.bytes, true);
  }
  zip.end();

  if (failure !== undefined) {
    throw failure;
  }

  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { bytes, size };
}

export function measureStoreZip(entries: readonly StoreZipEntry[]): number {
  return serializeStoreZip(entries).size;
}

export function measureStoreZipMetadata(entries: readonly StoreZipMetadata[]): number {
  let size = 0;
  let failure: Error | undefined;
  const zip = new Zip((error, data) => {
    if (error !== null) failure = error;
    else size += data.byteLength;
  });
  const zeroes = new Uint8Array(ZIP_INPUT_CHUNK);
  for (const entry of entries) {
    if (!Number.isSafeInteger(entry.size) || entry.size < 0)
      throw new RangeError("ZIP size is invalid");
    const file = new ZipPassThrough(entry.name);
    zip.add(file);
    let remaining = entry.size;
    while (remaining > 0) {
      const length = Math.min(remaining, zeroes.byteLength);
      file.push(length === zeroes.byteLength ? zeroes : zeroes.subarray(0, length), false);
      remaining -= length;
    }
    file.push(new Uint8Array(0), true);
  }
  zip.end();
  if (failure !== undefined) throw failure;
  return size;
}

export function createStoreZipStream(
  entries: readonly StoreZipSource[],
  onClose?: (completed: boolean) => Promise<void>,
): ReadableStream<Uint8Array> {
  let queue: Uint8Array[] = [];
  let failure: Error | undefined;
  let entryIndex = 0;
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  let file: ZipPassThrough | undefined;
  let pending: Uint8Array | undefined;
  let finished = false;
  let closed = false;
  const zip = new Zip((error, data, final) => {
    if (error !== null) failure = error;
    else if (data.byteLength > 0) queue.push(data);
    if (final) finished = true;
  });

  const close = async (completed: boolean) => {
    if (closed) return;
    closed = true;
    await onClose?.(completed);
  };

  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      while (queue.length === 0 && !finished && failure === undefined) {
        if (file === undefined) {
          const entry = entries[entryIndex];
          if (entry === undefined) {
            zip.end();
            continue;
          }
          file = new ZipPassThrough(entry.name);
          zip.add(file);
          reader = (await entry.stream()).getReader();
          entryIndex += 1;
        }
        if (pending === undefined) {
          const chunk = await reader?.read();
          if (chunk === undefined || chunk.done) {
            file.push(new Uint8Array(0), true);
            file = undefined;
            reader = undefined;
            continue;
          }
          pending = chunk.value;
        }
        const chunk = pending.subarray(0, ZIP_INPUT_CHUNK);
        pending =
          pending.byteLength > chunk.byteLength ? pending.subarray(chunk.byteLength) : undefined;
        file.push(chunk, false);
      }
      if (failure !== undefined) {
        await close(false).catch(() => undefined);
        controller.error(failure);
        return;
      }
      const next = queue.shift();
      if (next !== undefined) {
        controller.enqueue(next);
        return;
      }
      if (finished) {
        await close(true);
        controller.close();
      }
    },
    async cancel(reason) {
      zip.terminate();
      queue = [];
      await reader?.cancel(reason).catch(() => undefined);
      await close(false).catch(() => undefined);
    },
  });
}
