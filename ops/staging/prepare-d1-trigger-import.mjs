// Prepare a consecutive D1 migration range for /import. This never contacts Cloudflare.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

assert.ok(
  process.argv.length === 3 || process.argv.length === 4,
  "Pass a first and optional last migration filename",
);
const migrations = new URL("../../packages/worker/migrations/", import.meta.url);
const first = process.argv[2];
const last = process.argv[3] ?? first;
const names = (await readdir(migrations))
  .filter((entry) => /^\d{4}_[a-z0-9_]+\.sql$/.test(entry))
  .sort();
const start = names.indexOf(first);
const end = names.indexOf(last);
assert.ok(
  start >= 2 && end >= start,
  "Migration range must exist, be ordered, and follow 0001/0002",
);
assert.deepEqual(names.slice(0, 2), ["0001_foundation.sql", "0002_content_media.sql"]);
const selected = names.slice(start, end + 1);

// Wrangler normally appends this record before sending the migration to /query.
// Put the same record in the /import payload so migrations list remains accurate.
let sql = "";
for (const name of selected) {
  const migration = await readFile(new URL(name, migrations), "utf8");
  assert.equal(migration.includes("\r"), false, `${name} must have LF line endings`);
  sql += `${migration.trimEnd()}\nINSERT INTO "d1_migrations" (name) values ('${name}');\n`;
}

// Check the exact payload against all preceding migrations on an empty DB.
const db = new DatabaseSync(":memory:");
let triggerCount;
try {
  db.exec(`CREATE TABLE d1_migrations(
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT UNIQUE,
    applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL
  );`);
  for (const previous of names.slice(0, start)) {
    db.exec(await readFile(new URL(previous, migrations), "utf8"));
    db.prepare("INSERT INTO d1_migrations(name) VALUES (?)").run(previous);
  }
  db.exec(sql);
  assert.deepEqual(
    db
      .prepare("SELECT name FROM d1_migrations ORDER BY id")
      .all()
      .map((row) => row.name),
    names.slice(0, end + 1),
  );
  triggerCount = db.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type='trigger'").get().n;
} finally {
  db.close();
}

const directory = await mkdtemp(join(tmpdir(), "ncf-d1-trigger-import-"));
const path = join(directory, `${first.slice(0, 4)}-${last.slice(0, 4)}.sql`);
await writeFile(path, sql, { mode: 0o600, flag: "wx" });
const sha256 = createHash("sha256").update(sql).digest("hex");
console.log(
  JSON.stringify(
    {
      path,
      sha256,
      first,
      last,
      migrations: selected.length,
      precedingMigrations: start,
      expectedTotalMigrations: end + 1,
      expectedTotalTriggers: triggerCount,
    },
    null,
    2,
  ),
);
