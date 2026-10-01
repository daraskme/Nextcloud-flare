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
  expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM d1_migrations").first("n")).toBe(50);
  const graph = [];
  for (const name of exportTables) {
    const result = await env.DB.prepare(`PRAGMA foreign_key_list('${name}')`).all<ForeignKey>();
    graph.push({ name, foreignKeys: result.results });
  }
  expect(deletionOrder(graph)).toEqual(purgeOrder);
});

it("installs normalized private user node state with backup barriers", async () => {
  const table = await env.DB.prepare(
    "SELECT sql FROM sqlite_master WHERE type='table' AND name='user_node_state'",
  ).first<string>("sql");
  expect(table).toContain("PRIMARY KEY(user_id,node_id)");
  expect(table).toContain("CHECK(starred=1 OR last_opened_at IS NOT NULL)");
  const indexes = await env.DB.prepare(
    "SELECT name FROM sqlite_master WHERE type='index' AND name LIKE 'user_node_state_%' ORDER BY name",
  ).all<{ name: string }>();
  expect(indexes.results.map(({ name }) => name)).toEqual([
    "user_node_state_node_id_fk",
    "user_node_state_recent",
    "user_node_state_starred",
  ]);
  const triggers = await env.DB.prepare(
    "SELECT name FROM sqlite_master WHERE type='trigger' AND name LIKE '%user_node_state%' ORDER BY name",
  ).all<{ name: string }>();
  expect(triggers.results.map(({ name }) => name)).toEqual([
    "backup_freeze_user_node_state_delete",
    "backup_freeze_user_node_state_insert",
    "backup_freeze_user_node_state_update",
    "user_node_state_identity",
  ]);
  expect(exportTables).toContain("user_node_state");
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

it("installs immutable bounded-reshare authority and lifecycle schema", async () => {
  const tables = await env.DB.prepare(
    `SELECT name FROM sqlite_master WHERE type='table' AND name IN (
      'share_reshare_policies','share_reshare_policy_actions','share_delegations',
      'share_delegation_ancestry','share_delegation_status','share_reshare_requests'
    ) ORDER BY name`,
  ).all<{ name: string }>();
  expect(tables.results.map(({ name }) => name)).toEqual([
    "share_delegation_ancestry",
    "share_delegation_status",
    "share_delegations",
    "share_reshare_policies",
    "share_reshare_policy_actions",
    "share_reshare_requests",
  ]);
  const triggers = await env.DB.prepare(
    `SELECT name FROM sqlite_master WHERE type='trigger' AND name IN (
      'share_delegations_immutable','share_delegation_source_changed',
      'share_delegation_policy_changed','share_delegation_group_recipient_changed',
      'share_delegation_ancestry_changed','share_reshare_requests_immutable',
      'share_delegation_status_insert','share_delegation_status_no_reactivate',
      'share_delegation_status_invalidate_descendants'
    ) ORDER BY name`,
  ).all<{ name: string }>();
  expect(triggers.results.map(({ name }) => name)).toEqual([
    "share_delegation_ancestry_changed",
    "share_delegation_group_recipient_changed",
    "share_delegation_policy_changed",
    "share_delegation_source_changed",
    "share_delegation_status_insert",
    "share_delegation_status_invalidate_descendants",
    "share_delegation_status_no_reactivate",
    "share_delegations_immutable",
    "share_reshare_requests_immutable",
  ]);
  expect(
    await env.DB.prepare(
      "SELECT sql FROM sqlite_master WHERE type='view' AND name='current_internal_shares'",
    ).first<string>("sql"),
  ).toContain("share_delegation_status");
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
