import type { BackupGeneration, BackupPublication } from "../../../shared/src/backupPublication";
import { sha256 } from "../../src/backup/publication";
import { exportTables } from "../../src/db/schemaContract";

/** Transport-only fixture. Production callers must attest a real offline-verified SQL export. */
export async function publicationFixture(
  generation: BackupGeneration,
  chunks = [new TextEncoder().encode("SQL fixture")],
): Promise<BackupPublication> {
  const parts = await Promise.all(
    chunks.map(async (b) => ({ bytes: b.byteLength, sha256: await sha256(b) })),
  );
  return {
    format: "nextcloud-flare.r2-backup",
    version: 1,
    chunkBytes: 8 * 1024 * 1024,
    manifest: {
      format: "nextcloud-flare.logical-backup",
      version: 1,
      generation,
      capturedAt: generation.createdAt,
      data: {
        file: "data.sql",
        bytes: parts.reduce((n, p) => n + p.bytes, 0),
        sha256: "a".repeat(64),
      },
      schema: {
        sha256: "b".repeat(64),
        migrations: [{ name: "0001_foundation.sql", sha256: "c".repeat(64) }],
      },
      tables: exportTables.map((name) => ({ name, rows: 0, sha256: "d".repeat(64) })),
    },
    parts,
  };
}
