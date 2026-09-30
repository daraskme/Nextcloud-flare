import { applyD1Migrations } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeAll, expect, it } from "vitest";
import { handleStatsHttp, statsRoute } from "../../src/api/stats";
import { atomicBatch } from "../../src/db/primary";
import { readFolderStats } from "../../src/services/stats";
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
  const add = async (count: number, kind: "folder" | "file", parent = f.ids.folder) => {
    const ids = Array.from({ length: count }, () => crypto.randomUUID());
    for (let start = 0; start < count; start += 200)
      await env.DB.prepare(`INSERT INTO nodes(id,space_id,owner_id,parent_id,name,name_ci,kind,current_blob_id,created_at,updated_at)
        SELECT value,?,?,?,value,value,?,?,0,0 FROM json_each(?)`)
        .bind(
          f.ids.space,
          f.ids.user,
          parent,
          kind,
          kind === "file" ? f.ids.blob : null,
          JSON.stringify(ids.slice(start, start + 200)),
        )
        .run();
    return ids;
  };
  return {
    f,
    principal,
    add,
    stats: (scope?: string) => readFolderStats(env.DB, principal, scope),
  };
}

it("counts recursive current logical files including copies, with no persistent stats or R2 reads", async () => {
  const t = await fixture();
  expect(await t.stats()).toMatchObject({
    scopeId: t.f.ids.root,
    fileCount: 1,
    folderCount: 1,
    totalBytes: 3,
    scannedNodes: 3,
    unavailableFiles: 0,
    truncated: false,
  });
  const [child, empty] = await t.add(2, "folder");
  await t.add(2, "file", child!);
  expect(await t.stats(t.f.ids.folder)).toMatchObject({
    fileCount: 3,
    folderCount: 2,
    totalBytes: 9,
    scannedNodes: 6,
    truncated: false,
  });
  expect(await t.stats(empty)).toMatchObject({
    fileCount: 0,
    folderCount: 0,
    totalBytes: 0,
    scannedNodes: 1,
    truncated: false,
  });
});

it("excludes deleted ancestors and their still-live descendants", async () => {
  const t = await fixture();
  const [child] = await t.add(1, "folder");
  await t.add(3, "file", child!);
  const op = crypto.randomUUID();
  await atomicBatch(env.DB, [
    {
      sql: "INSERT INTO trash_ops(op_id,actor_id,space_id,root_node_id,state,created_at,epoch) VALUES(?,?,?,?,'trashed',1,1)",
      values: [op, t.f.ids.user, t.f.ids.space, child!],
    },
    { sql: "UPDATE nodes SET deleted_at=1,deleted_op_id=? WHERE id=?", values: [op, child!] },
  ]);
  expect(await t.stats(t.f.ids.folder)).toMatchObject({
    fileCount: 1,
    folderCount: 0,
    totalBytes: 3,
  });
  await expect(t.stats(child)).rejects.toThrow();
});

it("does not treat a file without current content as a complete byte total", async () => {
  const t = await fixture();
  await env.DB.prepare("UPDATE nodes SET current_blob_id=NULL WHERE id=?").bind(t.f.ids.file).run();
  await env.DB.prepare("UPDATE blobs SET state='deleting' WHERE id=?").bind(t.f.ids.blob).run();
  expect(await t.stats()).toMatchObject({ fileCount: 1, totalBytes: 0, unavailableFiles: 1 });
});

it("limits account stats to owned folders even for an administrator with a share grant", async () => {
  const t = await fixture();
  const other = await fixture();
  const share = crypto.randomUUID();
  await atomicBatch(env.DB, [
    {
      sql: "INSERT INTO shares(id,owner_id,root_node_id,kind,created_at) VALUES(?,?,?,'internal',0)",
      values: [share, other.f.ids.user, other.f.ids.folder],
    },
    { sql: "INSERT INTO share_actions(share_id,action) VALUES(?,'read')", values: [share] },
    {
      sql: "INSERT INTO share_grants(share_id,user_id,version) VALUES(?,?,1)",
      values: [share, t.f.ids.user],
    },
  ]);
  await expect(t.stats(other.f.ids.folder)).rejects.toThrow();
  await expect(t.stats(t.f.ids.file)).rejects.toThrow();
  await expect(t.stats("missing")).rejects.toThrow();
  await expect(t.stats("../invalid")).rejects.toThrow();
  await expect(
    readFolderStats(env.DB, { ...t.principal, kind: "app_password" }, t.f.ids.folder),
  ).rejects.toThrow();
  await expect(
    readFolderStats(env.DB, { ...t.principal, user_id: other.f.ids.user }, other.f.ids.folder),
  ).rejects.toThrow();
});

it.each(["session", "maintenance", "epoch", "generation", "disabled"])(
  "rechecks %s in the same batch as the aggregate",
  async (change) => {
    const t = await fixture();
    const changes = {
      session: env.DB.prepare("UPDATE sessions SET revoked_at=1 WHERE id=?").bind(t.f.ids.session),
      maintenance: env.DB.prepare("UPDATE control SET maintenance=1 WHERE singleton=1"),
      epoch: env.DB.prepare("UPDATE control SET epoch=2 WHERE singleton=1"),
      generation: env.DB.prepare(
        "UPDATE spaces SET tree_generation=tree_generation+1 WHERE id=?",
      ).bind(t.f.ids.space),
      disabled: env.DB.prepare("UPDATE users SET disabled_at=1 WHERE id=?").bind(t.f.ids.user),
    };
    const db = {
      prepare: env.DB.prepare.bind(env.DB),
      async batch(statements: D1PreparedStatement[]) {
        await changes[change as keyof typeof changes].run();
        return env.DB.batch(statements);
      },
    } as D1Database;
    await expect(readFolderStats(db, t.principal, t.f.ids.folder)).rejects.toThrow();
  },
);

it("stops a wide tree at 10,000 visited nodes and labels the result partial", async () => {
  const t = await fixture();
  await t.add(10_001, "folder");
  const result = await t.stats(t.f.ids.folder);
  expect(result.scannedNodes).toBe(10_000);
  expect(result.fileCount + result.folderCount).toBe(9_999);
  expect(result.truncated).toBe(true);
});

it("traverses nested siblings through absolute depth 64 and preserves the database depth guard", async () => {
  const t = await fixture();
  let parent = t.f.ids.folder;
  for (let depth = 2; depth <= 64; depth++)
    [parent] = (await t.add(1, "folder", parent)) as [string];
  await t.add(2, "folder", t.f.ids.root);
  expect(await t.stats()).toMatchObject({ folderCount: 66, fileCount: 1, truncated: false });
  await expect(t.add(1, "file", parent)).rejects.toThrow("invalid_tree_depth");
  expect(await t.stats(parent)).toMatchObject({ folderCount: 0, fileCount: 0, truncated: false });
});

it("validates the HTTP scope and returns private uncached JSON", async () => {
  const t = await fixture();
  const configured = { ...env, APP_ORIGIN: "https://app.invalid" };
  const get = (query: string) =>
    handleStatsHttp(
      new Request(`https://app.invalid/api/v1/stats${query}`),
      configured,
      t.principal,
    );
  const response = await get(`?scopeId=${t.f.ids.folder}`);
  expect(response.status).toBe(200);
  expect(response.headers.get("Cache-Control")).toBe("private, no-store");
  expect(response.headers.get("X-Content-Type-Options")).toBe("nosniff");
  expect(await response.json()).toMatchObject({ fileCount: 1, totalBytes: 3 });
  expect((await get("")).status).toBe(200);
  for (const query of ["?scopeId=", "?scopeId=a&scopeId=b", "?scopeId=..", "?q=unexpected"])
    expect((await get(query)).status).toBe(400);
  expect((await get(`?scopeId=${t.f.ids.file}`)).status).toBe(404);
  expect(statsRoute(new Request("https://app.invalid/api/v1/stats", { method: "POST" }))).toBe(
    false,
  );
  expect(
    (
      await handleStatsHttp(
        new Request("https://other.invalid/api/v1/stats"),
        configured,
        t.principal,
      )
    ).status,
  ).toBe(404);
});
