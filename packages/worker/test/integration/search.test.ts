import { applyD1Migrations } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { portableName, searchName } from "@next-cloud-flare/shared/names";
import { base64url } from "jose";
import { beforeAll, expect, it } from "vitest";
import { handleSearchHttp } from "../../src/api/search";
import { authorizeNode } from "../../src/auth/authorize";
import { contentKeyRing } from "../../src/auth/contentTokens";
import { SearchCursorTokens } from "../../src/auth/searchCursor";
import { atomicBatch } from "../../src/db/primary";
import { searchQuery } from "../../src/search/query";
import { searchNodes, searchStatement } from "../../src/services/search";
import { foundationFixture } from "../fixtures/foundation";

beforeAll(async () => applyD1Migrations(env.DB, env.TEST_MIGRATIONS));

async function fixture() {
  const f = foundationFixture(crypto.randomUUID(), Date.now() - 1000);
  await atomicBatch(env.DB, f.statements);
  await env.DB.prepare("UPDATE control SET maintenance=0,epoch=1 WHERE singleton=1").run();
  const principal = {
    kind: "user" as const,
    user_id: f.ids.user,
    credential_id: f.ids.credential,
    epoch: 1,
  };
  const ring = await contentKeyRing("test", {
    test: base64url.encode(crypto.getRandomValues(new Uint8Array(32))),
  });
  const cursors = new SearchCursorTokens(ring);
  const index = async (id: string, name: string) => {
    const q = searchName(name);
    await atomicBatch(env.DB, [
      {
        sql: "INSERT INTO search_index(node_id,space_id,text_norm,tokens,normalization_version,revision) SELECT id,space_id,?,?,?,revision FROM nodes WHERE id=?",
        values: [q.textNorm, q.tokens, q.version, id],
      },
      {
        sql: "INSERT INTO search_fts(rowid,text_norm,tokens) SELECT rowid,text_norm,tokens FROM search_index WHERE node_id=?",
        values: [id],
      },
    ]);
  };
  await index(f.ids.folder, "Folder");
  await index(f.ids.file, "File");
  const add = async (names: string[], parent = f.ids.folder) => {
    const rows = names.map((name) => ({
      id: crypto.randomUUID(),
      name,
      nameCi: portableName(name).nameCi,
      ...searchName(name),
    }));
    for (let start = 0; start < rows.length; start += 200) {
      const json = JSON.stringify(rows.slice(start, start + 200));
      await atomicBatch(env.DB, [
        {
          sql: `INSERT INTO nodes(id,space_id,owner_id,parent_id,name,name_ci,kind,created_at,updated_at)
          SELECT json_extract(value,'$.id'),?,?,?,json_extract(value,'$.name'),json_extract(value,'$.nameCi'),'folder',0,0 FROM json_each(?)`,
          values: [f.ids.space, f.ids.user, parent, json],
        },
        {
          sql: `INSERT INTO search_index(node_id,space_id,text_norm,tokens,normalization_version,revision)
          SELECT json_extract(value,'$.id'),?,json_extract(value,'$.textNorm'),json_extract(value,'$.tokens'),json_extract(value,'$.version'),1 FROM json_each(?)`,
          values: [f.ids.space, json],
        },
        {
          sql: "INSERT INTO search_fts(rowid,text_norm,tokens) SELECT rowid,text_norm,tokens FROM search_index WHERE node_id IN (SELECT json_extract(value,'$.id') FROM json_each(?))",
          values: [json],
        },
      ]);
    }
    return rows.map((r) => r.id);
  };
  const search = (q: string, cursor?: string, scope = f.ids.folder) =>
    searchNodes(env.DB, principal, scope, q, cursors, cursor);
  return { f, principal, cursors, add, search };
}

it("searches descendants with normalized terms, literal punctuation and final substring checks", async () => {
  const t = await fixture();
  const [deep] = await t.add(["Deep"]);
  await t.add(
    ["カタカナABC資料", "Straße_notes", "a++b", "a😀😁b", "100%_done", "abXbc", "abc", "éé"],
    deep!,
  );
  for (const [q, expected] of [
    ["ｶﾀｶﾅabc", "カタカナABC資料"],
    ["STRASSE", "Straße_notes"],
    ["++", "a++b"],
    ["😀😁", "a😀😁b"],
    ["%_", "100%_done"],
    ["abc", "abc"],
    ["éé", "éé"],
  ]) {
    const result = await t.search(q!);
    if (q === "abc") expect(result.items.map((r) => r.name)).toEqual(["abc", "カタカナABC資料"]);
    else expect(result.items.map((r) => r.name)).toEqual([expected]);
    expect(result.truncated).toBe(false);
  }
  expect((await t.search('" OR *')).items).toEqual([]);
  expect((await t.search("本")).items).toEqual([]);
  await t.add(["資料 outside"], t.f.ids.root);
  expect((await t.search("資料")).items.map((r) => r.name)).toEqual(["カタカナABC資料"]);
});

it("pages 201 matches and rejects cursors from another query, scope, credential or tree generation", async () => {
  const t = await fixture();
  await t.add(Array.from({ length: 201 }, (_, i) => `Match ${String(i).padStart(3, "0")}`));
  const first = await t.search("match");
  expect(first.items).toHaveLength(200);
  const cursor = first.nextCursor!;
  expect(cursor).toBeTruthy();
  expect((await t.search("MATCH", cursor)).items.map((r) => r.name)).toEqual(["Match 200"]);
  await expect(t.search("other", cursor)).rejects.toThrow("invalid_search_cursor");
  await expect(t.search("match", cursor, t.f.ids.root)).rejects.toThrow("invalid_search_cursor");
  const session = crypto.randomUUID();
  const credential = `as:${session}`;
  await atomicBatch(env.DB, [
    {
      sql: "INSERT INTO sessions(id,user_id,kind,fingerprint,epoch,issued_at,expires_at,last_seen_at) VALUES(?,?,'access',?,1,0,?,0)",
      values: [session, t.f.ids.user, session, Date.now() + 600000],
    },
    {
      sql: "INSERT INTO credentials(id,kind,session_id) VALUES(?,'access',?)",
      values: [credential, session],
    },
  ]);
  await expect(
    searchNodes(
      env.DB,
      { ...t.principal, credential_id: credential },
      t.f.ids.folder,
      "match",
      t.cursors,
      cursor,
    ),
  ).rejects.toThrow("invalid_search_cursor");
  await env.DB.prepare("UPDATE spaces SET tree_generation=tree_generation+1 WHERE id=?")
    .bind(t.f.ids.space)
    .run();
  await expect(t.search("match", cursor)).rejects.toThrow("invalid_search_cursor");
  const response = await handleSearchHttp(
    new Request(
      `https://app.invalid/api/v1/search?scopeId=${t.f.ids.folder}&q=match&cursor=${cursor}`,
    ),
    { ...env, APP_ORIGIN: "https://app.invalid" },
    t.principal,
    t.cursors,
  );
  expect(response.status).toBe(409);
});

it("never returns another owner's nodes or descendants of a deleted folder", async () => {
  const t = await fixture();
  const other = await fixture();
  await other.add(["Hidden Match"]);
  await expect(
    searchNodes(env.DB, t.principal, other.f.ids.root, "match", t.cursors),
  ).rejects.toThrow();
  const [parent] = await t.add(["Container"]);
  await t.add(["Hidden Match"], parent!);
  const op = crypto.randomUUID();
  await atomicBatch(env.DB, [
    {
      sql: "INSERT INTO trash_ops(op_id,actor_id,space_id,root_node_id,state,created_at,epoch) VALUES(?,?,?,?,'trashed',1,1)",
      values: [op, t.f.ids.user, t.f.ids.space, parent!],
    },
    { sql: "UPDATE nodes SET deleted_at=1,deleted_op_id=? WHERE id=?", values: [op, parent!] },
  ]);
  expect((await t.search("match")).items).toEqual([]);
  await expect(t.search("match", undefined, parent!)).rejects.toThrow();
  await expect(
    authorizeNode(
      env.DB,
      { ...t.principal, kind: "app_password" },
      { operation: "search.read", spaceId: t.f.ids.space, nodeId: t.f.ids.folder },
    ),
  ).rejects.toThrow();
  await expect(t.search("file", undefined, t.f.ids.file)).rejects.toThrow();
});

it("rechecks credentials and maintenance in the same batch that selects results", async () => {
  const t = await fixture();
  const db = {
    prepare: env.DB.prepare.bind(env.DB),
    async batch(statements: D1PreparedStatement[]) {
      await env.DB.prepare(
        "UPDATE sessions SET revoked_at=1 WHERE id=(SELECT session_id FROM credentials WHERE id=?)",
      )
        .bind(t.f.ids.credential)
        .run();
      return env.DB.batch(statements);
    },
  } as D1Database;
  await expect(searchNodes(db, t.principal, t.f.ids.folder, "file", t.cursors)).rejects.toThrow();
  const live = await fixture();
  await env.DB.prepare("UPDATE control SET maintenance=1 WHERE singleton=1").run();
  await expect(live.search("file")).rejects.toThrow();
});

it("marks missing or obsolete index rows incomplete instead of presenting a complete empty result", async () => {
  const t = await fixture();
  await env.DB.prepare("UPDATE search_index SET normalization_version='old' WHERE node_id=?")
    .bind(t.f.ids.file)
    .run();
  const result = await t.search("file");
  expect(result.items).toEqual([]);
  expect(result.truncated).toBe(true);
  await atomicBatch(env.DB, [
    {
      sql: "INSERT INTO search_fts(search_fts,rowid,text_norm,tokens) SELECT 'delete',rowid,text_norm,tokens FROM search_index WHERE node_id=?",
      values: [t.f.ids.file],
    },
    { sql: "DELETE FROM search_index WHERE node_id=?", values: [t.f.ids.file] },
  ]);
  expect((await t.search("file")).truncated).toBe(true);
  await env.DB.prepare("UPDATE nodes SET revision=revision+1 WHERE id=?")
    .bind(t.f.ids.folder)
    .run();
  // Index revision records the last text update, not a parent's child-list revision.
  expect((await t.search("folder", undefined, t.f.ids.root)).items.map((n) => n.id)).toContain(
    t.f.ids.folder,
  );
});

it("allows an internal grantee to search only within their live shared subtree", async () => {
  const owner = await fixture(),
    guest = await fixture();
  const share = crypto.randomUUID();
  await atomicBatch(env.DB, [
    {
      sql: "INSERT INTO shares(id,owner_id,root_node_id,kind,created_at) VALUES(?,?,?,'internal',0)",
      values: [share, owner.f.ids.user, owner.f.ids.folder],
    },
    { sql: "INSERT INTO share_actions(share_id,action) VALUES(?,'read')", values: [share] },
    {
      sql: "INSERT INTO share_grants(share_id,user_id,version) VALUES(?,?,1)",
      values: [share, guest.f.ids.user],
    },
  ]);
  const read = () =>
    searchNodes(env.DB, guest.principal, owner.f.ids.folder, "file", guest.cursors);
  expect((await read()).items.map((n) => n.id)).toEqual([owner.f.ids.file]);
  await expect(
    searchNodes(env.DB, guest.principal, owner.f.ids.root, "file", guest.cursors),
  ).rejects.toThrow();
  await env.DB.prepare("UPDATE share_grants SET disabled_at=1 WHERE share_id=?").bind(share).run();
  await expect(read()).rejects.toThrow();
});

it("caps the actual recursive scope at 10000 and keeps foreign matches outside that budget", async () => {
  const t = await fixture();
  await t.add(Array.from({ length: 10005 }, (_, i) => `Match ${String(i).padStart(5, "0")}`));
  const result = await t.search("match");
  expect(result.items).toHaveLength(200);
  expect(result.truncated).toBe(true);
  const q = searchQuery("match");
  const row = await env.DB.prepare(searchStatement(true))
    .bind(t.f.ids.folder, t.f.ids.space, t.f.ids.user, q.version, q.match, q.pattern, null, null)
    .first<{ scopeCount: number; hitCount: number }>();
  expect(row?.scopeCount).toBe(10000);
  expect(row!.hitCount).toBeLessThan(10000);
  const other = await fixture();
  await other.add(["Match visible"]);
  const visible = await other.search("match");
  expect(visible.items.map((n) => n.name)).toEqual(["Match visible"]);
  expect(visible.truncated).toBe(false);
}, 60_000);

it("validates the HTTP query and returns private cache headers", async () => {
  const t = await fixture();
  const call = (suffix: string, method = "GET") =>
    handleSearchHttp(
      new Request(`https://app.invalid/api/v1/search${suffix}`, { method }),
      { ...env, APP_ORIGIN: "https://app.invalid" },
      t.principal,
      t.cursors,
    );
  const response = await call(`?scopeId=${t.f.ids.folder}&q=file`);
  expect(response.status).toBe(200);
  expect(response.headers.get("Cache-Control")).toBe("private, no-store");
  expect(await response.json()).toMatchObject({ items: [{ id: t.f.ids.file }], truncated: false });
  for (const suffix of [
    "",
    `?scopeId=${t.f.ids.folder}&q=`,
    `?scopeId=${t.f.ids.folder}&q=a&q=b`,
    `?scopeId=${t.f.ids.folder}&q=a&extra=1`,
    `?scopeId=${t.f.ids.folder}&q=a&cursor=`,
  ])
    expect((await call(suffix)).status).toBe(400);
  expect((await call("", "POST")).status).toBe(404);
});

it("walks out of nested siblings and reaches depth64 from either root or a nested scope", async () => {
  const t = await fixture();
  const [a, z] = await t.add(["A branch", "Z branch"]);
  let parent = a!;
  for (let depth = 3; depth <= 64; depth++)
    [parent] = (await t.add([`Deep ${depth}`], parent)) as [string];
  const [sibling] = await t.add(["Deep sibling"], z!);
  const result = await t.search("Deep", undefined, t.f.ids.root);
  expect(result.items).toHaveLength(63);
  expect(result.items.map((n) => n.id)).toContain(parent);
  expect(result.items.map((n) => n.id)).toContain(sibling);
  expect(result.truncated).toBe(false);
  expect((await t.search("Deep 64", undefined, a!)).items.map((n) => n.id)).toEqual([parent]);
});
