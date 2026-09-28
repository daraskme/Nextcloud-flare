import { applyD1Migrations } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { searchName } from "@next-cloud-flare/shared/names";
import { beforeAll, beforeEach, expect, it } from "vitest";
import { publicPrincipal } from "../../src/api/publicShareRead";
import { publicShareRoute } from "../../src/api/publicShares";
import { accessPrincipal } from "../../src/auth/authorize";
import { contentKeyRing } from "../../src/auth/contentTokens";
import { ListCursorTokens } from "../../src/auth/listCursor";
import { lockTokenHashes } from "../../src/auth/locks";
import { atomicBatch } from "../../src/db/primary";
import type { VisibleOperation } from "../../src/jobs/operations";
import { nodeEventAuthority, readOutboxEvent } from "../../src/jobs/outboxAuthority";
import { createLinkShare, updateLinkShare } from "../../src/services/linkShares";
import { purgeTrash } from "../../src/services/purgeTrash";
import { restoreTrash } from "../../src/services/restoreTrash";
import { unlockShare } from "../../src/services/shareUnlock";
import { listTrash } from "../../src/services/trashRead";
import { publicShareFixture as fixture } from "../fixtures/publicShare";
import { injectBatch } from "../fixtures/uploadEnv";

beforeAll(() => applyD1Migrations(env.DB, env.TEST_MIGRATIONS));
beforeEach(async () => {
  await env.DB.prepare("UPDATE control SET maintenance=1").run();
  await env.DB.prepare("UPDATE control SET epoch=1,maintenance=0,gc_paused=1").run();
});
type Fixture = Awaited<ReturnType<typeof fixture>>;
const remove = (t: Fixture, node = t.f.ids.file, revision = 1, key = crypto.randomUUID()) =>
  t.request(`/nodes/${node}`, "DELETE", { revision }, t.token, key);
const live = (t: Fixture) =>
  env.DB.prepare("SELECT deleted_at FROM nodes WHERE id=?").bind(t.f.ids.file).first("deleted_at");

it("trashes once with anonymous attribution and a bounded original-session receipt", async () => {
  const t = await fixture(),
    key = crypto.randomUUID();
  expect(publicShareRoute(remove(t))).toBe(true);
  const response = await t.http(remove(t, t.f.ids.file, 1, key));
  expect(response.status).toBe(200);
  const op = await response.json<VisibleOperation>();
  expect(op).toMatchObject({ state: "committed", result: { status: 204 } });
  expect(op.result).not.toHaveProperty("nodeId");
  expect(await live(t)).toBeTypeOf("number");
  expect(await (await t.http(remove(t, t.f.ids.file, 1, key))).json()).toEqual(op);
  expect((await t.http(remove(t, t.f.ids.file, 2, key))).status).toBe(409);
  expect((await t.http(remove(t, t.f.ids.folder, 1, key))).status).toBe(409);
  expect(
    await env.DB.prepare("SELECT actor_id,state FROM trash_ops WHERE op_id=?").bind(op.id).first(),
  ).toEqual({ actor_id: null, state: "trashed" });
  expect(
    await env.DB.prepare("SELECT actor_id FROM activity WHERE op_id=?").bind(op.id).first(),
  ).toEqual({ actor_id: null });
  expect(
    await env.DB.prepare(
      "SELECT principal_kind,principal_id,credential_id FROM operations WHERE op_id=?",
    )
      .bind(op.id)
      .first(),
  ).toEqual({
    principal_kind: "link_share",
    principal_id: t.share.id,
    credential_id: `ss:${t.session.claims.session_id}`,
  });
  const event = await readOutboxEvent(env.DB, `${op.id}_event`);
  const proof = await nodeEventAuthority(env.DB, event!);
  expect(proof).not.toBeNull();
  await atomicBatch(env.DB, proof!);
  expect(await (await t.http(t.request(`/api/v1/operations/${op.id}`))).json()).toEqual(op);
});
it("keeps anonymous trash visible, restorable and purgeable only to its owner", async () => {
  const t = await fixture();
  const indexed = searchName("File");
  await atomicBatch(env.DB, [
    {
      sql: `INSERT INTO search_index(node_id,space_id,text_norm,tokens,normalization_version,revision)
        VALUES(?,?,?,?,?,1)`,
      values: [t.f.ids.file, t.f.ids.space, indexed.textNorm, indexed.tokens, indexed.version],
    },
    {
      sql: "INSERT INTO search_fts(rowid,text_norm,tokens) SELECT rowid,text_norm,tokens FROM search_index WHERE node_id=?",
      values: [t.f.ids.file],
    },
  ]);
  const op = await (await t.http(remove(t))).json<VisibleOperation>();
  const principal = accessPrincipal(t.owner);
  const coordinator = t.app.CONTROL.get(t.app.CONTROL.idFromName("singleton"));
  t.app.CONTROL = {
    idFromName: t.app.CONTROL.idFromName.bind(t.app.CONTROL),
    get: () => ({
      ...coordinator,
      // Namespace fixture; real ControlDO pause/GC races have separate integration coverage.
      acquireRestorePause: async (epoch: number, operationId: string) => {
        const token = crypto.randomUUID(),
          expiresAt = Date.now() + 300000;
        const ready =
          (await env.DB.prepare(
            "SELECT 1 FROM gc_candidates WHERE state='deleting' LIMIT 1",
          ).first()) === null;
        if (ready)
          await env.DB.prepare(
            "UPDATE control SET gc_paused=1,gc_hold_token=?,gc_hold_operation=?,gc_hold_expires_at=? WHERE epoch=?",
          )
            .bind(token, operationId, expiresAt, epoch)
            .run();
        return { epoch, operationId, token, expiresAt, ready };
      },
      releaseRestorePause: async (epoch: number, token: string) => {
        await env.DB.prepare(
          "UPDATE control SET gc_hold_token=NULL,gc_hold_operation=NULL,gc_hold_expires_at=NULL WHERE epoch=? AND gc_hold_token=?",
        )
          .bind(epoch, token)
          .run();
      },
    }),
  } as unknown as typeof t.app.CONTROL;
  const cursor = new ListCursorTokens(await contentKeyRing("test", { test: t.key }));
  expect((await listTrash(env.DB, principal, cursor, t.f.ids.space)).items).toMatchObject([
    { opId: op.id, rootNodeId: t.f.ids.file },
  ]);
  await expect(
    listTrash(env.DB, publicPrincipal(t.session), cursor, t.f.ids.space),
  ).rejects.toThrow();
  await expect(
    restoreTrash(t.app, {
      principal: publicPrincipal(t.session),
      requestId: crypto.randomUUID(),
      spaceId: t.f.ids.space,
      trashOpId: op.id,
      destinationParentId: t.f.ids.folder,
      lockTokens: [],
    }),
  ).rejects.toThrow();
  const restored = await restoreTrash(t.app, {
    principal,
    requestId: crypto.randomUUID(),
    spaceId: t.f.ids.space,
    trashOpId: op.id,
    destinationParentId: t.f.ids.folder,
    lockTokens: [],
  });
  expect(restored).toMatchObject({ kind: "terminal", operation: { state: "committed" } });
  expect(await live(t)).toBeNull();
  const revision = await env.DB.prepare("SELECT revision FROM nodes WHERE id=?")
    .bind(t.f.ids.file)
    .first<number>("revision");
  const again = await (await t.http(remove(t, t.f.ids.file, revision!))).json<VisibleOperation>();
  const purged = await purgeTrash(t.app, {
    principal,
    requestId: crypto.randomUUID(),
    spaceId: t.f.ids.space,
    trashOpId: again.id,
  });
  expect(purged).toMatchObject({ kind: "terminal", operation: { state: "committed" } });
  expect(
    await env.DB.prepare("SELECT 1 FROM nodes WHERE id=?").bind(t.f.ids.file).first(),
  ).toBeNull();
  expect(
    await env.DB.prepare("SELECT actor_id,state FROM trash_ops WHERE op_id=?")
      .bind(again.id)
      .first(),
  ).toEqual({ actor_id: null, state: "purged" });
  expect((await t.http(t.request(`/api/v1/operations/${again.id}`))).status).toBe(200);
});
it("trashes a subtree and revokes its nested links without deleting the shared root", async () => {
  const t = await fixture();
  const created = await (await t.http(t.create("削除するフォルダー"))).json<VisibleOperation>();
  const node = created.result!.nodeId!;
  const child = await t.http(
    t.request("/nodes", "POST", { kind: "folder", parentId: node, name: "子" }, t.token),
  );
  expect(child.status).toBe(201);
  const nested = await createLinkShare(t.app, t.owner, {
    kind: "link",
    rootNodeId: node,
    role: "read",
  });
  const unlocked = await unlockShare(t.app, (await t.deps.tokens.challenge(nested.id, 1)).claims, {
    secret: nested.secret,
  });
  const revision = await env.DB.prepare("SELECT revision FROM nodes WHERE id=?")
    .bind(node)
    .first<number>("revision");
  const response = await t.http(remove(t, node, revision!));
  expect(response.status).toBe(200);
  const op = await response.json<VisibleOperation>();
  expect(
    await env.DB.prepare("SELECT COUNT(*) AS n FROM trash_members WHERE trash_op_id=?")
      .bind(op.id)
      .first("n"),
  ).toBe(2);
  expect(
    await env.DB.prepare("SELECT disabled_at FROM shares WHERE id=?")
      .bind(nested.id)
      .first("disabled_at"),
  ).toBeTypeOf("number");
  expect(
    await env.DB.prepare("SELECT revoked_at FROM share_sessions WHERE id=?")
      .bind(unlocked.claims.session_id)
      .first("revoked_at"),
  ).toBeTypeOf("number");
  expect((await t.http(remove(t, t.f.ids.folder))).status).toBe(404);
  expect((await t.http(remove(t, t.f.ids.root))).status).toBe(404);
  expect(await live(t)).toBeNull();
});
it("rejects read-only links and invalid CSRF, original-session, and body operands", async () => {
  const read = await fixture("read");
  expect((await read.http(remove(read))).status).toBe(404);
  const t = await fixture();
  for (const [header, value, status] of [
    ["X-CSRF-Token", null, 403],
    ["Share-Session", null, 412],
    ["Share-Session", "replacement", 412],
    ["Idempotency-Key", null, 400],
    ["Origin", "https://evil.invalid", 403],
  ] as const) {
    const request = remove(t);
    if (value === null) request.headers.delete(header);
    else request.headers.set(header, value);
    expect((await t.http(request)).status).toBe(status);
  }
  for (const body of [
    {},
    { revision: 0 },
    { revision: 1.5 },
    { revision: "1" },
    { revision: 1, ownerId: t.f.ids.user },
    { revision: 1, lockTokens: [] },
  ])
    expect(
      (await t.http(t.request(`/nodes/${t.f.ids.file}`, "DELETE", body, t.token))).status,
    ).toBe(400);
  expect(await live(t)).toBeNull();
});
it("rejects a changed revision before deletion or idempotency claim", async () => {
  const t = await fixture();
  expect((await t.http(remove(t, t.f.ids.file, 2))).status).toBe(412);
  expect(await live(t)).toBeNull();
  expect(
    await env.DB.prepare("SELECT COUNT(*) AS n FROM operations WHERE space_id=?")
      .bind(t.f.ids.space)
      .first("n"),
  ).toBe(0);
});
it("rejects a directly shared file root and a normal file outside the shared subtree", async () => {
  const direct = await fixture("edit", "file");
  expect((await direct.http(remove(direct))).status).toBe(404);
  const t = await fixture(),
    outside = crypto.randomUUID();
  await env.DB.prepare(
    "INSERT INTO nodes(id,space_id,owner_id,parent_id,name,name_ci,kind,current_blob_id,created_at,updated_at) VALUES(?,?,?,?,'outside','outside','file',?,1,1)",
  )
    .bind(outside, t.f.ids.space, t.f.ids.user, t.f.ids.root, t.f.ids.blob)
    .run();
  expect((await t.http(remove(t, outside))).status).toBe(404);
  expect(await live(direct)).toBeNull();
  expect(
    await env.DB.prepare("SELECT deleted_at FROM nodes WHERE id=?")
      .bind(outside)
      .first("deleted_at"),
  ).toBeNull();
});
it("retains the original session and edit permission for a deletion receipt", async () => {
  const t = await fixture();
  const op = await (await t.http(remove(t))).json<VisibleOperation>();
  const other = await unlockShare(t.app, (await t.deps.tokens.challenge(t.share.id, 1)).claims, {
    secret: t.share.secret,
  });
  const request = t.request(`/api/v1/operations/${op.id}`);
  request.headers.set(
    "Cookie",
    `__Host-ncf_share_${t.share.id}=${await t.deps.tokens.issue(other.claims)}`,
  );
  expect((await t.http(request)).status).toBe(412);
  request.headers.set("Share-Session", other.claims.session_id);
  expect((await t.http(request)).status).toBe(404);
  await env.DB.prepare("DELETE FROM share_actions WHERE share_id=? AND action='edit'")
    .bind(t.share.id)
    .run();
  expect((await t.http(t.request(`/api/v1/operations/${op.id}`))).status).toBe(404);
  expect(
    await nodeEventAuthority(env.DB, (await readOutboxEvent(env.DB, `${op.id}_event`))!),
  ).toBeNull();
});
it.each(["share", "session", "owner", "revision"])(
  "rechecks %s immediately before committing deletion",
  async (change) => {
    const t = await fixture();
    const db = injectBatch(
      (sql) => sql.startsWith("INSERT INTO trash_ops"),
      async () => {
        if (change === "share")
          await env.DB.prepare("UPDATE shares SET version=version+1 WHERE id=?")
            .bind(t.share.id)
            .run();
        if (change === "session")
          await env.DB.prepare("UPDATE share_sessions SET revoked_at=1 WHERE id=?")
            .bind(t.session.claims.session_id)
            .run();
        if (change === "owner")
          await env.DB.prepare("UPDATE users SET disabled_at=1 WHERE id=?")
            .bind(t.f.ids.user)
            .run();
        if (change === "revision")
          await env.DB.prepare("UPDATE nodes SET revision=revision+1 WHERE id=?")
            .bind(t.f.ids.file)
            .run();
      },
      false,
    );
    expect((await t.http(remove(t), db)).status).toBeGreaterThanOrEqual(400);
    expect(await live(t)).toBeNull();
    expect(
      await env.DB.prepare("SELECT COUNT(*) AS n FROM trash_ops WHERE space_id=?")
        .bind(t.f.ids.space)
        .first("n"),
    ).toBe(0);
  },
);
it("reconciles a lost deletion commit acknowledgement without a second trash operation", async () => {
  const t = await fixture(),
    key = crypto.randomUUID();
  const db = injectBatch(
    (sql) => sql.startsWith("INSERT INTO trash_ops"),
    async () => {
      throw new Error("lost_ack");
    },
    true,
  );
  const response = await t.http(remove(t, t.f.ids.file, 1, key), db);
  expect(response.status).toBe(200);
  const op = await response.json();
  expect(await (await t.http(remove(t, t.f.ids.file, 1, key))).json()).toEqual(op);
  expect(
    await env.DB.prepare("SELECT COUNT(*) AS n FROM trash_ops WHERE space_id=?")
      .bind(t.f.ids.space)
      .first("n"),
  ).toBe(1);
});
it("honors descendant DAV locks and refuses oversized synchronous subtrees", async () => {
  const t = await fixture();
  const created = await (await t.http(t.create("削除対象"))).json<VisibleOperation>();
  const root = created.result!.nodeId!;
  const child = await (
    await t.http(
      t.request("/nodes", "POST", { kind: "folder", parentId: root, name: "子" }, t.token),
    )
  ).json<VisibleOperation>();
  const [hash] = await lockTokenHashes(["private-lock"]);
  await env.DB.prepare(
    "INSERT INTO locks(id,node_id,space_id,creator_credential_id,token_hash,display_href,depth,owner_text,epoch,expires_at) VALUES(?,?,?,?,?,'/dav/','infinity','owner',1,?)",
  )
    .bind(
      crypto.randomUUID(),
      child.result!.nodeId!,
      t.f.ids.space,
      t.f.ids.credential,
      hash,
      Date.now() + 60000,
    )
    .run();
  expect((await t.http(remove(t, root, 2))).status).toBe(423);
  await env.DB.prepare("DELETE FROM locks WHERE space_id=?").bind(t.f.ids.space).run();
  await env.DB.prepare(`WITH RECURSIVE seq(x) AS (VALUES(1) UNION ALL SELECT x+1 FROM seq WHERE x<1000)
    INSERT INTO nodes(id,space_id,owner_id,parent_id,name,name_ci,kind,created_at,updated_at)
    SELECT ?||x,?,?,?,CAST(x AS TEXT),CAST(x AS TEXT),'folder',1,1 FROM seq`)
    .bind(`${root}-`, t.f.ids.space, t.f.ids.user, root)
    .run();
  expect((await t.http(remove(t, root, 2))).status).toBe(413);
  expect(
    await env.DB.prepare("SELECT deleted_at FROM nodes WHERE id=?").bind(root).first("deleted_at"),
  ).toBeNull();
});
