import { randomUUID } from "node:crypto";
import { CHUNK_BYTES, digest, manifestKey, partKey } from "../../backup/objectStore.mjs";

/** Transport-only fixture for isolated pruning drills; never a restorable SQL generation. */
export function expiredBackupFixture() {
  const id = randomUUID(),
    token = randomUUID(),
    part = Buffer.from("expired transport fixture");
  const hash = digest(part);
  const bytes = Buffer.from(
    JSON.stringify({
      format: "nextcloud-flare.r2-backup",
      version: 1,
      chunkBytes: CHUNK_BYTES,
      manifest: {
        format: "nextcloud-flare.logical-backup",
        version: 1,
        capturedAt: 2,
        generation: { id, epoch: 1, token, createdAt: 1, watermark: null },
        schema: { sha256: hash, migrations: [{ name: "0001_foundation.sql", sha256: hash }] },
        data: { file: "data.sql", bytes: part.length, sha256: hash },
        tables: [{ name: "backup_runs", rows: 1, sha256: hash }],
      },
      parts: [{ bytes: part.length, sha256: hash }],
    }),
  );
  return {
    id,
    token,
    part,
    bytes,
    partKey: partKey(id, 0, hash),
    key: manifestKey(id),
    hash: digest(bytes),
  };
}
