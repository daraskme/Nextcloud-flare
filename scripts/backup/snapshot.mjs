import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import { exportTables, purgeOrder } from "../../packages/worker/src/db/schemaContract.ts";
import { parseInsert, statements, textLiteral } from "./sql.mjs";

export const migrationsDirectory = new URL("../../packages/worker/migrations/", import.meta.url);
const INTERNAL_TABLES = new Set(["_cf_KV", "_cf_METADATA", "d1_migrations"]);
/** Compare the whole source catalogue, including unexpected tables/views/virtual tables. */
export function schemaCatalogue(rows) {
  if (!Array.isArray(rows)) throw new Error("backup_invalid_schema_catalogue");
  const result = [],
    seen = new Set();
  for (const row of rows) {
    if (
      !row ||
      !["main", "temp"].includes(row.schema) ||
      typeof row.name !== "string" ||
      !["table", "view", "virtual", "shadow"].includes(row.type)
    )
      throw new Error("backup_invalid_schema_catalogue");
    if (row.schema === "temp" || row.name.startsWith("sqlite_") || INTERNAL_TABLES.has(row.name))
      continue;
    if (seen.has(row.name)) throw new Error("backup_invalid_schema_catalogue");
    seen.add(row.name);
    result.push({ name: row.name, type: row.type });
  }
  return result.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}
export const quote = (name) => '"' + name.replaceAll('"', '""') + '"';
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
export async function migrations() {
  const result = [];
  for (const name of (await readdir(migrationsDirectory))
    .filter((n) => /^\d{4}_.*\.sql$/.test(n))
    .sort()) {
    const sql = await readFile(new URL(name, migrationsDirectory), "utf8");
    result.push({ name, sha256: sha256(sql), sql });
  }
  return result;
}
export function initialize(path, versions) {
  const db = new DatabaseSync(path);
  try {
    db.exec("PRAGMA foreign_keys=ON;BEGIN;");
    for (const migration of versions) db.exec(migration.sql);
    db.exec("COMMIT;");
    return db;
  } catch (error) {
    db.close();
    throw error;
  }
}
export function specs(db) {
  const actual = db
    .prepare("PRAGMA table_list")
    .all()
    .filter((r) => r.type === "table" && !r.name.startsWith("sqlite_"))
    .map((r) => r.name)
    .sort();
  assert.deepEqual(actual, [...exportTables].sort(), "backup_table_contract");
  return exportTables.map((name) => {
    const columns = db.prepare(`PRAGMA table_info(${quote(name)})`).all();
    const keys = columns
      .filter((c) => c.pk)
      .sort((a, b) => a.pk - b.pk)
      .map((c) => c.name);
    if (!keys.length && name !== "_assert") throw new Error("backup_table_without_key");
    if (!keys.length) keys.push("rowid");
    return { name, columns: columns.map((c) => c.name), keys };
  });
}
export const schemaQuery = `SELECT type,name,tbl_name,sql FROM sqlite_schema
  WHERE sql IS NOT NULL AND tbl_name IN (${[...exportTables, "search_fts"].map((t) => `'${t}'`).join(",")})
  ORDER BY type,name`;
function normalizedSql(sql) {
  let result = "",
    quote = null,
    space = false;
  for (let i = 0; i < sql.length; i++) {
    const char = sql[i];
    if (quote !== null) {
      result += char;
      if (char === quote) {
        if (sql[i + 1] === quote) result += sql[++i];
        else quote = null;
      }
    } else if (char === "-" && sql[i + 1] === "-") {
      while (i + 1 < sql.length && sql[i + 1] !== "\n") i++;
      space = true;
    } else if (char === "/" && sql[i + 1] === "*") {
      const end = sql.indexOf("*/", i + 2);
      if (end === -1) throw new Error("backup_invalid_schema");
      i = end + 1;
      space = true;
    } else if (/\s/.test(char)) space = true;
    else {
      if (space && result) result += " ";
      space = false;
      result += char;
      if (char === "'" || char === '"' || char === "`") quote = char;
    }
  }
  if (quote !== null) throw new Error("backup_invalid_schema");
  return result;
}
export function schemaDigest(rows) {
  // Wrangler strips source comments; preserve quoted values while ignoring SQL trivia only.
  return sha256(
    JSON.stringify(rows.map((r) => [r.type, r.name, r.tbl_name, normalizedSql(r.sql)])),
  );
}
export function rowValues(spec, row) {
  return spec.columns.map((key) => {
    const value = row[key];
    if (value === null || typeof value === "string") return value;
    if (
      typeof value === "number" &&
      Number.isFinite(value) &&
      (!Number.isInteger(value) || Number.isSafeInteger(value))
    )
      return value;
    if (
      value instanceof Uint8Array ||
      (Array.isArray(value) && value.every((b) => Number.isInteger(b) && b >= 0 && b <= 255))
    )
      return { hex: Buffer.from(value).toString("hex") };
    throw new Error("backup_unsupported_value");
  });
}
const literal = (value) => {
  if (typeof value === "string") return textLiteral(value);
  if (typeof value === "number" && Number.isSafeInteger(value)) return String(value);
  throw new Error("backup_unsupported_primary_key");
};
export async function* tableRows(spec, query) {
  let last = null;
  while (true) {
    const tuple = "(" + spec.keys.map(quote).join(",") + ")";
    const after = last ? ` WHERE ${tuple}>(${last.map(literal).join(",")})` : "";
    // Four maximum-size D1 rows fit a bounded command response. Keyset pagination avoids OFFSET scans.
    const selected = [...new Set([...spec.columns, ...spec.keys])];
    // Wrangler's JSON display converts a BLOB array to a string. Ask SQLite for
    // the storage type and hex ourselves so BLOB and lookalike TEXT stay distinct.
    const projection = selected.flatMap((name, i) => {
      const column = quote(name);
      return [
        `typeof(${column}) AS ${quote(`__ncf_type_${i}`)}`,
        `CASE WHEN typeof(${column})='blob' THEN hex(${column}) ELSE ${column} END AS ${quote(`__ncf_value_${i}`)}`,
      ];
    });
    const rows = await query(
      `SELECT ${projection.join(",")} FROM ${quote(spec.name)}${after} ORDER BY ${spec.keys.map(quote).join(",")} LIMIT 4`,
    );
    if (!Array.isArray(rows) || rows.length > 4) throw new Error("backup_invalid_page");
    for (const record of rows) {
      const row = Object.fromEntries(
        selected.map((name, i) => {
          const type = record[`__ncf_type_${i}`];
          let value = record[`__ncf_value_${i}`];
          if (type === "blob" && typeof value === "string" && /^(?:[a-f0-9]{2})*$/i.test(value))
            value = Buffer.from(value, "hex");
          else if (
            !(
              (type === "null" && value === null) ||
              (type === "text" && typeof value === "string") ||
              (type === "integer" && Number.isSafeInteger(value)) ||
              (type === "real" && typeof value === "number" && Number.isFinite(value))
            )
          )
            throw new Error("backup_unsupported_value");
          return [name, value];
        }),
      );
      const values = rowValues(spec, row);
      const next = spec.keys.map((key) => row[key]);
      next.forEach(literal);
      if (last && JSON.stringify(next) === JSON.stringify(last))
        throw new Error("backup_nonadvancing_page");
      last = next;
      yield values;
    }
    if (rows.length < 4) break;
  }
}
export async function tableDigests(tableSpecs, query) {
  const result = [];
  for (const spec of tableSpecs) {
    const hash = createHash("sha256");
    let count = 0;
    for await (const values of tableRows(spec, query)) {
      hash.update(JSON.stringify(values) + "\n");
      count++;
    }
    result.push({ name: spec.name, rows: count, sha256: hash.digest("hex") });
  }
  return result;
}
export const barrierQuery = `SELECT b.id,b.epoch,b.barrier_token AS token,b.created_at AS createdAt,b.watermark
 FROM control c JOIN backup_runs b ON b.barrier_token=c.backup_token
 WHERE c.singleton=1 AND c.backup_frozen=1 AND c.maintenance=1 AND c.gc_paused=1
 AND b.epoch=c.epoch AND b.state='exporting' AND b.released_at IS NULL
 AND b.watermark IS c.backup_barrier_op AND b.watermark IS c.backup_last_op
 AND NOT EXISTS(SELECT 1 FROM permits WHERE state='open')
 AND NOT EXISTS(SELECT 1 FROM operations WHERE state='claimed')
 AND NOT EXISTS(SELECT 1 FROM mutation_admissions WHERE state<>'closed')`;
export function barrier(rows, id, epoch) {
  if (!Array.isArray(rows) || rows.length !== 1) throw new Error("backup_not_frozen");
  const r = rows[0];
  if (
    r.id !== id ||
    r.epoch !== epoch ||
    typeof r.token !== "string" ||
    !/^[0-9a-f-]{36}$/.test(r.token) ||
    !Number.isSafeInteger(r.createdAt) ||
    r.createdAt < 0 ||
    !(r.watermark === null || typeof r.watermark === "string")
  )
    throw new Error("backup_generation_conflict");
  return {
    id: r.id,
    epoch: r.epoch,
    token: r.token,
    createdAt: r.createdAt,
    watermark: r.watermark,
  };
}
export async function importData(db, chunks, tableSpecs) {
  const triggerRows = db
    .prepare("SELECT name,sql FROM sqlite_schema WHERE type='trigger' ORDER BY name")
    .all();
  const originalSchema = schemaDigest(db.prepare(schemaQuery).all());
  const byName = new Map(tableSpecs.map((spec) => [spec.name, spec]));
  const inserts = new Map();
  db.exec("BEGIN;PRAGMA defer_foreign_keys=ON;");
  try {
    // This function is only called on a newly created isolated target, never the source database.
    for (const t of triggerRows) db.exec(`DROP TRIGGER ${quote(t.name)}`);
    for (const name of purgeOrder) db.exec(`DELETE FROM ${quote(name)}`);
    for await (const statement of statements(chunks)) {
      const row = parseInsert(statement);
      if (!row) continue;
      const spec = byName.get(row.table);
      if (!spec || JSON.stringify(spec.columns) !== JSON.stringify(row.columns))
        throw new Error("backup_column_contract");
      let insert = inserts.get(row.table);
      if (!insert) {
        insert = db.prepare(
          `INSERT INTO ${quote(row.table)} (${spec.columns.map(quote).join(",")}) VALUES(${spec.columns.map(() => "?").join(",")})`,
        );
        inserts.set(row.table, insert);
      }
      insert.run(...row.values);
    }
    for (const t of triggerRows) db.exec(t.sql);
    if (db.prepare("PRAGMA foreign_key_check").all().length)
      throw new Error("backup_foreign_key_error");
    if (schemaDigest(db.prepare(schemaQuery).all()) !== originalSchema)
      throw new Error("backup_schema_changed");
    db.exec(
      "INSERT INTO search_fts(search_fts) VALUES('rebuild');INSERT INTO search_fts(search_fts,rank) VALUES('integrity-check',1)",
    );
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}
