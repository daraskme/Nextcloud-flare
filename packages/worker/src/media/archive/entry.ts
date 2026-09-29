import {
  ARCHIVE_LIMITS,
  checkMethod,
  crc32,
  dataView,
  encodedName,
  entryPath,
  extraFields,
  range,
  requireArchive,
  wide,
} from "./format";
import { type ArchiveEntry, type ArchiveIndex, type ArchiveSource, exactRead } from "./index";

async function dataOffset(source: ArchiveSource, entry: ArchiveEntry): Promise<number> {
  const header = dataView(await exactRead(source, entry.localOffset, 30));
  requireArchive(header.getUint32(0, true) === 0x04034b50);
  requireArchive(
    header.getUint16(4, true) === entry.version &&
      header.getUint16(6, true) === entry.flags &&
      header.getUint16(8, true) === entry.method,
    "archive_header_mismatch",
  );
  const nameLength = header.getUint16(26, true),
    extraLength = header.getUint16(28, true);
  requireArchive(nameLength === atob(entry.rawName).length, "archive_name_mismatch");
  range(entry.localOffset, 30 + nameLength + extraLength + entry.compressedSize, entry.endOffset);
  const metadata = await exactRead(source, entry.localOffset + 30, nameLength + extraLength);
  const raw = metadata.subarray(0, nameLength),
    fields = extraFields(metadata.subarray(nameLength));
  requireArchive(
    encodedName(raw) === entry.rawName && entryPath(raw, entry.flags, fields) === entry.path,
    "archive_name_mismatch",
  );
  let size = header.getUint32(22, true),
    compressed = header.getUint32(18, true);
  const zip = dataView(fields.get(1) ?? new Uint8Array());
  if (size === 0xffffffff || compressed === 0xffffffff) {
    // The local ZIP64 extension contains both sizes, even if only one overflows.
    requireArchive(
      size === 0xffffffff &&
        compressed === 0xffffffff &&
        zip.byteLength === 16 &&
        entry.version >= 45,
    );
    size = wide(zip, 0);
    compressed = wide(zip, 8);
  } else requireArchive(zip.byteLength === 0);
  const crc = header.getUint32(14, true),
    descriptor = Boolean(entry.flags & 8);
  requireArchive(
    (size === entry.size || (descriptor && size === 0)) &&
      (compressed === entry.compressedSize || (descriptor && compressed === 0)) &&
      (crc === entry.crc32 || (descriptor && crc === 0)),
    "archive_header_mismatch",
  );
  const offset = entry.localOffset + 30 + nameLength + extraLength;
  if (descriptor) {
    const at = offset + entry.compressedSize,
      sizeWidth = entry.zip64 || fields.has(1) ? 8 : 4;
    const length = 4 + sizeWidth * 2;
    range(at, length, entry.endOffset);
    const first = await exactRead(source, at, length),
      initial = dataView(first);
    const matches = (view: DataView, start: number) =>
      view.getUint32(start, true) === entry.crc32 &&
      (sizeWidth === 8
        ? view.getBigUint64(start + 4, true) === BigInt(entry.compressedSize)
        : view.getUint32(start + 4, true) === entry.compressedSize) &&
      (sizeWidth === 8
        ? view.getBigUint64(start + 12, true) === BigInt(entry.size)
        : view.getUint32(start + 8, true) === entry.size);
    // A real CRC can equal the optional signature. Prefer the exact unsigned form.
    if (!matches(initial, 0)) {
      requireArchive(initial.getUint32(0, true) === 0x08074b50, "archive_descriptor_mismatch");
      range(at, length + 4, entry.endOffset);
      const signed = new Uint8Array(length + 4);
      signed.set(first);
      signed.set(await exactRead(source, at + length, 4), length);
      requireArchive(matches(dataView(signed), 4), "archive_descriptor_mismatch");
    }
  }
  return offset;
}

/**
 * Open an ordinal of a freshly inspected, immutable index. Persisted JSON needs validation
 * before becoming an ArchiveIndex. Callers provide current authorization and a deadline
 * through checkpoint (also used by the R2 source). CRC failures can occur after output.
 */
export async function openArchiveEntry(
  source: ArchiveSource,
  index: ArchiveIndex,
  ordinal: number,
  checkpoint: () => Promise<void>,
): Promise<ReadableStream<Uint8Array>> {
  requireArchive(
    index.version === "archive-index-v1" &&
      index.sourceSize === source.size &&
      Number.isSafeInteger(ordinal),
  );
  const entry = index.entries[ordinal];
  requireArchive(entry && !entry.directory, "archive_entry_missing");
  checkMethod(entry.flags, entry.method, entry.version);
  range(entry.localOffset, 30, entry.endOffset);
  range(entry.endOffset, 0, index.centralOffset);
  requireArchive(
    entry.size >= 0 &&
      entry.size <= ARCHIVE_LIMITS.entryBytes &&
      entry.compressedSize >= 0 &&
      entry.compressedSize <= ARCHIVE_LIMITS.compressedBytes,
    "archive_size_limit",
  );
  await checkpoint();
  const offset = await dataOffset(source, entry);
  await checkpoint();
  const input = entry.compressedSize
    ? await source.open(offset, entry.compressedSize)
    : new ReadableStream<Uint8Array>({
        start(controller) {
          controller.close();
        },
      });
  let output: ReadableStream<Uint8Array>;
  let piping: Promise<void> | undefined,
    pipeFailed = false,
    pipeError: unknown;
  try {
    await checkpoint();
    if (entry.method === 8) {
      const decoder = new DecompressionStream("deflate-raw");
      // Observe writable failures as well as readable errors, and await source
      // completion before reporting a clean EOF.
      piping = input.pipeTo(decoder.writable).catch((error: unknown) => {
        pipeFailed = true;
        pipeError = error;
      });
      output = decoder.readable;
    } else output = input;
  } catch (error) {
    void input.cancel(error).catch(() => undefined);
    throw error;
  }
  const reader = output.getReader();
  let total = 0,
    crc = 0,
    closed = false,
    chunks = 0;
  let pending: Uint8Array = new Uint8Array();
  let position = 0;
  const stop = (reason?: unknown) => {
    closed = true;
    pending = new Uint8Array();
    void reader
      .cancel(reason)
      .catch(() => undefined)
      .finally(() => reader.releaseLock());
  };
  return new ReadableStream<Uint8Array>(
    {
      async pull(controller) {
        try {
          await checkpoint();
          if (closed) return;
          while (position === pending.length) {
            // Bound malformed sources that emit endless empty chunks.
            requireArchive(++chunks <= 131_072, "archive_chunk_limit");
            const next = await reader.read();
            if (closed) return;
            await checkpoint();
            if (closed) return;
            if (next.done) {
              await piping;
              if (pipeFailed) throw pipeError;
              await checkpoint();
              if (closed) return;
              requireArchive(total === entry.size, "archive_output_size_mismatch");
              requireArchive(crc === entry.crc32, "archive_crc_mismatch");
              closed = true;
              reader.releaseLock();
              controller.close();
              return;
            }
            // Check the entire decoder output before any part can reach a consumer.
            requireArchive(
              next.value.length <= entry.size - total &&
                next.value.length <= ARCHIVE_LIMITS.entryBytes - total,
              "archive_output_size_mismatch",
            );
            pending = next.value;
            position = 0;
          }
          const part = pending.subarray(position, position + ARCHIVE_LIMITS.chunkBytes);
          crc = crc32(part, crc);
          total += part.length;
          position += part.length;
          controller.enqueue(part);
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
  );
}
