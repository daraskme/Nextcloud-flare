import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, expect, it } from "vitest";
import { exportTables } from "../../packages/worker/src/db/schemaContract.ts";
import { foundationFixture } from "../../packages/worker/test/fixtures/foundation.ts";
import { exportData } from "../backup/export.mjs";
import { captureGeneration, restoreGeneration, verifyGeneration } from "../backup/generation.mjs";
import { initialize, migrations, quote, schemaDigest, schemaQuery } from "../backup/snapshot.mjs";
import { parseInsert, statements } from "../backup/sql.mjs";

let directory, db, versions, id, source;
const literal = (v) =>
  v === null ? "NULL" : typeof v === "number" ? String(v) : "'" + v.replaceAll("'", "''") + "'";
const snapshot = (database) =>
  Object.fromEntries(
    exportTables.map((table) => [
      table,
      database.prepare(`SELECT * FROM ${quote(table)} ORDER BY 1`).all(),
    ]),
  );
function dump(database) {
  const result = ["PRAGMA defer_foreign_keys=TRUE;"];
  for (const table of exportTables) {
    const columns = database
      .prepare(`PRAGMA table_info(${quote(table)})`)
      .all()
      .map((c) => c.name);
    for (const row of database.prepare(`SELECT * FROM ${quote(table)}`).all())
      result.push(
        `INSERT INTO ${quote(table)} (${columns.map(quote).join(",")}) VALUES(${columns.map((c) => literal(row[c])).join(",")});`,
      );
  }
  return result.join("\n");
}
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "backup-unit-"));
  versions = await migrations();
  db = initialize(":memory:", versions);
  id = randomUUID();
  const fixture = foundationFixture("backup", Date.now() - 1000);
  for (const s of fixture.statements) db.prepare(s.sql).run(...(s.values ?? []));
  db.prepare(
    "INSERT INTO blob_storage(blob_id,bytes,r2_etag,observed_at) VALUES(?,3,'stored',?)",
  ).run(fixture.ids.blob, Date.now());
  db.prepare(
    "INSERT INTO reservations(id,owner_id,bytes,state,expires_at,epoch) VALUES('held',?,5,'reserved',?,1)",
  ).run(fixture.ids.user, Date.now() + 86400000);
  db.prepare(
    "INSERT INTO search_index(node_id,space_id,text_norm,tokens,normalization_version,revision) VALUES(?,?,'sample','sample','fixture',1)",
  ).run(fixture.ids.file, fixture.ids.space);
  for (const [op, state] of [
    ["committed-history", "committed"],
    ["failed-history", "failed"],
  ]) {
    db.prepare(
      "INSERT INTO permits(permit_id,space_id,epoch,expires_at,state) VALUES(?,?,1,1,'released')",
    ).run(op, fixture.ids.space);
    db.prepare(`INSERT INTO operations(op_id,principal_kind,principal_id,credential_id,space_id,kind,state,request_digest,epoch,
      permit_id,permit_expires_at,claimed_expires_at,expected_steps,created_at,updated_at)
      VALUES(?,'user',?,?,?,'node.create',?,'digest',1,?,1,1,0,1,1)`).run(
      op,
      fixture.ids.user,
      fixture.ids.credential,
      fixture.ids.space,
      state,
      op,
    );
  }
  // Compact terminal fixtures test exact data preservation, not operation provenance or live recovery.
  const token = randomUUID();
  db.prepare(
    "INSERT INTO backup_runs(id,epoch,state,created_at,barrier_token,watermark) VALUES(?,1,'exporting',?,?,'committed-history')",
  ).run(id, Date.now(), token);
  db.prepare(
    "UPDATE control SET backup_token=?,backup_barrier_op='committed-history',backup_frozen=1",
  ).run(token);
  source = {
    query: async (sql) =>
      sql === "SELECT name FROM d1_migrations ORDER BY id"
        ? versions.map((v) => ({ name: v.name }))
        : db.prepare(sql).all(),
    export: async (path, tables) => {
      expect(tables.map((table) => table.name)).toEqual(exportTables);
      await writeFile(path, dump(db));
    },
  };
});
afterEach(async () => {
  db.close();
  await rm(directory, { recursive: true, force: true });
});
const capture = (extra = {}) => captureGeneration({ directory, id, epoch: 1, source, ...extra });
it("compares schemas across Wrangler comment stripping without normalizing quoted SQL values", () => {
  const schema = (sql) => [{ type: "table", name: "test", tbl_name: "test", sql }];
  expect(
    schemaDigest(schema("CREATE TABLE test(\n-- comment\n a TEXT DEFAULT '-- /* literal */')")),
  ).toBe(schemaDigest(schema("CREATE TABLE test(\n\n a TEXT DEFAULT '-- /* literal */')")));
  expect(schemaDigest(schema("CREATE TABLE test(a TEXT DEFAULT '-- /* changed */')"))).not.toBe(
    schemaDigest(schema("CREATE TABLE test(a TEXT DEFAULT '-- /* literal */')")),
  );
});
const changeManifest = async (path, mutate) => {
  const manifest = JSON.parse(await readFile(join(path, "manifest.json"), "utf8"));
  mutate(manifest);
  await writeFile(join(path, "manifest.json"), JSON.stringify(manifest));
};

it("captures every table, verifies hashes and restores schema, accounting, terminal history and FTS without thawing", async () => {
  const saved = snapshot(db),
    schema = schemaDigest(db.prepare(schemaQuery).all());
  const { directory: artifact, manifest } = await capture();
  expect(manifest.tables).toHaveLength(67);
  expect(manifest.generation.watermark).toBe("committed-history");
  expect(await readdir(artifact)).toEqual(["data.sql", "manifest.json"]);
  expect(await verifyGeneration(artifact)).toEqual(manifest);
  const target = join(directory, "restored.sqlite");
  await restoreGeneration({ directory: artifact, target });
  const restored = new DatabaseSync(target);
  try {
    expect(snapshot(restored)).toEqual(saved);
    expect(schemaDigest(restored.prepare(schemaQuery).all())).toBe(schema);
    expect(
      restored.prepare("SELECT used_bytes,reserved_bytes,physical_bytes FROM users").get(),
    ).toEqual({ used_bytes: 3, reserved_bytes: 5, physical_bytes: 3 });
    expect(
      restored.prepare("SELECT COUNT(*) n FROM search_fts WHERE search_fts MATCH 'sample'").get().n,
    ).toBe(1);
    expect(() => restored.exec("UPDATE users SET used_bytes=0")).toThrow("backup_frozen");
  } finally {
    restored.close();
  }
  expect(snapshot(db)).toEqual(saved);
});

it.each(["identity", "epoch", "thawed", "schema", "migration", "table", "view", "virtual"])(
  "rejects a conflicting source %s before exporting",
  async (change) => {
    let exported = false;
    source.export = async () => {
      exported = true;
    };
    const extra = {};
    if (change === "identity") extra.id = randomUUID();
    if (change === "epoch") extra.epoch = 2;
    if (change === "thawed") db.exec("UPDATE control SET backup_frozen=0");
    if (change === "schema") db.exec("CREATE INDEX unversioned_backup_index ON users(email)");
    if (change === "table")
      db.exec("CREATE TABLE unversioned_data(id TEXT NOT NULL PRIMARY KEY, value TEXT) STRICT");
    if (change === "view") db.exec("CREATE VIEW unversioned_view AS SELECT id FROM users");
    if (change === "virtual") db.exec("CREATE VIRTUAL TABLE unversioned_fts USING fts5(value)");
    if (change === "migration") {
      const query = source.query;
      source.query = (sql) =>
        sql.startsWith("SELECT name FROM d1_migrations") ? Promise.resolve([]) : query(sql);
    }
    await expect(capture(extra)).rejects.toThrow();
    expect(exported).toBe(false);
    expect(await readdir(directory)).toEqual([]);
  },
);
it.each(["table", "schema", "migration"])(
  "rejects source %s drift during export without leaving an artifact",
  async (kind) => {
    source.export = async (path) => {
      await writeFile(path, dump(db));
      if (kind === "table")
        db.exec("CREATE TABLE added_during_export(id INTEGER PRIMARY KEY) STRICT");
      if (kind === "schema") db.exec("CREATE INDEX added_during_export ON users(email)");
      if (kind === "migration") versions = versions.slice(0, -1);
    };
    await expect(capture()).rejects.toThrow();
    expect(await readdir(directory)).toEqual([]);
    expect(db.prepare("SELECT backup_frozen FROM control").get().backup_frozen).toBe(1);
  },
);
it("refuses a generation whose source barrier is released during export", async () => {
  source.export = async (path) => {
    await writeFile(path, dump(db));
    db.exec("UPDATE control SET backup_frozen=0");
  };
  await expect(capture()).rejects.toThrow("backup_not_frozen");
  expect(await readdir(directory)).toEqual([]);
});
it("allows only the named D1 and Wrangler infrastructure tables outside the application catalogue", async () => {
  const query = source.query;
  source.query = async (sql) => {
    const rows = await query(sql);
    return sql === "PRAGMA table_list"
      ? [
          ...rows,
          ...["_cf_KV", "_cf_METADATA", "d1_migrations"].map((name) => ({
            schema: "main",
            type: "table",
            name,
          })),
        ]
      : rows;
  };
  await expect(capture()).resolves.toBeDefined();
});
it("does not hide an extra ordinary table behind the Cloudflare internal prefix", async () => {
  db.exec("CREATE TABLE _cf_unversioned_data(id INTEGER PRIMARY KEY) STRICT");
  let exported = false;
  source.export = async () => {
    exported = true;
  };
  await expect(capture()).rejects.toThrow("backup_source_table_mismatch");
  expect(exported).toBe(false);
  expect(await readdir(directory)).toEqual([]);
});
it.each(["data", "omission", "injection", "column"])(
  "does not publish a corrupt export: %s",
  async (kind) => {
    const saved = snapshot(db);
    source.export = async (path) => {
      let sql = dump(db);
      if (kind === "data") sql = sql.replace("fixture@example.invalid", "changed@example.invalid");
      if (kind === "omission")
        sql = sql
          .split("\n")
          .filter((line) => !line.startsWith('INSERT INTO "search_index"'))
          .join("\n");
      if (kind === "injection") sql += "\nATTACH DATABASE '/tmp/unwanted.sqlite' AS external;";
      if (kind === "column") sql = sql.replace('("name") VALUES', '("unknown") VALUES');
      await writeFile(path, sql);
    };
    await expect(capture()).rejects.toThrow();
    expect(await readdir(directory)).toEqual([]);
    expect(snapshot(db)).toEqual(saved);
  },
);
it("detects export newline escaping that changes a literal backslash-n beside a real newline", async () => {
  db.exec("UPDATE control SET backup_frozen=0");
  db.prepare("UPDATE users SET email=?").run("real\nnewline; literal\\ntext");
  db.exec("UPDATE control SET backup_frozen=1");
  source.export = async (path) => {
    // Exact observed Miniflare escaping: replace() also converts pre-existing literal backslash-n.
    const sql = dump(db).replace(
      "'real\nnewline; literal\\ntext'",
      "replace('real\\nnewline; literal\\ntext','\\n',char(10))",
    );
    await writeFile(path, sql);
  };
  await expect(capture()).rejects.toThrow("backup_source_data_mismatch");
  expect(await readdir(directory)).toEqual([]);
});
it("preserves quoted semicolons, Unicode, CR/LF and literal backslashes in a lossless export", async () => {
  db.exec("UPDATE control SET backup_frozen=0");
  db.prepare("UPDATE users SET email=?").run("引用'😀;\r\n文字\\n\\r");
  db.exec("UPDATE control SET backup_frozen=1");
  const { directory: artifact } = await capture();
  await expect(verifyGeneration(artifact)).resolves.toBeDefined();
});
it("captures and restores exact query values including NUL through the production exporter", async () => {
  const value = "\ufeff引用'😀;\r\n文字\\n\\r\0end";
  db.exec("UPDATE control SET backup_frozen=0");
  db.prepare("UPDATE users SET email=?").run(value);
  db.exec("UPDATE control SET backup_frozen=1");
  source.export = (path, tables) => exportData(path, tables, source.query);
  const { directory: artifact } = await capture(),
    target = join(directory, "exact.sqlite");
  await restoreGeneration({ directory: artifact, target });
  const restored = new DatabaseSync(target);
  try {
    expect(restored.prepare("SELECT email FROM users").get().email).toBe(value);
    expect(restored.prepare("SELECT backup_frozen FROM control").get().backup_frozen).toBe(1);
    expect(db.prepare("SELECT backup_frozen FROM control").get().backup_frozen).toBe(1);
  } finally {
    restored.close();
  }
});
it("never replaces an existing generation or an existing restore destination", async () => {
  const { directory: artifact } = await capture();
  const saved = await readFile(join(artifact, "manifest.json"));
  await expect(capture()).rejects.toThrow("backup_destination_exists");
  expect(await readFile(join(artifact, "manifest.json"))).toEqual(saved);
  const target = join(directory, "existing.sqlite");
  await writeFile(target, "keep");
  await expect(restoreGeneration({ directory: artifact, target })).rejects.toThrow();
  expect(await readFile(target, "utf8")).toBe("keep");
});
it.each(["checksum", "schema", "migration", "table", "identity", "format"])(
  "rejects a manifest %s mismatch and removes only its new target",
  async (kind) => {
    const { directory: artifact } = await capture();
    await changeManifest(artifact, (m) => {
      if (kind === "checksum") m.data.sha256 = "0".repeat(64);
      if (kind === "schema") m.schema.sha256 = "0".repeat(64);
      if (kind === "migration") m.schema.migrations[0].sha256 = "0".repeat(64);
      if (kind === "table") m.tables.pop();
      if (kind === "identity") m.generation.id = randomUUID();
      if (kind === "format") m.version = 2;
    });
    const target = join(directory, "rejected.sqlite");
    await expect(restoreGeneration({ directory: artifact, target })).rejects.toThrow();
    expect(await readdir(directory)).not.toContain("rejected.sqlite");
  },
);
it("rejects arbitrary SQL even when a manifest's checksum is recomputed", async () => {
  const { directory: artifact } = await capture();
  const bytes = Buffer.from("PRAGMA foreign_keys=OFF; DROP TABLE users;");
  await writeFile(join(artifact, "data.sql"), bytes);
  await changeManifest(artifact, (m) => {
    m.data.bytes = bytes.length;
    m.data.sha256 = createHash("sha256").update(bytes).digest("hex");
  });
  await expect(verifyGeneration(artifact)).rejects.toThrow("backup_invalid_data_sql");
});
it("decodes the narrow Wrangler literal grammar without evaluating functions", () => {
  expect(
    parseInsert('INSERT INTO "x" ("a","b","c","d") VALUES(\'it\'\'s;\\n\',X\'00ff\',NULL,-1.5e2);'),
  ).toEqual({
    table: "x",
    columns: ["a", "b", "c", "d"],
    values: ["it's;\\n", Buffer.from([0, 255]), null, -150],
  });
  expect(
    parseInsert(
      "INSERT INTO \"x\" (\"a\") VALUES(replace(replace('line\\r\\n','\\r',char(13)),'\\n',char(10)));",
    ).values,
  ).toEqual(["line\r\n"]);
});
it.each([
  "ATTACH DATABASE 'outside' AS x;",
  "PRAGMA foreign_keys=OFF;",
  "CREATE TABLE x(a);",
  'INSERT INTO "x" ("a") VALUES(load_extension(\'x\'));',
  'INSERT INTO "x" ("a","a") VALUES(1,2);',
  'INSERT INTO "x" ("a") VALUES(9007199254740992);',
  'INSERT INTO "x" ("a") VALUES(1e999);',
  'INSERT INTO "x" ("a") VALUES(1); DELETE FROM users;',
])("rejects SQL outside the data grammar: %s", (sql) => expect(() => parseInsert(sql)).toThrow());
it("streams across UTF-8 and escaped quote boundaries and rejects truncated, oversized or invalid input", async () => {
  const sql = "INSERT INTO \"x\" (\"a\") VALUES('😀'';\ntext');";
  const chunks = Array.from(Buffer.from(sql), (byte) => Buffer.from([byte]));
  expect(await Array.fromAsync(statements(chunks))).toEqual([sql]);
  await expect(Array.fromAsync(statements([Buffer.from("INSERT INTO")]))).rejects.toThrow(
    "backup_incomplete_statement",
  );
  await expect(Array.fromAsync(statements([Buffer.from(sql)], 4))).rejects.toThrow(
    "backup_statement_too_large",
  );
  await expect(Array.fromAsync(statements([Buffer.from([0xff])]))).rejects.toThrow();
});
