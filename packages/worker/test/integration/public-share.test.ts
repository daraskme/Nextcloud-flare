import { applyD1Migrations } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { base64url } from "jose";
import { beforeAll, beforeEach, expect, it } from "vitest";
import type { PublicShareDependencies } from "../../src/api/publicShareConfig";
import { handlePublicShareHttp } from "../../src/api/publicShares";
import { publicAssets } from "../../src/assets/publicManifest";
import { servePublicShare } from "../../src/assets/publicShare";
import { contentKeyRing } from "../../src/auth/contentTokens";
import { CsrfTokens, csrfKeyRing } from "../../src/auth/csrf";
import { NodeCursorTokens } from "../../src/auth/nodeCursor";
import { shareSecretDigest } from "../../src/auth/shareSession";
import { atomicBatch } from "../../src/db/primary";
import { foundationFixture } from "../fixtures/foundation";
import { mutationEnv } from "../fixtures/mutationAdmission";

const origin = "https://app.invalid";
let dependencies: PublicShareDependencies;

beforeAll(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
  const privateSecret = base64url.encode(crypto.getRandomValues(new Uint8Array(32)));
  const publicSecret = base64url.encode(crypto.getRandomValues(new Uint8Array(32)));
  const cursorSecret = base64url.encode(crypto.getRandomValues(new Uint8Array(32)));
  dependencies = {
    csrf: new CsrfTokens(
      await csrfKeyRing("private", { private: privateSecret }),
      await csrfKeyRing("public", { public: publicSecret }),
      origin,
    ),
    cursors: new NodeCursorTokens(await contentKeyRing("cursor", { cursor: cursorSecret })),
  };
});

beforeEach(async () => {
  await env.DB.prepare("UPDATE control SET epoch=1,maintenance=0").run();
});

async function fixture() {
  const now = Date.now() - 1000;
  const owner = foundationFixture(crypto.randomUUID(), now);
  const outside = foundationFixture(crypto.randomUUID(), now);
  const shareId = crypto.randomUUID();
  const secret = base64url.encode(crypto.getRandomValues(new Uint8Array(32)));
  await atomicBatch(env.DB, [
    ...owner.statements,
    ...outside.statements,
    {
      sql: `INSERT INTO shares(
        id,owner_id,root_node_id,kind,secret_digest,expires_at,created_at
      ) VALUES(?,?,?,'link',?,?,?)`,
      values: [
        shareId,
        owner.ids.user,
        owner.ids.folder,
        await shareSecretDigest(secret),
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
    EDGE_LIMITER: { limit: async () => ({ success: true }) } as RateLimit,
  };
}

function unlockRequest(shareId: string, secret: string) {
  return new Request(`${origin}/api/v1/public/shares/${shareId}/unlock`, {
    method: "POST",
    headers: {
      Origin: origin,
      "Sec-Fetch-Site": "same-origin",
      "Content-Type": "application/json",
      "CF-Connecting-IP": "192.0.2.1",
    },
    body: JSON.stringify({ secret }),
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
  const html = await shell.text();
  for (const path of publicAssets) expect(html).toContain(path);
  expect(html).not.toContain("/private-assets/");
  for (const path of publicAssets) {
    const asset = await servePublicShare(new Request(`${origin}${path}`), shareEnv());
    expect(asset.status).toBe(200);
    expect(asset.headers.get("Cache-Control")).toBe("public, max-age=31536000, immutable");
  }
});
