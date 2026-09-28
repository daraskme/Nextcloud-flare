import { applyD1Migrations } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { base64url } from "jose";
import { afterEach, beforeAll, beforeEach, expect, it } from "vitest";
import { publicPrincipal } from "../../src/api/publicShareRead";
import { handlePublicShareHttp } from "../../src/api/publicShares";
import { acceptContentTicket } from "../../src/auth/contentAccept";
import { ContentTokens, contentKeyRing } from "../../src/auth/contentTokens";
import { CsrfTokens } from "../../src/auth/csrf";
import { NodeCursorTokens } from "../../src/auth/nodeCursor";
import { readAccessSession } from "../../src/auth/sessions";
import { ShareTokens } from "../../src/auth/shareTokens";
import { atomicBatch } from "../../src/db/primary";
import { streamBudgetedContentBlob } from "../../src/services/blobRead";
import { createLinkShare } from "../../src/services/linkShares";
import { listNodeChildren, readNode, readNodePath } from "../../src/services/nodeRead";
import { logoutShare, unlockShare } from "../../src/services/shareUnlock";
import { foundationFixture } from "../fixtures/foundation";
import { mutationEnv } from "../fixtures/mutationAdmission";
import { injectBatch } from "../fixtures/uploadEnv";

const origin = "https://app.invalid",
  cleanup: string[] = [];
beforeAll(() => applyD1Migrations(env.DB, env.TEST_MIGRATIONS));
beforeEach(async () => {
  await env.DB.prepare("UPDATE control SET maintenance=1").run();
  await env.DB.prepare("UPDATE control SET epoch=1,maintenance=0").run();
});
afterEach(async () => {
  if (cleanup.length) await env.BLOBS.delete(cleanup.splice(0));
});
async function fixture(root: "file" | "folder" = "folder") {
  const f = foundationFixture(crypto.randomUUID(), Date.now() - 1000);
  await atomicBatch(env.DB, f.statements);
  const app = {
    ...mutationEnv(),
    APP_ORIGIN: origin,
    CONTENT_ORIGIN: "https://content.invalid",
    EDGE_LIMITER: { limit: async () => ({ success: true }) },
  };
  const owner = (await readAccessSession(env.DB, f.ids.credential, 1))!;
  const share = await createLinkShare(app, owner, {
    kind: "link",
    rootNodeId: f.ids[root],
    role: "read",
  });
  const ring = await contentKeyRing("test", {
    test: base64url.encode(crypto.getRandomValues(new Uint8Array(32))),
  });
  const tokens = new ShareTokens(ring, origin),
    cursors = new NodeCursorTokens(ring),
    contentTokens = new ContentTokens(ring, ring, app.CONTENT_ORIGIN);
  const deps = {
    tokens,
    cursors,
    contentTokens,
    csrf: new CsrfTokens({ activeKid: "unused", keys: new Map() }, ring, origin),
  };
  const session = await unlockShare(app, (await tokens.challenge(share.id, 1)).claims, {
    secret: share.secret,
  });
  const cookie = `__Host-ncf_share_${share.id}=${await tokens.issue(session.claims)}`;
  const principal = publicPrincipal(session);
  const request = (suffix = "", method = "GET", body?: unknown, csrf?: string) =>
    new Request(`${origin}/api/v1/public/shares/${share.id}${suffix}`, {
      method,
      headers: {
        Origin: origin,
        "Sec-Fetch-Site": "same-origin",
        "CF-Connecting-IP": "192.0.2.1",
        Cookie: cookie,
        ...(method === "GET" ? {} : { "Content-Type": "application/json" }),
        ...(csrf ? { "X-CSRF-Token": csrf } : {}),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  const http = (r: Request) => handlePublicShareHttp(r, app, 1, deps);
  return { f, app, share, session, principal, deps, request, http };
}
it.each(["file", "folder"] as const)(
  "discloses only the authenticated %s root and its descendants",
  async (kind) => {
    const t = await fixture(kind),
      response = await t.http(t.request());
    expect(response.status).toBe(200);
    const value = await response.json<{ root: Record<string, unknown> }>();
    expect(value.root).toMatchObject({ id: t.f.ids[kind], parentId: null, kind });
    expect(value.root).not.toHaveProperty("ownerId");
    expect(value.root).not.toHaveProperty("spaceId");
    expect((await readNodePath(env.DB, t.principal, t.f.ids.file)).path[0]?.id).toBe(t.f.ids[kind]);
    expect((await t.http(t.request(`/children/${t.f.ids.root}`))).status).toBe(404);
    expect((await t.http(t.request(`/children/${t.f.ids.file}`))).status).toBe(404);
    const anonymous = t.request();
    anonymous.headers.delete("Cookie");
    expect((await t.http(anonymous)).status).toBe(401);
    const foreign = t.request();
    foreign.headers.set("Sec-Fetch-Site", "cross-site");
    expect((await t.http(foreign)).status).toBe(403);
    expect((await t.http(t.request("?secret=no"))).status).toBe(400);
  },
);
it("binds anonymous pagination to one share credential, version and tree", async () => {
  const t = await fixture();
  await atomicBatch(
    env.DB,
    Array.from({ length: 200 }, (_, n) => ({
      sql: "INSERT INTO nodes(id,space_id,owner_id,parent_id,name,name_ci,kind,created_at,updated_at) VALUES(?,?,?,?,?,?,'folder',1,1)",
      values: [
        crypto.randomUUID(),
        t.f.ids.space,
        t.f.ids.user,
        t.f.ids.folder,
        `Item ${n}`,
        `item ${n}`,
      ],
    })),
  );
  const first = await listNodeChildren(env.DB, t.principal, t.f.ids.folder, t.deps.cursors);
  expect(first.children).toHaveLength(200);
  expect(first.nextCursor).toBeTruthy();
  const claims = await t.deps.cursors.verify(first.nextCursor!);
  expect(claims).toMatchObject({
    userId: null,
    credentialId: t.principal.credential_id,
    shareId: t.share.id,
    shareVersion: 1,
  });
  const second = await t.http(t.request(`/children/${t.f.ids.folder}?cursor=${first.nextCursor}`));
  expect(second.status).toBe(200);
  expect(await second.json()).toMatchObject({ children: [expect.anything()], nextCursor: null });
  const other = await unlockShare(t.app, (await t.deps.tokens.challenge(t.share.id, 1)).claims, {
    secret: t.share.secret,
  });
  await expect(
    listNodeChildren(
      env.DB,
      publicPrincipal(other),
      t.f.ids.folder,
      t.deps.cursors,
      first.nextCursor!,
    ),
  ).rejects.toThrow("invalid_node_cursor");
  const owner = {
    kind: "user" as const,
    user_id: t.f.ids.user,
    credential_id: t.f.ids.credential,
    epoch: 1,
  };
  const privatePage = await listNodeChildren(env.DB, owner, t.f.ids.folder, t.deps.cursors);
  await expect(
    listNodeChildren(env.DB, t.principal, t.f.ids.folder, t.deps.cursors, privatePage.nextCursor!),
  ).rejects.toThrow("invalid_node_cursor");
  expect((await t.http(t.request(`/children/${t.f.ids.folder}?cursor=x&cursor=y`))).status).toBe(
    400,
  );
  await env.DB.prepare("UPDATE spaces SET tree_generation=tree_generation+1 WHERE id=?")
    .bind(t.f.ids.space)
    .run();
  expect(
    (await t.http(t.request(`/children/${t.f.ids.folder}?cursor=${first.nextCursor}`))).status,
  ).toBe(400);
});
it.each(["version", "logout", "ancestor", "owner"])(
  "reasserts current %s authority at the metadata snapshot",
  async (change) => {
    const t = await fixture();
    const db = injectBatch(
      (sql) => sql.includes("SELECT 1 FROM shares WHERE id=? AND version=? AND root_node_id=?"),
      async () => {
        if (change === "version")
          await env.DB.prepare("UPDATE shares SET version=version+1 WHERE id=?")
            .bind(t.share.id)
            .run();
        if (change === "logout") await logoutShare(t.app, t.session);
        if (change === "ancestor")
          await env.DB.prepare("UPDATE nodes SET deleted_at=1 WHERE id=?").bind(t.f.ids.root).run();
        if (change === "owner")
          await env.DB.prepare("UPDATE users SET disabled_at=1 WHERE id=?")
            .bind(t.f.ids.user)
            .run();
      },
      false,
    );
    await expect(readNode(db, t.principal, t.f.ids.file)).rejects.toThrow();
  },
);
it("uses one budget across public ticket renewals, counts HEAD/Range and stops on logout", async () => {
  const t = await fixture();
  const key = `u/${t.f.ids.user}/b/${t.f.ids.blob}`;
  cleanup.push(key);
  const object = (await env.BLOBS.put(key, "abc"))!;
  await env.DB.prepare(
    "INSERT INTO blob_storage(blob_id,bytes,r2_etag,observed_at) VALUES(?,3,?,?)",
  )
    .bind(t.f.ids.blob, object.etag, Date.now())
    .run();
  const csrfResponse = await t.http(t.request("/csrf", "POST")),
    { token } = await csrfResponse.json<{ token: string }>();
  const body = { nodeIds: [t.f.ids.file], ttlSeconds: 300 };
  expect((await t.http(t.request("/tickets", "POST", body))).status).toBe(403);
  expect(
    (await t.http(t.request("/tickets", "POST", { ...body, nodeIds: [t.f.ids.root] }, token)))
      .status,
  ).toBe(404);
  expect(
    (await t.http(t.request("/tickets", "POST", { ...body, spaceId: t.f.ids.space }, token)))
      .status,
  ).toBe(400);
  async function issue(path: string) {
    const response = await t.http(t.request(path, "POST", body, token));
    expect(response.status).toBe(201);
    const saved = await response.json<{
      ticket: string;
      ticketId: string;
      targetSetId: string;
      budgetId: string;
    }>();
    cleanup.push(`target-sets/${saved.targetSetId}`);
    return saved;
  }
  const first = await issue("/tickets"),
    accepted = await acceptContentTicket(t.app, t.deps.contentTokens, first.ticket);
  const cookie = accepted.setCookie.split(";")[0]!;
  const read = (method = "GET", range?: string) =>
    streamBudgetedContentBlob(
      env.DB,
      env.BLOBS,
      env.BUDGETS,
      t.deps.contentTokens,
      cookie,
      t.f.ids.space,
      t.f.ids.file,
      "content",
      new Request(`https://content.invalid/c/${t.f.ids.file}`, {
        method,
        headers: range ? { Range: range } : {},
      }),
    );
  expect((await read("HEAD")).status).toBe(200);
  const partial = await read("GET", "bytes=1-2");
  expect(partial.status).toBe(206);
  expect(new TextDecoder().decode(await partial.arrayBuffer())).toBe("bc");
  const renewed = await issue("/content-session");
  expect(renewed.budgetId).toBe(first.budgetId);
  expect(first.budgetId).toBe(`s:${t.share.id}:c:${t.session.claims.session_id}`);
  expect(await env.BUDGETS.get(env.BUDGETS.idFromName(first.budgetId)).status()).toMatchObject({
    bytesCharged: 2,
    requests: 2,
  });
  expect(
    (await t.http(t.request(`/tickets/${renewed.ticketId}`, "DELETE", undefined, token))).status,
  ).toBe(204);
  await expect(acceptContentTicket(t.app, t.deps.contentTokens, renewed.ticket)).rejects.toThrow();
  await logoutShare(t.app, t.session);
  expect((await t.http(t.request())).status).toBe(401);
  await expect(read()).rejects.toThrow();
});
