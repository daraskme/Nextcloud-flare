// Local browser-test entry only. Never imported by src/index.ts or the deployed bundle.
import { base64url, exportJWK, generateKeyPair, SignJWT } from "jose";
import { CONTROL_NAME } from "../../src/do/ControlDO";
import type { Env } from "../../src/env";
import worker from "../../src/index";

export { BudgetDO, ControlDO, LockDO, UploadDO } from "../../src/index";

let initialized: Promise<{ env: Env; token: string }> | undefined;
async function initialize(bindings: Env) {
  const keys = () =>
    JSON.stringify({ browser: base64url.encode(crypto.getRandomValues(new Uint8Array(32))) });
  const env: Env = {
    ...bindings,
    ACCESS_ISSUER: "https://browser-access.invalid",
    ACCESS_USER_AUDIENCE: "browser-user",
    ACCESS_SERVICE_AUDIENCE: "browser-service",
    CSRF_PRIVATE_ACTIVE_KID: "browser",
    CSRF_PUBLIC_ACTIVE_KID: "browser",
    CSRF_PRIVATE_KEYS: keys(),
    CSRF_PUBLIC_KEYS: keys(),
    APP_PASSWORD_ACTIVE_KID: "browser",
    APP_PASSWORD_PEPPERS: keys(),
    CONTENT_TICKET_ACTIVE_KID: "browser",
    CONTENT_COOKIE_ACTIVE_KID: "browser",
    CONTENT_TICKET_KEYS: keys(),
    CONTENT_COOKIE_KEYS: keys(),
    NODE_CURSOR_ACTIVE_KID: "browser",
    NODE_CURSOR_KEYS: keys(),
    UPLOAD_CAPABILITY_ACTIVE_KID: "browser",
    UPLOAD_CAPABILITY_KEYS: keys(),
    BOOTSTRAP_OWNER_EMAILS: '["local@example.invalid"]',
    BOOTSTRAP_OWNER_IDENTITIES: "[]",
    BOOTSTRAP_QUOTA_BYTES: "2000000000",
  };
  // DOs receive bindings, not this spread object. Upload keys are fixed in the test-only config.
  env.UPLOAD_CAPABILITY_KEYS = bindings.UPLOAD_CAPABILITY_KEYS!;
  const pair = await generateKeyPair("RS256", { extractable: true });
  await env.CACHE.put(
    `access-jwks:v1:${env.ACCESS_ISSUER}`,
    JSON.stringify({
      version: 1,
      issuer: env.ACCESS_ISSUER,
      fetchedAt: Date.now(),
      jwks: {
        keys: [{ ...(await exportJWK(pair.publicKey)), kid: "browser", alg: "RS256", use: "sig" }],
      },
    }),
  );
  const token = await new SignJWT({ type: "app", email: "local@example.invalid" })
    .setProtectedHeader({ alg: "RS256", typ: "JWT", kid: "browser" })
    .setIssuer(env.ACCESS_ISSUER!)
    .setSubject("local-browser-owner")
    .setAudience(env.ACCESS_USER_AUDIENCE!)
    .setIssuedAt()
    .setNotBefore(Math.floor(Date.now() / 1000) - 1)
    .setExpirationTime("1h")
    .sign(pair.privateKey);
  const control = env.CONTROL.get(env.CONTROL.idFromName(CONTROL_NAME));
  const { epoch } = await control.recover();
  await control.beginRecoveryAudit(epoch);
  let completed = false;
  for (let i = 0; i < 30 && !completed; i++)
    completed = (await control.nextRecoveryAuditPage(epoch, 20)).completed;
  if (!completed) throw new Error("browser_audit_incomplete");
  await control.resumeAdmission(epoch);
  await control.resumeGarbageCollection(epoch);
  // This isolated HTTP fixture starts after the post-recovery KDF cooldown.
  await env.DB.prepare("UPDATE control SET kdf_not_before=0").run();
  const response = await worker.fetch(
    new Request(`${env.APP_ORIGIN}/api/v1/me`, { headers: { "Cf-Access-Jwt-Assertion": token } }),
    env,
  );
  if (!response.ok) throw new Error("browser_bootstrap_failed");
  return { env, token };
}

export default {
  async fetch(request: Request, bindings: Env): Promise<Response> {
    const ready = await (initialized ??= initialize(bindings));
    const path = new URL(request.url).pathname;
    if (path === "/__test__/ready") return Response.json({ ready: true });
    if (path === "/__test__/control" && request.method === "GET") {
      const control = ready.env.CONTROL.get(ready.env.CONTROL.idFromName(CONTROL_NAME));
      return Response.json(await control.status());
    }
    if (path === "/cdn-cgi/access/logout")
      return new Response("ローカルテスト: ログアウトしました", {
        headers: { "Content-Type": "text/plain; charset=utf-8" },
      });
    const headers = new Headers(request.headers);
    if (!headers.has("X-Test-Without-Auth")) headers.set("Cf-Access-Jwt-Assertion", ready.token);
    return worker.fetch(new Request(request, { headers }), ready.env);
  },
};
