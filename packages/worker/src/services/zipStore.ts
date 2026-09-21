import { Zip, ZipPassThrough } from "fflate";

export interface StoreZipEntry {
  name: string;
  bytes: Uint8Array;
}

export interface StoreZipResult {
  bytes: Uint8Array;
  size: number;
}

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
