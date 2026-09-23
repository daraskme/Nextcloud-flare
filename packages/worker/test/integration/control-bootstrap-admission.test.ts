import { applyD1Migrations } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { base64url, exportJWK, generateKeyPair, SignJWT } from "jose";
import { expect, it } from "vitest";
import { CONTROL_NAME } from "../../src/do/ControlDO";
import { EPOCH_PREFIX } from "../../src/do/epochHistory";
import type { Env } from "../../src/env";
import worker from "../../src/index";

it("audits a pristine installation, admits only authenticated bootstrap, then stops and audits the real account", async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
  await env.BACKUPS.put(
    `${EPOCH_PREFIX}1.json`,
    JSON.stringify({ epoch: 1, at: 1, reason: "operator" }),
  );
  const control = env.CONTROL.get(env.CONTROL.idFromName(CONTROL_NAME));
  const { epoch } = await control.recover();
  const issuer = "https://admission-access.invalid";
  const { publicKey, privateKey } = await generateKeyPair("RS256", { extractable: true });
  await env.CACHE.put(
    `access-jwks:v1:${issuer}`,
    JSON.stringify({
      version: 1,
      issuer,
      fetchedAt: Date.now(),
      jwks: {
        keys: [{ ...(await exportJWK(publicKey)), kid: "admission", alg: "RS256", use: "sig" }],
      },
    }),
  );
  const keys = JSON.stringify({
    test: base64url.encode(crypto.getRandomValues(new Uint8Array(32))),
  });
  const appEnv: Env = {
    ...env,
    APP_ORIGIN: "https://app.invalid",
    CONTENT_ORIGIN: "https://content.invalid",
    ACCESS_ISSUER: issuer,
    ACCESS_USER_AUDIENCE: "user",
    ACCESS_SERVICE_AUDIENCE: "service",
    CSRF_PRIVATE_ACTIVE_KID: "test",
    CSRF_PUBLIC_ACTIVE_KID: "test",
    CSRF_PRIVATE_KEYS: keys,
    CSRF_PUBLIC_KEYS: keys,
    CONTENT_TICKET_ACTIVE_KID: "test",
    CONTENT_COOKIE_ACTIVE_KID: "test",
    CONTENT_TICKET_KEYS: keys,
    CONTENT_COOKIE_KEYS: keys,
    BOOTSTRAP_OWNER_EMAILS: JSON.stringify(["owner@example.invalid"]),
    BOOTSTRAP_OWNER_IDENTITIES: "[]",
    BOOTSTRAP_QUOTA_BYTES: "1000000",
  };
  const token = (email: string) =>
    new SignJWT({ email, type: "app" })
      .setProtectedHeader({ kid: "admission", alg: "RS256", typ: "JWT" })
      .setIssuer(issuer)
      .setSubject(email)
      .setAudience("user")
      .setIssuedAt()
      .setNotBefore(Math.floor(Date.now() / 1000) - 1)
      .setExpirationTime("10m")
      .sign(privateKey);
  const me = (jwt?: string) =>
    worker.fetch(
      new Request(`${appEnv.APP_ORIGIN}/api/v1/me`, {
        headers: jwt ? { "Cf-Access-Jwt-Assertion": jwt } : {},
      }),
      appEnv,
    );
  const audit = async () => {
    await control.beginRecoveryAudit(epoch);
    for (let i = 0; i < 20; i++)
      if ((await control.nextRecoveryAuditPage(epoch, 20)).completed) return;
    throw new Error("audit_did_not_finish");
  };
  const owner = await token("owner@example.invalid");
  expect((await me(owner)).status).toBe(503);
  await audit();
  await control.resumeAdmission(epoch);
  expect((await me()).status).toBe(401);
  expect((await me(await token("unlisted@example.invalid"))).status).toBe(403);
  const registered = await me(owner);
  expect(registered.status).toBe(200);
  const account = await registered.json<{ id: string; rootNodeId: string; role: string }>();
  expect(account.role).toBe("app_admin");
  expect(
    await env.DB.prepare("SELECT bootstrap_done_at FROM control").first("bootstrap_done_at"),
  ).not.toBeNull();
  expect(
    await env.DB.prepare("SELECT owner_id FROM nodes WHERE id=? AND kind='root'")
      .bind(account.rootNodeId)
      .first("owner_id"),
  ).toBe(account.id);
  await control.quiesce(epoch);
  expect((await me(owner)).status).toBe(503);
  await audit();
  await control.resumeAdmission(epoch);
  expect((await me(owner)).status).toBe(200);
  expect(await control.resumeGarbageCollection(epoch)).toEqual({
    epoch,
    maintenance: false,
    gcPaused: false,
  });
});
