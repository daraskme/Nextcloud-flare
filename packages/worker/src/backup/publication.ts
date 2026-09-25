import {
  BACKUP_MANIFEST_BYTES,
  type BackupGeneration,
  backupManifestKey,
  backupPartKey,
  parseBackupPublication,
} from "../../../shared/src/backupPublication";
import { exportTables } from "../db/schemaContract";

export const sha256 = async (bytes: Uint8Array): Promise<string> =>
  [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))]
    .map((v) => v.toString(16).padStart(2, "0"))
    .join("");

/** One bounded request, including a body deadline. Late reads cannot grant completion. */
async function readObject(bucket: R2Bucket, key: string, limit: number): Promise<Uint8Array> {
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  let expired = false,
    timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      expired = true;
      void reader?.cancel().catch(() => {});
      reject(new Error("backup_read_timeout"));
    }, 10000);
  });
  try {
    return await Promise.race([
      timeout,
      (async () => {
        const object = await bucket.get(key);
        if (expired || !object || object.size < 1 || object.size > limit) {
          void object?.body.cancel().catch(() => {});
          throw new Error("backup_object_missing_or_invalid");
        }
        reader = object.body.getReader();
        const bytes = new Uint8Array(object.size);
        let count = 0;
        while (true) {
          const part = await reader.read();
          if (expired) throw new Error("backup_read_timeout");
          if (part.done) break;
          if (count + part.value.byteLength > bytes.byteLength)
            throw new Error("backup_object_size");
          bytes.set(part.value, count);
          count += part.value.byteLength;
        }
        if (count !== bytes.byteLength) throw new Error("backup_object_size");
        return bytes;
      })(),
    ]);
  } catch {
    void reader?.cancel().catch(() => {});
    throw new Error(expired ? "backup_read_timeout" : "backup_publication_unavailable");
  } finally {
    clearTimeout(timer);
    reader?.releaseLock();
  }
}

/** The pinned hash is an attestation from the trusted SQL verifier, never from an end user. */
export async function verifyPublicationPart(
  bucket: R2Bucket,
  generation: BackupGeneration,
  expectedHash: string,
  cursor: number,
): Promise<{ parts: number; next: number }> {
  if (!/^[a-f0-9]{64}$/.test(expectedHash)) throw new Error("backup_invalid_manifest_hash");
  const bytes = await readObject(bucket, backupManifestKey(generation.id), BACKUP_MANIFEST_BYTES);
  if ((await sha256(bytes)) !== expectedHash) throw new Error("backup_publication_hash_mismatch");
  const publication = parseBackupPublication(bytes, generation.id),
    found = publication.manifest.generation;
  if (
    Object.entries(generation).some(
      ([key, value]) => found[key as keyof BackupGeneration] !== value,
    ) ||
    publication.manifest.tables
      .map((t) => t.name)
      .sort()
      .join(",") !== [...exportTables].sort().join(",")
  )
    throw new Error("backup_generation_conflict");
  if (!Number.isSafeInteger(cursor) || cursor < 0 || cursor >= publication.parts.length)
    throw new Error("backup_invalid_cursor");
  const part = publication.parts[cursor]!;
  const data = await readObject(
    bucket,
    backupPartKey(generation.id, cursor, part.sha256),
    part.bytes,
  );
  if (data.byteLength !== part.bytes || (await sha256(data)) !== part.sha256)
    throw new Error("backup_part_mismatch");
  return { parts: publication.parts.length, next: cursor + 1 };
}
