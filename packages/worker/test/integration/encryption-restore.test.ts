import { applyD1Migrations } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { searchName } from "@next-cloud-flare/shared/names";
import { beforeAll, expect, it } from "vitest";
import { atomicBatch } from "../../src/db/primary";
import { CONTROL_NAME } from "../../src/do/ControlDO";
import { EPOCH_PREFIX } from "../../src/do/epochHistory";
import type { Env } from "../../src/env";
import { lookupOperation } from "../../src/jobs/operations";
import { handleOutboxBatch } from "../../src/jobs/queue";
import { dispatchTreeJob } from "../../src/jobs/treeJobStore";
import { createFolder } from "../../src/services/createFolder";
import { restoreTrash } from "../../src/services/restoreTrash";
import { createShare } from "../../src/services/shares";
import { trashNode } from "../../src/services/trashNode";
import { foundationFixture } from "../fixtures/foundation";
import { injectBatch } from "../fixtures/uploadEnv";

const control = () => env.CONTROL.get(env.CONTROL.idFromName(CONTROL_NAME));
const fixture = foundationFixture(crypto.randomUUID(), Date.now() - 1_000);
let epoch = 2;
const principal = () => ({
  kind: "user" as const,
  user_id: fixture.ids.user,
  credential_id: fixture.ids.credential,
  epoch,
});
const session = () => ({
  ...principal(),
  session_id: fixture.ids.session,
  role: "app_admin" as const,
  expires_at: Date.now() + 60_000,
});

beforeAll(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
  await env.BACKUPS.put(
    `${EPOCH_PREFIX}1.json`,
    JSON.stringify({ epoch: 1, at: 1, reason: "operator" }),
  );
  await control().recover();
  await atomicBatch(
    env.DB,
    fixture.statements.map((statement) =>
      statement.sql.startsWith("INSERT INTO sessions")
        ? { ...statement, sql: statement.sql.replace("?,1,?,?,?)", "?,2,?,?,?)") }
        : statement,
    ),
  );
  const object = (await env.BLOBS.put(`u/${fixture.ids.user}/b/${fixture.ids.blob}`, "abc"))!;
  await env.DB.prepare(
    "INSERT INTO blob_storage(blob_id,bytes,r2_etag,observed_at) VALUES(?,3,?,1)",
  )
    .bind(fixture.ids.blob, object.etag)
    .run();
  await env.DB.prepare(
    "UPDATE control SET bootstrap_done_at=1,bootstrap_iss='https://access.invalid',bootstrap_sub=?",
  )
    .bind(fixture.ids.user)
    .run();
  epoch = (await control().recover()).epoch;
  await control().beginRecoveryAudit(epoch);
  let audited = false;
  for (let index = 0; index < 30 && !audited; index++)
    audited = (await control().nextRecoveryAuditPage(epoch, 20)).completed;
  expect(audited).toBe(true);
  await control().resumeAdmission(epoch);
  await control().resumeGarbageCollection(epoch);
});

async function folder(parentId = fixture.ids.root) {
  const result = await createFolder(env, {
    principal: principal(),
    idempotencyKey: crypto.randomUUID(),
    spaceId: fixture.ids.space,
    parentId,
    name: crypto.randomUUID(),
    lockTokens: [],
  });
  expect(result).toMatchObject({ kind: "terminal", operation: { state: "committed" } });
  if (result.kind !== "terminal") throw new Error("fixture_folder_failed");
  return (result.operation.result as { nodeId: string }).nodeId;
}

async function file(parentId: string, encrypted: boolean) {
  const nodeId = crypto.randomUUID(),
    blobId = crypto.randomUUID();
  const object = (await env.BLOBS.put(`u/${fixture.ids.user}/b/${blobId}`, "abc"))!;
  const search = searchName("File");
  await atomicBatch(env.DB, [
    {
      sql: "INSERT INTO blobs(id,owner_id,r2_key,size,content_etag,state,created_at) VALUES(?,?,?,3,?,'committed',1)",
      values: [blobId, fixture.ids.user, `u/${fixture.ids.user}/b/${blobId}`, `"${blobId}"`],
    },
    {
      sql: "INSERT INTO blob_storage(blob_id,bytes,r2_etag,observed_at) VALUES(?,3,?,1)",
      values: [blobId, object.etag],
    },
    {
      sql: "INSERT INTO nodes(id,space_id,owner_id,parent_id,name,name_ci,kind,current_blob_id,created_at,updated_at) VALUES(?,?,?,?,'File','file','file',?,1,1)",
      values: [nodeId, fixture.ids.space, fixture.ids.user, parentId, blobId],
    },
    {
      sql: "INSERT INTO search_index(node_id,space_id,text_norm,tokens,normalization_version,revision) VALUES(?,?,?,?,?,1)",
      values: [nodeId, fixture.ids.space, search.textNorm, search.tokens, search.version],
    },
    {
      sql: "INSERT INTO search_fts(rowid,text_norm,tokens) SELECT rowid,text_norm,tokens FROM search_index WHERE node_id=?",
      values: [nodeId],
    },
  ]);
  if (encrypted)
    await env.DB.prepare(`INSERT INTO blob_encryption(blob_id,owner_id,header_sha256,
    signer_rsa_fingerprint,signer_signing_fingerprint,required_admin_fingerprint,crypto_id,
    format_version,admin_receipt_state,verified_at) VALUES(?,?,?, ?,?,?,?,2,'pending',1)`)
      .bind(
        blobId,
        fixture.ids.user,
        "a".repeat(64),
        "A".repeat(43),
        "B".repeat(43),
        "C".repeat(43),
        nodeId,
      )
      .run();
  return { nodeId, blobId };
}

async function trash(nodeId: string) {
  const result = await trashNode(env, {
    principal: principal(),
    requestId: crypto.randomUUID(),
    nodeId,
    spaceId: fixture.ids.space,
    lockTokens: [],
  });
  expect(result).toMatchObject({ kind: "terminal", operation: { state: "committed" } });
  if (result.kind !== "terminal") throw new Error("fixture_trash_failed");
  return result.operation.id;
}

const restore = (trashOpId: string, destinationParentId: string) =>
  restoreTrash(env, {
    principal: principal(),
    requestId: crypto.randomUUID(),
    spaceId: fixture.ids.space,
    trashOpId,
    destinationParentId,
    lockTokens: [],
  });

it("restores ordinary files under a shared parent through real ControlDO and LockDO", async () => {
  const parentId = await folder();
  const plain = await file(parentId, false);
  const trashOpId = await trash(plain.nodeId);
  await createShare(env, session(), { rootNodeId: parentId, spaceId: fixture.ids.space });
  expect(await restore(trashOpId, parentId)).toMatchObject({
    kind: "terminal",
    operation: { state: "committed" },
  });
  expect(
    await env.DB.prepare("SELECT deleted_at FROM nodes WHERE id=?")
      .bind(plain.nodeId)
      .first("deleted_at"),
  ).toBeNull();
});

it("rejects trash then share then restore for an encrypted file", async () => {
  const parentId = await folder();
  const encrypted = await file(parentId, true);
  const trashOpId = await trash(encrypted.nodeId);
  await createShare(env, session(), { rootNodeId: parentId, spaceId: fixture.ids.space });
  await expect(restore(trashOpId, parentId)).rejects.toThrow("encrypted_operation_forbidden");
  expect(
    await env.DB.prepare("SELECT deleted_op_id FROM nodes WHERE id=?")
      .bind(encrypted.nodeId)
      .first("deleted_op_id"),
  ).toBe(trashOpId);
});

it("rejects a trashed encrypted descendant restored below an upload-only shared ancestor", async () => {
  const ancestor = await folder();
  const destination = await folder(ancestor);
  const subtree = await folder(destination);
  const encrypted = await file(subtree, true);
  const trashOpId = await trash(subtree);
  await createShare(env, session(), {
    rootNodeId: ancestor,
    spaceId: fixture.ids.space,
    kind: "upload_only",
  });
  await expect(restore(trashOpId, destination)).rejects.toThrow("encrypted_operation_forbidden");
  expect(
    await env.DB.prepare("SELECT deleted_op_id FROM nodes WHERE id=?")
      .bind(encrypted.nodeId)
      .first("deleted_op_id"),
  ).toBe(trashOpId);
});

it.each(["unshared", "disabled", "expired"])(
  "restores encrypted files into %s destinations",
  async (state) => {
    const parentId = await folder();
    const encrypted = await file(parentId, true);
    const trashOpId = await trash(encrypted.nodeId);
    if (state !== "unshared") {
      const share = await createShare(env, session(), {
        rootNodeId: parentId,
        spaceId: fixture.ids.space,
      });
      await env.DB.prepare(
        state === "disabled"
          ? "UPDATE shares SET disabled_at=? WHERE id=?"
          : "UPDATE shares SET expires_at=? WHERE id=?",
      )
        .bind(Date.now() - 1_000, share.id)
        .run();
    }
    expect(await restore(trashOpId, parentId)).toMatchObject({
      kind: "terminal",
      operation: { state: "committed" },
    });
    expect(
      await env.DB.prepare("SELECT current_blob_id FROM nodes WHERE id=? AND deleted_at IS NULL")
        .bind(encrypted.nodeId)
        .first("current_blob_id"),
    ).toBe(encrypted.blobId);
    expect(
      await env.DB.prepare("SELECT blob_id FROM blob_encryption WHERE blob_id=?")
        .bind(encrypted.blobId)
        .first("blob_id"),
    ).toBe(encrypted.blobId);
  },
);

it("fences a share enabled after the restore preflight in the same publishing batch", async () => {
  const parentId = await folder();
  const encrypted = await file(parentId, true);
  const trashOpId = await trash(encrypted.nodeId);
  const share = await createShare(env, session(), {
    rootNodeId: parentId,
    spaceId: fixture.ids.space,
  });
  await env.DB.prepare("UPDATE shares SET disabled_at=? WHERE id=?")
    .bind(Date.now(), share.id)
    .run();
  let raced = false;
  const db = injectBatch(
    (sql) => sql.includes("UPDATE trash_ops SET state='restoring'"),
    async () => {
      raced = true;
      await env.DB.prepare("UPDATE shares SET disabled_at=NULL,version=version+1 WHERE id=?")
        .bind(share.id)
        .run();
    },
    false,
  );
  const result = await restoreTrash(
    { ...env, DB: db },
    {
      principal: principal(),
      requestId: crypto.randomUUID(),
      spaceId: fixture.ids.space,
      trashOpId,
      destinationParentId: parentId,
      lockTokens: [],
    },
  );
  expect(raced).toBe(true);
  expect(result).toMatchObject({
    kind: "terminal",
    operation: { state: "failed", errorCode: "mutation_rejected" },
  });
  expect(
    await env.DB.prepare("SELECT deleted_op_id FROM nodes WHERE id=?")
      .bind(encrypted.nodeId)
      .first("deleted_op_id"),
  ).toBe(trashOpId);
  expect(
    await env.DB.prepare("SELECT state FROM trash_ops WHERE op_id=?")
      .bind(trashOpId)
      .first("state"),
  ).toBe("trashed");
  expect(await control().status()).toMatchObject({ maintenance: false, gcPaused: false });
});

async function settleTree(operationId: string, beforeFinalize?: () => Promise<void>) {
  const visible = await lookupOperation(env.DB, principal(), operationId);
  const jobId = visible?.job?.id;
  if (!jobId) throw new Error("fixture_missing_tree_job");
  let injected = false;
  for (let index = 0; index < 20; index++) {
    await dispatchTreeJob(env, { async send() {} }, jobId, epoch);
    const handled = await handleOutboxBatch(env as Env, {
      messages: [
        {
          body: { treeJobId: jobId },
          ack() {},
          retry() {
            throw new Error("unexpected_tree_retry");
          },
        },
      ],
    });
    expect(handled).toEqual({ acked: 1, retried: 0 });
    const progress = await lookupOperation(env.DB, principal(), operationId);
    if (progress?.state !== "claimed") return progress;
    if (!injected && beforeFinalize && progress.job?.total !== null) {
      injected = true;
      await beforeFinalize();
    }
  }
  throw new Error("tree_did_not_finish");
}

it("rechecks encrypted membership when a 1,001-node restore becomes shared before finalization", async () => {
  const parentId = await folder();
  const subtree = await folder(parentId);
  const encrypted = await file(subtree, true);
  await env.DB.prepare(`WITH RECURSIVE seq(n) AS (VALUES(0) UNION ALL SELECT n+1 FROM seq WHERE n<998)
    INSERT INTO nodes(id,space_id,owner_id,parent_id,name,name_ci,kind,created_at,updated_at)
    SELECT ?||n,?,?,?,?||n,?||n,'folder',1,1 FROM seq`)
    .bind(`${subtree}_child_`, fixture.ids.space, fixture.ids.user, subtree, "child_", "child_")
    .run();
  const trashed = await trashNode(env, {
    principal: principal(),
    requestId: crypto.randomUUID(),
    nodeId: subtree,
    spaceId: fixture.ids.space,
    lockTokens: [],
  });
  if (trashed.kind !== "terminal") throw new Error("fixture_trash_unknown");
  expect(await settleTree(trashed.operation.id)).toMatchObject({
    state: "committed",
    job: { state: "completed", total: 1_001 },
  });
  const restored = await restore(trashed.operation.id, parentId);
  if (restored.kind !== "terminal") throw new Error("fixture_restore_unknown");
  expect(restored.operation).toMatchObject({ state: "claimed", job: { state: "pending" } });
  expect(
    await settleTree(restored.operation.id, async () => {
      await createShare(env, session(), { rootNodeId: parentId, spaceId: fixture.ids.space });
    }),
  ).toMatchObject({ state: "failed", errorCode: "mutation_rejected", job: { state: "failed" } });
  expect(
    await env.DB.prepare("SELECT COUNT(*) AS n FROM nodes WHERE deleted_op_id=?")
      .bind(trashed.operation.id)
      .first("n"),
  ).toBe(1_001);
  expect(
    await env.DB.prepare("SELECT current_blob_id FROM nodes WHERE id=?")
      .bind(encrypted.nodeId)
      .first("current_blob_id"),
  ).toBe(encrypted.blobId);
  // The async preflight also refuses a new restore while the ancestor share is active.
  await expect(restore(trashed.operation.id, parentId)).rejects.toThrow(
    "encrypted_operation_forbidden",
  );
  expect(await control().status()).toMatchObject({ maintenance: false, gcPaused: false });
}, 60_000);
