import { applyD1Migrations } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeAll, expect, it } from "vitest";
import { handleNodeMutationHttp } from "../../src/api/nodeMutations";
import { atomicBatch } from "../../src/db/primary";
import { CONTROL_NAME } from "../../src/do/ControlDO";
import { EPOCH_PREFIX } from "../../src/do/epochHistory";
import type { Env } from "../../src/env";
import { lookupOperation } from "../../src/jobs/operations";
import { handleOutboxBatch } from "../../src/jobs/queue";
import { dispatchTreeJob, type TreeJobSender } from "../../src/jobs/treeJobStore";
import { purgeTrash } from "../../src/services/purgeTrash";
import { restoreTrash } from "../../src/services/restoreTrash";
import { trashNode } from "../../src/services/trashNode";
import { foundationFixture } from "../fixtures/foundation";

const control = () => env.CONTROL.get(env.CONTROL.idFromName(CONTROL_NAME));
const fixture = foundationFixture(crypto.randomUUID(), Date.now() - 1_000);
let epoch = 2;
const principal = () => ({
  kind: "user" as const,
  user_id: fixture.ids.user,
  credential_id: fixture.ids.credential,
  epoch,
});
const queue: TreeJobSender = {
  async send() {
    return {};
  },
};

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

async function largeTree(rootId: string) {
  const blobId = `blob_${crypto.randomUUID().replaceAll("-", "")}`;
  await env.DB.prepare(
    `INSERT INTO nodes(
      id,space_id,owner_id,parent_id,name,name_ci,kind,created_at,updated_at
    ) VALUES(?,?,?,?,?,?,'folder',1,1)`,
  )
    .bind(
      rootId,
      fixture.ids.space,
      fixture.ids.user,
      fixture.ids.root,
      rootId,
      rootId.toLowerCase(),
    )
    .run();
  await env.DB.prepare(
    `WITH RECURSIVE seq(n) AS (VALUES(0) UNION ALL SELECT n+1 FROM seq WHERE n<998)
    INSERT INTO nodes(id,space_id,owner_id,parent_id,name,name_ci,kind,created_at,updated_at)
    SELECT ?||n,?,?,?,?||n,?||n,'folder',1,1 FROM seq`,
  )
    .bind(
      `${rootId}_child_`,
      fixture.ids.space,
      fixture.ids.user,
      rootId,
      `${rootId}_child_`,
      `${rootId.toLowerCase()}_child_`,
    )
    .run();
  const object = (await env.BLOBS.put(`u/${fixture.ids.user}/b/${blobId}`, "tree"))!;
  await atomicBatch(env.DB, [
    {
      sql: `INSERT INTO blobs(id,owner_id,r2_key,size,content_etag,state,created_at)
        VALUES(?,?,?,4,?,'committed',1)`,
      values: [blobId, fixture.ids.user, `u/${fixture.ids.user}/b/${blobId}`, `"${blobId}"`],
    },
    {
      sql: "INSERT INTO blob_storage(blob_id,bytes,r2_etag,observed_at) VALUES(?,4,?,1)",
      values: [blobId, object.etag],
    },
    {
      sql: `INSERT INTO nodes(
        id,space_id,owner_id,parent_id,name,name_ci,kind,current_blob_id,created_at,updated_at
      ) VALUES(?,?,?,?,?,?,'file',?,1,1)`,
      values: [
        `${rootId}_file`,
        fixture.ids.space,
        fixture.ids.user,
        rootId,
        `${rootId}_file`,
        `${rootId.toLowerCase()}_file`,
        blobId,
      ],
    },
  ]);
  await env.DB.prepare(
    `INSERT INTO search_index(node_id,space_id,text_norm,tokens,normalization_version,revision)
      VALUES(?,?,?,?,?,1)`,
  )
    .bind(rootId, fixture.ids.space, rootId.toLowerCase(), rootId.toLowerCase(), "v1")
    .run();
  await env.DB.prepare(
    `INSERT INTO search_fts(rowid,text_norm,tokens)
      SELECT rowid,text_norm,tokens FROM search_index WHERE node_id=?`,
  )
    .bind(rootId)
    .run();
  return blobId;
}

async function finish(operationId: string, beforeFinalize?: (jobId: string) => Promise<void>) {
  const visible = await lookupOperation(env.DB, principal(), operationId);
  expect(visible?.job).toBeDefined();
  const jobId = visible?.job?.id;
  if (!jobId) throw new Error("missing_job");
  let inspectedManifest = false;
  for (let index = 0; index < 20; index++) {
    await dispatchTreeJob(env, queue, jobId, epoch);
    let acked = false;
    const handled = await handleOutboxBatch(env as Env, {
      messages: [
        {
          body: { treeJobId: jobId },
          ack() {
            acked = true;
          },
          retry() {
            throw new Error("unexpected_retry");
          },
        },
      ],
    });
    expect(handled).toEqual({ acked: 1, retried: 0 });
    expect(acked).toBe(true);
    const progress = await lookupOperation(env.DB, principal(), operationId);
    if (progress?.state === "committed") break;
    if (!inspectedManifest && progress?.job?.total !== null && beforeFinalize) {
      await beforeFinalize(jobId);
      inspectedManifest = true;
    }
  }
  const terminal = await lookupOperation(env.DB, principal(), operationId);
  expect(terminal).toMatchObject({
    state: "committed",
    job: { id: jobId, state: "completed", processed: 1_001, total: 1_001 },
  });
  return terminal;
}

it("durably trashes, restores with conflict naming, and purges a 1,001-node tree", async () => {
  const rootId = `large_${crypto.randomUUID().replaceAll("-", "")}`;
  const trashRequestId = crypto.randomUUID();
  const blobId = await largeTree(rootId);
  const fileBlob = () =>
    env.DB.prepare("SELECT current_blob_id FROM nodes WHERE id=?")
      .bind(`${rootId}_file`)
      .first("current_blob_id");
  expect(await fileBlob()).toBe(blobId);
  const trashRequest = () =>
    new Request(`https://app.invalid/api/v1/nodes/${rootId}`, {
      method: "DELETE",
      headers: {
        "Content-Type": "application/json",
        "Idempotency-Key": trashRequestId,
      },
      body: JSON.stringify({ spaceId: fixture.ids.space }),
    });
  const started = await handleNodeMutationHttp(
    trashRequest(),
    { ...env, APP_ORIGIN: "https://app.invalid", JOBS: queue } as unknown as Env,
    principal(),
    { async verify() {} },
  );
  expect(started.status).toBe(202);
  expect(started.headers.get("Location")).toMatch(/^\/api\/v1\/operations\/op_/);
  const trashed = await started.json<{
    id: string;
    state: string;
    job: { id: string; state: string };
  }>();
  expect(trashed).toMatchObject({
    state: "claimed",
    job: { state: "pending" },
  });
  const retried = await handleNodeMutationHttp(
    trashRequest(),
    { ...env, APP_ORIGIN: "https://app.invalid", JOBS: queue } as unknown as Env,
    principal(),
    { async verify() {} },
  );
  expect(retried.status).toBe(202);
  expect(await retried.json()).toMatchObject({ id: trashed.id, job: { id: trashed.job.id } });
  const status = await handleNodeMutationHttp(
    new Request(`https://app.invalid/api/v1/operations/${trashed.id}`),
    { ...env, APP_ORIGIN: "https://app.invalid", JOBS: queue } as unknown as Env,
    principal(),
    { async verify() {} },
  );
  expect(status.status).toBe(200);
  expect(await status.json()).toMatchObject({
    id: trashed.id,
    state: "claimed",
    job: { id: trashed.job.id, state: "pending", processed: 0 },
  });
  await finish(trashed.id);
  expect(await fileBlob()).toBe(blobId);
  expect(
    await env.DB.prepare("SELECT COUNT(*) AS n FROM nodes WHERE deleted_op_id=?")
      .bind(trashed.id)
      .first("n"),
  ).toBe(1_001);

  await env.DB.prepare(
    `INSERT INTO nodes(
      id,space_id,owner_id,parent_id,name,name_ci,kind,created_at,updated_at
    ) VALUES(?,?,?,?,?,?,'folder',1,1)`,
  )
    .bind(
      `conflict_${rootId}`,
      fixture.ids.space,
      fixture.ids.user,
      fixture.ids.root,
      rootId,
      rootId.toLowerCase(),
    )
    .run();
  const restored = await restoreTrash(env as Env, {
    principal: principal(),
    requestId: crypto.randomUUID(),
    spaceId: fixture.ids.space,
    trashOpId: trashed.id,
    destinationParentId: fixture.ids.root,
    lockTokens: [],
  });
  expect(restored).toMatchObject({
    kind: "terminal",
    operation: { state: "claimed", job: { state: "pending" } },
  });
  if (restored.kind !== "terminal") throw new Error("restore_not_started");
  await finish(restored.operation.id);
  expect(await fileBlob()).toBe(blobId);
  expect(await env.DB.prepare("SELECT name FROM nodes WHERE id=?").bind(rootId).first("name")).toBe(
    `${rootId} (restored 1)`,
  );

  const trashedAgain = await trashNode(env as Env, {
    principal: principal(),
    requestId: crypto.randomUUID(),
    nodeId: rootId,
    spaceId: fixture.ids.space,
    lockTokens: [],
  });
  if (trashedAgain.kind !== "terminal") throw new Error("trash_not_started");
  await finish(trashedAgain.operation.id);
  expect(await fileBlob()).toBe(blobId);
  const purged = await purgeTrash(env as Env, {
    principal: principal(),
    requestId: crypto.randomUUID(),
    spaceId: fixture.ids.space,
    trashOpId: trashedAgain.operation.id,
  });
  expect(purged).toMatchObject({
    kind: "terminal",
    operation: { state: "claimed", job: { state: "pending" } },
  });
  if (purged.kind !== "terminal") throw new Error("purge_not_started");
  await finish(purged.operation.id, async () => {
    expect(
      await env.DB.prepare(`SELECT COUNT(*) AS n FROM purge_members pm
        JOIN nodes n ON n.id=pm.node_id
        WHERE pm.purge_op_id=? AND n.current_blob_id=?`)
        .bind(purged.operation.id, blobId)
        .first("n"),
    ).toBe(1);
    expect(
      await env.DB.prepare("SELECT COUNT(*) AS n FROM purge_blobs WHERE blob_id=?")
        .bind(blobId)
        .first("n"),
    ).toBe(1);
  });
  expect(
    await env.DB.prepare("SELECT COUNT(*) AS n FROM nodes WHERE id=? OR parent_id=?")
      .bind(rootId, rootId)
      .first("n"),
  ).toBe(0);
  expect(
    await env.DB.prepare(`SELECT b.ref_count,b.state,
      (SELECT COUNT(*) FROM purge_blobs WHERE blob_id=b.id) AS manifest_count,
      (SELECT COUNT(*) FROM gc_candidates WHERE blob_id=b.id) AS candidate_count
      FROM blobs b WHERE b.id=?`)
      .bind(blobId)
      .first(),
  ).toEqual({
    ref_count: 0,
    state: "gc_candidate",
    manifest_count: 1,
    candidate_count: 1,
  });
  expect(
    await env.DB.prepare("SELECT state,trash_op_id FROM gc_candidates WHERE blob_id=?")
      .bind(blobId)
      .first(),
  ).toEqual({ state: "candidate", trash_op_id: trashedAgain.operation.id });
  expect(await env.BLOBS.head(`u/${fixture.ids.user}/b/${blobId}`)).not.toBeNull();
});
