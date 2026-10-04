// Local browser-test entry only. Never imported by src/index.ts or the deployed bundle.
import { base64url, exportJWK, generateKeyPair, SignJWT } from "jose";
import { primary } from "../../src/db/primary";
import { CONTROL_NAME } from "../../src/do/ControlDO";
import type { Env } from "../../src/env";
import worker from "../../src/index";
import { dispatchOutbox } from "../../src/jobs/outbox";

export { BudgetDO, ControlDO, LockDO, UploadDO } from "../../src/index";

const TEST_IDENTITY_COOKIE = "__Host-ncf-test-identity";

function cookieIdentity(cookieHeader: string | null): "owner" | "member" | undefined {
  const value = cookieHeader
    ?.split(";")
    .map((item) => item.trim())
    .find((item) => item.startsWith(`${TEST_IDENTITY_COOKIE}=`))
    ?.slice(TEST_IDENTITY_COOKIE.length + 1);
  return value === "owner" || value === "member" ? value : undefined;
}

let initialized:
  | Promise<{
      env: Env;
      ownerToken: string;
      memberToken: string;
      issueToken: (identity: "owner" | "member") => Promise<string>;
    }>
  | undefined;
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
    SHARE_PASSWORD_ACTIVE_KID: "browser",
    SHARE_PASSWORD_PEPPERS: keys(),
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
  let lastIssuedAt = 0;
  const accessToken = (email: string, subject: string) => {
    const issuedAt = Math.max(Math.floor(Date.now() / 1000), lastIssuedAt + 1);
    lastIssuedAt = issuedAt;
    return new SignJWT({ type: "app", email })
      .setProtectedHeader({ alg: "RS256", typ: "JWT", kid: "browser" })
      .setIssuer(env.ACCESS_ISSUER!)
      .setSubject(subject)
      .setAudience(env.ACCESS_USER_AUDIENCE!)
      .setIssuedAt(issuedAt)
      .setNotBefore(issuedAt - 1)
      .setExpirationTime(issuedAt + 3_600)
      .sign(pair.privateKey);
  };
  const issueToken = (identity: "owner" | "member") =>
    identity === "owner"
      ? accessToken("local@example.invalid", "local-browser-owner")
      : accessToken("browser-member@example.invalid", "local-browser-member");
  const ownerToken = await issueToken("owner");
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
    new Request(`${env.APP_ORIGIN}/api/v1/me`, {
      headers: { "Cf-Access-Jwt-Assertion": ownerToken },
    }),
    env,
  );
  if (!response.ok) throw new Error("browser_bootstrap_failed");
  const issueCsrf = await worker.fetch(
    new Request(`${env.APP_ORIGIN}/api/v1/csrf`, {
      method: "POST",
      headers: {
        "Cf-Access-Jwt-Assertion": ownerToken,
        Origin: env.APP_ORIGIN,
        "Sec-Fetch-Site": "same-origin",
      },
    }),
    env,
  );
  if (!issueCsrf.ok) throw new Error(`browser_admin_csrf_${issueCsrf.status}`);
  const csrf = (await issueCsrf.json<{ token: string }>()).token;
  const invited = await worker.fetch(
    new Request(`${env.APP_ORIGIN}/api/v1/admin/invites`, {
      method: "POST",
      headers: {
        "Cf-Access-Jwt-Assertion": ownerToken,
        "Content-Type": "application/json",
        "X-CSRF-Token": csrf,
        Origin: env.APP_ORIGIN,
        "Sec-Fetch-Site": "same-origin",
      },
      body: JSON.stringify({ email: "browser-member@example.invalid" }),
    }),
    env,
  );
  if (!invited.ok) throw new Error(`browser_member_invite_${invited.status}`);
  const memberToken = await issueToken("member");
  const memberAccount = await worker.fetch(
    new Request(`${env.APP_ORIGIN}/api/v1/me`, {
      headers: { "Cf-Access-Jwt-Assertion": memberToken },
    }),
    env,
  );
  if (!memberAccount.ok) throw new Error(`browser_member_claim_${memberAccount.status}`);
  return { env, ownerToken, memberToken, issueToken };
}

export default {
  async fetch(request: Request, bindings: Env): Promise<Response> {
    const ready = await (initialized ??= initialize(bindings));
    const path = new URL(request.url).pathname;
    if (path === "/__test__/ready") return Response.json({ ready: true });
    if (path === "/__test__/login" && request.method === "POST") {
      if (request.headers.get("X-Test-Without-Auth"))
        return Response.json({ error: "unauthorized" }, { status: 403 });
      const identity = request.headers.get("X-Test-Identity") === "member" ? "member" : "owner";
      const token = await ready.issueToken(identity);
      if (identity === "member") ready.memberToken = token;
      else ready.ownerToken = token;
      return Response.json(
        { authenticated: true },
        {
          headers: {
            "Set-Cookie": `${TEST_IDENTITY_COOKIE}=${identity}; Path=/; Secure; HttpOnly; SameSite=Strict`,
          },
        },
      );
    }
    if (path === "/__test__/process-media" && request.method === "POST") {
      const nodeId = new URL(request.url).searchParams.get("nodeId") ?? "";
      if (!/^[A-Za-z0-9_-]{1,128}$/.test(nodeId))
        return Response.json({ error: "bad_node" }, { status: 400 });
      const control = ready.env.CONTROL.get(ready.env.CONTROL.idFromName(CONTROL_NAME));
      const { epoch } = await control.status();
      let outbox = await primary(ready.env.DB)
        .prepare(`SELECT outbox_id AS id,state FROM outbox
          WHERE payload_ref=? AND kind IN ('node.created','node.updated') ORDER BY created_at DESC LIMIT 1`)
        .bind(nodeId)
        .first<{ id: string; state: string }>();
      if (!outbox) return Response.json({ error: "missing_outbox" }, { status: 404 });
      if (outbox.state !== "completed") {
        await dispatchOutbox(ready.env, ready.env.JOBS, outbox.id, epoch);
        outbox = await primary(ready.env.DB)
          .prepare("SELECT outbox_id AS id,state FROM outbox WHERE outbox_id=?")
          .bind(outbox.id)
          .first<{ id: string; state: string }>();
      }
      if (!outbox) return Response.json({ error: "missing_outbox" }, { status: 404 });
      if (outbox.state === "sent" || outbox.state === "dispatching") {
        let acked = false;
        let retried = false;
        await worker.queue(
          {
            queue: ready.env.JOBS_QUEUE_NAME,
            metadata: { metrics: { backlogCount: 0, backlogBytes: 0 } },
            messages: [
              {
                id: outbox.id,
                timestamp: new Date(),
                attempts: 1,
                body: { outboxId: outbox.id },
                ack: () => {
                  acked = true;
                },
                retry: () => {
                  retried = true;
                },
              },
            ],
            ackAll: () => {
              acked = true;
            },
            retryAll: () => {
              retried = true;
            },
          },
          ready.env,
        );
        const completed = await primary(ready.env.DB)
          .prepare("SELECT state FROM outbox WHERE outbox_id=?")
          .bind(outbox.id)
          .first<{ state: string }>();
        return Response.json({ state: completed?.state ?? outbox.state, acked, retried });
      }
      return Response.json({ state: outbox.state, acked: false, retried: false });
    }
    if (path === "/__test__/control" && request.method === "GET") {
      const control = ready.env.CONTROL.get(ready.env.CONTROL.idFromName(CONTROL_NAME));
      return Response.json(await control.status());
    }
    if (path === "/cdn-cgi/access/logout")
      return new Response("ローカルテスト: ログアウトしました", {
        headers: { "Content-Type": "text/plain; charset=utf-8" },
      });
    const headers = new Headers(request.headers);
    if (!headers.has("X-Test-Without-Auth")) {
      const explicit = headers.get("X-Test-Identity");
      const identity =
        explicit === "member" || explicit === "owner"
          ? explicit
          : (cookieIdentity(headers.get("Cookie")) ?? "owner");
      headers.set(
        "Cf-Access-Jwt-Assertion",
        identity === "member" ? ready.memberToken : ready.ownerToken,
      );
    }
    return worker.fetch(new Request(request, { headers }), ready.env);
  },
};
