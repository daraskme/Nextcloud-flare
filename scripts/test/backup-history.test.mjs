import { createHash, randomUUID } from "node:crypto";
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, expect, it } from "vitest";
import { foundationFixture } from "../../packages/worker/test/fixtures/foundation.ts";
import { restoreGeneration, verifyGeneration } from "../backup/generation.mjs";
import { downloadGeneration, publishGeneration } from "../backup/publication.mjs";
import {
  barrier,
  barrierQuery,
  initialize,
  migrations,
  quote,
  schemaDigest,
  schemaQuery,
  specs,
  tableDigests,
} from "../backup/snapshot.mjs";

let root;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "backup-history-"));
});
afterEach(() => rm(root, { recursive: true, force: true }));

// Construct the old schema from immutable migrations, not the current capture
// code, which must continue to require the latest source schema.
async function historical(last = 37) {
  const available = await migrations(),
    versions = available.slice(0, last);
  const db = initialize(":memory:", versions),
    id = randomUUID(),
    token = randomUUID();
  try {
    for (const statement of foundationFixture("past", 1).statements)
      db.prepare(statement.sql).run(...(statement.values ?? []));
    db.prepare(
      "INSERT INTO node_props(node_id,namespace,name,value_xml) VALUES('past-f','urn:history','value',?)",
    ).run("<p>引用'😀;\r\n文字\\n\\r</p>");
    db.exec(
      "INSERT INTO search_index(node_id,space_id,text_norm,tokens,normalization_version,revision) VALUES('past-f','past-s','history','history','v1',1)",
    );
    db.prepare(
      "INSERT INTO backup_runs(id,epoch,state,created_at,barrier_token) VALUES(?,1,'exporting',1,?)",
    ).run(id, token);
    db.prepare("UPDATE control SET backup_token=?,backup_frozen=1").run(token);
    const tableSpecs = specs(db),
      lines = ["PRAGMA defer_foreign_keys=TRUE;"];
    const literal = (value) =>
      value === null
        ? "NULL"
        : typeof value === "number"
          ? String(value)
          : "'" + value.replaceAll("'", "''") + "'";
    for (const table of tableSpecs)
      for (const row of db.prepare(`SELECT * FROM ${quote(table.name)}`).all())
        lines.push(
          `INSERT INTO ${quote(table.name)} (${table.columns.map(quote).join(",")}) VALUES(${table.columns.map((name) => literal(row[name])).join(",")});`,
        );
    const data = Buffer.from(lines.join("\n"));
    const manifest = {
      format: "nextcloud-flare.logical-backup",
      version: 1,
      capturedAt: 2,
      generation: barrier(db.prepare(barrierQuery).all(), id, 1),
      schema: {
        migrations: versions.map(({ name, sha256 }) => ({ name, sha256 })),
        sha256: schemaDigest(db.prepare(schemaQuery).all()),
      },
      tables: await tableDigests(tableSpecs, async (sql) => db.prepare(sql).all()),
      data: {
        file: "data.sql",
        bytes: data.length,
        sha256: createHash("sha256").update(data).digest("hex"),
      },
    };
    await writeFile(join(root, "data.sql"), data);
    await writeFile(join(root, "manifest.json"), JSON.stringify(manifest));
    return manifest;
  } finally {
    db.close();
  }
}

it.each([37, 38])(
  "restores schema %s without applying later migrations or thawing the snapshot",
  async (last) => {
    const manifest = await historical(last),
      target = join(root, "restored.sqlite");
    expect(await verifyGeneration(root)).toEqual(manifest);
    await restoreGeneration({ directory: root, target });
    const db = new DatabaseSync(target);
    try {
      expect(schemaDigest(db.prepare(schemaQuery).all())).toBe(manifest.schema.sha256);
      expect(db.prepare("SELECT backup_frozen FROM control").get().backup_frozen).toBe(1);
      expect(() => db.exec("UPDATE users SET used_bytes=0")).toThrow("backup_frozen");
      expect(db.prepare("SELECT used_bytes FROM users WHERE id='past-u'").get().used_bytes).toBe(3);
      expect(
        db.prepare("SELECT COUNT(*) n FROM search_fts WHERE search_fts MATCH 'history'").get().n,
      ).toBe(1);
      expect(db.prepare("SELECT value_xml FROM node_props").get().value_xml).toBe(
        "<p>引用'😀;\r\n文字\\n\\r</p>",
      );
      expect(db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
      expect(
        db.prepare("SELECT name FROM sqlite_schema WHERE name='backup_completion_update'").get()
          ?.name,
      ).toBe(last >= 38 ? "backup_completion_update" : undefined);
    } finally {
      db.close();
    }
  },
);

it.each(["hash", "gap", "order", "future", "too_old", "extra_key", "absent"])(
  "rejects an untrusted migration history: %s",
  async (kind) => {
    const manifest = await historical(),
      records = manifest.schema.migrations;
    if (kind === "hash") records[0].sha256 = "0".repeat(64);
    if (kind === "gap") records.splice(3, 1);
    if (kind === "order") records.reverse();
    if (kind === "future") records.push({ name: "9999_untrusted.sql", sha256: "a".repeat(64) });
    if (kind === "too_old") records.length = 36;
    if (kind === "extra_key") records[0].sql = "DROP TABLE users";
    if (kind === "absent") delete manifest.schema.migrations;
    await writeFile(join(root, "manifest.json"), JSON.stringify(manifest));
    const target = join(root, "rejected.sqlite");
    await expect(restoreGeneration({ directory: root, target })).rejects.toThrow(
      "backup_migration_mismatch",
    );
    await expect(access(target)).rejects.toMatchObject({ code: "ENOENT" });
  },
);

it("rejects old data with a forged matching byte checksum and preserves an existing destination", async () => {
  const manifest = await historical(),
    data = await readFile(join(root, "data.sql"), "utf8");
  const changed = Buffer.from(data.replace("fixture@example.invalid", "changed@example.invalid"));
  await writeFile(join(root, "data.sql"), changed);
  manifest.data = {
    ...manifest.data,
    bytes: changed.length,
    sha256: createHash("sha256").update(changed).digest("hex"),
  };
  await writeFile(join(root, "manifest.json"), JSON.stringify(manifest));
  await expect(verifyGeneration(root)).rejects.toThrow("backup_data_mismatch");
  const target = join(root, "existing.sqlite");
  await writeFile(target, "preserve");
  await expect(restoreGeneration({ directory: root, target })).rejects.toThrow();
  expect(await readFile(target, "utf8")).toBe("preserve");
});

it("round-trips a historical schema through immutable publication and verified download", async () => {
  const manifest = await historical(37),
    objects = new Map();
  const store = {
    async get(key) {
      return objects.get(key) ?? null;
    },
    async put(key, bytes) {
      if (objects.has(key)) return false;
      objects.set(key, Buffer.from(bytes));
      return true;
    },
  };
  const published = await publishGeneration({ directory: root, store });
  const downloaded = await downloadGeneration({
    directory: join(root, "download"),
    id: manifest.generation.id,
    store,
    expectedSha256: published.sha256,
  });
  expect(downloaded.manifest).toEqual(manifest);
  expect(await readFile(join(downloaded.directory, "data.sql"))).toEqual(
    await readFile(join(root, "data.sql")),
  );
  expect(objects.size).toBe(2);
});
