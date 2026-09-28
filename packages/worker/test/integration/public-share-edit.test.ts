import { applyD1Migrations } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeAll, beforeEach, expect, it } from "vitest";
import { publicShareRoute } from "../../src/api/publicShares";
import { lockTokenHashes } from "../../src/auth/locks";
import worker from "../../src/index";
import type { VisibleOperation } from "../../src/jobs/operations";
import { updateLinkShare } from "../../src/services/linkShares";
import { unlockShare } from "../../src/services/shareUnlock";
import { publicShareFixture as fixture } from "../fixtures/publicShare";
import { injectBatch } from "../fixtures/uploadEnv";

beforeAll(() => applyD1Migrations(env.DB, env.TEST_MIGRATIONS));
beforeEach(async () => {
  await env.DB.prepare("UPDATE control SET maintenance=1").run();
  await env.DB.prepare("UPDATE control SET epoch=1,maintenance=0").run();
});

it("creates and renames once per original credential/key and exposes only a bounded receipt", async () => {
  const t = await fixture();
  const key = crypto.randomUUID();
  const response = await t.http(t.create("子フォルダー", key));
  expect(response.status).toBe(201);
  const op = await response.json<VisibleOperation>();
  expect(op).toEqual({
    id: expect.stringMatching(/^op_[a-f0-9]{64}$/),
    state: "committed",
    errorCode: null,
    result: { status: 201, nodeId: expect.any(String), revision: 1 },
  });
  expect(await (await t.http(t.create("子フォルダー", key))).json()).toEqual(op);
  expect((await t.http(t.create("別の内容", key))).status).toBe(409);
  const renameKey = crypto.randomUUID();
  const rename = () =>
    t.request(`/nodes/${op.result!.nodeId}`, "PATCH", { name: "名前変更後" }, t.token, renameKey);
  const changed = await t.http(rename());
  expect(changed.status).toBe(200);
  const renamed = await changed.json<VisibleOperation>();
  expect(await (await t.http(rename())).json()).toEqual(renamed);
  expect(
    await env.DB.prepare("SELECT name,revision FROM nodes WHERE id=?")
      .bind(op.result!.nodeId)
      .first(),
  ).toEqual({ name: "名前変更後", revision: 2 });
  expect(
    await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM activity WHERE op_id IN (?,?) AND actor_id IS NULL",
    )
      .bind(op.id, renamed.id)
      .first("n"),
  ).toBe(2);
  const root = await (await t.http(t.request(""))).json<{
    sessionId: string;
    permissions: unknown;
  }>();
  expect(root.sessionId).toBe(t.session.claims.session_id);
  expect(root.permissions).toEqual({
    createFolder: true,
    rename: true,
    delete: true,
    upload: true,
    overwrite: true,
  });
  const lookup = t.request(`/api/v1/operations/${renamed.id}`);
  expect(publicShareRoute(lookup)).toBe(true);
  expect(await (await t.http(lookup)).json()).toEqual(renamed);
  // Test actual routing without Access configuration, not only the handler.
  expect(
    (
      await worker.fetch(t.request(`/api/v1/operations/${op.id}`), {
        ...t.app,
        SHARE_COOKIE_ACTIVE_KID: "test",
        SHARE_COOKIE_KEYS: JSON.stringify({ test: t.key }),
        CSRF_PUBLIC_ACTIVE_KID: "test",
        CSRF_PUBLIC_KEYS: JSON.stringify({ test: t.key }),
      })
    ).status,
  ).toBe(200);
});
it("hides upload controls when only folder creation and rename remain authorized", async () => {
  const t = await fixture();
  await env.DB.prepare("DELETE FROM share_actions WHERE share_id=? AND action='upload'")
    .bind(t.share.id)
    .run();
  const root = await (await t.http(t.request(""))).json<{ permissions: unknown }>();
  expect(root.permissions).toEqual({
    createFolder: true,
    rename: true,
    delete: true,
    upload: false,
    overwrite: false,
  });
});
it("requires same-origin public CSRF, an idempotency key and the original session", async () => {
  const t = await fixture();
  for (const [header, value, status] of [
    ["X-CSRF-Token", null, 403],
    ["Idempotency-Key", null, 400],
    ["Idempotency-Key", "a,b", 400],
    ["Share-Session", null, 412],
    ["Share-Session", "us_other", 412],
    ["Origin", "https://other.invalid", 403],
    ["Sec-Fetch-Site", "cross-site", 403],
    ["Cookie", null, 401],
  ] as const) {
    const request = t.create();
    if (value === null) request.headers.delete(header);
    else request.headers.set(header, value);
    expect((await t.http(request)).status, header).toBe(status);
  }
  for (const field of ["spaceId", "ownerId", "share", "lockTokens", "credentialId"])
    expect(
      (
        await t.http(
          t.request(
            "/nodes",
            "POST",
            {
              kind: "folder",
              parentId: t.f.ids.folder,
              name: "child",
              [field]: "injected",
            },
            t.token,
          ),
        )
      ).status,
    ).toBe(400);
  expect((await t.http(t.request("/nodes?secret=x", "POST", {}, t.token))).status).toBe(400);
  expect((await t.http(t.create("a/b"))).status).toBe(400);
  expect(
    await env.DB.prepare("SELECT COUNT(*) AS n FROM operations WHERE credential_id=?")
      .bind(`ss:${t.session.claims.session_id}`)
      .first("n"),
  ).toBe(0);
});
it("rejects read links, shared-root renames and all targets outside the current subtree", async () => {
  const read = await fixture("read");
  expect((await read.http(read.create())).status).toBe(404);
  expect(
    (
      await read.http(
        read.request(`/nodes/${read.f.ids.file}`, "PATCH", { name: "renamed" }, read.token),
      )
    ).status,
  ).toBe(404);
  expect(await (await read.http(read.request(""))).json()).toMatchObject({
    permissions: {
      createFolder: false,
      rename: false,
      delete: false,
      upload: false,
      overwrite: false,
    },
  });
  const t = await fixture();
  expect(
    (
      await t.http(
        t.request(
          "/nodes",
          "POST",
          { kind: "folder", parentId: t.f.ids.root, name: "escape" },
          t.token,
        ),
      )
    ).status,
  ).toBe(404);
  for (const id of [t.f.ids.root, t.f.ids.folder, read.f.ids.file])
    expect(
      (await t.http(t.request(`/nodes/${id}`, "PATCH", { name: "escape" }, t.token))).status,
    ).toBe(404);
  expect(
    (await t.http(t.request(`/nodes/${t.f.ids.folder}`, "DELETE", { revision: 1 }, t.token)))
      .status,
  ).toBe(404);
});
it("keeps operation lookup isolated across sessions and rejects retries after cookie replacement", async () => {
  const t = await fixture(),
    created = await (await t.http(t.create())).json<VisibleOperation>();
  const other = await unlockShare(t.app, (await t.deps.tokens.challenge(t.share.id, 1)).claims, {
    secret: t.share.secret,
  });
  const otherCookie = `__Host-ncf_share_${t.share.id}=${await t.deps.tokens.issue(other.claims)}`;
  const lookup = t.request(`/api/v1/operations/${created.id}`);
  lookup.headers.set("Cookie", otherCookie);
  expect((await t.http(lookup)).status).toBe(412);
  lookup.headers.set("Share-Session", other.claims.session_id);
  expect((await t.http(lookup)).status).toBe(404);
  const retry = t.create();
  retry.headers.set("Cookie", otherCookie);
  expect((await t.http(retry)).status).toBe(412);
  const invalid = t.request(`/api/v1/operations/${created.id}`);
  invalid.headers.set("X-Share-Id", `${t.share.id},other`);
  expect((await t.http(invalid)).status).toBe(400);
  invalid.headers.delete("X-Share-Id");
  expect(publicShareRoute(invalid)).toBe(false);
  await updateLinkShare(t.app, t.owner, t.share.id, 1, {
    kind: "link",
    rootNodeId: t.f.ids.folder,
    role: "read",
  });
  expect((await t.http(t.request(`/api/v1/operations/${created.id}`))).status).toBe(401);
  expect((await t.http(t.create())).status).toBe(401);
});
it.each(["share", "session", "ancestor", "owner"])(
  "rechecks %s at commit before publishing a public folder",
  async (change) => {
    const t = await fixture();
    const db = injectBatch(
      (sql) => sql.startsWith("INSERT INTO nodes(id,space_id"),
      async () => {
        if (change === "share")
          await env.DB.prepare("UPDATE shares SET version=version+1 WHERE id=?")
            .bind(t.share.id)
            .run();
        if (change === "session")
          await env.DB.prepare("UPDATE share_sessions SET revoked_at=1 WHERE id=?")
            .bind(t.session.claims.session_id)
            .run();
        if (change === "ancestor")
          await env.DB.prepare("UPDATE nodes SET deleted_at=1 WHERE id=?").bind(t.f.ids.root).run();
        if (change === "owner")
          await env.DB.prepare("UPDATE users SET disabled_at=1 WHERE id=?")
            .bind(t.f.ids.user)
            .run();
      },
      false,
    );
    const response = await t.http(t.create("不成立"), db);
    expect(response.status).toBeGreaterThanOrEqual(400);
    expect(
      await env.DB.prepare("SELECT COUNT(*) AS n FROM nodes WHERE parent_id=? AND name='不成立'")
        .bind(t.f.ids.folder)
        .first("n"),
    ).toBe(0);
  },
);
it("reconciles a lost D1 commit response without duplicate nodes", async () => {
  const t = await fixture();
  const key = crypto.randomUUID();
  const db = injectBatch(
    (sql) => sql.startsWith("INSERT INTO nodes(id,space_id"),
    async () => {
      throw new Error("lost_ack");
    },
    true,
  );
  const response = await t.http(t.create("一度だけ", key), db);
  expect(response.status).toBe(201);
  const saved = await response.json<VisibleOperation>();
  expect(await (await t.http(t.create("一度だけ", key))).json()).toEqual(saved);
  expect(
    await env.DB.prepare("SELECT COUNT(*) AS n FROM nodes WHERE parent_id=? AND name='一度だけ'")
      .bind(t.f.ids.folder)
      .first("n"),
  ).toBe(1);
});
it("honors an existing DAV lock even on an edit link", async () => {
  const t = await fixture();
  const saved = await (await t.http(t.create())).json<VisibleOperation>();
  const [hash] = await lockTokenHashes(["owner-only-lock"]);
  await env.DB.prepare(
    "INSERT INTO locks(id,node_id,space_id,creator_credential_id,token_hash,display_href,depth,owner_text,epoch,expires_at) VALUES(?,?,?,?,?,'/dav/','infinity','owner',1,?)",
  )
    .bind(
      crypto.randomUUID(),
      t.f.ids.folder,
      t.f.ids.space,
      t.f.ids.credential,
      hash,
      Date.now() + 60000,
    )
    .run();
  expect((await t.http(t.create("locked"))).status).toBe(423);
  expect(
    (
      await t.http(
        t.request(`/nodes/${saved.result!.nodeId}`, "PATCH", { name: "locked" }, t.token),
      )
    ).status,
  ).toBe(423);
});
