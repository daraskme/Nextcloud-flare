import { randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { exportTables } from "../../../packages/worker/src/db/schemaContract.ts";
import { foundationFixture } from "../../../packages/worker/test/fixtures/foundation.ts";
import { captureGeneration } from "../../backup/generation.mjs";
import { initialize, migrations, quote } from "../../backup/snapshot.mjs";

export async function fixtureGeneration(directory, paddingRows = 0) {
  const versions = await migrations(),
    db = initialize(":memory:", versions),
    id = randomUUID();
  try {
    const fixture = foundationFixture("publication", Date.now() - 1000);
    for (const statement of fixture.statements)
      db.prepare(statement.sql).run(...(statement.values ?? []));
    for (let i = 0; i < paddingRows; i++) {
      // Separate bounded TEXT rows exercise multi-object SQL without increasing the SQL statement cap.
      db.prepare(
        "INSERT INTO users(id,access_iss,access_sub,email,role,quota_bytes,created_at) VALUES(?,'https://fixture.example',?,?,'member',0,0)",
      ).run(`padding-${i}`, `padding-${i}`, "x".repeat(1024 * 1024));
    }
    const token = randomUUID();
    db.prepare(
      "INSERT INTO backup_runs(id,epoch,state,created_at,barrier_token) VALUES(?,1,'exporting',?,?)",
    ).run(id, Date.now(), token);
    db.prepare("UPDATE control SET backup_token=?,backup_frozen=1").run(token);
    const literal = (v) =>
      v === null ? "NULL" : typeof v === "number" ? String(v) : "'" + v.replaceAll("'", "''") + "'";
    const sql = ["PRAGMA defer_foreign_keys=TRUE;"];
    for (const name of exportTables) {
      const columns = db
        .prepare(`PRAGMA table_info(${quote(name)})`)
        .all()
        .map((c) => c.name);
      for (const row of db.prepare(`SELECT * FROM ${quote(name)}`).all())
        sql.push(
          `INSERT INTO ${quote(name)} (${columns.map(quote).join(",")}) VALUES(${columns.map((c) => literal(row[c])).join(",")});`,
        );
    }
    return await captureGeneration({
      directory,
      id,
      epoch: 1,
      source: {
        query: async (command) =>
          command === "SELECT name FROM d1_migrations ORDER BY id"
            ? versions.map((v) => ({ name: v.name }))
            : db.prepare(command).all(),
        export: (path) => writeFile(path, sql.join("\n")),
      },
    });
  } finally {
    db.close();
  }
}
