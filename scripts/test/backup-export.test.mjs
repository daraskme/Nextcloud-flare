import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, expect, it } from "vitest";
import { exportData } from "../backup/export.mjs";
import { tableDigests } from "../backup/snapshot.mjs";
import { parseInsert, statements } from "../backup/sql.mjs";

let directory;
const transportRow = (values) =>
  Object.fromEntries(
    values.flatMap((value, i) => [
      [
        `__ncf_type_${i}`,
        value === null
          ? "null"
          : typeof value === "number"
            ? Number.isInteger(value)
              ? "integer"
              : "real"
            : typeof value === "string"
              ? "text"
              : typeof value,
      ],
      [`__ncf_value_${i}`, value],
    ]),
  );
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "backup-export-"));
});
afterEach(() => rm(directory, { recursive: true, force: true }));

it("preserves all scalar values in executable SQL and the restricted reader across keyset pages", async () => {
  const source = new DatabaseSync(":memory:"),
    restored = new DatabaseSync(":memory:");
  const schema = `CREATE TABLE data(id TEXT PRIMARY KEY, text TEXT, bytes BLOB, number REAL, nullable TEXT) STRICT;
    CREATE TABLE empty(id INTEGER PRIMARY KEY) STRICT;
    CREATE TABLE _assert(value INTEGER) STRICT;`;
  const specs = [
    { name: "data", columns: ["id", "text", "bytes", "number", "nullable"], keys: ["id"] },
    { name: "empty", columns: ["id"], keys: ["id"] },
    { name: "_assert", columns: ["value"], keys: ["rowid"] },
  ];
  try {
    source.exec(schema);
    restored.exec(schema);
    const texts = [
      "",
      "引用'😀;\r\n文字\\n\\r",
      "\0",
      "\ufeff\0引用",
      "\ufefftext",
      "tab\t\n",
      "[0, 255, 0, 128]",
    ];
    for (let index = 0; index < texts.length; index++)
      source
        .prepare("INSERT INTO data VALUES(?,?,?,?,NULL)")
        .run(
          index === 3 ? "d\0quoted'" : String.fromCharCode(97 + index),
          texts[index],
          Buffer.from(index === 0 ? [] : [0, 255, index]),
          index % 2 ? -1250.125 : 1.2345e-20,
        );
    source.exec("INSERT INTO _assert VALUES(0),(1),(2),(3),(4)");
    const queries = [],
      query = async (sql) => {
        queries.push(sql);
        return source.prepare(sql).all();
      };
    const path = join(directory, "data.sql");
    await exportData(path, specs, query);
    const bytes = await readFile(path);
    expect(bytes.includes(0)).toBe(false);
    expect(queries).toHaveLength(5);
    expect(queries.every((sql) => sql.endsWith("LIMIT 4") && !sql.includes("OFFSET"))).toBe(true);
    expect(queries.some((sql) => sql.includes("CAST(X'"))).toBe(true);
    restored.exec(bytes.toString("utf8"));
    for (const table of specs)
      expect(restored.prepare(`SELECT * FROM ${table.name} ORDER BY 1`).all()).toEqual(
        source.prepare(`SELECT * FROM ${table.name} ORDER BY 1`).all(),
      );
    const parsed = [];
    for await (const statement of statements([bytes])) parsed.push(parseInsert(statement));
    expect(parsed.filter((row) => row.table === "data").map((row) => row.values[1])).toEqual(texts);
    expect(parsed.find((row) => row.values[0] === "b").values[2]).toEqual(Buffer.from([0, 255, 1]));
    expect(await tableDigests(specs, async (sql) => restored.prepare(sql).all())).toEqual(
      await tableDigests(specs, query),
    );
    if (process.platform !== "win32") expect((await stat(path)).mode & 0o777).toBe(0o600);
  } finally {
    source.close();
    restored.close();
  }
});

it("never replaces an existing export file", async () => {
  const path = join(directory, "existing.sql");
  await writeFile(path, "preserve");
  await expect(exportData(path, [], async () => [])).rejects.toMatchObject({ code: "EEXIST" });
  expect(await readFile(path, "utf8")).toBe("preserve");
});

it.each([NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, undefined, {}, "\ud800"])(
  "rejects unsupported scalar data without serializing a replacement: %s",
  async (value) => {
    await expect(
      exportData(
        join(directory, "rejected.sql"),
        [{ name: "data", columns: ["id", "value"], keys: ["id"] }],
        async () => [transportRow(["a", value])],
      ),
    ).rejects.toThrow("backup_unsupported_value");
  },
);

it("bounds each statement and closes a partially written file after a query failure", async () => {
  const spec = { name: "data", columns: ["id", "value"], keys: ["id"] },
    path = join(directory, "failed.sql");
  await expect(
    exportData(path, [spec], async () => [transportRow(["a", "x".repeat(8 * 1024 * 1024)])]),
  ).rejects.toThrow("backup_statement_too_large");
  await rm(path);
  let calls = 0;
  await expect(
    exportData(path, [spec], async () => {
      if (++calls > 1) throw new Error("source_unavailable");
      return [0, 1, 2, 3].map((id) => transportRow([id, "kept"]));
    }),
  ).rejects.toThrow("source_unavailable");
  expect((await readFile(path, "utf8")).split(";\n")).toHaveLength(5);
  await rm(path);
});

it.each([
  "CAST('text' AS TEXT)",
  "CAST(X'ff' AS TEXT)",
  "CAST(X'61' AS BLOB)",
  "CAST(X'61' AS TEXT)||'tail'",
  "CAST(replace('x','x',char(10)) AS TEXT)",
  "CAST(X'61' AS TEXT);DROP TABLE data",
])("rejects data-only CAST extensions: %s", (value) => {
  expect(() => parseInsert(`INSERT INTO "data" ("value") VALUES(${value});`)).toThrow(
    "backup_invalid_data_sql",
  );
});
