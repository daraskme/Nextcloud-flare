// Local browser-test entry only. Never imported by src/index.ts or the deployed bundle.
import { base64url, exportJWK, generateKeyPair, SignJWT } from "jose";
import { atomicBatch } from "../../src/db/primary";
import { CONTROL_NAME } from "../../src/do/ControlDO";
import type { Env } from "../../src/env";
import worker from "../../src/index";
import { executeCopyJob } from "../../src/jobs/copyExecutor";
import { consumeCopyOutbox } from "../../src/jobs/copyQueue";
import { handleDeadLetterBatch } from "../../src/jobs/deadLetters";
import { dispatchOutbox } from "../../src/jobs/outbox";
import { handleOutboxBatch } from "../../src/jobs/queue";
import { foundationFixture } from "../fixtures/foundation";
import { audioLibraryFixture } from "./audioLibrary";
import { legacyAudioFixture } from "./legacyAudio";

export { BudgetDO, ControlDO, LockDO, UploadDO } from "../../src/index";

function recipientRequest(request: Request) {
  return (
    request.headers.get("X-Test-Access-Identity") === "recipient" ||
    (request.headers.get("Cookie") ?? "")
      .split(";")
      .some((item) => item.trim() === "ncf-test-user=recipient")
  );
}

type TestIdentity = "owner" | "recipient";
let initialized:
  | Promise<{
      env: Env;
      token: string;
      recipientToken: string;
      login: (identity?: TestIdentity) => Promise<string>;
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
    SHARE_COOKIE_ACTIVE_KID: "browser",
    SHARE_COOKIE_KEYS: keys(),
    SHARE_PASSWORD_ACTIVE_KID: "browser",
    SHARE_PASSWORD_KEYS: keys(),
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
  const startedAt = Math.floor(Date.now() / 1000);
  let loginSequence = 0;
  // A fresh Access login has a different fingerprint. Keep revoked sessions revoked.
  const login = (identity: TestIdentity = "owner") =>
    new SignJWT({
      type: "app",
      email: identity === "owner" ? "local@example.invalid" : "recipient@example.invalid",
    })
      .setProtectedHeader({ alg: "RS256", typ: "JWT", kid: "browser" })
      .setIssuer(env.ACCESS_ISSUER!)
      .setSubject(identity === "owner" ? "local-browser-owner" : "local-browser-recipient")
      .setAudience(env.ACCESS_USER_AUDIENCE!)
      .setIssuedAt(startedAt - loginSequence++)
      .setNotBefore(startedAt - 1)
      .setExpirationTime(startedAt + 3600)
      .sign(pair.privateKey);
  const token = await login();
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
  const recipient = foundationFixture("browser-share-recipient", Date.now() - 1000);
  await atomicBatch(env.DB, [
    ...recipient.statements,
    {
      sql: "UPDATE users SET email='recipient@example.invalid',role='member',access_iss=?,access_sub='local-browser-recipient' WHERE id=?",
      values: [env.ACCESS_ISSUER!, recipient.ids.user],
    },
  ]);
  return { env, token, recipientToken: await login("recipient"), login };
}

export default {
  async fetch(request: Request, bindings: Env): Promise<Response> {
    const ready = await (initialized ??= initialize(bindings));
    const path = new URL(request.url).pathname;
    if (path === "/__test__/ready") return Response.json({ ready: true });
    if (path === "/__test__/audio-library" && request.method === "POST")
      return Response.json(await audioLibraryFixture(ready.env.DB, await request.json()));
    const legacyAudio = /^\/__test__\/legacy-audio\/([A-Za-z0-9_-]{1,128})$/.exec(path);
    if (legacyAudio && request.method === "POST")
      return Response.json(await legacyAudioFixture(ready.env, legacyAudio[1]!));
    const shareSessions = /^\/__test__\/share-session-count\/([A-Za-z0-9_-]{1,128})$/.exec(path);
    if (shareSessions && request.method === "GET") {
      const count = await ready.env.DB.prepare(
        "SELECT COUNT(*) AS n FROM share_sessions WHERE share_id=?",
      )
        .bind(shareSessions[1])
        .first<number>("n");
      return Response.json({ count });
    }
    const deadLetterNode = /^\/__test__\/dead-letter-node\/([A-Za-z0-9_-]{1,128})$/.exec(path);
    if (deadLetterNode && request.method === "POST") {
      const outbox = await ready.env.DB.prepare(
        "SELECT outbox_id,epoch FROM outbox WHERE payload_ref=? AND kind='node.created' ORDER BY created_at DESC LIMIT 1",
      )
        .bind(deadLetterNode[1])
        .first<{ outbox_id: string; epoch: number }>();
      if (!outbox) return new Response(null, { status: 404 });
      await dispatchOutbox(
        ready.env,
        { send: async () => ({ metadata: { metrics: { backlogCount: 0, backlogBytes: 0 } } }) },
        outbox.outbox_id,
        outbox.epoch,
      );
      await ready.env.DB.prepare("UPDATE outbox SET dispatch_expires_at=0 WHERE outbox_id=?")
        .bind(outbox.outbox_id)
        .run();
      const messageId = crypto.randomUUID();
      const result = await handleDeadLetterBatch(ready.env, {
        messages: [
          {
            id: messageId,
            timestamp: new Date(),
            body: { outboxId: outbox.outbox_id },
            ack: () => {},
            retry: () => {},
          },
        ],
      });
      return Response.json({ ...result, messageId, outboxId: outbox.outbox_id });
    }
    const deadLetterDispatch = /^\/__test__\/dead-letter-dispatch\/([A-Za-z0-9_-]{1,128})$/.exec(
      path,
    );
    if (deadLetterDispatch && request.method === "POST") {
      const id = deadLetterDispatch[1]!;
      const epoch = await ready.env.DB.prepare("SELECT epoch FROM outbox WHERE outbox_id=?")
        .bind(id)
        .first<number>("epoch");
      if (!epoch) return new Response(null, { status: 404 });
      await dispatchOutbox(
        ready.env,
        { send: async () => ({ metadata: { metrics: { backlogCount: 0, backlogBytes: 0 } } }) },
        id,
        epoch,
      );
      const result = await handleOutboxBatch(ready.env, {
        messages: [{ body: { outboxId: id }, ack: () => {}, retry: () => {} }],
      });
      const audits = await ready.env.DB.prepare(
        "SELECT COUNT(*) n FROM activity WHERE kind='admin.dlq' AND affected_id IN (SELECT message_id FROM queue_dead_letters WHERE outbox_id=?)",
      )
        .bind(id)
        .first<number>("n");
      return Response.json({ ...result, audits });
    }
    if (path === "/__test__/dead-letters" && request.method === "POST") {
      let acked = 0,
        retried = 0;
      const ids = Array.from({ length: 52 }, () => crypto.randomUUID());
      for (let offset = 0; offset < ids.length; offset += 10) {
        const messages = ids.slice(offset, offset + 10).map((id, index) => ({
          id,
          timestamp: new Date(1000),
          attempts: 1,
          body:
            (offset + index) % 2
              ? { outboxId: "missing-browser-event" }
              : { privateFileName: "secret-dlq-document.txt" },
          ack: () => {
            acked++;
          },
          retry: () => {
            retried++;
          },
        }));
        await worker.queue(
          {
            queue: ready.env.JOBS_DLQ_NAME!,
            metadata: { metrics: { backlogCount: messages.length, backlogBytes: 0 } },
            messages,
            ackAll: () => {
              acked += messages.length;
            },
            retryAll: () => {
              retried += messages.length;
            },
          },
          ready.env,
        );
      }
      return Response.json({ acked, retried });
    }
    // Explicit local delivery lets browser tests observe pending/partial/terminal
    // states through real HTTP, D1, R2 and DOs without enabling a background cron.
    const copy = /^\/__test__\/copy\/(copy_[a-f0-9]{64})$/.exec(path);
    if (copy && request.method === "POST") {
      const outbox = await ready.env.DB.prepare(
        "SELECT outbox_id,epoch FROM outbox WHERE kind='copy.requested' AND payload_ref=?",
      )
        .bind(copy[1])
        .first<{ outbox_id: string; epoch: number }>();
      if (!outbox) return new Response(null, { status: 404 });
      await dispatchOutbox(
        ready.env,
        {
          send: async () => ({ metadata: { metrics: { backlogCount: 1, backlogBytes: 0 } } }),
        },
        outbox.outbox_id,
        outbox.epoch,
      );
      const steps = new URL(request.url).searchParams.get("steps");
      const result = steps
        ? await executeCopyJob(ready.env, outbox.outbox_id, { maxSteps: Number(steps) })
        : await consumeCopyOutbox(ready.env, outbox.outbox_id, Date.now() + 25_000);
      return Response.json(result);
    }
    if (path === "/__test__/access-login" && request.method === "POST") {
      if (recipientRequest(request)) ready.recipientToken = await ready.login("recipient");
      else ready.token = await ready.login();
      return Response.json({ ready: true });
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
    const anonymous = (headers.get("Cookie") ?? "")
      .split(";")
      .some((item) => item.trim() === "ncf-test-user=anonymous");
    if (!headers.has("X-Test-Without-Auth") && !anonymous)
      headers.set(
        "Cf-Access-Jwt-Assertion",
        recipientRequest(request) ? ready.recipientToken : ready.token,
      );
    return worker.fetch(new Request(request, { headers }), ready.env);
  },
};
