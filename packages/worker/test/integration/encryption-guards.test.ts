import { applyD1Migrations } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { searchName } from "@next-cloud-flare/shared/names";
import { beforeAll, expect, it } from "vitest";
import { atomicBatch } from "../../src/db/primary";
import type { Env } from "../../src/env";
import { consumeOutbox } from "../../src/jobs/consumeOutbox";
import { copyNode } from "../../src/services/copyNode";
import {
  assertNoEncryptedSubtree,
  unencryptedSubtreeAssertion,
} from "../../src/services/encryptionGuards";
import { moveNode } from "../../src/services/moveNode";
import { renameNode } from "../../src/services/renameNode";
import { createInternalShare, createShare } from "../../src/services/shares";
import { planZipDownload } from "../../src/services/zipDownload";
import { foundationFixture } from "../fixtures/foundation";
import { grantPermit, mutationEnv } from "../fixtures/mutationAdmission";

beforeAll(async () => applyD1Migrations(env.DB, env.TEST_MIGRATIONS));

async function fixture() {
  const now = Date.now() - 1000;
  const f = foundationFixture(crypto.randomUUID(), now);
  const recipient = foundationFixture(crypto.randomUUID(), now);
  const recipientEmail = `${recipient.ids.user}@example.invalid`;
  await atomicBatch(env.DB, [...f.statements, ...recipient.statements]);
  await env.DB.prepare("UPDATE users SET email=? WHERE id=?")
    .bind(recipientEmail, recipient.ids.user)
    .run();
  await env.DB.prepare("UPDATE control SET epoch=1,maintenance=0 WHERE singleton=1").run();
  const object = await env.BLOBS.put(`u/${f.ids.user}/b/${f.ids.blob}`, "abc");
  if (!object) throw new Error("fixture_blob_put_failed");
  await env.DB.prepare(
    "INSERT INTO blob_storage(blob_id,bytes,r2_etag,observed_at) VALUES(?,3,?,?)",
  )
    .bind(f.ids.blob, object.etag, now)
    .run();
  const principal = {
    kind: "user" as const,
    user_id: f.ids.user,
    credential_id: f.ids.credential,
    epoch: 1,
  };
  const session = {
    ...principal,
    session_id: f.ids.session,
    role: "app_admin" as const,
    expires_at: now + 599000,
  };
  const mark = () =>
    env.DB.prepare(`INSERT INTO blob_encryption(
    blob_id,owner_id,header_sha256,signer_rsa_fingerprint,signer_signing_fingerprint,
    required_admin_fingerprint,crypto_id,format_version,admin_receipt_state,verified_at)
    VALUES(?,?,'${"a".repeat(64)}','${"A".repeat(43)}','${"B".repeat(43)}',
      '${"C".repeat(43)}','fixture-crypto',2,'pending',?)`)
      .bind(f.ids.blob, f.ids.user, Date.now())
      .run();
  return { f, recipient, recipientEmail, principal, session, mark };
}

it("rejects marked files and containing folders from rename, move and copy before mutation", async () => {
  const t = await fixture();
  await t.mark();
  for (const nodeId of [t.f.ids.file, t.f.ids.folder]) {
    await expect(assertNoEncryptedSubtree(env.DB, nodeId, t.f.ids.space)).rejects.toThrow(
      "encrypted_operation_forbidden",
    );
    await expect(
      renameNode(mutationEnv(), {
        principal: t.principal,
        idempotencyKey: crypto.randomUUID(),
        spaceId: t.f.ids.space,
        nodeId,
        name: "Renamed",
        lockTokens: [],
      }),
    ).rejects.toThrow("encrypted_operation_forbidden");
    await expect(
      copyNode(mutationEnv(), {
        principal: t.principal,
        requestId: crypto.randomUUID(),
        spaceId: t.f.ids.space,
        sourceNodeId: nodeId,
        destinationParentId: t.f.ids.root,
        depth: "infinity",
        name: "Copied",
        lockTokens: [],
      }),
    ).rejects.toThrow("encrypted_operation_forbidden");
    await expect(
      moveNode(mutationEnv(), {
        principal: t.principal,
        requestId: crypto.randomUUID(),
        spaceId: t.f.ids.space,
        nodeId,
        destinationParentId: t.f.ids.root,
        name: "Moved",
        lockTokens: [],
      }),
    ).rejects.toThrow("encrypted_operation_forbidden");
  }
  const plainId = crypto.randomUUID();
  const plainBlobId = crypto.randomUUID();
  await atomicBatch(env.DB, [
    {
      sql: "INSERT INTO blobs(id,owner_id,r2_key,size,content_etag,state,created_at) VALUES(?,?,?,3,?,'committed',?)",
      values: [
        plainBlobId,
        t.f.ids.user,
        `u/${t.f.ids.user}/b/${plainBlobId}`,
        '"plain"',
        Date.now(),
      ],
    },
    {
      sql: `INSERT INTO nodes(id,space_id,owner_id,parent_id,name,name_ci,kind,current_blob_id,created_at,updated_at)
      VALUES(?,?,?,?,'Plain','plain','file',?,?,?)`,
      values: [
        plainId,
        t.f.ids.space,
        t.f.ids.user,
        t.f.ids.folder,
        plainBlobId,
        Date.now(),
        Date.now(),
      ],
    },
  ]);
  await expect(
    copyNode(mutationEnv(), {
      principal: t.principal,
      requestId: crypto.randomUUID(),
      spaceId: t.f.ids.space,
      sourceNodeId: plainId,
      destinationParentId: t.f.ids.folder,
      overwriteTargetId: t.f.ids.file,
      depth: "0",
      name: "File",
      lockTokens: [],
    }),
  ).rejects.toThrow("encrypted_operation_forbidden");
  await expect(
    moveNode(mutationEnv(), {
      principal: t.principal,
      requestId: crypto.randomUUID(),
      spaceId: t.f.ids.space,
      nodeId: plainId,
      destinationParentId: t.f.ids.folder,
      overwriteTargetId: t.f.ids.file,
      name: "File",
      lockTokens: [],
    }),
  ).rejects.toThrow("encrypted_operation_forbidden");
  expect(
    await env.DB.prepare("SELECT name FROM nodes WHERE id=?").bind(t.f.ids.file).first("name"),
  ).toBe("File");
  await expect(
    atomicBatch(env.DB, [unencryptedSubtreeAssertion(t.f.ids.folder, t.f.ids.space)]),
  ).rejects.toThrow();
}, 30_000);

it("rejects marked descendants from public and internal shares and private ZIP plans", async () => {
  const t = await fixture();
  await t.mark();
  await expect(
    createShare(mutationEnv(), t.session, {
      rootNodeId: t.f.ids.folder,
      spaceId: t.f.ids.space,
    }),
  ).rejects.toThrow("encrypted_operation_forbidden");
  await expect(
    createInternalShare(mutationEnv(), t.session, {
      rootNodeId: t.f.ids.folder,
      spaceId: t.f.ids.space,
      recipientEmail: t.recipientEmail,
      actions: ["read"],
    }),
  ).rejects.toThrow("encrypted_operation_forbidden");
  await expect(
    planZipDownload(env.DB, env.BLOBS, t.principal, [
      { nodeId: t.f.ids.folder, spaceId: t.f.ids.space },
    ]),
  ).rejects.toThrow("encrypted_operation_forbidden");
  expect(
    await env.DB.prepare("SELECT COUNT(*) AS n FROM shares WHERE owner_id=?")
      .bind(t.f.ids.user)
      .first("n"),
  ).toBe(0);
}, 30_000);

it("allows an unmarked .ncf filename and fences adoption between preflight and batch commit", async () => {
  const t = await fixture();
  const search = searchName("opaque.ncf");
  await atomicBatch(env.DB, [
    {
      sql: "UPDATE nodes SET name='opaque.ncf',name_ci='opaque.ncf' WHERE id=?",
      values: [t.f.ids.file],
    },
    {
      sql: `INSERT INTO search_index(node_id,space_id,text_norm,tokens,normalization_version,revision)
      VALUES(?,?,?,?,?,1)`,
      values: [t.f.ids.file, t.f.ids.space, search.textNorm, search.tokens, search.version],
    },
    {
      sql: "INSERT INTO search_fts(rowid,text_norm,tokens) SELECT rowid,text_norm,tokens FROM search_index WHERE node_id=?",
      values: [t.f.ids.file],
    },
  ]);
  await expect(
    assertNoEncryptedSubtree(env.DB, t.f.ids.folder, t.f.ids.space),
  ).resolves.toBeUndefined();
  await expect(
    atomicBatch(env.DB, [unencryptedSubtreeAssertion(t.f.ids.folder, t.f.ids.space)]),
  ).resolves.toHaveLength(1);
  const plan = await planZipDownload(env.DB, env.BLOBS, t.principal, [
    { nodeId: t.f.ids.folder, spaceId: t.f.ids.space },
  ]);
  expect(plan.entries).toHaveLength(1);
  const share = await createShare(mutationEnv(), t.session, {
    rootNodeId: t.f.ids.folder,
    spaceId: t.f.ids.space,
  });
  expect(share.rootNodeId).toBe(t.f.ids.folder);
  const lockEnv = {
    ...mutationEnv(),
    LOCKS: {
      idFromName: env.LOCKS.idFromName.bind(env.LOCKS),
      get: () => ({
        acquireRename: (request: {
          requestId: string;
          spaceId: string;
          principal: { epoch: number };
        }) => grantPermit(env.DB, request.requestId, request.spaceId, request.principal.epoch),
        release: async () => undefined,
      }),
    } as unknown as Env["LOCKS"],
  };
  const renamed = await renameNode(lockEnv, {
    principal: t.principal,
    idempotencyKey: crypto.randomUUID(),
    spaceId: t.f.ids.space,
    nodeId: t.f.ids.file,
    name: "renamed.ncf",
    lockTokens: [],
  });
  expect(renamed.kind).toBe("terminal");
  if (renamed.kind === "terminal") expect(renamed.operation.state).toBe("committed");
  // The preflight was true, but a newly adopted marker must abort the write batch.
  await assertNoEncryptedSubtree(env.DB, t.f.ids.folder, t.f.ids.space);
  await t.mark();
  await expect(
    atomicBatch(env.DB, [unencryptedSubtreeAssertion(t.f.ids.folder, t.f.ids.space)]),
  ).rejects.toThrow();
}, 30_000);

it("completes an encrypted file outbox without inspecting ciphertext as image, audio, video or EPUB", async () => {
  const t = await fixture();
  await t.mark();
  const outboxId = crypto.randomUUID();
  const permit = await grantPermit(env.DB, crypto.randomUUID(), t.f.ids.space, 1);
  const operands = JSON.stringify({ parentId: t.f.ids.folder });
  const result = JSON.stringify({ status: 201, nodeId: t.f.ids.file });
  await atomicBatch(env.DB, [
    {
      sql: `INSERT INTO operations(op_id,principal_kind,principal_id,credential_id,space_id,kind,state,
        request_digest,epoch,permit_id,permit_expires_at,claimed_expires_at,expected_steps,
        created_at,updated_at,operands_json,result_json)
        VALUES(?,'user',?,?,?,'node.create','committed','digest',?,?,?,?,0,1,1,?,?)`,
      values: [
        outboxId,
        t.f.ids.user,
        t.f.ids.credential,
        t.f.ids.space,
        1,
        permit.permit_id,
        permit.expires_at,
        permit.expires_at,
        operands,
        result,
      ],
    },
    {
      sql: `INSERT INTO outbox(outbox_id,op_id,kind,payload_ref,state,epoch,created_at,updated_at)
      VALUES(?,?,'node.created',?,'sent',1,1,1)`,
      values: [outboxId, outboxId, t.f.ids.file],
    },
    {
      sql: "INSERT INTO operation_steps(op_id,step_no,kind,affected_id) VALUES(?,1,'node',?)",
      values: [outboxId, t.f.ids.file],
    },
  ]);
  await env.DB.prepare("UPDATE permits SET state='released' WHERE permit_id=?")
    .bind(permit.permit_id)
    .run();
  const noCiphertextReads = {
    ...mutationEnv(),
    BLOBS: {
      get() {
        throw new Error("ciphertext_read_forbidden");
      },
      put() {
        throw new Error("derived_object_forbidden");
      },
      head() {
        throw new Error("ciphertext_head_forbidden");
      },
    } as unknown as R2Bucket,
  };
  expect(await consumeOutbox(noCiphertextReads, outboxId)).toBe("completed");
  expect(
    await env.DB.prepare("SELECT mime_sniffed FROM blobs WHERE id=?")
      .bind(t.f.ids.blob)
      .first("mime_sniffed"),
  ).toBeNull();
  expect(
    await env.DB.prepare("SELECT COUNT(*) FROM node_media WHERE node_id=?")
      .bind(t.f.ids.file)
      .first("COUNT(*)"),
  ).toBe(0);
  expect(
    await env.DB.prepare("SELECT COUNT(*) FROM node_audio WHERE node_id=?")
      .bind(t.f.ids.file)
      .first("COUNT(*)"),
  ).toBe(0);
  expect(
    await env.DB.prepare("SELECT COUNT(*) FROM derivative_results WHERE blob_id=?")
      .bind(t.f.ids.blob)
      .first("COUNT(*)"),
  ).toBe(0);
}, 30_000);
