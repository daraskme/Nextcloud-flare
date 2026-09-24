import { applyD1Migrations } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeAll, expect, it } from "vitest";
import { atomicBatch } from "../../src/db/primary";
import { exportTables, purgeOrder } from "../../src/db/schemaContract";
import { deletionOrder, type ForeignKey } from "../../src/db/schemaGraph";
import { foundationFixture } from "../fixtures/foundation";

beforeAll(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
});

it("applies the production migrations on D1 with every foreign key enabled", async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS); // idempotent runner, not repeated SQL
  expect((await env.DB.prepare("PRAGMA foreign_key_check").all()).results).toEqual([]);
  expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM d1_migrations").first("n")).toBe(36);
  const graph = [];
  for (const name of exportTables) {
    const result = await env.DB.prepare(`PRAGMA foreign_key_list('${name}')`).all<ForeignKey>();
    graph.push({ name, foreignKeys: result.results });
  }
  expect(deletionOrder(graph)).toEqual(purgeOrder);
});

it("rolls back a production-schema batch when a structural guard rejects a later step", async () => {
  const { ids, statements } = foundationFixture("rollback", Date.now());
  await atomicBatch(env.DB, statements);
  await expect(
    atomicBatch(env.DB, [
      { sql: "UPDATE users SET used_bytes=123 WHERE id=?", values: [ids.user] },
      { sql: "UPDATE nodes SET parent_id=? WHERE id=?", values: [ids.folder, ids.folder] },
    ]),
  ).rejects.toThrow();
  expect(
    await env.DB.prepare("SELECT used_bytes FROM users WHERE id=?")
      .bind(ids.user)
      .first("used_bytes"),
  ).toBe(3);
});

it("enforces depth 64/65 in actual D1 triggers", async () => {
  const { ids, statements } = foundationFixture("depth", Date.now());
  await atomicBatch(env.DB, statements);
  await atomicBatch(
    env.DB,
    Array.from({ length: 64 }, (_, i) => ({
      sql: "INSERT INTO nodes(id,space_id,owner_id,parent_id,name,name_ci,kind,created_at,updated_at) VALUES(?,?,?,?,?,?,'folder',1,1)",
      values: [
        `d-${i}`,
        ids.space,
        ids.user,
        i === 0 ? ids.root : `d-${i - 1}`,
        `d-${i}`,
        `d-${i}`,
      ],
    })),
  );
  await expect(
    env.DB.prepare(
      "INSERT INTO nodes(id,space_id,owner_id,parent_id,name,name_ci,kind,created_at,updated_at) VALUES('d65',?,?,'d-63','d65','d65','folder',1,1)",
    )
      .bind(ids.space, ids.user)
      .run(),
  ).rejects.toThrow(/depth/);
});

it("exports base search data and rebuilds FTS in D1", async () => {
  const { ids, statements } = foundationFixture("fts", Date.now());
  await atomicBatch(env.DB, statements);
  await env.DB.prepare(
    "INSERT INTO search_index(node_id,space_id,text_norm,tokens,normalization_version,revision) VALUES(?,?,'hello','he el ll lo','v1',1)",
  )
    .bind(ids.file, ids.space)
    .run();
  await env.DB.prepare("INSERT INTO search_fts(search_fts) VALUES('rebuild')").run();
  expect(
    (await env.DB.prepare("SELECT rowid FROM search_fts WHERE search_fts MATCH 'hello'").all())
      .results,
  ).toHaveLength(1);
});

it("requires a complete bounded restore pause tuple and keeps operator policy separate", async () => {
  const token = crypto.randomUUID(),
    operation = `op_${"a".repeat(64)}`;
  for (const [held, op, expires] of [
    [token, null, null],
    [null, operation, 1],
    [token, operation, null],
    [token, operation, 0],
    [token, operation, 1.5],
    [token, operation, 9007199254740992],
    ["short", operation, 1],
    [token, "not_an_operation", 1],
  ]) {
    await expect(
      env.DB.prepare("UPDATE control SET gc_hold_token=?,gc_hold_operation=?,gc_hold_expires_at=?")
        .bind(held, op, expires)
        .run(),
    ).rejects.toThrow();
  }
  await expect(env.DB.prepare("UPDATE control SET gc_operator_paused=2").run()).rejects.toThrow();
  await env.DB.prepare(
    "UPDATE control SET gc_operator_paused=0,gc_paused=1,gc_hold_token=?,gc_hold_operation=?,gc_hold_expires_at=?",
  )
    .bind(token, operation, Date.now() + 60_000)
    .run();
  expect(await env.DB.prepare("SELECT gc_operator_paused,gc_paused FROM control").first()).toEqual({
    gc_operator_paused: 0,
    gc_paused: 1,
  });
  await env.DB.prepare(
    "UPDATE control SET gc_operator_paused=1,gc_hold_token=NULL,gc_hold_operation=NULL,gc_hold_expires_at=NULL",
  ).run();
});
