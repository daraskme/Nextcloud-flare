import { applyD1Migrations } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { base64url } from "jose";
import { beforeAll, beforeEach, expect, it } from "vitest";
import { handleAppPasswordHttp } from "../../src/api/appPasswords";
import { privateAppRoute } from "../../src/api/privateApp";
import { appPasswordPepperRing, authenticateAppPassword } from "../../src/auth/appPassword";
import { CsrfTokens, csrfKeyRing } from "../../src/auth/csrf";
import type { AccessSession } from "../../src/auth/sessions";
import { atomicBatch } from "../../src/db/primary";
import { createAppPassword } from "../../src/services/appPasswords";
import { foundationFixture } from "../fixtures/foundation";
import { localKdf } from "../fixtures/kdf";

beforeAll(async () => applyD1Migrations(env.DB, env.TEST_MIGRATIONS));
beforeEach(async () => env.DB.prepare("UPDATE control SET epoch=1,maintenance=0").run());

it("creates, lists, authenticates and revokes a scoped app password through the private API", async () => {
  const f = foundationFixture(crypto.randomUUID(), Date.now() - 1000);
  await atomicBatch(env.DB, f.statements);
  const appEnv = { ...env, APP_ORIGIN: "https://app.invalid" };
  const session: AccessSession = {
    credential_id: f.ids.credential,
    session_id: f.ids.session,
    user_id: f.ids.user,
    role: "app_admin",
    epoch: 1,
    expires_at: Date.now() + 600000,
  };
  const privateKey = base64url.encode(crypto.getRandomValues(new Uint8Array(32)));
  const csrfRing = await csrfKeyRing("v1", { v1: privateKey });
  const csrf = new CsrfTokens(csrfRing, csrfRing, appEnv.APP_ORIGIN);
  const pepper = await appPasswordPepperRing(
    "v1",
    {
      v1: base64url.encode(crypto.getRandomValues(new Uint8Array(32))),
    },
    localKdf,
  );
  const issued = await csrf.issue(
    env.DB,
    new Request("https://app.invalid/api/v1/csrf", {
      method: "POST",
      headers: { "Sec-Fetch-Site": "same-origin" },
    }),
    { kind: "access", credentialId: session.credential_id, epoch: 1 },
  );
  const headers = {
    Origin: appEnv.APP_ORIGIN,
    "Sec-Fetch-Site": "same-origin",
    "Content-Type": "application/json",
    "X-CSRF-Token": issued.token,
  };
  const url = "https://app.invalid/api/v1/app-passwords";
  const body = JSON.stringify({
    name: "DAV client",
    scopes: ["node:read", "node:write"],
    spaceId: f.ids.space,
    rootNodeId: f.ids.folder,
  });
  expect(privateAppRoute(new Request(url, { method: "POST" }))).toBe(true);
  const missingCsrf = await handleAppPasswordHttp(
    new Request(url, { method: "POST", headers: { ...headers, "X-CSRF-Token": "" }, body }),
    appEnv,
    session,
    csrf,
    pepper,
  );
  expect(missingCsrf.status).toBe(403);
  const created = await handleAppPasswordHttp(
    new Request(url, { method: "POST", headers, body }),
    appEnv,
    session,
    csrf,
    pepper,
  );
  expect(created.status).toBe(201);
  expect(created.headers.get("Cache-Control")).toBe("private, no-store");
  const credential = await created.json<{
    id: string;
    credentialId: string;
    secret: string;
    scopes: string[];
  }>();
  expect(credential.id).toMatch(/^ap_[0-9A-HJKMNP-TV-Z]{26}$/);
  expect(credential.scopes).toEqual(["node:read", "node:write"]);
  const listed = await handleAppPasswordHttp(new Request(url), appEnv, session, csrf);
  expect(listed.status).toBe(200);
  const listBody = await listed.text();
  expect(listBody).not.toContain(credential.secret);
  expect(JSON.parse(listBody)).toMatchObject({
    passwords: [{ id: credential.id, credentialId: credential.credentialId }],
  });
  const dav = new Request("https://app.invalid/dav/file", {
    headers: { Authorization: `Basic ${btoa(`${credential.id}:${credential.secret}`)}` },
  });
  expect(await authenticateAppPassword(env.DB, dav, appEnv.APP_ORIGIN, 1, pepper)).toMatchObject({
    credential_id: credential.credentialId,
    user_id: f.ids.user,
  });
  const budgetId = crypto.randomUUID();
  const targetSetId = crypto.randomUUID();
  const ticketId = crypto.randomUUID();
  const contentSessionId = crypto.randomUUID();
  const now = Date.now();
  await atomicBatch(env.DB, [
    {
      sql: "INSERT INTO budgets(id,owner_id,user_id,epoch,expires_at,state) VALUES(?,?,?,1,?,'active')",
      values: [budgetId, f.ids.user, f.ids.user, now + 60000],
    },
    {
      sql: "INSERT INTO target_sets(id,owner_id,credential_id,manifest_hash,manifest_ref,total_bytes,expires_at,epoch) VALUES(?,?,?,'hash','ref',0,?,1)",
      values: [targetSetId, f.ids.user, credential.credentialId, now + 60000],
    },
    {
      sql: "INSERT INTO tickets(id,credential_id,target_set_id,budget_id,purpose,epoch,issued_at,expires_at) VALUES(?,?,?,?,'content',1,?,?)",
      values: [ticketId, credential.credentialId, targetSetId, budgetId, now, now + 60000],
    },
    {
      sql: "INSERT INTO content_sessions(id,user_id,issued_by_credential_id,target_set_id,budget_id,epoch,issued_at,expires_at,ticket_id) VALUES(?,?,?,?,?,1,?,?,?)",
      values: [
        contentSessionId,
        f.ids.user,
        credential.credentialId,
        targetSetId,
        budgetId,
        now,
        now + 60000,
        ticketId,
      ],
    },
  ]);
  const revokeUrl = `${url}/${encodeURIComponent(credential.credentialId)}`;
  expect(privateAppRoute(new Request(revokeUrl, { method: "DELETE" }))).toBe(true);
  for (const body of [
    "{}",
    new ReadableStream<Uint8Array>({ start: (controller) => controller.error(new Error("lost")) }),
  ]) {
    const rejected = await handleAppPasswordHttp(
      new Request(revokeUrl, {
        method: "DELETE",
        headers: { ...headers, "Content-Length": "0" },
        body,
      }),
      appEnv,
      session,
      csrf,
    );
    expect(rejected.status).toBe(400);
    expect(await authenticateAppPassword(env.DB, dav, appEnv.APP_ORIGIN, 1, pepper)).toMatchObject({
      credential_id: credential.credentialId,
    });
  }
  const revoked = await handleAppPasswordHttp(
    new Request(revokeUrl, {
      method: "DELETE",
      headers,
      body: new ReadableStream<Uint8Array>({ start: (controller) => controller.close() }),
    }),
    appEnv,
    session,
    csrf,
  );
  expect(revoked.status).toBe(204);
  expect(
    await env.DB.prepare("SELECT revoked_at FROM content_sessions WHERE id=?")
      .bind(contentSessionId)
      .first<number>("revoked_at"),
  ).not.toBeNull();
  await expect(authenticateAppPassword(env.DB, dav, appEnv.APP_ORIGIN, 1, pepper)).rejects.toThrow(
    "app_password_denied",
  );
  expect(
    (
      await handleAppPasswordHttp(
        new Request(revokeUrl, { method: "DELETE", headers }),
        appEnv,
        session,
        csrf,
      )
    ).status,
  ).toBe(204);
  const after = await handleAppPasswordHttp(new Request(url), appEnv, session, csrf);
  expect(await after.json()).toEqual({ passwords: [] });
});

it("rejects privilege scopes and roots outside the Access user's space", async () => {
  const own = foundationFixture(crypto.randomUUID(), Date.now() - 1000);
  const other = foundationFixture(crypto.randomUUID(), Date.now() - 1000);
  await atomicBatch(env.DB, [...own.statements, ...other.statements]);
  const session: AccessSession = {
    credential_id: own.ids.credential,
    session_id: own.ids.session,
    user_id: own.ids.user,
    role: "app_admin",
    epoch: 1,
    expires_at: Date.now() + 600000,
  };
  const pepper = await appPasswordPepperRing(
    "v1",
    {
      v1: base64url.encode(crypto.getRandomValues(new Uint8Array(32))),
    },
    localKdf,
  );
  await expect(
    createAppPassword(env.DB, session, { name: "admin", scopes: ["admin:user"] }, pepper),
  ).rejects.toThrow("invalid_app_password_request");
  await expect(
    createAppPassword(
      env.DB,
      session,
      {
        name: "outside",
        scopes: ["node:read"],
        spaceId: other.ids.space,
        rootNodeId: other.ids.folder,
      },
      pepper,
    ),
  ).rejects.toThrow("invalid_app_password_root");
  expect(
    await env.DB.prepare("SELECT COUNT(*) FROM app_passwords WHERE user_id=?")
      .bind(own.ids.user)
      .first<number>("COUNT(*)"),
  ).toBe(0);
  const alphabet = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
  const now = Date.now();
  for (let index = 0; index < 20; index++) {
    const id = `ap_${"0".repeat(25)}${alphabet[index]}`;
    await atomicBatch(env.DB, [
      {
        sql: `INSERT INTO app_passwords(id,user_id,name,secret_digest,salt,kdf,kdf_params,kid,created_at,expires_at)
          VALUES(?,?,'existing','digest','salt','PBKDF2-SHA256','{"iterations":100000}','v1',?,?)`,
        values: [id, own.ids.user, now, now + 60000],
      },
      {
        sql: "INSERT INTO credentials(id,kind,app_password_id) VALUES(?,'app_password',?)",
        values: [`ap:${id}`, id],
      },
    ]);
  }
  await expect(
    createAppPassword(env.DB, session, { name: "extra", scopes: ["node:read"] }, pepper),
  ).rejects.toThrow("app_password_limit");
});
