import type { RestoreSnapshotMirror } from "../../../shared/src/restoreSnapshot";
import { exportTables } from "./schemaContract.ts";

export const RESTORE_SNAPSHOT_CONTROL_QUERY = "SELECT * FROM control WHERE singleton=1";
export const RESTORE_SNAPSHOT_SCHEMA_QUERY = `SELECT type,name,tbl_name,sql FROM sqlite_schema
  WHERE sql IS NOT NULL AND tbl_name IN (${[...exportTables, "search_fts"].map((t) => `'${t}'`).join(",")})
  ORDER BY type,name`;
export const RESTORE_SNAPSHOT_CATALOGUE_QUERY = "PRAGMA table_list";
export const RESTORE_SNAPSHOT_MIGRATIONS_QUERY = "SELECT name FROM d1_migrations ORDER BY id";
const internal = new Set(["_cf_KV", "_cf_METADATA", "d1_migrations"]);
const digest = async (value: unknown) =>
  [
    ...new Uint8Array(
      await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify(value))),
    ),
  ]
    .map((v) => v.toString(16).padStart(2, "0"))
    .join("");

export async function restoredControlDigest(control: Record<string, unknown>[]): Promise<string> {
  if (
    !Array.isArray(control) ||
    control.length !== 1 ||
    control[0]?.singleton !== 1 ||
    !Number.isSafeInteger(control[0].epoch) ||
    (control[0].epoch as number) < 1
  )
    throw new Error("database_restore_invalid_snapshot");
  const fields = Object.keys(control[0])
    .sort()
    .map((key) => {
      const value = control[0]![key];
      if (
        !(
          value === null ||
          typeof value === "string" ||
          (typeof value === "number" && Number.isSafeInteger(value))
        )
      )
        throw new Error("database_restore_invalid_snapshot");
      return [key, value];
    });
  return digest(fields);
}

/** The epoch trigger may extend the KDF cooldown using the actual D1 execution clock. */
export async function restoredAdoptionDigest(control: Record<string, unknown>[], minimum: number) {
  const row = Array.isArray(control) && control.length === 1 ? control[0] : undefined;
  if (!row || !Number.isSafeInteger(row.kdf_not_before) || (row.kdf_not_before as number) < minimum)
    throw new Error("database_restore_adoption_mirror_conflict");
  return restoredControlDigest([{ ...row, kdf_not_before: minimum }]);
}

/** Same canonical read observation for the Worker and the independently configured CLI. */
export async function restoredSnapshotMirror(
  control: Record<string, unknown>[],
  schema: Record<string, unknown>[],
  catalogue: Record<string, unknown>[],
): Promise<RestoreSnapshotMirror> {
  const controlSha256 = await restoredControlDigest(control);
  if (!Array.isArray(schema) || !schema.length || !Array.isArray(catalogue))
    throw new Error("database_restore_invalid_snapshot");
  const objects = schema.map((row) => {
    if (
      !["table", "index", "trigger", "view"].includes(row.type as string) ||
      typeof row.name !== "string" ||
      typeof row.tbl_name !== "string" ||
      typeof row.sql !== "string"
    )
      throw new Error("database_restore_invalid_snapshot");
    return [row.type, row.name, row.tbl_name, row.sql];
  });
  const tables = catalogue
    .map((row) => {
      if (
        !row ||
        !["main", "temp"].includes(row.schema as string) ||
        typeof row.name !== "string" ||
        !["table", "view", "virtual", "shadow"].includes(row.type as string)
      )
        throw new Error("database_restore_invalid_snapshot");
      return row;
    })
    .filter(
      (row) =>
        row.schema !== "temp" &&
        !(row.name as string).startsWith("sqlite_") &&
        !internal.has(row.name as string),
    )
    .map((row) => {
      if (
        row.schema !== "main" ||
        typeof row.name !== "string" ||
        !["table", "view", "virtual", "shadow"].includes(row.type as string)
      )
        throw new Error("database_restore_invalid_snapshot");
      return { name: row.name, type: row.type as string };
    })
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  if (new Set(tables.map((t) => t.name)).size !== tables.length)
    throw new Error("database_restore_invalid_snapshot");
  return {
    snapshotEpoch: control[0]!.epoch as number,
    controlSha256,
    schemaSha256: await digest(objects),
    catalogueSha256: await digest(tables),
    tables: tables.filter((t) => t.type === "table").map((t) => t.name),
  };
}
