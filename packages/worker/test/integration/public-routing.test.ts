import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";

import type { AuthenticatedUser } from "../../src/auth/httpAuth.js";
import type { Env } from "../../src/env.js";
import { app } from "../../src/index.js";
import { createShare, disableShare } from "../../src/services/shares.js";
import { seedFoundation } from "../helpers/foundation.js";

const user: AuthenticatedUser = {
  email: "user@test.invalid",
  role: "member",
  principal: {
    kind: "user",
    principalId: "user",
    userId: "user",
    sessionId: "session",
    credentialId: "as:session",
    scopes: [],
  },
};

function secret(publicUrl: string | undefined): string {
  if (publicUrl === undefined) throw new Error("share secret missing");
  return publicUrl.slice(publicUrl.indexOf("#") + 1);
}

function publicEnv(): Env {
  const testEnv = Object.create(env) as Env;
  Object.assign(testEnv, {
    DEV_PRINCIPAL_EMAIL: "dev@example.invalid",
    DEV_PRINCIPAL_ID: "dev-user-must-not-be-used",
    ASSETS: {
      fetch: () =>
        Promise.resolve(
          new Response(
            '<!doctype html><html><body><main id="public-share"></main><script src="/public-assets/public-share.js"></script></body></html>',
            { headers: { "Content-Type": "text/html; charset=utf-8" } },
          ),
        ),
    } as unknown as Fetcher,
  });
  return testEnv;
}

beforeEach(async () => {
  await seedFoundation();
  const now = Date.now();
  await env.DB.prepare(
    "INSERT INTO nodes(id,space_id,owner_id,parent_id,name,name_ci,kind,current_blob_id,revision,created_at,updated_at,hidden) VALUES('folder','space','user','root','Shared','shared','folder',NULL,1,?1,?1,0)",
  )
    .bind(now)
    .run();
});

describe("anonymous public share routing", () => {
  it("serves only the public shell and enforces password unlock before metadata", async () => {
    const created = await createShare(env, user, {
      rootNodeId: "folder",
      kind: "link",
      mode: "download",
      password: "required password",
    });
    const bindings = publicEnv();
    const landing = await app.request(
      `http://127.0.0.1/s/${encodeURIComponent(created.id)}`,
      undefined,
      bindings,
    );
    expect(landing.status).toBe(200);
    expect(landing.headers.get("Content-Security-Policy")).toContain("default-src 'none'");
    const shell = await landing.text();
    expect(shell).toContain('id="public-share"');
    expect(shell).not.toContain('id="root"');

    const locked = await app.request(
      `http://127.0.0.1/api/v1/public/shares/${encodeURIComponent(created.id)}`,
      undefined,
      bindings,
    );
    expect(locked.status).toBe(401);

    const missingPassword = await app.request(
      `http://127.0.0.1/api/v1/public/shares/${encodeURIComponent(created.id)}/unlock`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Origin: "https://app.test.invalid",
          "Sec-Fetch-Site": "same-origin",
        },
        body: JSON.stringify({ secret: secret(created.publicUrl) }),
      },
      bindings,
    );
    expect([401, 403]).toContain(missingPassword.status);

    const unlocked = await app.request(
      `http://127.0.0.1/api/v1/public/shares/${encodeURIComponent(created.id)}/unlock`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Origin: "https://app.test.invalid",
          "Sec-Fetch-Site": "same-origin",
        },
        body: JSON.stringify({
          secret: secret(created.publicUrl),
          password: "required password",
        }),
      },
      bindings,
    );
    expect(unlocked.status).toBe(200);
    const cookie = unlocked.headers.get("Set-Cookie")?.split(";", 1)[0] ?? "";
    const metadata = await app.request(
      `http://127.0.0.1/api/v1/public/shares/${encodeURIComponent(created.id)}`,
      { headers: { Cookie: cookie } },
      bindings,
    );
    expect(metadata.status).toBe(200);
    await expect(metadata.json()).resolves.toMatchObject({
      id: created.id,
      mode: "download",
      root: { id: "folder", name: "Shared" },
    });
  });

  it("returns gone for expired and disabled shares and not-found for unknown shares", async () => {
    const expires = await createShare(env, user, {
      rootNodeId: "folder",
      kind: "link",
      mode: "view",
      expiresAt: Date.now() + 60_000,
    });
    await env.DB.prepare("UPDATE shares SET expires_at=?1 WHERE id=?2")
      .bind(Date.now() - 1, expires.id)
      .run();
    const disabled = await createShare(env, user, {
      rootNodeId: "folder",
      kind: "link",
      mode: "view",
    });
    await disableShare(env, user, disabled.id);
    const bindings = publicEnv();
    for (const shareId of [expires.id, disabled.id]) {
      const response = await app.request(
        `http://127.0.0.1/api/v1/public/shares/${encodeURIComponent(shareId)}`,
        undefined,
        bindings,
      );
      expect(response.status).toBe(410);
    }
    const missing = await app.request(
      "http://127.0.0.1/api/v1/public/shares/unknown",
      undefined,
      bindings,
    );
    expect(missing.status).toBe(404);
  });
});
