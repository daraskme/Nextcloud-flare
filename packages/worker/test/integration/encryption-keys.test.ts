import { applyD1Migrations } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeAll, expect, it } from "vitest";
import { handleEncryptionKeyHttp } from "../../src/api/encryptionKeys";
import type { AccessSession } from "../../src/auth/sessions";
import { atomicBatch } from "../../src/db/primary";
import type { Env } from "../../src/env";
import { foundationFixture } from "../fixtures/foundation";
import { mutationEnv } from "../fixtures/mutationAdmission";

const ORIGIN = "https://app.invalid";
const encoder = new TextEncoder();
const csrf = { verify: async () => {} };
const deniedCsrf = {
  verify: async () => {
    throw new Error("csrf_denied");
  },
};
const b64 = (bytes: Uint8Array) => {
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x4000)
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x4000));
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
};
async function identity() {
  const rsa = (await crypto.subtle.generateKey(
    {
      name: "RSA-OAEP",
      modulusLength: 3072,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: "SHA-256",
    },
    true,
    ["encrypt", "decrypt"],
  )) as CryptoKeyPair;
  const ed = (await crypto.subtle.generateKey("Ed25519", true, [
    "sign",
    "verify",
  ])) as CryptoKeyPair;
  const rsaSpki = new Uint8Array(
    (await crypto.subtle.exportKey("spki", rsa.publicKey)) as ArrayBuffer,
  );
  const edSpki = new Uint8Array(
    (await crypto.subtle.exportKey("spki", ed.publicKey)) as ArrayBuffer,
  );
  const recipient = {
    spki: b64(rsaSpki),
    fingerprint: b64(new Uint8Array(await crypto.subtle.digest("SHA-256", rsaSpki))),
  };
  const signer = {
    spki: b64(edSpki),
    fingerprint: b64(new Uint8Array(await crypto.subtle.digest("SHA-256", edSpki))),
  };
  return { rsa, ed, recipient, signer };
}
async function setup() {
  const now = Date.now();
  const admin = foundationFixture(crypto.randomUUID(), now - 1000);
  const member = foundationFixture(crypto.randomUUID(), now - 1000);
  await atomicBatch(env.DB, [...admin.statements, ...member.statements]);
  await env.DB.prepare("UPDATE users SET role='member' WHERE id=?").bind(member.ids.user).run();
  await env.DB.prepare(
    "UPDATE control SET epoch=1,maintenance=0,bootstrap_done_at=1 WHERE singleton=1",
  ).run();
  const app = { ...mutationEnv(), APP_ORIGIN: ORIGIN } as Env;
  const session = (f: typeof admin, role: AccessSession["role"]): AccessSession => ({
    credential_id: f.ids.credential,
    session_id: f.ids.session,
    user_id: f.ids.user,
    role,
    epoch: 1,
    expires_at: now + 599000,
  });
  const call = (
    path: string,
    person: AccessSession,
    options: RequestInit = {},
    gate = csrf,
    origin = ORIGIN,
  ) =>
    handleEncryptionKeyHttp(
      new Request(`${origin}/api/v1/encryption${path}`, options),
      app,
      person,
      gate,
    );
  const post = (
    path: string,
    person: AccessSession,
    body: unknown,
    gate = csrf,
    origin = ORIGIN,
    headerOrigin = ORIGIN,
  ) =>
    call(
      path,
      person,
      {
        method: "POST",
        headers: { "Content-Type": "application/json", Origin: headerOrigin },
        body: JSON.stringify(body),
      },
      gate,
      origin,
    );
  return {
    admin,
    member,
    app,
    adminSession: session(admin, "app_admin"),
    memberSession: session(member, "member"),
    call,
    post,
  };
}
async function challenge(
  f: Awaited<ReturnType<typeof setup>>,
  person: AccessSession,
  keys: Awaited<ReturnType<typeof identity>>,
) {
  const response = await f.post("/keys/challenge", person, {
    recipient: keys.recipient,
    signer: keys.signer,
  });
  expect(response.status).toBe(201);
  const result = await response.json<{ id: string; ciphertext: string; expiresAt: number }>();
  const ciphertext = Uint8Array.from(
    atob(result.ciphertext.replaceAll("-", "+").replaceAll("_", "/")),
    (character) => character.charCodeAt(0),
  );
  const secret = new Uint8Array(
    await crypto.subtle.decrypt(
      {
        name: "RSA-OAEP",
        label: encoder.encode(`ncf-key-registration-v1\0${result.id}\0${person.user_id}`),
      },
      keys.rsa.privateKey,
      ciphertext,
    ),
  );
  const encodedSecret = b64(secret);
  const signature = b64(
    new Uint8Array(
      await crypto.subtle.sign(
        "Ed25519",
        keys.ed.privateKey,
        encoder.encode(
          `ncf-encryption-key-register-v1\0${result.id}\0${person.user_id}\0${encodedSecret}\0${keys.recipient.fingerprint}\0${keys.signer.fingerprint}`,
        ),
      ),
    ),
  );
  return { ...result, secret: encodedSecret, signature };
}

beforeAll(async () => applyD1Migrations(env.DB, env.TEST_MIGRATIONS));

it("requires RSA and Ed25519 possession, registers once, then returns an idempotent pinned identity", async () => {
  const f = await setup();
  const keys = await identity();
  const proof = await challenge(f, f.adminSession, keys);
  const body = { challengeId: proof.id, secret: proof.secret, signature: proof.signature };
  expect(
    (await f.post("/keys/register", f.adminSession, { ...body, secret: b64(new Uint8Array(32)) }))
      .status,
  ).toBe(403);
  expect(
    (
      await f.post("/keys/register", f.adminSession, {
        ...body,
        signature: b64(new Uint8Array(64)),
      })
    ).status,
  ).toBe(403);
  const registered = await f.post("/keys/register", f.adminSession, body);
  expect(registered.status).toBe(200);
  expect(await registered.json()).toMatchObject({
    accountId: f.admin.ids.user,
    recipient: keys.recipient,
    signer: keys.signer,
  });
  expect((await f.post("/keys/register", f.adminSession, body)).status).toBe(200);
  expect(
    (
      await f.post("/keys/challenge", f.adminSession, {
        recipient: keys.recipient,
        signer: keys.signer,
      })
    ).status,
  ).toBe(409);
  expect((await f.call(`/keys/${f.admin.ids.user}`, f.adminSession)).status).toBe(200);
  const row = await env.DB.prepare("SELECT COUNT(*) AS n FROM encryption_keys WHERE account_id=?")
    .bind(f.admin.ids.user)
    .first<{ n: number }>();
  expect(row?.n).toBe(1);
}, 30_000);

it("pins challenge to account, live credential, epoch and expiry; enforces origin and CSRF", async () => {
  const f = await setup();
  const keys = await identity();
  expect(
    (
      await f.post(
        "/keys/challenge",
        f.adminSession,
        { recipient: keys.recipient, signer: keys.signer },
        deniedCsrf,
      )
    ).status,
  ).toBe(403);
  expect(
    (
      await f.post(
        "/keys/challenge",
        f.adminSession,
        { recipient: keys.recipient, signer: keys.signer },
        csrf,
        ORIGIN,
        "https://other.invalid",
      )
    ).status,
  ).toBe(403);
  expect(
    (
      await f.post(
        "/keys/challenge",
        f.adminSession,
        { recipient: keys.recipient, signer: keys.signer },
        csrf,
        "https://other.invalid",
      )
    ).status,
  ).toBe(404);
  const proof = await challenge(f, f.adminSession, keys);
  const body = { challengeId: proof.id, secret: proof.secret, signature: proof.signature };
  expect((await f.post("/keys/register", f.memberSession, body)).status).toBe(403);
  expect(
    (
      await f.post(
        "/keys/register",
        { ...f.adminSession, credential_id: f.member.ids.credential },
        body,
      )
    ).status,
  ).toBe(403);
  expect((await f.post("/keys/register", { ...f.adminSession, epoch: 2 }, body)).status).toBe(403);
  await env.DB.prepare("UPDATE encryption_key_challenges SET expires_at=? WHERE id=?")
    .bind(Date.now() - 1, proof.id)
    .run();
  expect((await f.post("/keys/register", f.adminSession, body)).status).toBe(403);
}, 30_000);

it("lists only currently active administrators and prevents a member reading another identity", async () => {
  const f = await setup();
  const adminKeys = await identity();
  const memberKeys = await identity();
  for (const [session, keys] of [
    [f.adminSession, adminKeys],
    [f.memberSession, memberKeys],
  ] as const) {
    const proof = await challenge(f, session, keys);
    expect(
      (
        await f.post("/keys/register", session, {
          challengeId: proof.id,
          secret: proof.secret,
          signature: proof.signature,
        })
      ).status,
    ).toBe(200);
  }
  const list = async () =>
    (
      await (
        await f.call("/admin-keys", f.memberSession)
      ).json<{
        keys: Array<{ accountId: string }>;
      }>()
    ).keys.map((key) => key.accountId);
  expect(await list()).toContain(f.admin.ids.user);
  expect(await list()).not.toContain(f.member.ids.user);
  expect((await f.call(`/keys/${f.admin.ids.user}`, f.memberSession)).status).toBe(403);
  await env.DB.prepare("UPDATE users SET role='member' WHERE id=?").bind(f.admin.ids.user).run();
  expect(await list()).not.toContain(f.admin.ids.user);
  await env.DB.prepare("UPDATE users SET role='app_admin' WHERE id=?").bind(f.admin.ids.user).run();
  await env.DB.prepare("UPDATE users SET disabled_at=? WHERE id=?")
    .bind(Date.now(), f.admin.ids.user)
    .run();
  expect(await list()).not.toContain(f.admin.ids.user);
  await env.DB.prepare("UPDATE users SET disabled_at=NULL WHERE id=?").bind(f.admin.ids.user).run();
  await env.DB.prepare("UPDATE encryption_keys SET revoked_at=? WHERE account_id=?")
    .bind(Date.now(), f.admin.ids.user)
    .run();
  expect(await list()).not.toContain(f.admin.ids.user);
}, 30_000);
