import { applyD1Migrations, evictDurableObject, runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { base64url } from "jose";
import { afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { handleContentHttp } from "../../src/api/content";
import { handlePrivateContentTicketHttp } from "../../src/api/contentTickets";
import { privateAppRoute } from "../../src/api/privateApp";
import { handlePublicShareHttp, publicShareRoute } from "../../src/api/publicShares";
import { handleThumbnailHttp } from "../../src/api/thumbnails";
import { acceptContentTicket } from "../../src/auth/contentAccept";
import { ContentTokens, contentKeyRing } from "../../src/auth/contentTokens";
import { CsrfTokens } from "../../src/auth/csrf";
import { readAccessSession } from "../../src/auth/sessions";
import { ShareTokens } from "../../src/auth/shareTokens";
import { atomicBatch } from "../../src/db/primary";
import { CONTROL_NAME } from "../../src/do/controlName";
import { storeImageDerivative } from "../../src/jobs/imageDerivative";
import { prepareContentBlobRead, streamBudgetedBlobPlan } from "../../src/services/blobRead";
import { issueContentTicket } from "../../src/services/contentTicket";
import { cancelContentTicket } from "../../src/services/contentTicketCancel";
import { createInternalShare } from "../../src/services/internalShares";
import { createLinkShare } from "../../src/services/linkShares";
import { unlockShare } from "../../src/services/shareUnlock";
import { loadTargetManifest } from "../../src/services/targetManifest";
import { trashNode } from "../../src/services/trashNode";
import { davBucket } from "../fixtures/davPut";
import { foundationFixture } from "../fixtures/foundation";
import { imageDerivativeFixture } from "../fixtures/imageDerivative";
import { clearEndedR2TestWrites } from "../fixtures/mutationAdmission";
import { admitted, injectBatch } from "../fixtures/uploadEnv";

const control = () => env.CONTROL.get(env.CONTROL.idFromName(CONTROL_NAME));
beforeAll(() => applyD1Migrations(env.DB, env.TEST_MIGRATIONS));
beforeEach(async () => {
  await env.DB.prepare(
    "UPDATE control SET backup_token=NULL,backup_frozen=0,restore_freeze_token=NULL",
  ).run();
  await clearEndedR2TestWrites();
  await env.DB.prepare("UPDATE control SET epoch=1,maintenance=0,gc_paused=0").run();
  await env.DB.prepare("UPDATE mutation_admissions SET state='closed' WHERE state='active'").run();
  await runInDurableObject(control(), (_, state) => state.storage.deleteAll());
  await evictDurableObject(control());
});
afterEach(() => vi.restoreAllMocks());
async function fixture() {
  const f = await imageDerivativeFixture();
  const output = await storeImageDerivative(f.app, f.grant.id, f.output);
  const app = {
    ...f.app,
    APP_ORIGIN: "https://app.invalid",
    CONTENT_ORIGIN: "https://content.invalid",
  };
  const key = base64url.encode(crypto.getRandomValues(new Uint8Array(32))),
    ring = await contentKeyRing("test", { test: key });
  const tokens = new ContentTokens(ring, ring, app.CONTENT_ORIGIN);
  const principal = {
    kind: "user" as const,
    user_id: f.ids.user,
    credential_id: f.ids.credential,
    epoch: 1,
  };
  const targets = [{ spaceId: f.ids.space, nodeId: f.node.id, variant: "sm" as const }];
  const issue = () =>
    issueContentTicket(app, env.BLOBS, tokens, principal, targets, "thumb", Date.now() + 300000);
  const issued = await issue(),
    accepted = await acceptContentTicket(app, tokens, issued.ticket);
  const cookie = accepted.setCookie.split(";")[0]!;
  const request = (method = "GET", headers: HeadersInit = {}, variant = "sm") => {
    const h = new Headers({
      Origin: app.APP_ORIGIN,
      "Sec-Fetch-Site": "same-origin",
      "Content-Session": accepted.sessionId,
    });
    for (const [key, value] of new Headers(headers)) h.set(key, value);
    return new Request(`${app.APP_ORIGIN}/api/v1/nodes/${f.node.id}/thumb?variant=${variant}`, {
      method,
      headers: h,
    });
  };
  const http = (r = request()) => handleThumbnailHttp(r, app, principal, f.node.id);
  const budget = env.BUDGETS.get(env.BUDGETS.idFromName(issued.budgetId));
  return {
    ...f,
    app,
    output,
    bytes: f.output.bytes,
    tokens,
    ring,
    principal,
    targets,
    issue,
    issued,
    accepted,
    cookie,
    request,
    http,
    budget,
  };
}

it("issues an exact derivative manifest and streams counted HEAD, Range, 304 and 416", async () => {
  const f = await fixture();
  const record = (await env.DB.prepare(
    "SELECT id,manifest_ref AS ref,manifest_hash AS hash,total_bytes AS totalBytes FROM target_sets WHERE id=?",
  )
    .bind(f.issued.targetSetId)
    .first<any>())!;
  expect(await loadTargetManifest(env.BLOBS, record)).toEqual({
    v: 3,
    targets: [
      {
        spaceId: f.ids.space,
        nodeId: f.node.id,
        blobId: f.node.blob,
        purpose: "thumb",
        size: f.output.size,
        imageId: f.grant.id,
        variant: "sm",
        generator: "image-webp-v1",
      },
    ],
  });
  expect(record.totalBytes).toBe(f.output.size);
  expect(privateAppRoute(f.request())).toBe(true);
  const head = await f.http(f.request("HEAD"));
  expect(head.status).toBe(200);
  expect(head.body).toBeNull();
  expect(head.headers.get("Content-Type")).toBe("image/webp");
  expect(head.headers.get("Content-Length")).toBe(String(f.output.size));
  expect(head.headers.get("Cache-Control")).toBe("private, no-store");
  expect(head.headers.get("Content-Disposition")).toMatch(/^inline;/);
  const part = await f.http(f.request("GET", { Range: "bytes=0-9" }));
  expect(part.status).toBe(206);
  expect(new Uint8Array(await part.arrayBuffer())).toEqual(f.bytes.slice(0, 10));
  expect(
    (await f.http(f.request("GET", { "If-None-Match": head.headers.get("ETag")! }))).status,
  ).toBe(304);
  expect((await f.http(f.request("GET", { Range: "bytes=999999-" }))).status).toBe(416);
  expect(new Uint8Array(await (await f.http()).arrayBuffer())).toEqual(f.bytes);
  expect(await f.budget.status()).toMatchObject({
    requests: 5,
    bytesCharged: 10 + f.bytes.length,
    byteLimit: f.bytes.length * 3,
    active: 0,
  });
});

it("content-host cookies and app sessions use the same budget without mixing original and thumbnail purposes", async () => {
  const f = await fixture();
  const url = `${f.app.CONTENT_ORIGIN}/c/${f.node.id}/${f.node.blob}`;
  const content = (suffix: string, cookie = f.cookie) =>
    handleContentHttp(
      new Request(url + suffix, { headers: { Cookie: cookie, Origin: f.app.APP_ORIGIN } }),
      f.app,
      f.tokens,
    );
  expect((await content("")).status).toBe(404);
  const thumb = await content("?variant=sm");
  expect(thumb.status).toBe(200);
  expect(thumb.headers.get("Content-Type")).toBe("image/webp");
  expect(new Uint8Array(await thumb.arrayBuffer())).toEqual(
    new Uint8Array(await (await env.BLOBS.get(f.output.key))!.arrayBuffer()),
  );
  const next = await f.issue();
  expect(next.budgetId).toBe(f.issued.budgetId);
  const accepted = await acceptContentTicket(f.app, f.tokens, next.ticket);
  expect((await f.http(f.request("HEAD", { "Content-Session": accepted.sessionId }))).status).toBe(
    200,
  );
  expect(await f.budget.status()).toMatchObject({
    requests: 2,
    bytesCharged: f.output.size,
    byteLimit: f.output.size * 3,
    active: 0,
  });
  for (const suffix of ["?variant=md", "?variant=lg", "?variant=sm&variant=sm", "?token=abc"])
    expect((await content(suffix)).status).toBe(404);
  const original = await issueContentTicket(
    f.app,
    env.BLOBS,
    f.tokens,
    f.principal,
    [{ spaceId: f.ids.space, nodeId: f.node.id }],
    "content",
    Date.now() + 300000,
  );
  const originalSession = await acceptContentTicket(f.app, f.tokens, original.ticket);
  expect((await content("?variant=sm", originalSession.setCookie.split(";")[0]!)).status).toBe(404);
});

it.each(["credential", "ancestor", "source", "result", "ticket"])(
  "denies %s changes before the next request",
  async (kind) => {
    const f = await fixture();
    if (kind === "credential")
      await env.DB.prepare("UPDATE sessions SET revoked_at=? WHERE id=?")
        .bind(Date.now(), f.ids.session)
        .run();
    if (kind === "ancestor")
      expect(
        await trashNode(
          { ...f.app, LOCKS: admitted().LOCKS },
          {
            principal: f.principal,
            requestId: crypto.randomUUID(),
            spaceId: f.ids.space,
            nodeId: f.ids.folder,
            lockTokens: [],
          },
        ),
      ).toMatchObject({ kind: "terminal", operation: { state: "committed" } });
    if (kind === "source")
      await env.DB.prepare("UPDATE nodes SET current_blob_id=? WHERE id=?")
        .bind(f.ids.blob, f.node.id)
        .run();
    if (kind === "result")
      await env.DB.prepare(
        "UPDATE derivative_results SET state='failed',error_code='test_retired' WHERE id=?",
      )
        .bind(f.output.id)
        .run();
    if (kind === "ticket") await cancelContentTicket(f.app, f.principal, f.issued.ticketId);
    const head = vi.fn(env.BLOBS.head.bind(env.BLOBS));
    const response = await handleThumbnailHttp(
      f.request(),
      { ...f.app, BLOBS: davBucket({ head }) },
      f.principal,
      f.node.id,
    );
    expect([404, 503]).toContain(response.status);
    expect(head).not.toHaveBeenCalled();
  },
);

it.each(["head", "get"])("rechecks authorization after the derivative R2 %s", async (stage) => {
  const f = await fixture();
  const revoke = () =>
    env.DB.prepare("UPDATE sessions SET revoked_at=? WHERE id=?")
      .bind(Date.now(), f.ids.session)
      .run();
  const bucket = davBucket(
    stage === "head"
      ? {
          head: async (key) => {
            const r = await env.BLOBS.head(key);
            if (key === f.output.key) await revoke();
            return r;
          },
        }
      : {
          get: (async (...args: Parameters<R2Bucket["get"]>) => {
            const r = await env.BLOBS.get(...args);
            if (args[0] === f.output.key) await revoke();
            return r;
          }) as R2Bucket["get"],
        },
  );
  const response = await handleThumbnailHttp(
    f.request(),
    { ...f.app, BLOBS: bucket },
    f.principal,
    f.node.id,
  );
  expect([404, 503]).toContain(response.status);
  expect(await f.budget.status()).toMatchObject({ requests: 1, bytesCharged: 0, active: 0 });
});

it("rechecks the original and generation after waiting for a budget lease", async () => {
  const f = await fixture();
  const plan = await prepareContentBlobRead(
    env.DB,
    env.BLOBS,
    f.principal,
    f.ids.space,
    f.node.id,
    {
      sessionId: f.accepted.sessionId,
      ticketId: f.issued.ticketId,
      purpose: "thumb",
      variant: "sm",
    },
  );
  await env.DB.prepare("UPDATE nodes SET current_blob_id=? WHERE id=?")
    .bind(f.ids.blob, f.node.id)
    .run();
  const head = vi.fn(env.BLOBS.head.bind(env.BLOBS));
  await expect(
    streamBudgetedBlobPlan(davBucket({ head }), env.BUDGETS, plan, f.request()),
  ).rejects.toThrow();
  expect(head).not.toHaveBeenCalled();
  expect(await f.budget.status()).toMatchObject({ requests: 1, bytesCharged: 0, active: 0 });
});

it("refuses unknown variants, missing sessions and unsupported lg before issuing a manifest", async () => {
  const f = await fixture();
  expect((await f.http(f.request("HEAD", { "Content-Session": "" }))).status).toBe(400);
  expect((await f.http(f.request("GET", {}, "large"))).status).toBe(400);
  await expect(
    issueContentTicket(
      f.app,
      env.BLOBS,
      f.tokens,
      f.principal,
      [{ ...f.targets[0]!, variant: "lg" }],
      "thumb",
      Date.now() + 300000,
    ),
  ).rejects.toThrow("thumbnail_not_ready");
});

it("private ticket HTTP accepts explicit app delivery with strict variant fields", async () => {
  const f = await fixture();
  const csrf = { verify: async () => {} };
  const request = (targets: unknown = f.targets) =>
    new Request(`${f.app.APP_ORIGIN}/api/v1/content-session`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Origin: f.app.APP_ORIGIN,
        "Sec-Fetch-Site": "same-origin",
      },
      body: JSON.stringify({ targets, purpose: "thumb", delivery: "app", ttlSeconds: 300 }),
    });
  const response = await handlePrivateContentTicketHttp(
    request(),
    f.app,
    f.principal,
    csrf,
    f.tokens,
  );
  expect(response.status).toBe(201);
  const receipt = await response.json<any>();
  expect(receipt.sessionId).toMatch(/^[A-Za-z0-9_-]{43}$/);
  expect(receipt.ticket).toBeUndefined();
  expect(response.headers.get("Set-Cookie")).toBeNull();
  expect((await f.http(f.request("HEAD", { "Content-Session": receipt.sessionId }))).status).toBe(
    200,
  );
  expect(
    (
      await handlePrivateContentTicketHttp(
        request([{ spaceId: f.ids.space, nodeId: f.node.id }]),
        f.app,
        f.principal,
        csrf,
        f.tokens,
      )
    ).status,
  ).toBe(400);
});

it("refuses a stale output in the final ticket publication batch", async () => {
  const f = await fixture();
  const db = injectBatch(
    (sql) => sql.includes("INSERT INTO target_sets"),
    async () => {
      await env.DB.prepare(
        "UPDATE derivative_results SET state='failed',error_code='test_retired' WHERE id=?",
      )
        .bind(f.output.id)
        .run();
    },
    false,
  );
  await expect(
    issueContentTicket(
      { ...f.app, DB: db },
      env.BLOBS,
      f.tokens,
      f.principal,
      f.targets,
      "thumb",
      Date.now() + 300000,
    ),
  ).rejects.toThrow();
  expect(
    await env.DB.prepare("SELECT COUNT(*) AS n FROM tickets WHERE credential_id=?")
      .bind(f.principal.credential_id)
      .first("n"),
  ).toBe(1);
});

it("batches more than 32 COW targets while charging the immutable output only once", async () => {
  const f = await fixture();
  const targets = [];
  for (let i = 0; i < 34; i++) {
    const id = crypto.randomUUID();
    await env.DB.prepare(
      "INSERT INTO nodes(id,space_id,owner_id,parent_id,name,name_ci,kind,current_blob_id,created_at,updated_at) VALUES(?,?,?,?,?,?,'file',?,1,1)",
    )
      .bind(id, f.ids.space, f.ids.user, f.ids.folder, id, id, f.node.blob)
      .run();
    targets.push({ nodeId: id, spaceId: f.ids.space, variant: "sm" as const });
  }
  const issued = await issueContentTicket(
    f.app,
    env.BLOBS,
    f.tokens,
    f.principal,
    targets,
    "thumb",
    Date.now() + 300000,
  );
  const session = await acceptContentTicket(f.app, f.tokens, issued.ticket);
  expect(
    (await handleThumbnailHttp(f.request("HEAD"), f.app, f.principal, targets[0]!.nodeId)).status,
  ).toBe(404);
  const response = await handleThumbnailHttp(
    f.request("HEAD", { "Content-Session": session.sessionId }),
    f.app,
    f.principal,
    targets[0]!.nodeId,
  );
  expect(response.status).toBe(200);
  expect(issued.budgetId).toBe(f.issued.budgetId);
  expect(await f.budget.status()).toMatchObject({
    requests: 1,
    byteLimit: f.bytes.length * 3,
    bytesCharged: 0,
  });
});

it("binds an internal-share thumbnail to its recipient and current grant", async () => {
  const f = await fixture(),
    recipient = foundationFixture(crypto.randomUUID(), Date.now());
  await atomicBatch(env.DB, recipient.statements);
  const email = `${recipient.ids.user}@example.invalid`;
  await env.DB.prepare("UPDATE users SET email=? WHERE id=?").bind(email, recipient.ids.user).run();
  const owner = (await readAccessSession(env.DB, f.ids.credential, 1))!;
  const share = await createInternalShare(f.app, owner, {
    kind: "internal",
    rootNodeId: f.ids.folder,
    role: "read",
    recipients: [email],
  });
  const principal = {
    kind: "user" as const,
    user_id: recipient.ids.user,
    credential_id: recipient.ids.credential,
    epoch: 1,
  };
  const issued = await issueContentTicket(
    f.app,
    env.BLOBS,
    f.tokens,
    principal,
    f.targets,
    "thumb",
    Date.now() + 300000,
    share,
  );
  const session = await acceptContentTicket(f.app, f.tokens, issued.ticket);
  const request = () => f.request("HEAD", { "Content-Session": session.sessionId });
  expect((await handleThumbnailHttp(request(), f.app, principal, f.node.id)).status).toBe(200);
  expect((await handleThumbnailHttp(request(), f.app, f.principal, f.node.id)).status).toBe(404);
  expect(issued.budgetId).toBe(`u:${recipient.ids.user}:s:${share.id}`);
  await env.DB.prepare("UPDATE share_grants SET disabled_at=? WHERE share_id=? AND user_id=?")
    .bind(Date.now(), share.id, recipient.ids.user)
    .run();
  expect((await handleThumbnailHttp(request(), f.app, principal, f.node.id)).status).toBe(404);
});

it("serves a public read link with a session bound to the original unlock cookie and revokes it", async () => {
  const f = await fixture(),
    owner = (await readAccessSession(env.DB, f.ids.credential, 1))!;
  const share = await createLinkShare(f.app, owner, {
    kind: "link",
    rootNodeId: f.ids.folder,
    role: "read",
  });
  const shareTokens = new ShareTokens(f.ring, f.app.APP_ORIGIN),
    csrf = new CsrfTokens(f.ring, f.ring, f.app.APP_ORIGIN);
  const session = await unlockShare(f.app, (await shareTokens.challenge(share.id, 1)).claims, {
    secret: share.secret,
  });
  const cookie = `__Host-ncf_share_${share.id}=${await shareTokens.issue(session.claims)}`;
  const app = { ...f.app, EDGE_LIMITER: { limit: async () => ({ success: true }) } },
    deps = { tokens: shareTokens, csrf, contentTokens: f.tokens };
  const request = (suffix: string, method = "GET", body?: unknown, token?: string) =>
    new Request(`${app.APP_ORIGIN}/api/v1/public/shares/${share.id}${suffix}`, {
      method,
      headers: {
        Origin: app.APP_ORIGIN,
        "Sec-Fetch-Site": "same-origin",
        Cookie: cookie,
        "Share-Session": session.claims.session_id,
        "Content-Type": "application/json",
        ...(token ? { "X-CSRF-Token": token } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
  const http = (r: Request) => handlePublicShareHttp(r, app, 1, deps);
  const cr = await http(request("/csrf", "POST")),
    { token } = await cr.json<{ token: string }>();
  expect(
    (
      await http(
        request(
          "/content-session",
          "POST",
          {
            nodeIds: [f.node.id],
            purpose: null,
            ttlSeconds: 300,
          },
          token,
        ),
      )
    ).status,
  ).toBe(400);
  const issued = await http(
    request(
      "/content-session",
      "POST",
      { nodeIds: [f.node.id], purpose: "thumb", variant: "sm", delivery: "app", ttlSeconds: 300 },
      token,
    ),
  );
  expect(issued.status).toBe(201);
  const receipt = await issued.json<{ sessionId: string }>();
  const get = request(`/thumb/${f.node.id}?variant=sm`);
  get.headers.set("Content-Session", receipt.sessionId);
  expect(publicShareRoute(get)).toBe(true);
  const response = await http(get);
  expect(response.status).toBe(200);
  expect(response.headers.get("Content-Type")).toBe("image/webp");
  await response.arrayBuffer();
  const original = request(`/content/${f.node.id}`);
  original.headers.set("Content-Session", receipt.sessionId);
  expect((await http(original)).status).toBe(404);
  const missing = new Request(get);
  missing.headers.delete("Cookie");
  expect((await http(missing)).status).toBe(401);
  await env.DB.prepare("UPDATE shares SET disabled_at=? WHERE id=?")
    .bind(Date.now(), share.id)
    .run();
  expect([401, 404]).toContain((await http(new Request(get))).status);
});
