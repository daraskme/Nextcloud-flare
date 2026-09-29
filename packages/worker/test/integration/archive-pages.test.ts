import { applyD1Migrations, evictDurableObject, runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { base64url } from "jose";
import { beforeAll, beforeEach, expect, it, vi } from "vitest";
import { handleContentHttp } from "../../src/api/content";
import { handleLibraryBookHttp } from "../../src/api/library";
import { privateAppRoute } from "../../src/api/privateApp";
import { handlePublicShareHttp, publicShareRoute } from "../../src/api/publicShares";
import { acceptContentTicket } from "../../src/auth/contentAccept";
import { ContentTokens, contentKeyRing } from "../../src/auth/contentTokens";
import { CsrfTokens } from "../../src/auth/csrf";
import { readAccessSession } from "../../src/auth/sessions";
import { ShareTokens } from "../../src/auth/shareTokens";
import { atomicBatch } from "../../src/db/primary";
import { CONTROL_NAME } from "../../src/do/controlName";
import { consumeOutbox } from "../../src/jobs/consumeOutbox";
import { issueContentTicket } from "../../src/services/contentTicket";
import { cancelContentTicket } from "../../src/services/contentTicketCancel";
import { createInternalShare } from "../../src/services/internalShares";
import { createLinkShare } from "../../src/services/linkShares";
import { unlockShare } from "../../src/services/shareUnlock";
import { loadTargetManifest } from "../../src/services/targetManifest";
import { archiveFixture } from "../fixtures/archive";
import { archiveStorageFixture } from "../fixtures/archiveDerivative";
import { davBucket } from "../fixtures/davPut";
import { foundationFixture } from "../fixtures/foundation";
import { imageBytes } from "../fixtures/images/encoded";
import { clearEndedR2TestWrites } from "../fixtures/mutationAdmission";

beforeAll(() => applyD1Migrations(env.DB, env.TEST_MIGRATIONS));
beforeEach(async () => {
  await env.DB.prepare(
    "UPDATE control SET backup_token=NULL,backup_frozen=0,restore_freeze_token=NULL",
  ).run();
  await clearEndedR2TestWrites();
  await env.DB.prepare("UPDATE control SET epoch=1,maintenance=0,gc_paused=0").run();
  await env.DB.prepare("UPDATE mutation_admissions SET state='closed' WHERE state='active'").run();
  const control = env.CONTROL.get(env.CONTROL.idFromName(CONTROL_NAME));
  await runInDurableObject(control, (_, state) => state.storage.deleteAll());
  await evictDurableObject(control);
});
async function fixture(content: Uint8Array = imageBytes("red.png"), method = 0, crc?: number) {
  const bytes = archiveFixture([
    { name: "page10.jpg", content, method, ...(crc === undefined ? {} : { crc }) },
    { name: "page2.png", content, method, ...(crc === undefined ? {} : { crc }) },
  ]).bytes;
  const f = await archiveStorageFixture(bytes, "book.cbz", false);
  await f.release();
  expect(await consumeOutbox(f.app, f.outboxId)).toBe("completed");
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
  const targets = [{ spaceId: f.ids.space, nodeId: f.node.id }];
  const issue = (purpose: "page" | "content" = "page") =>
    issueContentTicket(app, env.BLOBS, tokens, principal, targets, purpose, Date.now() + 300000);
  const issued = await issue(),
    accepted = await acceptContentTicket(app, tokens, issued.ticket);
  const cookie = accepted.setCookie.split(";")[0]!;
  const request = (page = "1", method = "GET", headers: HeadersInit = {}) =>
    new Request(`${app.CONTENT_ORIGIN}/c/${f.node.id}/${f.node.blob}/pages/${page}`, {
      method,
      headers: new Headers({
        cookie,
        origin: app.APP_ORIGIN,
        ...Object.fromEntries(new Headers(headers)),
      }),
    });
  const http = (r = request(), options = {}) =>
    handleContentHttp(r, { ...app, ...options }, tokens);
  const budget = env.BUDGETS.get(env.BUDGETS.idFromName(issued.budgetId));
  return {
    ...f,
    app,
    content,
    principal,
    targets,
    tokens,
    ring,
    issued,
    accepted,
    cookie,
    request,
    http,
    budget,
    issue,
  };
}

it.each([0, 8])(
  "serves natural pages from method %i with an expanded-byte manifest and counted HEAD/304/GET",
  async (method) => {
    const f = await fixture(imageBytes("red.png"), method);
    const record = (await env.DB.prepare(
      "SELECT id,manifest_ref AS ref,manifest_hash AS hash,total_bytes AS totalBytes FROM target_sets WHERE id=?",
    )
      .bind(f.issued.targetSetId)
      .first<any>())!;
    expect(await loadTargetManifest(env.BLOBS, record)).toMatchObject({
      v: 4,
      targets: [
        {
          purpose: "page",
          size: f.content.length * 2,
          pageBytes: [f.content.length, f.content.length],
          pageCount: 2,
        },
      ],
    });
    const head = await f.http(f.request("1", "HEAD"));
    expect(head.status).toBe(200);
    expect(head.body).toBeNull();
    expect(head.headers.get("Content-Type")).toBe("image/png");
    expect(head.headers.get("Content-Length")).toBe(String(f.content.length));
    expect(head.headers.get("Cache-Control")).toBe("private, no-store");
    expect(head.headers.get("Content-Disposition")).toBe('inline; filename="page-1.png"');
    const unchanged = await f.http(
      f.request("1", "GET", { "If-None-Match": head.headers.get("ETag")! }),
    );
    expect(unchanged.status).toBe(304);
    expect(unchanged.body).toBeNull();
    const response = await f.http(f.request("2", "GET", { Range: "bytes=0-9" }));
    expect(response.status).toBe(200);
    expect(response.headers.get("Accept-Ranges")).toBe("none");
    expect(response.headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(f.content);
    expect(await f.budget.status()).toMatchObject({
      requests: 3,
      bytesCharged: f.content.length,
      byteLimit: f.content.length * 6,
      active: 0,
    });
  },
);

it("recognizes AVIF page bodies", async () => {
  const f = await fixture(imageBytes("red.avif"));
  const response = await f.http();
  expect(response.headers.get("Content-Type")).toBe("image/avif");
  expect(new Uint8Array(await response.arrayBuffer())).toEqual(f.content);
});

it.each(["<script>alert(1)</script>", "<svg xmlns='http://www.w3.org/2000/svg'/>", "GIF89", ""])(
  "rejects non-image content disguised by an image filename: %s",
  async (text) => {
    const f = await fixture(new TextEncoder().encode(text));
    expect((await f.http()).status).toBe(404);
    expect(await f.budget.status()).toMatchObject({ requests: 1, bytesCharged: 0, active: 0 });
  },
);

it.each(["credential", "hidden", "blob", "ticket", "epoch", "result"])(
  "denies a changed %s before reading the index or original",
  async (change) => {
    const f = await fixture();
    if (change === "credential")
      await env.DB.prepare("UPDATE sessions SET revoked_at=? WHERE id=?")
        .bind(Date.now(), f.ids.session)
        .run();
    if (change === "hidden")
      await env.DB.prepare("UPDATE nodes SET hidden=1 WHERE id=?").bind(f.ids.folder).run();
    if (change === "blob")
      await env.DB.prepare("UPDATE nodes SET current_blob_id=? WHERE id=?")
        .bind(f.ids.blob, f.node.id)
        .run();
    if (change === "ticket") await cancelContentTicket(f.app, f.principal, f.issued.ticketId);
    if (change === "epoch") await env.DB.prepare("UPDATE control SET epoch=2").run();
    if (change === "result")
      await env.DB.prepare(
        "UPDATE derivative_results SET state='failed',error_code='test' WHERE blob_id=? AND kind='archive_index'",
      )
        .bind(f.node.blob)
        .run();
    const get = vi.fn(env.BLOBS.get.bind(env.BLOBS));
    expect((await f.http(f.request(), { BLOBS: davBucket({ get }) })).status).toBe(404);
    expect(get.mock.calls.every(([key]) => String(key).startsWith("target-sets/"))).toBe(true);
  },
);

it("refuses cross-purpose cookies, malformed pages, foreign origins and query credentials", async () => {
  const f = await fixture();
  for (const page of [
    "0",
    "01",
    "-1",
    "3",
    "10001",
    "1?variant=sm",
    "1?ticket=abc",
    "1?download=1&download=1",
    "1/extra",
  ])
    expect((await f.http(f.request(page))).status).toBe(404);
  expect((await f.http(f.request("1", "GET", { Origin: "https://foreign.invalid" }))).status).toBe(
    403,
  );
  const ticket = await f.issue("content"),
    session = await acceptContentTicket(f.app, f.tokens, ticket.ticket);
  expect(
    (await f.http(f.request("1", "GET", { Cookie: session.setCookie.split(";")[0]! }))).status,
  ).toBe(404);
  expect(
    (
      await f.http(
        new Request(`${f.app.CONTENT_ORIGIN}/c/${f.node.id}/${f.node.blob}`, {
          headers: { Cookie: f.cookie },
        }),
      )
    ).status,
  ).toBe(404);
  expect(await f.budget.status()).toBeNull();
});

it("forces attachment delivery in single-host mode", async () => {
  const f = await fixture();
  const request = f.request("1", "GET", { Origin: f.app.CONTENT_ORIGIN });
  const response = await f.http(request, { APP_ORIGIN: f.app.CONTENT_ORIGIN });
  expect(response.status).toBe(200);
  expect(response.headers.get("Content-Disposition")).toMatch(/^attachment;/);
  await response.arrayBuffer();
});

it("checks the stored index hash and original R2 ETag before delivering pages", async () => {
  const f = await fixture();
  await env.BLOBS.put(f.node.key, new Uint8Array(f.bytes.length));
  expect((await f.http()).status).toBe(404);
  expect(await f.budget.status()).toMatchObject({ requests: 1, bytesCharged: 0, active: 0 });
});

it("rejects tampered index bytes before any original range is opened", async () => {
  const f = await fixture(),
    row = (await f.row())!;
  const key = await env.DB.prepare("SELECT r2_key FROM blobs WHERE id=?")
    .bind(row.output_blob_id)
    .first<string>("r2_key");
  await env.BLOBS.put(key!, new Uint8Array(100));
  const get = vi.fn(env.BLOBS.get.bind(env.BLOBS));
  expect((await f.http(f.request(), { BLOBS: davBucket({ get }) })).status).toBe(404);
  expect(get.mock.calls.some(([key]) => key === f.node.key)).toBe(false);
});

it.each(["crc", "revoke"])(
  "fails a page stream on %s and keeps uncertain bytes charged",
  async (reason) => {
    const content = new Uint8Array(131072);
    content.set([255, 216, 255]);
    const f = await fixture(content, 0, reason === "crc" ? 1 : undefined),
      response = await f.http();
    expect(response.status).toBe(200);
    if (reason === "revoke")
      await env.DB.prepare("UPDATE nodes SET hidden=1 WHERE id=?").bind(f.ids.folder).run();
    await expect(response.arrayBuffer()).rejects.toThrow();
    await vi.waitFor(async () =>
      expect(await f.budget.status()).toMatchObject({
        requests: 1,
        bytesCharged: content.length,
        active: 0,
      }),
    );
  },
);

it("renews page tickets without replenishing a book's allowance", async () => {
  const f = await fixture();
  for (let i = 0; i < 6; i++) await (await f.http()).arrayBuffer();
  const again = await f.issue(),
    session = await acceptContentTicket(f.app, f.tokens, again.ticket);
  expect(again.budgetId).toBe(f.issued.budgetId);
  expect(
    (await f.http(f.request("1", "GET", { Cookie: session.setCookie.split(";")[0]! }))).status,
  ).toBe(429);
  expect(await f.budget.status()).toMatchObject({
    bytesCharged: f.content.length * 6,
    byteLimit: f.content.length * 6,
    active: 0,
  });
});

it("exposes only a currently readable book through the private detail route", async () => {
  const f = await fixture(),
    r = new Request(`${f.app.APP_ORIGIN}/api/v1/library/${f.node.id}`);
  expect(privateAppRoute(r)).toBe(true);
  const response = await handleLibraryBookHttp(r, f.app, f.principal);
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({
    nodeId: f.node.id,
    spaceId: f.ids.space,
    blobId: f.node.blob,
    title: "book.cbz",
    pageCount: 2,
    generator: "archive-index-v1",
  });
  await env.DB.prepare("UPDATE nodes SET hidden=1 WHERE id=?").bind(f.ids.folder).run();
  expect((await handleLibraryBookHttp(r, f.app, f.principal)).status).toBe(404);
});

it("requires the library scope on an app password in addition to original-file read access", async () => {
  const f = await fixture(),
    principal = f.input.principal;
  await expect(
    issueContentTicket(
      f.app,
      env.BLOBS,
      f.tokens,
      principal,
      f.targets,
      "page",
      Date.now() + 300000,
    ),
  ).rejects.toThrow("authorization_denied");
  await env.DB.prepare(
    "INSERT INTO credential_scopes(credential_id,scope) VALUES(?,'library:read')",
  )
    .bind(principal.credential_id)
    .run();
  const issued = await issueContentTicket(
    f.app,
    env.BLOBS,
    f.tokens,
    principal,
    f.targets,
    "page",
    Date.now() + 300000,
  );
  const session = await acceptContentTicket(f.app, f.tokens, issued.ticket);
  const response = await f.http(
    f.request("1", "GET", { Cookie: session.setCookie.split(";")[0]! }),
  );
  expect(response.status).toBe(200);
  await response.arrayBuffer();
  await env.DB.prepare(
    "DELETE FROM credential_scopes WHERE credential_id=? AND scope='library:read'",
  )
    .bind(principal.credential_id)
    .run();
  expect(
    (await f.http(f.request("2", "GET", { Cookie: session.setCookie.split(";")[0]! }))).status,
  ).toBe(404);
});

it("requires explicit internal share selection and stops after the recipient grant is revoked", async () => {
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
  await expect(
    issueContentTicket(
      f.app,
      env.BLOBS,
      f.tokens,
      principal,
      f.targets,
      "page",
      Date.now() + 300000,
    ),
  ).rejects.toThrow();
  const issued = await issueContentTicket(
    f.app,
    env.BLOBS,
    f.tokens,
    principal,
    f.targets,
    "page",
    Date.now() + 300000,
    share,
  );
  const session = await acceptContentTicket(f.app, f.tokens, issued.ticket),
    cookie = session.setCookie.split(";")[0]!;
  const response = await f.http(f.request("1", "GET", { Cookie: cookie }));
  expect(response.status).toBe(200);
  await response.arrayBuffer();
  await env.DB.prepare("UPDATE share_grants SET disabled_at=? WHERE share_id=? AND user_id=?")
    .bind(Date.now(), share.id, recipient.ids.user)
    .run();
  expect((await f.http(f.request("1", "GET", { Cookie: cookie }))).status).toBe(404);
});

it("uses the real public read-link detail and page-ticket routes, then revokes content delivery", async () => {
  const f = await fixture(),
    owner = (await readAccessSession(env.DB, f.ids.credential, 1))!;
  const share = await createLinkShare(f.app, owner, {
    kind: "link",
    rootNodeId: f.ids.folder,
    role: "read",
  });
  const tokens = new ShareTokens(f.ring, f.app.APP_ORIGIN),
    csrf = new CsrfTokens(f.ring, f.ring, f.app.APP_ORIGIN);
  const session = await unlockShare(f.app, (await tokens.challenge(share.id, 1)).claims, {
    secret: share.secret,
  });
  const cookie = `__Host-ncf_share_${share.id}=${await tokens.issue(session.claims)}`;
  const app = { ...f.app, EDGE_LIMITER: { limit: async () => ({ success: true }) } },
    deps = { tokens, csrf, contentTokens: f.tokens };
  const request = (path: string, body?: unknown, token?: string) =>
    new Request(`${app.APP_ORIGIN}/api/v1/public/shares/${share.id}${path}`, {
      method: body || path === "/csrf" ? "POST" : "GET",
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
  const detail = request(`/library/${f.node.id}`);
  expect(publicShareRoute(detail)).toBe(true);
  expect((await http(detail)).status).toBe(200);
  const { token } = await (await http(request("/csrf"))).json<{ token: string }>();
  const issued = await http(
    request("/content-session", { nodeIds: [f.node.id], purpose: "page", ttlSeconds: 300 }, token),
  );
  expect(issued.status).toBe(201);
  const receipt = await issued.json<{ ticket: string }>(),
    accepted = await acceptContentTicket(f.app, f.tokens, receipt.ticket);
  const content = () =>
    f.http(f.request("1", "GET", { Cookie: accepted.setCookie.split(";")[0]! }));
  const response = await content();
  expect(response.status).toBe(200);
  await response.arrayBuffer();
  await env.DB.prepare("UPDATE shares SET disabled_at=? WHERE id=?")
    .bind(Date.now(), share.id)
    .run();
  expect((await content()).status).toBe(404);
});
