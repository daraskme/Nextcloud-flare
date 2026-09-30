export const BACKUP_CHUNK_BYTES = 8 * 1024 * 1024;
export const BACKUP_MAX_PARTS = 131072;
export const BACKUP_MANIFEST_BYTES = 16 * 1024 * 1024;
const HASH = /^[a-f0-9]{64}$/;
const UUID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;

export interface BackupGeneration {
  id: string;
  epoch: number;
  token: string;
  createdAt: number;
  watermark: string | null;
}
export interface LogicalBackupManifest {
  format: "nextcloud-flare.logical-backup";
  version: 1;
  capturedAt: number;
  generation: BackupGeneration;
  schema: { sha256: string; migrations: { name: string; sha256: string }[] };
  data: { file: "data.sql"; bytes: number; sha256: string };
  tables: { name: string; rows: number; sha256: string }[];
}
export interface BackupPublication {
  format: "nextcloud-flare.r2-backup";
  version: 1;
  chunkBytes: number;
  manifest: LogicalBackupManifest;
  parts: { bytes: number; sha256: string }[];
}
function object(value: unknown, keys: string): Record<string, unknown> {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).sort().join(",") !== keys
  )
    throw new Error("backup_invalid_publication");
  return value as Record<string, unknown>;
}
const integer = (v: unknown, min: number, max = Number.MAX_SAFE_INTEGER): v is number =>
  typeof v === "number" && Number.isSafeInteger(v) && v >= min && v <= max;
const hash = (v: unknown): v is string => typeof v === "string" && HASH.test(v);
export function backupManifestKey(id: string): string {
  if (!UUID.test(id)) throw new Error("backup_invalid_generation");
  return `sys/backups/v1/${id}/manifest.json`;
}
export function backupPartKey(id: string, index: number, sha256: string): string {
  backupManifestKey(id);
  if (!integer(index, 0, BACKUP_MAX_PARTS - 1) || !hash(sha256))
    throw new Error("backup_invalid_part");
  return `sys/backups/v1/${id}/parts/${String(index).padStart(6, "0")}-${sha256}.bin`;
}

/** Shared wire-format validation; SQL/schema/row verification remains the trusted exporter's job. */
export function parseBackupPublication(bytes: Uint8Array, id: string): BackupPublication {
  backupManifestKey(id);
  if (bytes.byteLength < 1 || bytes.byteLength > BACKUP_MANIFEST_BYTES)
    throw new Error("backup_manifest_size");
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes));
  } catch {
    throw new Error("backup_invalid_publication");
  }
  const p = object(value, "chunkBytes,format,manifest,parts,version"),
    m = object(p.manifest, "capturedAt,data,format,generation,schema,tables,version"),
    g = object(m.generation, "createdAt,epoch,id,token,watermark"),
    d = object(m.data, "bytes,file,sha256"),
    s = object(m.schema, "migrations,sha256");
  if (
    p.format !== "nextcloud-flare.r2-backup" ||
    p.version !== 1 ||
    p.chunkBytes !== BACKUP_CHUNK_BYTES ||
    m.format !== "nextcloud-flare.logical-backup" ||
    m.version !== 1 ||
    g.id !== id ||
    !integer(g.epoch, 1) ||
    typeof g.token !== "string" ||
    !UUID.test(g.token) ||
    !integer(g.createdAt, 0) ||
    !integer(m.capturedAt, g.createdAt) ||
    !(
      g.watermark === null ||
      (typeof g.watermark === "string" && g.watermark.length > 0 && g.watermark.length <= 128)
    ) ||
    d.file !== "data.sql" ||
    !integer(d.bytes, 1, BACKUP_CHUNK_BYTES * BACKUP_MAX_PARTS) ||
    !hash(d.sha256) ||
    !hash(s.sha256) ||
    !Array.isArray(s.migrations) ||
    s.migrations.length < 1 ||
    s.migrations.length > 10000 ||
    !Array.isArray(m.tables) ||
    m.tables.length < 1 ||
    m.tables.length > 1000 ||
    !Array.isArray(p.parts) ||
    p.parts.length < 1 ||
    p.parts.length > BACKUP_MAX_PARTS
  )
    throw new Error("backup_invalid_publication");
  const migrations = new Set<string>();
  for (const value of s.migrations) {
    const row = object(value, "name,sha256");
    if (
      typeof row.name !== "string" ||
      !/^\d{4}_[a-z0-9_]+\.sql$/.test(row.name) ||
      !hash(row.sha256) ||
      migrations.has(row.name)
    )
      throw new Error("backup_invalid_publication");
    migrations.add(row.name);
  }
  const tables = new Set<string>();
  for (const value of m.tables) {
    const row = object(value, "name,rows,sha256");
    if (
      typeof row.name !== "string" ||
      !/^[a-z_][a-z0-9_]*$/.test(row.name) ||
      !integer(row.rows, 0) ||
      !hash(row.sha256) ||
      tables.has(row.name)
    )
      throw new Error("backup_invalid_publication");
    tables.add(row.name);
  }
  let total = 0;
  for (const [i, value] of p.parts.entries()) {
    const part = object(value, "bytes,sha256");
    if (
      !integer(part.bytes, 1, BACKUP_CHUNK_BYTES) ||
      !hash(part.sha256) ||
      (i < p.parts.length - 1 && part.bytes !== BACKUP_CHUNK_BYTES)
    )
      throw new Error("backup_invalid_part");
    total += part.bytes;
  }
  if (total !== d.bytes) throw new Error("backup_export_size");
  return p as unknown as BackupPublication;
}
