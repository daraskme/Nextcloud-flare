import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";

import nodeRevisionSql from "../fixtures/g01-node-revision.sql?raw";
import trashRevisionSql from "../fixtures/g01-trash-revision.sql?raw";
import treeGenerationSql from "../fixtures/g01-tree-generation.sql?raw";

const tableNames = ["users", "spaces", "nodes", "trash_ops", "outbox"] as const;

function splitStatements(sql: string): string[] {
  return sql
    .split(/;\s*(?:\r?\n|$)/u)
    .map((statement) => statement.trim())
    .filter((statement) => statement.length > 0);
}

async function resetDatabase(): Promise<void> {
  const schema = `
    DROP TABLE IF EXISTS outbox;
    DROP TABLE IF EXISTS trash_ops;
    DROP TABLE IF EXISTS nodes;
    DROP TABLE IF EXISTS spaces;
    DROP TABLE IF EXISTS users;
    DROP TABLE IF EXISTS _assert;
    CREATE TABLE _assert(v INTEGER NOT NULL CHECK(v=0)) STRICT;
    CREATE TABLE users(
      id TEXT NOT NULL PRIMARY KEY,
      reserved_bytes INTEGER NOT NULL CHECK(reserved_bytes>=0),
      used_bytes INTEGER NOT NULL CHECK(used_bytes>=0)
    ) STRICT;
    CREATE TABLE spaces(
      id TEXT NOT NULL PRIMARY KEY,
      tree_generation INTEGER NOT NULL CHECK(tree_generation>=1)
    ) STRICT;
    CREATE TABLE nodes(
      id TEXT NOT NULL PRIMARY KEY,
      revision INTEGER NOT NULL CHECK(revision>=1),
      deleted_at INTEGER,
      last_op_id TEXT
    ) STRICT;
    CREATE TABLE trash_ops(
      op_id TEXT NOT NULL PRIMARY KEY,
      state TEXT NOT NULL CHECK(state IN ('pending','trashed'))
    ) STRICT;
    CREATE TABLE outbox(
      outbox_id TEXT NOT NULL PRIMARY KEY,
      op_id TEXT NOT NULL,
      state TEXT NOT NULL CHECK(state='pending')
    ) STRICT;
    INSERT INTO users(id,reserved_bytes,used_bytes) VALUES('user',100,0);
    INSERT INTO spaces(id,tree_generation) VALUES('space',7);
    INSERT INTO nodes(id,revision,deleted_at,last_op_id) VALUES('node',3,NULL,NULL);
    INSERT INTO trash_ops(op_id,state) VALUES('trash','pending');
  `;
  await env.DB.batch(splitStatements(schema).map((statement) => env.DB.prepare(statement)));
}

async function snapshot(): Promise<Record<string, unknown[]>> {
  const entries = await Promise.all(
    tableNames.map(async (table) => {
      const result = await env.DB.prepare(`SELECT * FROM ${table} ORDER BY 1`).all();
      return [table, result.results] as const;
    }),
  );
  return Object.fromEntries(entries);
}

async function runFixture(sql: string): Promise<void> {
  const statements = splitStatements(sql).map((statement) => env.DB.prepare(statement));
  await env.DB.batch(statements);
}

beforeEach(resetDatabase);

describe("D1 SQL error barrier", () => {
  it.each([
    ["g01-node-revision", nodeRevisionSql],
    ["g01-tree-generation", treeGenerationSql],
    ["g01-trash-revision", trashRevisionSql],
  ])("rolls back every side effect for %s", async (_name, sql) => {
    const before = await snapshot();
    await expect(runFixture(sql)).rejects.toThrow();
    await expect(snapshot()).resolves.toEqual(before);
  });

  it("makes changes() refer to the immediately preceding statement", async () => {
    await expect(
      env.DB.batch([
        env.DB.prepare("UPDATE nodes SET revision=revision+1 WHERE id='missing'"),
        env.DB.prepare("INSERT INTO _assert(v) SELECT 1 WHERE changes()<>0"),
        env.DB.prepare(
          "UPDATE spaces SET tree_generation=tree_generation+1 WHERE id='space' AND tree_generation=7",
        ),
        env.DB.prepare("INSERT INTO _assert(v) SELECT 1 WHERE changes()<>1"),
      ]),
    ).resolves.toHaveLength(4);

    const space = await env.DB.prepare(
      "SELECT tree_generation FROM spaces WHERE id='space'",
    ).first<{
      tree_generation: number;
    }>();
    expect(space?.tree_generation).toBe(8);
  });

  it("rejects the stale-target counterexample with precondition and postcondition EXISTS", async () => {
    await env.DB.prepare("UPDATE spaces SET tree_generation=8 WHERE id='space'").run();
    await env.DB.batch([
      env.DB.prepare(
        "UPDATE spaces SET tree_generation=tree_generation+1 WHERE id='space' AND tree_generation=7",
      ),
      env.DB.prepare(
        "INSERT INTO _assert(v) SELECT 1 WHERE NOT EXISTS(SELECT 1 FROM spaces WHERE id='space' AND tree_generation=8)",
      ),
      env.DB.prepare("UPDATE users SET used_bytes=used_bytes+1 WHERE id='user'"),
    ]);
    const unsafeUser = await env.DB.prepare("SELECT used_bytes FROM users WHERE id='user'").first<{
      used_bytes: number;
    }>();
    expect(unsafeUser?.used_bytes).toBe(1);

    await resetDatabase();
    await env.DB.prepare("UPDATE spaces SET tree_generation=8 WHERE id='space'").run();
    const before = await snapshot();
    await expect(
      env.DB.batch([
        env.DB.prepare(
          "INSERT INTO _assert(v) SELECT 1 WHERE NOT EXISTS(SELECT 1 FROM spaces WHERE id='space' AND tree_generation=7)",
        ),
        env.DB.prepare(
          "UPDATE spaces SET tree_generation=tree_generation+1 WHERE id='space' AND tree_generation=7",
        ),
        env.DB.prepare(
          "INSERT INTO _assert(v) SELECT 1 WHERE NOT EXISTS(SELECT 1 FROM spaces WHERE id='space' AND tree_generation=8)",
        ),
        env.DB.prepare("UPDATE users SET used_bytes=used_bytes+1 WHERE id='user'"),
      ]),
    ).rejects.toThrow();
    await expect(snapshot()).resolves.toEqual(before);
  });
});
