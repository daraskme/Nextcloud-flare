import { applyD1Migrations } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { base64url } from "jose";
import { beforeAll, beforeEach, expect, it, vi } from "vitest";
import { handleContentHttp } from "../../src/api/content";
import type { PublicShareDependencies } from "../../src/api/publicShareConfig";
import { handlePublicShareHttp } from "../../src/api/publicShares";
import { publicAssets } from "../../src/assets/publicManifest";
import { servePublicShare } from "../../src/assets/publicShare";
import { ContentTokens, contentKeyRing } from "../../src/auth/contentTokens";
import { CsrfTokens, csrfKeyRing } from "../../src/auth/csrf";
import { KdfUnavailableError } from "../../src/auth/kdf";
import { NodeCursorTokens } from "../../src/auth/nodeCursor";
import {
  hashSharePassword,
  type SharePasswordPepperRing,
  sharePasswordPepperRing,
} from "../../src/auth/sharePassword";
import { shareSecretDigest } from "../../src/auth/shareSession";
import { atomicBatch } from "../../src/db/primary";
import { foundationFixture } from "../fixtures/foundation";
import { localKdf } from "../fixtures/kdf";
import { mutationEnv } from "../fixtures/mutationAdmission";

const origin = "https://app.invalid";
const contentOrigin = "https://content.invalid";
let dependencies: PublicShareDependencies;
let contentTokens: ContentTokens;
let passwordRing: SharePasswordPepperRing;
let passwordPepperKey: string;

beforeAll(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
  const privateSecret = base64url.encode(crypto.getRandomValues(new Uint8Array(32)));
  const publicSecret = base64url.encode(crypto.getRandomValues(new Uint8Array(32)));
  const cursorSecret = base64url.encode(crypto.getRandomValues(new Uint8Array(32)));
  const ticketSecret = base64url.encode(crypto.getRandomValues(new Uint8Array(32)));
  const cookieSecret = base64url.encode(crypto.getRandomValues(new Uint8Array(32)));
  contentTokens = new ContentTokens(
    await contentKeyRing("ticket", { ticket: ticketSecret }),
    await contentKeyRing("cookie", { cookie: cookieSecret }),
    contentOrigin,
  );
  passwordPepperKey = base64url.encode(crypto.getRandomValues(new Uint8Array(32)));
  passwordRing = await sharePasswordPepperRing(
    "password",
    { password: passwordPepperKey },
    localKdf,
  );
  dependencies = {
    csrf: new CsrfTokens(
      await csrfKeyRing("private", { private: privateSecret }),
      await csrfKeyRing("public", { public: publicSecret }),
      origin,
    ),
    cursors: new NodeCursorTokens(await contentKeyRing("cursor", { cursor: cursorSecret })),
    tokens: contentTokens,
    passwordPepper: passwordRing,
  };
});

beforeEach(async () => {
  await env.DB.prepare("UPDATE control SET epoch=1,maintenance=0").run();
});

async function fixture(password?: string, ring = passwordRing) {
  const now = Date.now() - 1000;
  const owner = foundationFixture(crypto.randomUUID(), now);
  const outside = foundationFixture(crypto.randomUUID(), now);
  const shareId = crypto.randomUUID();
  const secret = base64url.encode(crypto.getRandomValues(new Uint8Array(32)));
  const passwordRecord =
    password === undefined ? undefined : await hashSharePassword(password, ring);
  await atomicBatch(env.DB, [
    ...owner.statements,
    ...outside.statements,
    {
      sql: `INSERT INTO shares(
        id,owner_id,root_node_id,kind,secret_digest,password_digest,salt,kdf,kdf_params,kid,
        expires_at,created_at
      ) VALUES(?,?,?,'link',?,?,?,?,?,?,?,?)`,
      values: [
        shareId,
        owner.ids.user,
        owner.ids.folder,
        await shareSecretDigest(secret),
        passwordRecord?.passwordDigest ?? null,
        passwordRecord?.salt ?? null,
        passwordRecord?.kdf ?? null,
        passwordRecord?.kdfParams ?? null,
        passwordRecord?.kid ?? null,
        now + 600_000,
        now,
      ],
    },
    {
      sql: "INSERT INTO share_actions VALUES(?,'read'),(?,'download')",
      values: [shareId, shareId],
    },
  ]);
  return { owner, outside, shareId, secret };
}

function shareEnv() {
  return {
    ...mutationEnv(),
    APP_ORIGIN: origin,
    CONTENT_ORIGIN: contentOrigin,
    EDGE_LIMITER: { limit: async () => ({ success: true }) } as RateLimit,
    SHARE_PASSWORD_LIMITER: { limit: async () => ({ success: true }) } as RateLimit,
    SHARE_PASSWORD_IP_LIMITER: { limit: async () => ({ success: true }) } as RateLimit,
  };
}

function unlockRequest(shareId: string, secret: string, password?: string) {
  return new Request(`${origin}/api/v1/public/shares/${shareId}/unlock`, {
    method: "POST",
    headers: {
      Origin: origin,
      "Sec-Fetch-Site": "same-origin",
      "Content-Type": "application/json",
      "CF-Connecting-IP": "192.0.2.1",
    },
    body: JSON.stringify({ secret, ...(password === undefined ? {} : { password }) }),
  });
}

function sessionRequest(path: string, cookie: string, init: RequestInit = {}) {
  return new Request(`${origin}${path}`, {
    ...init,
    headers: { Cookie: cookie, ...init.headers },
  });
}

it("unlocks a capability into a share-bound cookie and reads only the selected tree", async () => {
  const f = await fixture();
  const wrong = await handlePublicShareHttp(
    unlockRequest(f.shareId, base64url.encode(crypto.getRandomValues(new Uint8Array(32)))),
    shareEnv(),
    1,
    dependencies,
  );
  expect(wrong.status).toBe(404);

  const unlocked = await handlePublicShareHttp(
    unlockRequest(f.shareId, f.secret),
    shareEnv(),
    1,
    dependencies,
  );
  expect(unlocked.status).toBe(200);
  const setCookie = unlocked.headers.get("Set-Cookie") ?? "";
  expect(setCookie).toContain("Secure; HttpOnly; SameSite=Lax");
  const cookie = setCookie.split(";")[0] ?? "";

  const metadata = await handlePublicShareHttp(
    sessionRequest(`/api/v1/public/shares/${f.shareId}`, cookie),
    shareEnv(),
    1,
    dependencies,
  );
  expect(metadata.status).toBe(200);
  expect(await metadata.json()).toMatchObject({
    id: f.shareId,
    contentOrigin,
    root: { id: f.owner.ids.folder, kind: "folder" },
    actions: ["read", "download"],
  });

  const children = await handlePublicShareHttp(
    sessionRequest(`/api/v1/public/shares/${f.shareId}/children/${f.owner.ids.folder}`, cookie),
    shareEnv(),
    1,
    dependencies,
  );
  expect(children.status).toBe(200);
  expect(await children.json()).toMatchObject({
    parentId: f.owner.ids.folder,
    children: [{ id: f.owner.ids.file, name: "File" }],
  });

  for (const nodeId of [f.owner.ids.root, f.outside.ids.folder]) {
    const response = await handlePublicShareHttp(
      sessionRequest(`/api/v1/public/shares/${f.shareId}/children/${nodeId}`, cookie),
      shareEnv(),
      1,
      dependencies,
    );
    expect(response.status).toBe(404);
  }
  const otherShare = await fixture();
  const wrongShare = await handlePublicShareHttp(
    sessionRequest(`/api/v1/public/shares/${otherShare.shareId}`, cookie),
    shareEnv(),
    1,
    dependencies,
  );
  expect(wrongShare.status).toBe(401);
});

it("requires the current password and applies share and IP limits only before password KDF", async () => {
  const password = "correct horse battery staple";
  const f = await fixture(password);
  const shareLimit = vi.fn(async () => ({ success: true }));
  const ipLimit = vi.fn(async () => ({ success: true }));
  const app = {
    ...shareEnv(),
    SHARE_PASSWORD_LIMITER: { limit: shareLimit } as RateLimit,
    SHARE_PASSWORD_IP_LIMITER: { limit: ipLimit } as RateLimit,
  };
  const missing = await handlePublicShareHttp(
    unlockRequest(f.shareId, f.secret),
    app,
    1,
    dependencies,
  );
  expect(missing.status).toBe(401);
  expect((await missing.json()) as { title: string }).toMatchObject({
    title: "password_required",
  });
  expect(shareLimit).not.toHaveBeenCalled();
  expect(ipLimit).not.toHaveBeenCalled();

  const wrong = await handlePublicShareHttp(
    unlockRequest(f.shareId, f.secret, "wrong"),
    app,
    1,
    dependencies,
  );
  expect(wrong.status).toBe(401);
  expect(
    await env.DB.prepare("SELECT COUNT(*) AS count FROM share_sessions WHERE share_id=?")
      .bind(f.shareId)
      .first<number>("count"),
  ).toBe(0);
  expect(shareLimit).toHaveBeenLastCalledWith({ key: f.shareId });
  expect(ipLimit).toHaveBeenLastCalledWith({ key: "192.0.2.1" });

  expect(
    (
      await handlePublicShareHttp(
        unlockRequest(f.shareId, f.secret, "x".repeat(1025)),
        app,
        1,
        dependencies,
      )
    ).status,
  ).toBe(401);
  expect(
    (
      await handlePublicShareHttp(
        unlockRequest(f.shareId, f.secret, "\0".repeat(1024)),
        app,
        1,
        dependencies,
      )
    ).status,
  ).toBe(401);
  const malformed = new Request(`${origin}/api/v1/public/shares/${f.shareId}/unlock`, {
    method: "POST",
    headers: {
      Origin: origin,
      "Sec-Fetch-Site": "same-origin",
      "Content-Type": "application/json",
      "CF-Connecting-IP": "192.0.2.1",
    },
    body: JSON.stringify({ secret: f.secret, password: 1 }),
  });
  expect((await handlePublicShareHttp(malformed, app, 1, dependencies)).status).toBe(400);

  const unlocked = await handlePublicShareHttp(
    unlockRequest(f.shareId, f.secret, password),
    app,
    1,
    dependencies,
  );
  expect(unlocked.status).toBe(200);
  expect(unlocked.headers.get("Set-Cookie")).toContain("HttpOnly");

  const unprotected = await fixture();
  shareLimit.mockClear();
  ipLimit.mockClear();
  expect(
    (
      await handlePublicShareHttp(
        unlockRequest(unprotected.shareId, unprotected.secret),
        app,
        1,
        dependencies,
      )
    ).status,
  ).toBe(200);
  expect(shareLimit).not.toHaveBeenCalled();
  expect(ipLimit).not.toHaveBeenCalled();
});

it("rehashes a verified password under the active pepper before retiring the old key", async () => {
  const password = "rotate this protected share";
  const oldKey = base64url.encode(crypto.getRandomValues(new Uint8Array(32)));
  const newKey = base64url.encode(crypto.getRandomValues(new Uint8Array(32)));
  const creationRing = await sharePasswordPepperRing(
    "old",
    { old: oldKey, current: newKey },
    localKdf,
  );
  const verificationRing = await sharePasswordPepperRing(
    "current",
    { old: oldKey, current: newKey },
    localKdf,
  );
  const f = await fixture(password, creationRing);
  const original = await env.DB.prepare(
    "SELECT password_digest AS digest,kid FROM shares WHERE id=?",
  )
    .bind(f.shareId)
    .first<{ digest: string; kid: string }>();
  expect(original?.kid).toBe("old");

  expect(
    (
      await handlePublicShareHttp(unlockRequest(f.shareId, f.secret, password), shareEnv(), 1, {
        ...dependencies,
        passwordPepper: verificationRing,
      })
    ).status,
  ).toBe(200);
  const migrated = await env.DB.prepare(
    "SELECT password_digest AS digest,kid FROM shares WHERE id=?",
  )
    .bind(f.shareId)
    .first<{ digest: string; kid: string }>();
  expect(migrated?.kid).toBe("current");
  expect(migrated?.digest).not.toBe(original?.digest);

  const currentOnly = await sharePasswordPepperRing("current", { current: newKey }, localKdf);
  expect(
    (
      await handlePublicShareHttp(unlockRequest(f.shareId, f.secret, password), shareEnv(), 1, {
        ...dependencies,
        passwordPepper: currentOnly,
      })
    ).status,
  ).toBe(200);
});

it("returns retryable password rate and KDF failures without creating a session", async () => {
  const password = "rate limited";
  const f = await fixture(password);
  const limited = await handlePublicShareHttp(
    unlockRequest(f.shareId, f.secret, password),
    {
      ...shareEnv(),
      SHARE_PASSWORD_LIMITER: {
        limit: async () => ({ success: false }),
      } as RateLimit,
    },
    1,
    dependencies,
  );
  expect(limited.status).toBe(429);
  expect(limited.headers.get("Retry-After")).toBe("60");
  const ipLimited = await handlePublicShareHttp(
    unlockRequest(f.shareId, f.secret, password),
    {
      ...shareEnv(),
      SHARE_PASSWORD_IP_LIMITER: {
        limit: async () => ({ success: false }),
      } as RateLimit,
    },
    1,
    dependencies,
  );
  expect(ipLimited.status).toBe(429);
  expect(ipLimited.headers.get("Retry-After")).toBe("60");

  const unavailableRing = await sharePasswordPepperRing(
    "password",
    { password: base64url.encode(crypto.getRandomValues(new Uint8Array(32))) },
    async () => {
      throw new KdfUnavailableError();
    },
  );
  const unavailable = await handlePublicShareHttp(
    unlockRequest(f.shareId, f.secret, password),
    shareEnv(),
    1,
    { ...dependencies, passwordPepper: unavailableRing },
  );
  expect(unavailable.status).toBe(503);
  expect(unavailable.headers.get("Retry-After")).toBe("1");
  const missingKeyRing = await sharePasswordPepperRing(
    "other",
    { other: base64url.encode(crypto.getRandomValues(new Uint8Array(32))) },
    localKdf,
  );
  const missingKey = await handlePublicShareHttp(
    unlockRequest(f.shareId, f.secret, password),
    shareEnv(),
    1,
    { ...dependencies, passwordPepper: missingKeyRing },
  );
  expect(missingKey.status).toBe(503);
  expect(missingKey.headers.get("Retry-After")).toBe("1");
  expect(
    await env.DB.prepare("SELECT COUNT(*) AS count FROM share_sessions WHERE share_id=?")
      .bind(f.shareId)
      .first<number>("count"),
  ).toBe(0);
});

it("rejects disabled, expired, stale-epoch, version-changed, and password-changed unlocks", async () => {
  const password = "current password";
  const disabled = await fixture(password);
  await env.DB.prepare("UPDATE shares SET disabled_at=? WHERE id=?")
    .bind(Date.now(), disabled.shareId)
    .run();
  expect(
    (
      await handlePublicShareHttp(
        unlockRequest(disabled.shareId, disabled.secret, password),
        shareEnv(),
        1,
        dependencies,
      )
    ).status,
  ).toBe(404);

  const expired = await fixture(password);
  await env.DB.prepare("UPDATE shares SET expires_at=? WHERE id=?")
    .bind(Date.now() - 1, expired.shareId)
    .run();
  expect(
    (
      await handlePublicShareHttp(
        unlockRequest(expired.shareId, expired.secret, password),
        shareEnv(),
        1,
        dependencies,
      )
    ).status,
  ).toBe(404);

  const staleEpoch = await fixture(password);
  await env.DB.prepare("UPDATE control SET epoch=2").run();
  expect(
    (
      await handlePublicShareHttp(
        unlockRequest(staleEpoch.shareId, staleEpoch.secret, password),
        shareEnv(),
        1,
        dependencies,
      )
    ).status,
  ).toBe(404);
  await env.DB.prepare("UPDATE control SET epoch=1").run();

  const changed = await fixture(password);
  const racingRing = await sharePasswordPepperRing(
    "password",
    { password: passwordPepperKey },
    async (input, salt) => {
      const result = await localKdf(input, salt);
      await env.DB.prepare("UPDATE shares SET password_digest=? WHERE id=?")
        .bind(base64url.encode(crypto.getRandomValues(new Uint8Array(32))), changed.shareId)
        .run();
      return result;
    },
  );
  expect(
    (
      await handlePublicShareHttp(
        unlockRequest(changed.shareId, changed.secret, password),
        shareEnv(),
        1,
        { ...dependencies, passwordPepper: racingRing },
      )
    ).status,
  ).toBe(404);
  expect(
    await env.DB.prepare("SELECT COUNT(*) AS count FROM share_sessions WHERE share_id=?")
      .bind(changed.shareId)
      .first<number>("count"),
  ).toBe(0);

  const changedVersion = await fixture(password);
  const versionRacingRing = await sharePasswordPepperRing(
    "password",
    { password: passwordPepperKey },
    async (input, salt) => {
      const result = await localKdf(input, salt);
      await env.DB.prepare("UPDATE shares SET version=version+1 WHERE id=?")
        .bind(changedVersion.shareId)
        .run();
      return result;
    },
  );
  expect(
    (
      await handlePublicShareHttp(
        unlockRequest(changedVersion.shareId, changedVersion.secret, password),
        shareEnv(),
        1,
        { ...dependencies, passwordPepper: versionRacingRing },
      )
    ).status,
  ).toBe(404);
  expect(
    await env.DB.prepare("SELECT COUNT(*) AS count FROM share_sessions WHERE share_id=?")
      .bind(changedVersion.shareId)
      .first<number>("count"),
  ).toBe(0);
});

it("issues, redeems, reuses, and cancels budgeted public content tickets", async () => {
  const password = "download password";
  const f = await fixture(password);
  const key = `u/${f.owner.ids.user}/b/${f.owner.ids.blob}`;
  const stored = await env.BLOBS.put(key, "abc");
  if (!stored) throw new Error("fixture_blob_missing");
  await env.DB.prepare(
    "INSERT INTO blob_storage(blob_id,bytes,r2_etag,observed_at) VALUES(?,3,?,?)",
  )
    .bind(f.owner.ids.blob, stored.etag, Date.now())
    .run();
  try {
    const unlocked = await handlePublicShareHttp(
      unlockRequest(f.shareId, f.secret, password),
      shareEnv(),
      1,
      dependencies,
    );
    const shareCookie = (unlocked.headers.get("Set-Cookie") ?? "").split(";")[0] ?? "";
    const csrfResponse = await handlePublicShareHttp(
      sessionRequest(`/api/v1/public/shares/${f.shareId}/csrf`, shareCookie, {
        method: "POST",
        headers: { Origin: origin, "Sec-Fetch-Site": "same-origin" },
      }),
      shareEnv(),
      1,
      dependencies,
    );
    const { token } = (await csrfResponse.json()) as { token: string };
    const issue = (path: string, nodeId = f.owner.ids.file) =>
      handlePublicShareHttp(
        sessionRequest(path, shareCookie, {
          method: "POST",
          headers: {
            Origin: origin,
            "Sec-Fetch-Site": "same-origin",
            "Content-Type": "application/json",
            "X-CSRF-Token": token,
          },
          body: JSON.stringify({
            targets: [{ spaceId: f.owner.ids.space, nodeId }],
            purpose: "content",
            ttlSeconds: 300,
          }),
        }),
        shareEnv(),
        1,
        dependencies,
      );

    const first = await issue(`/api/v1/public/shares/${f.shareId}/tickets`);
    expect(first.status).toBe(201);
    const issued = (await first.json()) as {
      ticket: string;
      ticketId: string;
      budgetId: string;
    };
    const renewed = await issue(`/api/v1/public/shares/${f.shareId}/content-session`);
    expect(renewed.status).toBe(201);
    expect(((await renewed.json()) as { budgetId: string }).budgetId).toBe(issued.budgetId);
    expect(
      (await issue(`/api/v1/public/shares/${f.shareId}/tickets`, f.outside.ids.file)).status,
    ).toBe(404);

    const accepted = await handleContentHttp(
      new Request(`${contentOrigin}/session`, {
        method: "POST",
        headers: { Origin: origin, "Content-Type": "application/json" },
        body: JSON.stringify({ ticket: issued.ticket }),
      }),
      shareEnv(),
      contentTokens,
    );
    expect(accepted.status).toBe(201);
    const contentCookie = (accepted.headers.get("Set-Cookie") ?? "").split(";")[0] ?? "";
    const contentPath = `/c/${f.owner.ids.file}/${f.owner.ids.blob}`;
    const downloaded = await handleContentHttp(
      new Request(`${contentOrigin}${contentPath}`, {
        headers: { Cookie: contentCookie },
      }),
      shareEnv(),
      contentTokens,
    );
    expect(downloaded.status).toBe(200);
    expect(new TextDecoder().decode(await downloaded.arrayBuffer())).toBe("abc");

    const cancelled = await handlePublicShareHttp(
      sessionRequest(`/api/v1/public/shares/${f.shareId}/tickets/${issued.ticketId}`, shareCookie, {
        method: "DELETE",
        headers: {
          Origin: origin,
          "Sec-Fetch-Site": "same-origin",
          "Content-Type": "application/json",
          "X-CSRF-Token": token,
        },
      }),
      shareEnv(),
      1,
      dependencies,
    );
    expect(cancelled.status).toBe(204);
    expect(
      (
        await handleContentHttp(
          new Request(`${contentOrigin}${contentPath}`, {
            headers: { Cookie: contentCookie },
          }),
          shareEnv(),
          contentTokens,
        )
      ).status,
    ).toBe(404);
  } finally {
    await env.BLOBS.delete(key);
  }
});

it("requires current share/session state and revokes through public CSRF logout", async () => {
  const f = await fixture();
  const unlocked = await handlePublicShareHttp(
    unlockRequest(f.shareId, f.secret),
    shareEnv(),
    1,
    dependencies,
  );
  const cookie = (unlocked.headers.get("Set-Cookie") ?? "").split(";")[0] ?? "";
  const csrf = await handlePublicShareHttp(
    sessionRequest(`/api/v1/public/shares/${f.shareId}/csrf`, cookie, {
      method: "POST",
      headers: { Origin: origin, "Sec-Fetch-Site": "same-origin" },
    }),
    shareEnv(),
    1,
    dependencies,
  );
  expect(csrf.status).toBe(200);
  const { token } = (await csrf.json()) as { token: string };
  const logout = await handlePublicShareHttp(
    sessionRequest(`/api/v1/public/shares/${f.shareId}/logout`, cookie, {
      method: "POST",
      headers: {
        Origin: origin,
        "Sec-Fetch-Site": "same-origin",
        "Content-Type": "application/json",
        "X-CSRF-Token": token,
      },
      body: "{}",
    }),
    shareEnv(),
    1,
    dependencies,
  );
  expect(logout.status).toBe(204);
  expect(logout.headers.get("Set-Cookie")).toContain("Max-Age=0");
  expect(
    (
      await handlePublicShareHttp(
        sessionRequest(`/api/v1/public/shares/${f.shareId}`, cookie),
        shareEnv(),
        1,
        dependencies,
      )
    ).status,
  ).toBe(401);

  const second = await handlePublicShareHttp(
    unlockRequest(f.shareId, f.secret),
    shareEnv(),
    1,
    dependencies,
  );
  const currentCookie = (second.headers.get("Set-Cookie") ?? "").split(";")[0] ?? "";
  await env.DB.prepare("UPDATE shares SET version=version+1 WHERE id=?").bind(f.shareId).run();
  expect(
    (
      await handlePublicShareHttp(
        sessionRequest(`/api/v1/public/shares/${f.shareId}`, currentCookie),
        shareEnv(),
        1,
        dependencies,
      )
    ).status,
  ).toBe(401);
  await env.DB.prepare("UPDATE control SET epoch=2").run();
  expect(
    (
      await handlePublicShareHttp(
        sessionRequest(`/api/v1/public/shares/${f.shareId}`, currentCookie),
        shareEnv(),
        1,
        dependencies,
      )
    ).status,
  ).toBe(401);
});

it("serves an isolated no-store shell and immutable hashed public assets", async () => {
  const shell = await servePublicShare(
    new Request(`${origin}/s/${crypto.randomUUID()}`),
    shareEnv(),
  );
  expect(shell.status).toBe(200);
  expect(shell.headers.get("Cache-Control")).toBe("public, no-store");
  expect(shell.headers.get("Content-Security-Policy")).toContain(
    `connect-src 'self' ${contentOrigin}`,
  );
  const html = await shell.text();
  for (const path of publicAssets) expect(html).toContain(path);
  expect(html).not.toContain("/private-assets/");
  for (const path of publicAssets) {
    const asset = await servePublicShare(new Request(`${origin}${path}`), shareEnv());
    expect(asset.status).toBe(200);
    expect(asset.headers.get("Cache-Control")).toBe("public, max-age=31536000, immutable");
  }
});
