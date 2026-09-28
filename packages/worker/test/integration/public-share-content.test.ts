import { applyD1Migrations, runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { handleContentHttp } from "../../src/api/content";
import { publicPrincipal } from "../../src/api/publicShareRead";
import { handlePublicShareHttp, publicShareRoute } from "../../src/api/publicShares";
import { accessPrincipal } from "../../src/auth/authorize";
import { acceptContentTicket } from "../../src/auth/contentAccept";
import { ContentTokens, contentKeyRing } from "../../src/auth/contentTokens";
import type { Env } from "../../src/env";
import { issueContentTicket } from "../../src/services/contentTicket";
import { logoutShare, unlockShare } from "../../src/services/shareUnlock";
import { trashNode } from "../../src/services/trashNode";
import { publicShareFixture } from "../fixtures/publicShare";
import { injectBatch } from "../fixtures/uploadEnv";

const cleanup: string[] = [];
beforeAll(() => applyD1Migrations(env.DB, env.TEST_MIGRATIONS));
beforeEach(async () => {
  await env.DB.prepare("UPDATE control SET maintenance=1").run();
  await env.DB.prepare("UPDATE control SET epoch=1,maintenance=0,gc_paused=1").run();
});
afterEach(async () => {
  vi.restoreAllMocks();
  if (cleanup.length) await env.BLOBS.delete(cleanup.splice(0));
});
interface Delivery {
  sessionId: string;
  ticketId: string;
  targetSetId: string;
  budgetId: string;
  expiresAt: number;
}
async function fixture(root: "file" | "folder" = "folder") {
  const t = await publicShareFixture("read", root);
  t.app.CONTENT_ORIGIN = "https://content.invalid";
  const ring = await contentKeyRing("test", { test: t.key });
  const contentTokens = new ContentTokens(ring, ring, t.app.CONTENT_ORIGIN);
  const deps = { ...t.deps, contentTokens };
  const http = (request: Request, overrides: Partial<Env> = {}) =>
    handlePublicShareHttp(request, { ...t.app, ...overrides }, 1, deps);
  const key = `u/${t.f.ids.user}/b/${t.f.ids.blob}`;
  cleanup.push(key);
  const stored = (await env.BLOBS.put(key, "abc"))!;
  await env.DB.prepare(
    "INSERT INTO blob_storage(blob_id,bytes,r2_etag,observed_at) VALUES(?,3,?,?)",
  )
    .bind(t.f.ids.blob, stored.etag, Date.now())
    .run();
  const issueRequest = (input: Record<string, unknown> = {}) =>
    t.request(
      "/content-session",
      "POST",
      {
        nodeIds: [t.f.ids.file],
        ttlSeconds: 300,
        delivery: "app",
        ...input,
      },
      t.token,
    );
  const issue = async () => {
    const response = await http(issueRequest());
    expect(response.status).toBe(201);
    expect(response.headers.get("Set-Cookie")).toBeNull();
    const saved = await response.json<Delivery>();
    expect(saved).not.toHaveProperty("ticket");
    expect(saved.sessionId).toMatch(/^[A-Za-z0-9_-]{43}$/);
    cleanup.push(`target-sets/${saved.targetSetId}`);
    return saved;
  };
  const delivery = await issue();
  const read = (method = "GET", headers: HeadersInit = {}, nodeId = t.f.ids.file) => {
    const request = t.request(`/content/${nodeId}`, method);
    request.headers.set("Content-Session", delivery.sessionId);
    for (const [name, value] of new Headers(headers)) request.headers.set(name, value);
    return request;
  };
  const budget = env.BUDGETS.get(env.BUDGETS.idFromName(delivery.budgetId));
  return { ...t, http, deps, key, delivery, issue, issueRequest, read, budget };
}

it.each(["folder", "file"] as const)(
  "streams a %s share with counted HEAD, Range, 304 and 416",
  async (root) => {
    const t = await fixture(root);
    const head = t.read("HEAD");
    head.headers.delete("Origin"); // Same-origin browser HEAD need not send Origin.
    expect(publicShareRoute(head)).toBe(true);
    const h = await t.http(head);
    expect(h.status).toBe(200);
    expect(h.body).toBeNull();
    expect(h.headers.get("Content-Length")).toBe("3");
    expect(h.headers.get("Cache-Control")).toBe("private, no-store");
    expect(h.headers.get("Referrer-Policy")).toBe("no-referrer");
    const partial = await t.http(t.read("GET", { Range: "bytes=1-2" }));
    expect(partial.status).toBe(206);
    expect(partial.headers.get("Content-Range")).toBe("bytes 1-2/3");
    expect(await partial.text()).toBe("bc");
    const unchanged = await t.http(t.read("GET", { "If-None-Match": h.headers.get("ETag")! }));
    expect(unchanged.status).toBe(304);
    expect(unchanged.body).toBeNull();
    const invalid = await t.http(t.read("GET", { Range: "bytes=9-" }));
    expect(invalid.status).toBe(416);
    expect(invalid.headers.get("Content-Range")).toBe("bytes */3");
    expect(await invalid.text()).toBe("");
    expect(await (await t.http(t.read())).text()).toBe("abc");
    const changed = await t.http(t.read("GET", { Range: "bytes=0-0", "If-Range": '"old"' }));
    expect(changed.status).toBe(200);
    expect(await changed.text()).toBe("abc");
    expect(await t.budget.status()).toMatchObject({
      requests: 6,
      bytesCharged: 8,
      active: 0,
      byteLimit: 9,
    });
    // Ignored multi-range must reserve the entire body before R2 access.
    expect((await t.http(t.read("GET", { Range: "bytes=0-0,2-2" }))).status).toBe(429);
    expect((await t.http(t.read("HEAD"))).status).toBe(200);
    expect(await t.budget.status()).toMatchObject({ requests: 7, bytesCharged: 8, active: 0 });
  },
);

it("shares consumption with the content host and renewed app sessions without resetting limits", async () => {
  const t = await fixture();
  expect(await (await t.http(t.read())).text()).toBe("abc");
  const issued = await issueContentTicket(
    t.app,
    env.BLOBS,
    t.deps.contentTokens,
    publicPrincipal(t.session),
    [{ spaceId: t.f.ids.space, nodeId: t.f.ids.file }],
    "content",
    Date.now() + 300000,
  );
  cleanup.push(`target-sets/${issued.targetSetId}`);
  const accepted = await acceptContentTicket(t.app, t.deps.contentTokens, issued.ticket);
  const r = await handleContentHttp(
    new Request(`https://content.invalid/c/${t.f.ids.file}/${t.f.ids.blob}`, {
      headers: { Cookie: accepted.setCookie.split(";")[0]!, Origin: t.app.APP_ORIGIN },
    }),
    t.app,
    t.deps.contentTokens,
  );
  expect(await r.text()).toBe("abc");
  const next = await t.issue();
  expect(next.budgetId).toBe(t.delivery.budgetId);
  expect(next.sessionId).not.toBe(t.delivery.sessionId);
  expect(accepted.budgetId).toBe(next.budgetId);
  expect(await (await t.http(t.read("GET", { "Content-Session": next.sessionId }))).text()).toBe(
    "abc",
  );
  expect((await t.http(t.read())).status).toBe(429);
  expect(await t.budget.status()).toMatchObject({
    requests: 3,
    bytesCharged: 9,
    byteLimit: 9,
    active: 0,
  });
});

it("requires the original cookie, share session, same origin and explicit bounded delivery selection", async () => {
  const t = await fixture();
  for (const [header, value, status] of [
    ["Cookie", "", 401],
    ["Share-Session", "another", 412],
    ["Content-Session", "", 400],
    ["Content-Session", "a".repeat(44), 400],
    ["Content-Session", "a".repeat(43), 404],
    ["Origin", "https://other.invalid", 403],
    ["Sec-Fetch-Site", "cross-site", 403],
  ] as const) {
    const r = await t.http(t.read("HEAD", { [header]: value }));
    expect(r.status).toBe(status);
    expect(r.body).toBeNull();
    expect(r.headers.get("Cache-Control")).toBe("private, no-store");
    expect(r.headers.get("Referrer-Policy")).toBe("no-referrer");
  }
  const unknown = t.issueRequest();
  unknown.headers.delete("Share-Session");
  expect((await t.http(unknown)).status).toBe(412);
  unknown.headers.set("Share-Session", t.session.claims.session_id);
  unknown.headers.delete("X-CSRF-Token");
  expect((await t.http(unknown)).status).toBe(403);
  expect((await t.http(t.issueRequest({ delivery: "content" }))).status).toBe(400);
  expect((await t.http(t.issueRequest({ spaceId: t.f.ids.space }))).status).toBe(400);
  expect(
    (
      await t.http(
        t.request(
          "/tickets",
          "POST",
          { nodeIds: [t.f.ids.file], ttlSeconds: 300, delivery: "app" },
          t.token,
        ),
      )
    ).status,
  ).toBe(400);
  const query = new Request(`${t.read().url}?session=${t.delivery.sessionId}`, t.read());
  expect((await t.http(query)).status).toBe(400);
  expect((await t.http(t.read("POST"))).status).toBe(404);
  expect(await t.budget.status()).toBeNull();
});

it("does not use another unlock, another principal, a wrong purpose or an unlisted blob", async () => {
  const t = await fixture();
  const second = await unlockShare(t.app, (await t.deps.tokens.challenge(t.share.id, 1)).claims, {
    secret: t.share.secret,
  });
  const request = t.read("GET", {
    Cookie: `__Host-ncf_share_${t.share.id}=${await t.deps.tokens.issue(second.claims)}`,
    "Share-Session": second.claims.session_id,
  });
  expect((await t.http(request)).status).toBe(404);
  for (const [principal, purpose] of [
    [publicPrincipal(t.session), "thumb"],
    [accessPrincipal(t.owner), "content"],
  ] as const) {
    const issued = await issueContentTicket(
      t.app,
      env.BLOBS,
      t.deps.contentTokens,
      principal,
      [{ spaceId: t.f.ids.space, nodeId: t.f.ids.file }],
      purpose,
      Date.now() + 300000,
    );
    cleanup.push(`target-sets/${issued.targetSetId}`);
    const accepted = await acceptContentTicket(t.app, t.deps.contentTokens, issued.ticket);
    expect((await t.http(t.read("GET", { "Content-Session": accepted.sessionId }))).status).toBe(
      404,
    );
  }
  expect((await t.http(t.read("GET", {}, t.f.ids.root))).status).toBe(404);
  expect((await t.http(t.read("GET", {}, t.f.ids.folder))).status).toBe(404);
  await env.DB.prepare(`INSERT INTO nodes(id,space_id,owner_id,parent_id,name,name_ci,kind,current_blob_id,created_at,updated_at)
    VALUES('extra',?,?,?,'Extra','extra','file',?,1,1)`)
    .bind(t.f.ids.space, t.f.ids.user, t.f.ids.folder, t.f.ids.blob)
    .run();
  expect((await t.http(t.read("GET", {}, "extra"))).status).toBe(404);
  expect(await t.budget.status()).toBeNull();
});

it.each(["ticket", "session", "expired", "logout", "version", "owner", "ancestor", "moved"])(
  "rejects %s changes before serving even HEAD or 304",
  async (change) => {
    const t = await fixture();
    if (change === "ticket")
      expect(
        (await t.http(t.request(`/tickets/${t.delivery.ticketId}`, "DELETE", undefined, t.token)))
          .status,
      ).toBe(204);
    if (change === "session")
      await env.DB.prepare("UPDATE content_sessions SET revoked_at=1 WHERE id=?")
        .bind(t.delivery.sessionId)
        .run();
    if (change === "expired")
      await env.DB.prepare("UPDATE content_sessions SET expires_at=issued_at+1 WHERE id=?")
        .bind(t.delivery.sessionId)
        .run();
    if (change === "logout") await logoutShare(t.app, t.session);
    if (change === "version")
      await env.DB.prepare("UPDATE shares SET version=version+1 WHERE id=?").bind(t.share.id).run();
    if (change === "owner")
      await env.DB.prepare("UPDATE users SET disabled_at=1 WHERE id=?").bind(t.f.ids.user).run();
    if (change === "ancestor") {
      const outcome = await trashNode(t.app, {
        principal: accessPrincipal(t.owner),
        requestId: crypto.randomUUID(),
        spaceId: t.f.ids.space,
        nodeId: t.f.ids.folder,
        lockTokens: [],
      });
      expect(outcome).toMatchObject({ kind: "terminal", operation: { state: "committed" } });
    }
    if (change === "moved")
      await env.DB.prepare("UPDATE nodes SET parent_id=?,revision=revision+1 WHERE id=?")
        .bind(t.f.ids.root, t.f.ids.file)
        .run();
    for (const method of ["HEAD", "GET"]) {
      const response = await t.http(t.read(method, { "If-None-Match": "*" }));
      expect([401, 404]).toContain(response.status);
      if (method === "HEAD") expect(response.body).toBeNull();
    }
    expect(await t.budget.status()).toBeNull();
  },
);

it("keeps an old target manifest from reading a replacement blob at the same public node URL", async () => {
  const t = await fixture();
  expect(await (await t.http(t.read())).text()).toBe("abc");
  const blob = crypto.randomUUID(),
    key = `u/${t.f.ids.user}/b/${blob}`;
  cleanup.push(key);
  const stored = (await env.BLOBS.put(key, "new"))!;
  await env.DB.prepare(
    "INSERT INTO blobs(id,owner_id,r2_key,size,content_etag,state,created_at) VALUES(?,?,?,3,?,'committed',1)",
  )
    .bind(blob, t.f.ids.user, key, `"b-${blob}"`)
    .run();
  await env.DB.prepare(
    "INSERT INTO blob_storage(blob_id,bytes,r2_etag,observed_at) VALUES(?,3,?,1)",
  )
    .bind(blob, stored.etag)
    .run();
  await env.DB.prepare("UPDATE nodes SET current_blob_id=?,revision=revision+1 WHERE id=?")
    .bind(blob, t.f.ids.file)
    .run();
  expect((await t.http(t.read("GET", { "If-None-Match": "*" }))).status).toBe(404);
  expect(await t.budget.status()).toMatchObject({ requests: 1, bytesCharged: 3 });
  const renewed = await t.issue();
  const response = await t.http(t.read("GET", { "Content-Session": renewed.sessionId }));
  expect(response.status).toBe(200);
  expect(await response.text()).toBe("new");
  expect(await t.budget.status()).toMatchObject({ requests: 2, bytesCharged: 6, byteLimit: 18 });
});

it("rechecks owner authority in the content plan batch before reading file bytes", async () => {
  const t = await fixture();
  const head = vi.spyOn(env.BLOBS, "head");
  const db = injectBatch(
    (sql) => sql.includes("SELECT b.r2_key AS key"),
    async () => {
      await env.DB.prepare("UPDATE users SET disabled_at=1 WHERE id=?").bind(t.f.ids.user).run();
    },
    false,
  );
  const response = await t.http(t.read(), { DB: db });
  expect(response.status).toBe(503);
  expect(head).not.toHaveBeenCalled();
  expect(await t.budget.status()).toBeNull();
});

it("applies the request and parallel caps to public HEADs without minting new grants", async () => {
  const t = await fixture();
  expect((await t.http(t.read("HEAD"))).status).toBe(200);
  const before = await env.DB.prepare("SELECT COUNT(*) AS n FROM content_sessions").first("n");
  const leases = Array.from({ length: 8 }, () => crypto.randomUUID());
  for (const requestId of leases)
    await t.budget.reserve({
      budgetId: t.delivery.budgetId,
      sessionId: t.delivery.sessionId,
      requestId,
      epoch: 1,
      bytes: 0,
    });
  expect((await t.http(t.read("HEAD"))).status).toBe(429);
  for (const requestId of leases)
    await t.budget.settle({ budgetId: t.delivery.budgetId, requestId, deliveredBytes: 0 });
  await runInDurableObject(t.budget, (_instance, state) => {
    state.storage.sql.exec("UPDATE budget_state SET requests=1023");
  });
  expect((await t.http(t.read("HEAD"))).status).toBe(200);
  expect((await t.http(t.read("HEAD"))).status).toBe(429);
  expect(await t.budget.status()).toMatchObject({ requests: 1024, bytesCharged: 0, active: 0 });
  expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM content_sessions").first("n")).toBe(
    before,
  );
});

it("keeps lost/cancelled transfers charged and rejects missing or changed R2 objects", async () => {
  const t = await fixture();
  const aborted = new AbortController();
  aborted.abort();
  expect((await t.http(new Request(t.read(), { signal: aborted.signal }))).status).toBe(400);
  expect(await t.budget.status()).toBeNull();
  const response = await t.http(t.read());
  const reader = response.body!.getReader();
  expect((await reader.read()).value?.byteLength).toBe(3);
  await reader.cancel();
  expect(await t.budget.status()).toMatchObject({ bytesCharged: 3, requests: 1, active: 0 });
  await env.BLOBS.delete(t.key);
  expect((await t.http(t.read())).status).toBe(503);
  expect(await t.budget.status()).toMatchObject({ bytesCharged: 3, requests: 2, active: 0 });
  await env.BLOBS.put(t.key, "xyz");
  expect((await t.http(t.read())).status).toBe(503);
  expect(await t.budget.status()).toMatchObject({ bytesCharged: 3, requests: 3, active: 0 });
});

it.each(["text/html", "image/svg+xml"])(
  "serves %s as an attachment with restrictive CSP and a safe filename",
  async (mime) => {
    const t = await fixture();
    await env.DB.prepare("UPDATE blobs SET mime_sniffed=? WHERE id=?")
      .bind(mime, t.f.ids.blob)
      .run();
    await env.DB.prepare("UPDATE nodes SET name='共有メモ.txt' WHERE id=?")
      .bind(t.f.ids.file)
      .run();
    const response = await t.http(t.read());
    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toBe(mime);
    expect(response.headers.get("Content-Disposition")).toContain(
      "attachment; filename*=UTF-8''%E5%85%B1%E6%9C%89",
    );
    expect(response.headers.get("Content-Disposition")).toContain('filename="download"');
    expect(response.headers.get("Content-Security-Policy")).toBe(
      "default-src 'none'; sandbox; frame-ancestors 'none'",
    );
    expect(response.headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(await response.text()).toBe("abc");
  },
);
