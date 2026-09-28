import { applyD1Migrations } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterEach, beforeAll, beforeEach, expect, it } from "vitest";
import { assertExists, atomicBatch } from "../../src/db/primary";
import {
  inspectRecoveryFinalFence,
  inspectRecoveryPage,
  RECOVERY_FINAL_QUERY,
} from "../../src/do/recoveryAudit";
import { consumeOutbox } from "../../src/jobs/consumeOutbox";
import { claimCopyJob, releaseCopyJobClaim } from "../../src/jobs/copyClaim";
import { loadCopyJobManifest } from "../../src/jobs/copyManifest";
import { copyNextBlob } from "../../src/jobs/copyMultipart";
import { publishCopyJob } from "../../src/jobs/copyPublication";
import { lookupOperation } from "../../src/jobs/operations";
import { dispatchOutbox } from "../../src/jobs/outbox";
import { type CreateCopyJobRequest, createCopyJob } from "../../src/services/createCopyJob";
import { createInternalShare, updateInternalShare } from "../../src/services/internalShares";
import { auditOwnerLedger } from "../../src/services/refs";
import { copyJobFixture } from "../fixtures/copyJob";
import { foundationFixture } from "../fixtures/foundation";
import { clearEndedR2TestWrites, mutationEnv } from "../fixtures/mutationAdmission";
import { admitted, injectBatch } from "../fixtures/uploadEnv";

beforeAll(() => applyD1Migrations(env.DB, env.TEST_MIGRATIONS));
beforeEach(async () => {
  await env.DB.prepare("UPDATE control SET maintenance=1").run();
  await env.DB.prepare("UPDATE control SET epoch=1,maintenance=0").run();
});
afterEach(clearEndedR2TestWrites);
const app = () => ({ ...admitted(), ...mutationEnv(), BLOBS: env.BLOBS });
async function ready(body?: Uint8Array) {
  const f = await copyJobFixture(false, body),
    claim = await claimCopyJob(mutationEnv(), f.job.outboxId);
  for (let i = 0; i < 8; i++)
    if ((await copyNextBlob(app(), claim, 8 * 1024 * 1024)) === "ready") return { ...f, claim };
  throw new Error("fixture_not_ready");
}
async function count(table: string, column: string, id: string) {
  return env.DB.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE ${column}=?`)
    .bind(id)
    .first<number>("n");
}
it.each([3, 9 * 1024 * 1024])(
  "publishes a whole transferred tree and settles its holds once (%s bytes)",
  async (size) => {
    const f = await ready(new Uint8Array(size));
    const errors: string[] = [];
    const db = new Proxy(env.DB, {
      get(target, key) {
        if (key === "batch")
          return async (statements: D1PreparedStatement[]) => {
            try {
              return await target.batch(statements);
            } catch (e) {
              errors.push(e instanceof Error ? e.message : String(e));
              throw e;
            }
          };
        const value = Reflect.get(target, key);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const result = await publishCopyJob(admitted(db), f.claim);
    expect(errors).toEqual([]);
    expect(result).toMatchObject({
      kind: "terminal",
      operation: { state: "committed", result: { status: 201, nodeId: f.job.id + "_n00001" } },
    });
    if (result.kind !== "terminal") throw new Error("no_receipt");
    expect(await count("nodes", "last_op_id", result.operation.id)).toBe(3); // folder, file, destination parent
    expect(await count("copy_job_blobs", "job_id", f.job.id)).toBe(0);
    expect(await count("copy_multipart_uploads", "destination_blob_id", f.job.id + "_b00001")).toBe(
      0,
    );
    expect(await count("copy_multipart_parts", "destination_blob_id", f.job.id + "_b00001")).toBe(
      0,
    );
    expect(await count("blob_pins", "pin_id", f.job.id + "_p00001")).toBe(0);
    expect(await count("job_leases", "job_id", f.job.id)).toBe(0);
    expect(await auditOwnerLedger(env.DB, f.target.ids.user)).toMatchObject({
      used_bytes: 3 + size,
      reserved_bytes: 0,
      physical_bytes: size,
      incorrect_refs: 0,
    });
    expect(await auditOwnerLedger(env.DB, f.source.ids.user)).toMatchObject({ incorrect_refs: 0 });
    expect((await loadCopyJobManifest(env.DB, f.job.id)).plan.digest).toBe(f.claim.plan.digest);
    expect(await publishCopyJob(admitted(), f.claim)).toEqual(result);
    expect(await count("activity", "op_id", result.operation.id)).toBe(1);
    const outboxId = result.operation.id + "_event";
    expect(
      await dispatchOutbox(
        mutationEnv(),
        { send: async () => ({ metadata: { metrics: { backlogCount: 1, backlogBytes: 0 } } }) },
        outboxId,
        1,
      ),
    ).toBe("sent");
    expect(await consumeOutbox(mutationEnv(), outboxId)).toBe("completed");
    await releaseCopyJobClaim(mutationEnv(), f.claim);
    await env.DB.prepare("UPDATE control SET maintenance=1").run();
    for (const id of [outboxId, f.job.outboxId])
      expect(
        (
          await inspectRecoveryPage(
            env.DB,
            env.BLOBS,
            1,
            { stage: "outbox", afterId: id.slice(0, -1) },
            1,
          )
        ).examined,
      ).toBe(1);
    await inspectRecoveryFinalFence(env.DB, 1);
    await atomicBatch(env.DB, [assertExists(RECOVERY_FINAL_QUERY, [1])]);
  },
);
it("rejects incomplete transfers and invented request-local claims", async () => {
  const f = await copyJobFixture(),
    claim = await claimCopyJob(mutationEnv(), f.job.outboxId);
  await expect(publishCopyJob(admitted(), claim)).rejects.toThrow("copy_transfer_incomplete");
  await expect(publishCopyJob(admitted(), { ...claim })).rejects.toThrow("invalid_copy_claim");
  expect(await count("nodes", "owner_id", f.target.ids.user)).toBe(3);
});
it("reconciles a lost publication ACK without repeating any namespace effect", async () => {
  const f = await ready();
  const db = injectBatch(
    (sql) => sql.startsWith("UPDATE bulk_jobs SET publish_op_id="),
    async () => {
      throw new Error("ack_lost");
    },
    true,
  );
  const result = await publishCopyJob(admitted(db), f.claim);
  expect(result).toMatchObject({ kind: "terminal", operation: { state: "committed" } });
  expect(await publishCopyJob(admitted(), f.claim)).toEqual(result);
  expect(await count("nodes", "owner_id", f.target.ids.user)).toBe(5);
});
it("does not publish or refund reservations after revocation immediately before the batch", async () => {
  const f = await ready();
  const db = injectBatch(
    (sql) => sql.startsWith("UPDATE bulk_jobs SET publish_op_id="),
    async () => {
      await f.revoke();
    },
    false,
  );
  expect(await publishCopyJob(admitted(db), f.claim)).toMatchObject({ kind: "commit_unknown" });
  expect(await count("nodes", "owner_id", f.target.ids.user)).toBe(3);
  expect(await count("copy_job_blobs", "job_id", f.job.id)).toBe(1);
  expect(await auditOwnerLedger(env.DB, f.target.ids.user)).toMatchObject({
    used_bytes: 3,
    reserved_bytes: 3,
    incorrect_refs: 0,
  });
});
it("rechecks source authority for completed publication lookup", async () => {
  const f = await ready(),
    result = await publishCopyJob(admitted(), f.claim);
  if (result.kind !== "terminal") throw new Error("no_receipt");
  await f.revoke();
  const principal = {
    kind: "user" as const,
    user_id: f.target.ids.user,
    credential_id: f.target.ids.credential,
    epoch: 1,
  };
  expect(await lookupOperation(env.DB, principal, result.operation.id)).toBeNull();
  await expect(publishCopyJob(admitted(), f.claim)).rejects.toThrow("authorization_denied");
});
it("only the current execution lease can publish a ready transfer", async () => {
  const f = await ready();
  await releaseCopyJobClaim(mutationEnv(), f.claim);
  await expect(publishCopyJob(admitted(), f.claim)).rejects.toThrow("copy_claim_released");
  const resumed = await claimCopyJob(mutationEnv(), f.job.outboxId);
  expect(await publishCopyJob(admitted(), resumed)).toMatchObject({
    kind: "terminal",
    operation: { state: "committed" },
  });
});

async function accept(request: CreateCopyJobRequest) {
  const result = await createCopyJob(admitted(), { ...request, requestId: crypto.randomUUID() });
  if (result.kind !== "terminal" || !result.operation.result?.jobId)
    throw new Error("accept_failed");
  const outboxId = result.operation.id + "_copy";
  await dispatchOutbox(
    mutationEnv(),
    { send: async () => ({ metadata: { metrics: { backlogCount: 1, backlogBytes: 0 } } }) },
    outboxId,
    1,
  );
  const claim = await claimCopyJob(mutationEnv(), outboxId);
  for (let i = 0; i < 8; i++)
    if ((await copyNextBlob(app(), claim, 8 * 1024 * 1024)) === "ready") return claim;
  throw new Error("not_ready");
}
it("uses the accepted names and properties while charging aliases once", async () => {
  const f = await copyJobFixture();
  await env.DB.prepare(
    "INSERT INTO nodes(id,space_id,owner_id,parent_id,name,name_ci,kind,current_blob_id,created_at,updated_at) VALUES(?,?,?,?,'Alias','alias','file',?,1,1)",
  )
    .bind(
      f.source.ids.file + "_alias",
      f.source.ids.space,
      f.source.ids.user,
      f.source.ids.folder,
      f.source.ids.blob,
    )
    .run();
  await env.DB.prepare(
    "INSERT INTO node_props(node_id,namespace,name,value_xml) VALUES(?,'urn:test','p','original')",
  )
    .bind(f.source.ids.file)
    .run();
  const claim = await accept({ ...f.request, name: ".Snapshot" });
  await env.DB.prepare(
    "UPDATE nodes SET name='Changed',name_ci='changed',revision=revision+1 WHERE id=?",
  )
    .bind(f.source.ids.file)
    .run();
  await env.DB.prepare("UPDATE node_props SET value_xml='changed' WHERE node_id=?")
    .bind(f.source.ids.file)
    .run();
  const result = await publishCopyJob(admitted(), claim);
  expect(result).toMatchObject({ kind: "terminal", operation: { state: "committed" } });
  const nodes = await env.DB.prepare(
    "SELECT name,hidden,current_blob_id FROM nodes WHERE id>=? AND id<? ORDER BY id",
  )
    .bind(claim.id + "_n", claim.id + "_o")
    .all();
  expect(nodes.results.map((n) => n.name)).toEqual([".Snapshot", "File", "Alias"]);
  expect(nodes.results[0]!.hidden).toBe(1);
  expect(nodes.results.slice(1).map((n) => n.current_blob_id)).toEqual([
    claim.id + "_b00001",
    claim.id + "_b00001",
  ]);
  expect(
    await env.DB.prepare("SELECT value_xml FROM node_props WHERE node_id=?")
      .bind(claim.id + "_n00002")
      .first("value_xml"),
  ).toBe("original");
  expect(await auditOwnerLedger(env.DB, f.target.ids.user)).toMatchObject({
    used_bytes: 6,
    reserved_bytes: 3,
    incorrect_refs: 0,
  });
});
it("converts reserved to used quota even when no spare logical quota remains", async () => {
  const f = await ready();
  await env.DB.prepare("UPDATE users SET quota_bytes=6 WHERE id=?").bind(f.target.ids.user).run();
  expect(await publishCopyJob(admitted(), f.claim)).toMatchObject({
    kind: "terminal",
    operation: { state: "committed" },
  });
  expect(await auditOwnerLedger(env.DB, f.target.ids.user)).toMatchObject({
    used_bytes: 6,
    reserved_bytes: 0,
    incorrect_refs: 0,
  });
});
it("publishes Depth 0 with no transfer or blob holds", async () => {
  const f = await copyJobFixture(),
    claim = await accept({ ...f.request, depth: "0" });
  expect(claim.plan.source.blobs).toHaveLength(0);
  expect(await publishCopyJob(admitted(), claim)).toMatchObject({
    kind: "terminal",
    operation: { state: "committed" },
  });
  expect(
    await env.DB.prepare("SELECT kind,current_blob_id FROM nodes WHERE id=?")
      .bind(claim.id + "_n00001")
      .first(),
  ).toEqual({ kind: "folder", current_blob_id: null });
  expect(await count("nodes", "parent_id", claim.id + "_n00001")).toBe(0);
});
async function overwriteReady() {
  const f = await copyJobFixture();
  const stored = await env.BLOBS.put(`u/${f.target.ids.user}/b/${f.target.ids.blob}`, "old");
  await env.DB.prepare(
    "INSERT INTO blob_storage(blob_id,bytes,r2_etag,observed_at) VALUES(?,3,?,1)",
  )
    .bind(f.target.ids.blob, stored!.etag)
    .run();
  const claim = await accept({ ...f.request, name: "File", overwriteTargetId: f.target.ids.file });
  return { ...f, claim };
}
it("trashes the exact overwrite snapshot and keeps its old bytes recoverable", async () => {
  const f = await overwriteReady(),
    result = await publishCopyJob(admitted(), f.claim);
  expect(result).toMatchObject({
    kind: "terminal",
    operation: { state: "committed", result: { status: 204 } },
  });
  expect(
    await env.DB.prepare("SELECT deleted_op_id FROM nodes WHERE id=?")
      .bind(f.target.ids.file)
      .first("deleted_op_id"),
  ).toBe(result.kind === "terminal" ? result.operation.id : null);
  expect(
    await env.DB.prepare("SELECT ref_count FROM blobs WHERE id=?")
      .bind(f.target.ids.blob)
      .first("ref_count"),
  ).toBe(1);
  expect(await auditOwnerLedger(env.DB, f.target.ids.user)).toMatchObject({
    used_bytes: 6,
    reserved_bytes: 3,
    physical_bytes: 6,
    incorrect_refs: 0,
  });
});
it.each(["revision", "parent"])("rejects an overwrite target whose %s changed", async (change) => {
  const f = await overwriteReady();
  if (change === "revision")
    await env.DB.prepare("UPDATE nodes SET revision=revision+1 WHERE id=?")
      .bind(f.target.ids.file)
      .run();
  else
    await env.DB.prepare("UPDATE nodes SET parent_id=? WHERE id=?")
      .bind(f.target.ids.root, f.target.ids.file)
      .run();
  expect(await publishCopyJob(admitted(), f.claim)).toMatchObject({
    kind: "terminal",
    operation: { state: "failed" },
  });
  expect(
    await env.DB.prepare("SELECT deleted_at FROM nodes WHERE id=?")
      .bind(f.target.ids.file)
      .first("deleted_at"),
  ).toBeNull();
  expect(await count("copy_job_blobs", "job_id", f.claim.id)).toBe(1);
});
it("rejects a member moved outside the accepted source subtree after transfer", async () => {
  const f = await ready();
  await env.DB.prepare("UPDATE nodes SET parent_id=? WHERE id=?")
    .bind(f.source.ids.root, f.source.ids.file)
    .run();
  expect(await publishCopyJob(admitted(), f.claim)).toMatchObject({
    kind: "terminal",
    operation: { state: "failed" },
  });
  expect(await count("nodes", "owner_id", f.target.ids.user)).toBe(3);
});
it("checks destination locks again inside the publication transaction", async () => {
  const f = await ready();
  const db = injectBatch(
    (sql) => sql.startsWith("UPDATE bulk_jobs SET publish_op_id="),
    async () => {
      await env.DB.prepare(
        "INSERT INTO locks(id,node_id,space_id,creator_credential_id,token_hash,depth,owner_text,epoch,expires_at,display_href) VALUES(?,?,?,?,?,'infinity','owner',1,?,'/dav/Folder/')",
      )
        .bind(
          crypto.randomUUID(),
          f.target.ids.folder,
          f.target.ids.space,
          f.target.ids.credential,
          crypto.randomUUID(),
          Date.now() + 60000,
        )
        .run();
    },
    false,
  );
  expect(await publishCopyJob(admitted(db), f.claim)).toMatchObject({
    kind: "terminal",
    operation: { state: "failed" },
  });
  expect(await count("copy_job_blobs", "job_id", f.job.id)).toBe(1);
});
it("retains every hold while a native write on the destination key is pending", async () => {
  const f = await ready(),
    id = crypto.randomUUID();
  await env.DB.prepare(
    "INSERT INTO r2_write_attempts(id,token,epoch,owner_id,kind,r2_key,dispatch_before,started_at,state,source_ref) VALUES(?,?,1,?,'copy.put',?,strftime('%s','now')*1000+5000,strftime('%s','now')*1000,'pending',?)",
  )
    .bind(
      id,
      crypto.randomUUID(),
      f.target.ids.user,
      `u/${f.target.ids.user}/b/${f.claim.id}_b00001`,
      JSON.stringify([f.claim.id, f.source.ids.blob, crypto.randomUUID()]),
    )
    .run();
  try {
    const result = await publishCopyJob(admitted(), f.claim);
    expect(
      result.kind === "commit_unknown" ||
        (result.kind === "terminal" && result.operation.state === "failed"),
    ).toBe(true);
    expect(await count("nodes", "owner_id", f.target.ids.user)).toBe(3);
    expect(await count("copy_job_blobs", "job_id", f.job.id)).toBe(1);
    await expect(
      env.DB.prepare("UPDATE reservations SET state='released' WHERE id=?")
        .bind(f.claim.id + "_r00001")
        .run(),
    ).rejects.toThrow("copy_reservation_held");
  } finally {
    // This fixture never dispatched a native call.
    await env.DB.prepare(
      "UPDATE r2_write_attempts SET state='not_started',finished_at=started_at WHERE id=?",
    )
      .bind(id)
      .run();
  }
});

function rejectAfter(prefix: string): D1Database {
  const statements = new WeakMap<object, string>();
  let injected = false;
  return {
    prepare(sql: string) {
      const stmt = env.DB.prepare(sql);
      return new Proxy(stmt, {
        get(target, key) {
          if (key === "bind")
            return (...values: unknown[]) => {
              const bound = target.bind(...values);
              statements.set(bound, sql);
              return bound;
            };
          const value = Reflect.get(target, key);
          return typeof value === "function" ? value.bind(target) : value;
        },
      });
    },
    batch(batch: D1PreparedStatement[]) {
      const index = injected ? -1 : batch.findIndex((s) => statements.get(s)?.startsWith(prefix));
      if (index >= 0) {
        injected = true;
        batch = [
          ...batch.slice(0, index + 1),
          env.DB.prepare("INSERT INTO _assert(v) VALUES(1)"),
          ...batch.slice(index + 1),
        ];
      }
      return env.DB.batch(batch);
    },
  } as D1Database;
}
it.each([
  "UPDATE reservations SET state='released'",
  "UPDATE blobs SET state='committed'",
  "INSERT INTO nodes(",
  "UPDATE nodes SET revision=revision+1",
  "UPDATE spaces SET tree_generation=tree_generation+1",
  "INSERT INTO search_index(",
  "INSERT INTO search_fts(",
  "INSERT INTO activity(",
  "INSERT INTO outbox(",
  "UPDATE bulk_jobs SET state='completed'",
  "UPDATE operations SET state='committed'",
  "DELETE FROM copy_job_blobs",
  "DELETE FROM blob_pins",
  "DELETE FROM job_leases",
])("rolls back namespace and both ledgers after %s fails", async (prefix) => {
  const f = await ready();
  expect(await publishCopyJob(admitted(rejectAfter(prefix)), f.claim)).toMatchObject({
    kind: "terminal",
    operation: { state: "failed" },
  });
  expect(await count("nodes", "owner_id", f.target.ids.user)).toBe(3);
  expect(await count("copy_job_blobs", "job_id", f.job.id)).toBe(1);
  expect(await count("blob_pins", "pin_id", f.job.id + "_p00001")).toBe(1);
  expect(await auditOwnerLedger(env.DB, f.target.ids.user)).toMatchObject({
    used_bytes: 3,
    reserved_bytes: 3,
    physical_bytes: 3,
    incorrect_refs: 0,
  });
  expect(
    await env.DB.prepare("SELECT publish_op_id FROM bulk_jobs WHERE id=?")
      .bind(f.job.id)
      .first("publish_op_id"),
  ).toBeNull();
});
it("publishes 10000 accepted nodes within the D1 batch and claim budgets", async () => {
  const f = await copyJobFixture();
  await env.DB.prepare(
    "WITH RECURSIVE seq(n) AS (SELECT 1 UNION ALL SELECT n+1 FROM seq WHERE n<9998) INSERT INTO nodes(id,space_id,owner_id,parent_id,name,name_ci,kind,created_at,updated_at) SELECT ?1||'_many_'||n,?2,?3,?4,'n'||n,'n'||n,'folder',1,1 FROM seq",
  )
    .bind(f.source.ids.user, f.source.ids.space, f.source.ids.user, f.source.ids.folder)
    .run();
  const claim = await accept(f.request);
  expect(claim.plan.source.entries).toHaveLength(10000);
  const result = await publishCopyJob(admitted(), claim);
  expect(result).toMatchObject({ kind: "terminal", operation: { state: "committed" } });
  expect(await count("nodes", "owner_id", f.target.ids.user)).toBe(10003);
}, 60000);

it("publishes the pinned original when the current source content changes", async () => {
  const f = await ready(),
    blob = crypto.randomUUID();
  await atomicBatch(env.DB, [
    {
      sql: "INSERT INTO blobs(id,owner_id,r2_key,size,content_etag,state,created_at) VALUES(?,?,?,3,'changed','committed',1)",
      values: [blob, f.source.ids.user, `u/${f.source.ids.user}/b/${blob}`],
    },
    {
      sql: "UPDATE nodes SET current_blob_id=?,revision=revision+1 WHERE id=?",
      values: [blob, f.source.ids.file],
    },
  ]);
  expect(await publishCopyJob(admitted(), f.claim)).toMatchObject({
    kind: "terminal",
    operation: { state: "committed" },
  });
  const saved = await env.BLOBS.get(`u/${f.target.ids.user}/b/${f.claim.id}_b00001`);
  expect(await saved!.text()).toBe("abc");
  expect(await auditOwnerLedger(env.DB, f.source.ids.user)).toMatchObject({ incorrect_refs: 0 });
});
it.each([false, true])(
  "keeps an independent destination selection after revocation (published=%s)",
  async (published) => {
    const f = await copyJobFixture(),
      owner = foundationFixture(crypto.randomUUID(), Date.now() - 1000);
    await atomicBatch(env.DB, owner.statements);
    const session = {
      user_id: owner.ids.user,
      credential_id: owner.ids.credential,
      session_id: owner.ids.session,
      role: "app_admin" as const,
      epoch: 1,
      expires_at: Date.now() + 600000,
    };
    const input = {
      kind: "internal" as const,
      rootNodeId: owner.ids.folder,
      recipients: [f.target.ids.user + "@example.invalid"],
      role: "edit" as const,
      expiresAt: null,
    };
    const share = await createInternalShare(mutationEnv(), session, input);
    const claim = await accept({
      ...f.request,
      destination: { spaceId: owner.ids.space, share },
      destinationParentId: owner.ids.folder,
    });
    const result = published ? await publishCopyJob(admitted(), claim) : null;
    if (published)
      expect(result).toMatchObject({ kind: "terminal", operation: { state: "committed" } });
    await updateInternalShare(mutationEnv(), session, share.id, share.version, null);
    await createInternalShare(mutationEnv(), session, input); // A different grant cannot replace the selected one.
    await expect(publishCopyJob(admitted(), claim)).rejects.toThrow();
    expect(await count("nodes", "owner_id", owner.ids.user)).toBe(published ? 5 : 3);
    if (result?.kind === "terminal") {
      const outboxId = result.operation.id + "_event";
      await dispatchOutbox(
        mutationEnv(),
        { send: async () => ({ metadata: { metrics: { backlogCount: 1, backlogBytes: 0 } } }) },
        outboxId,
        1,
      );
      expect(await consumeOutbox(mutationEnv(), outboxId)).toBe("retry");
    }
  },
);
it("copies an owned space root as a regular folder through the selected destination grant", async () => {
  const f = await copyJobFixture();
  await env.DB.prepare("UPDATE users SET email=? WHERE id=?")
    .bind(f.source.ids.user + "@example.invalid", f.source.ids.user)
    .run();
  const session = {
    user_id: f.target.ids.user,
    credential_id: f.target.ids.credential,
    session_id: f.target.ids.session,
    role: "app_admin" as const,
    epoch: 1,
    expires_at: Date.now() + 600000,
  };
  const share = await createInternalShare(mutationEnv(), session, {
    kind: "internal",
    rootNodeId: f.target.ids.folder,
    recipients: [f.source.ids.user + "@example.invalid"],
    role: "edit",
    expiresAt: null,
  });
  const claim = await accept({
    ...f.request,
    principal: {
      kind: "user",
      user_id: f.source.ids.user,
      credential_id: f.source.ids.credential,
      epoch: 1,
    },
    sourceNodeId: f.source.ids.root,
    destination: { spaceId: f.target.ids.space, share },
    depth: "0",
  });
  expect(await publishCopyJob(admitted(), claim)).toMatchObject({
    kind: "terminal",
    operation: { state: "committed" },
  });
  expect(
    await env.DB.prepare("SELECT kind,parent_id FROM nodes WHERE id=?")
      .bind(claim.id + "_n00001")
      .first(),
  ).toEqual({ kind: "folder", parent_id: f.target.ids.folder });
});
