import { applyD1Migrations } from "cloudflare:test";
import { env } from "cloudflare:workers";
import {
  adminReceiptPayload,
  encryptionHeaderHash,
  legacyAdoptionPayload,
} from "@next-cloud-flare/shared/encryptionAttestation";
import {
  encodeSignedBase64,
  signedContainerFingerprint,
} from "@next-cloud-flare/shared/signedContainer";
import { beforeAll, beforeEach, expect, it } from "vitest";
import { handleEncryptionAttestationHttp } from "../../src/api/encryptionAttestations";
import type { AccessSession } from "../../src/auth/sessions";
import { atomicBatch } from "../../src/db/primary";
import { readBlobEncryption } from "../../src/services/encryptionMarker";
import { foundationFixture } from "../fixtures/foundation";
import { mutationEnv } from "../fixtures/mutationAdmission";

beforeAll(() => applyD1Migrations(env.DB, env.TEST_MIGRATIONS));
beforeEach(async () => {
  await env.DB.prepare("UPDATE control SET epoch=1,maintenance=0,bootstrap_done_at=1").run();
});

async function fixture() {
  const f = foundationFixture(crypto.randomUUID(), Date.now() - 1000);
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
  const ed = (await crypto.subtle.generateKey({ name: "Ed25519" }, true, [
    "sign",
    "verify",
  ])) as CryptoKeyPair;
  const rsaBytes = new Uint8Array(
    (await crypto.subtle.exportKey("spki", rsa.publicKey)) as ArrayBuffer,
  );
  const edBytes = new Uint8Array(
    (await crypto.subtle.exportKey("spki", ed.publicKey)) as ArrayBuffer,
  );
  const rsaFingerprint = await signedContainerFingerprint(rsaBytes);
  const signingFingerprint = await signedContainerFingerprint(edBytes);
  const cryptoId = encodeSignedBase64(crypto.getRandomValues(new Uint8Array(16)));
  // Deliberately structurally valid, unusable wrap: only an administrator attestation may
  // change pending status; owner authentication alone cannot prove RSA decryption works.
  const headerJson = JSON.stringify({
    version: 1,
    envelope: {
      version: 1,
      cryptoId,
      plainSize: 3,
      chunkBytes: 4 * 1024 * 1024,
      cipherSize: 31,
      recipients: [
        { fingerprint: rsaFingerprint, wrappedKey: encodeSignedBase64(new Uint8Array(384)) },
      ],
    },
    encryptedMetadata: {
      iv: encodeSignedBase64(new Uint8Array(12)),
      data: encodeSignedBase64(new Uint8Array(16)),
    },
  });
  const json = new TextEncoder().encode(headerJson);
  const header = new Uint8Array(12 + json.length);
  header.set([78, 67, 70, 69, 78, 67, 49, 0]);
  new DataView(header.buffer).setUint32(8, json.length, false);
  header.set(json, 12);
  const bytes = new Uint8Array(header.length + 31);
  bytes.set(header);
  const r2Key = `u/${f.ids.user}/b/${f.ids.blob}`;
  await atomicBatch(
    env.DB,
    f.statements.map((statement) => ({
      ...statement,
      sql: statement.sql.startsWith("INSERT INTO blobs")
        ? statement.sql.replace(",3,?,'committed'", `,${bytes.length},?,'committed'`)
        : statement.sql,
    })),
  );
  const object = await env.BLOBS.put(r2Key, bytes);
  await env.DB.prepare("UPDATE blobs SET r2_etag=? WHERE id=?")
    .bind(object!.etag, f.ids.blob)
    .run();
  await env.DB.prepare(
    "INSERT INTO blob_storage(blob_id,bytes,r2_etag,observed_at) VALUES(?,?,?,1)",
  )
    .bind(f.ids.blob, bytes.length, object!.etag)
    .run();
  await env.DB.prepare(`INSERT INTO encryption_keys(account_id,rsa_fingerprint,rsa_spki,signing_fingerprint,signing_spki,registered_at)
    VALUES(?,?,?,?,?,1)`)
    .bind(
      f.ids.user,
      rsaFingerprint,
      encodeSignedBase64(rsaBytes),
      signingFingerprint,
      encodeSignedBase64(edBytes),
    )
    .run();
  const session: AccessSession = {
    user_id: f.ids.user,
    credential_id: f.ids.credential,
    session_id: f.ids.session,
    role: "app_admin",
    epoch: 1,
    expires_at: Date.now() + 600000,
  };
  const app = { ...mutationEnv(), APP_ORIGIN: "https://app.invalid" };
  const sign = async (payload: Uint8Array<ArrayBuffer>) =>
    encodeSignedBase64(
      new Uint8Array(await crypto.subtle.sign({ name: "Ed25519" }, ed.privateKey, payload)),
    );
  const headerSha256 = await encryptionHeaderHash(header);
  const statement = {
    ownerId: f.ids.user,
    nodeId: f.ids.file,
    blobId: f.ids.blob,
    revision: 1,
    headerSha256,
    cryptoId,
    requiredAdminFingerprint: rsaFingerprint,
  };
  const input = {
    blobId: f.ids.blob,
    revision: 1,
    headerSha256,
    ownerSignature: await sign(legacyAdoptionPayload(statement)),
    requiredAdminFingerprint: rsaFingerprint,
  };
  const call = (path: string, value: unknown, actor = session, origin = app.APP_ORIGIN) =>
    handleEncryptionAttestationHttp(
      new Request(app.APP_ORIGIN + path, {
        method: "POST",
        headers: { Origin: origin, "Content-Type": "application/json" },
        body: JSON.stringify(value),
      }),
      app,
      actor,
      { verify: async () => {} },
    );
  const adopt = (value = input, actor = session) =>
    call(`/api/v1/encryption/nodes/${f.ids.file}/adopt`, value, actor);
  const receiptInput = async () => ({
    headerSha256,
    signature: await sign(
      adminReceiptPayload({
        ownerId: f.ids.user,
        blobId: f.ids.blob,
        headerSha256,
        cryptoId,
        adminAccountId: f.ids.user,
        adminFingerprint: rsaFingerprint,
      }),
    ),
  });
  return {
    f,
    app,
    session,
    sign,
    input,
    statement,
    r2Key,
    bytes,
    header,
    call,
    adopt,
    receiptInput,
  };
}

it("binds an approved legacy header to its immutable blob and keeps administrator recovery pending", async () => {
  const f = await fixture();
  const result = await f.adopt();
  expect(result.status).toBe(200);
  expect(await result.json()).toMatchObject({
    encryption: {
      formatVersion: 1,
      legacyAttestation: true,
      ownerSignature: f.input.ownerSignature,
      attestedNodeId: f.f.ids.file,
      attestedRevision: 1,
      adminReceiptState: "pending",
    },
  });
  expect((await f.adopt()).status).toBe(200);
  expect((await readBlobEncryption(env.DB, f.f.ids.blob))?.adminReceiptState).toBe("pending");
  expect(new Uint8Array(await (await env.BLOBS.get(f.r2Key))!.arrayBuffer())).toEqual(f.bytes);
});

it("rejects forged signatures, stale node revisions, mismatched headers, and unregistered administrator wraps", async () => {
  const f = await fixture();
  for (const value of [
    { ...f.input, ownerSignature: encodeSignedBase64(new Uint8Array(64)) },
    { ...f.input, headerSha256: "a".repeat(64) },
    { ...f.input, revision: 2 },
    { ...f.input, requiredAdminFingerprint: encodeSignedBase64(new Uint8Array(32)) },
  ])
    expect((await f.adopt(value)).status).toBe(400);
  expect(await readBlobEncryption(env.DB, f.f.ids.blob)).toBeNull();
});

it("does not accept another live administrator as the owner's legacy signer", async () => {
  const f = await fixture(),
    other = await fixture();
  expect((await f.adopt(f.input, other.session)).status).toBe(400);
  expect(await readBlobEncryption(env.DB, f.f.ids.blob)).toBeNull();
});

it("checks actual R2 bytes and refuses sharing through an ancestor", async () => {
  const f = await fixture();
  const changedBody = new Uint8Array(f.bytes);
  changedBody[changedBody.length - 1] = 1;
  await env.BLOBS.put(f.r2Key, changedBody);
  expect((await f.adopt()).status).toBe(400);
  await env.BLOBS.put(f.r2Key, new Uint8Array(f.bytes.length));
  expect((await f.adopt()).status).toBe(400);
  await env.BLOBS.put(f.r2Key, f.bytes);
  await env.DB.prepare(
    "INSERT INTO shares(id,owner_id,root_node_id,kind,created_at) VALUES(?,?,?,'link',1)",
  )
    .bind(crypto.randomUUID(), f.f.ids.user, f.f.ids.folder)
    .run();
  expect((await f.adopt()).status).toBe(503);
  expect(await readBlobEncryption(env.DB, f.f.ids.blob)).toBeNull();
});

it("records only the required current administrator's signed receipt and rejects header substitution", async () => {
  const f = await fixture();
  expect((await f.adopt()).status).toBe(200);
  const path = `/api/v1/encryption/blobs/${f.f.ids.blob}/admin-receipt`;
  const value = await f.receiptInput();
  expect((await f.call(path, { ...value, headerSha256: "0".repeat(64) })).status).toBe(400);
  expect(
    (await f.call(path, { ...value, signature: encodeSignedBase64(new Uint8Array(64)) })).status,
  ).toBe(400);
  expect((await f.call(path, value)).status).toBe(200);
  expect(await readBlobEncryption(env.DB, f.f.ids.blob)).toMatchObject({
    adminReceiptState: "verified",
    adminAccountId: f.f.ids.user,
    adminReceiptSignature: value.signature,
  });
});

it("fails closed for a revoked key, current role demotion, wrong origin, and maintenance", async () => {
  const f = await fixture();
  expect((await f.adopt()).status).toBe(200);
  const path = `/api/v1/encryption/blobs/${f.f.ids.blob}/admin-receipt`;
  const value = await f.receiptInput();
  expect((await f.call(path, value, f.session, "https://evil.invalid")).status).toBe(403);
  await env.DB.prepare("UPDATE users SET role='member' WHERE id=?").bind(f.f.ids.user).run();
  expect((await f.call(path, value)).status).toBe(403);
  await env.DB.prepare("UPDATE users SET role='app_admin' WHERE id=?").bind(f.f.ids.user).run();
  await env.DB.prepare("UPDATE encryption_keys SET revoked_at=2 WHERE account_id=?")
    .bind(f.f.ids.user)
    .run();
  expect((await f.call(path, value)).status).toBe(400);
  const next = await fixture();
  await env.DB.prepare("UPDATE control SET maintenance=1").run();
  expect((await next.adopt()).status).toBe(503);
  expect(await readBlobEncryption(env.DB, next.f.ids.blob)).toBeNull();
});
