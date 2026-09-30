import { open } from "node:fs/promises";
import { quote, tableRows } from "./snapshot.mjs";
import { textLiteral } from "./sql.mjs";

function literal(value) {
  if (value === null) return "NULL";
  if (typeof value === "number") return String(value);
  if (typeof value === "string") return textLiteral(value);
  return `X'${value.hex}'`;
}

/** Stream exact query values from an already-frozen source, never rewrite a dump. */
export async function exportData(path, tableSpecs, query) {
  const file = await open(path, "wx", 0o600);
  try {
    for (const spec of tableSpecs) {
      const prefix = `INSERT INTO ${quote(spec.name)} (${spec.columns.map(quote).join(",")}) VALUES(`;
      for await (const values of tableRows(spec, query)) {
        const bytes = Buffer.from(prefix + values.map(literal).join(",") + ");\n");
        if (bytes.length > 8 * 1024 * 1024) throw new Error("backup_statement_too_large");
        let offset = 0;
        while (offset < bytes.length) {
          const { bytesWritten } = await file.write(bytes, offset, bytes.length - offset);
          if (!bytesWritten) throw new Error("backup_export_write_failed");
          offset += bytesWritten;
        }
      }
    }
  } finally {
    await file.close();
  }
}
