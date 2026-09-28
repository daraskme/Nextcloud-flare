import { applyD1Migrations } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterEach, beforeAll, beforeEach, expect, it } from "vitest";
import { privateAssets } from "../../src/assets/privateManifest";
import { publicManifest } from "../../src/assets/publicManifest";
import type { Env } from "../../src/env";
import worker from "../../src/index";
import { publicShareFixture } from "../fixtures/publicShare";

const cleanup: string[] = [];
beforeAll(() => applyD1Migrations(env.DB, env.TEST_MIGRATIONS));
beforeEach(async () => {
  await env.DB.prepare("UPDATE control SET maintenance=1").run();
  await env.DB.prepare("UPDATE control SET epoch=1,maintenance=0,gc_paused=1").run();
});
afterEach(async () => {
  if (cleanup.length) await env.BLOBS.delete(cleanup.splice(0));
});
async function fixture(single: boolean) {
  const t = await publicShareFixture("read", "file");
  const keys = JSON.stringify({ test: t.key });
  const app: Env = {
    ...t.app,
    CONTENT_ORIGIN: single ? t.app.APP_ORIGIN : "https://content.invalid",
    SHARE_COOKIE_ACTIVE_KID: "test",
    SHARE_COOKIE_KEYS: keys,
    CSRF_PUBLIC_ACTIVE_KID: "test",
    CSRF_PUBLIC_KEYS: keys,
    CSRF_PRIVATE_ACTIVE_KID: "test",
    CSRF_PRIVATE_KEYS: keys,
    CONTENT_TICKET_ACTIVE_KID: "test",
    CONTENT_TICKET_KEYS: keys,
    CONTENT_COOKIE_ACTIVE_KID: "test",
    CONTENT_COOKIE_KEYS: keys,
    APP_PASSWORD_ACTIVE_KID: "test",
    APP_PASSWORD_PEPPERS: keys,
    ACCESS_ISSUER: "https://access.invalid",
    ACCESS_USER_AUDIENCE: "user",
    ACCESS_SERVICE_AUDIENCE: "service",
    BOOTSTRAP_OWNER_EMAILS: '["owner@example.invalid"]',
    BOOTSTRAP_OWNER_IDENTITIES: "[]",
    BOOTSTRAP_QUOTA_BYTES: "1000000",
  };
  const http = (request: Request) => worker.fetch(request, app);
  return { ...t, app, http };
}

it.each([false, true])(
  "keeps API, DAV and asset authorization with single host=%s",
  async (single) => {
    const t = await fixture(single);
    expect((await t.http(t.request(""))).status).toBe(200);
    for (const path of ["/api/v1/me", "/files", "/", ...privateAssets]) {
      const response = await t.http(
        new Request(t.app.APP_ORIGIN + path, { headers: { Cookie: t.cookie } }),
      );
      expect(response.status, path).toBe(401);
      expect(response.headers.get("Content-Type")).toContain("application/problem+json");
    }
    expect(
      (await t.http(new Request(`${t.app.APP_ORIGIN}/dav`, { method: "PROPFIND" }))).status,
    ).toBe(401);
    const paths = [
      "/api/v1/me",
      "/files",
      "/",
      `/s/${t.share.id}`,
      ...privateAssets,
      ...publicManifest.assets.map((a) => a.path),
    ];
    for (const origin of ["https://other.invalid", ...(!single ? [t.app.CONTENT_ORIGIN] : [])]) {
      for (const path of paths) {
        const response = await t.http(
          new Request(origin + path, { headers: { Cookie: t.cookie } }),
        );
        expect(response.status, origin + path).toBe(404);
        expect(response.headers.get("Content-Type")).toContain("application/problem+json");
      }
    }
    for (const path of [
      "/missing",
      "/index.html",
      "/public.html",
      "/sw.js",
      "/session/extra",
      "/c",
      "/c/a",
      "/c/a/b/c",
      "/c/a/b?ticket=secret",
    ]) {
      expect((await t.http(new Request(t.app.APP_ORIGIN + path))).status, path).toBe(404);
    }
    for (const path of ["/files", `/s/${t.share.id}`, "/session", "/c/a/b"]) {
      expect(
        (await t.http(new Request(t.app.APP_ORIGIN + path, { method: "PUT" }))).status,
        path,
      ).toBe(404);
    }
  },
);

it.each([false, true])(
  "redeems and revokes a host-only content grant with single host=%s",
  async (single) => {
    const t = await fixture(single);
    const key = `u/${t.f.ids.user}/b/${t.f.ids.blob}`;
    cleanup.push(key);
    const stored = (await env.BLOBS.put(key, "abc"))!;
    await env.DB.prepare(
      "INSERT INTO blob_storage(blob_id,bytes,r2_etag,observed_at) VALUES(?,3,?,?)",
    )
      .bind(t.f.ids.blob, stored.etag, Date.now())
      .run();
    const issue = () =>
      t.request("/content-session", "POST", { nodeIds: [t.f.ids.file], ttlSeconds: 300 }, t.token);
    const noCsrf = issue();
    noCsrf.headers.delete("X-CSRF-Token");
    expect((await t.http(noCsrf)).status).toBe(403);
    const issued = await t.http(issue());
    expect(issued.status).toBe(201);
    const ticket = await issued.json<{ ticket: string; targetSetId: string; ticketId: string }>();
    cleanup.push(`target-sets/${ticket.targetSetId}`);
    const accept = (origin?: string) =>
      new Request(`${t.app.CONTENT_ORIGIN}/session`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...(origin ? { Origin: origin } : {}) },
        body: JSON.stringify({ ticket: ticket.ticket }),
      });
    expect((await t.http(accept())).status).toBe(403);
    expect((await t.http(accept("https://other.invalid"))).status).toBe(403);
    const preflight = new Request(`${t.app.CONTENT_ORIGIN}/session`, {
      method: "OPTIONS",
      headers: {
        Origin: t.app.APP_ORIGIN,
        "Access-Control-Request-Method": "POST",
        "Access-Control-Request-Headers": "Content-Type",
      },
    });
    const allowed = await t.http(preflight);
    expect(allowed.status).toBe(204);
    expect(allowed.headers.get("Access-Control-Allow-Origin")).toBe(t.app.APP_ORIGIN);
    expect(allowed.headers.get("Access-Control-Allow-Credentials")).toBe("true");
    preflight.headers.set("Access-Control-Request-Headers", "Content-Type,Authorization");
    expect((await t.http(preflight)).status).toBe(403);
    const accepted = await t.http(accept(t.app.APP_ORIGIN));
    expect(accepted.status).toBe(201);
    expect(accepted.headers.get("Access-Control-Allow-Origin")).toBe(t.app.APP_ORIGIN);
    const cookie = accepted.headers.get("Set-Cookie")!;
    expect(cookie).toContain("__Host-");
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("Secure");
    expect(cookie).toContain("Path=/");
    expect(cookie).not.toMatch(/Domain=/i);
    const url = `${t.app.CONTENT_ORIGIN}/c/${t.f.ids.file}/${t.f.ids.blob}`;
    expect((await t.http(new Request(url))).status).toBe(404);
    const headers = { Cookie: cookie.split(";")[0]! };
    const read = await t.http(new Request(url, { headers: { ...headers, Range: "bytes=1-2" } }));
    expect(read.status).toBe(206);
    expect(await read.text()).toBe("bc");
    expect(read.headers.get("Content-Security-Policy")).toBe(
      "default-src 'none'; sandbox; frame-ancestors 'none'",
    );
    expect(read.headers.get("Cache-Control")).toBe("private, no-store");
    expect(read.headers.get("Referrer-Policy")).toBe("no-referrer");
    const head = await t.http(new Request(url, { method: "HEAD", headers }));
    expect(head.status).toBe(200);
    expect(head.body).toBeNull();
    expect(
      (await t.http(new Request(url, { headers: { ...headers, Origin: "https://other.invalid" } })))
        .status,
    ).toBe(403);
    const cookieOnly = t.request("");
    cookieOnly.headers.set("Cookie", headers.Cookie);
    expect((await t.http(cookieOnly)).status).toBe(401);
    const cancelled = await t.http(
      t.request(`/tickets/${ticket.ticketId}`, "DELETE", undefined, t.token),
    );
    expect(cancelled.status).toBe(204);
    expect((await t.http(new Request(url, { headers }))).status).toBe(404);
  },
);

it("retains the control and D1 maintenance gate for both single-host surfaces", async () => {
  const t = await fixture(true);
  await env.DB.prepare("UPDATE control SET maintenance=1").run();
  for (const path of [
    "/api/v1/me",
    `/api/v1/public/shares/${t.share.id}`,
    "/files",
    "/c/a/b",
    "/session",
    "/dav",
  ]) {
    expect((await t.http(new Request(t.app.APP_ORIGIN + path))).status, path).toBe(503);
  }
  // The generic public landing does not depend on admission or reveal protected data.
  expect((await t.http(new Request(`${t.app.APP_ORIGIN}/s/${t.share.id}`))).status).toBe(200);
});
