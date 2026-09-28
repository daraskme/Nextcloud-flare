import { applyD1Migrations } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeAll, beforeEach, expect, it } from "vitest";
import { atomicBatch } from "../../src/db/primary";
import { inspectRecoveryPage, releaseStaleRecoveryReservations } from "../../src/do/recoveryAudit";
import { loadCopyJobManifest } from "../../src/jobs/copyManifest";
import { lookupOperation } from "../../src/jobs/operations";
import { dispatchOutbox, type OutboxMessage, type OutboxSender } from "../../src/jobs/outbox";
import { handleOutboxBatch } from "../../src/jobs/queue";
import { copyPreparationAssertions } from "../../src/services/copyPreparation";
import { createCopyJob } from "../../src/services/createCopyJob";
import { createInternalShare, updateInternalShare } from "../../src/services/internalShares";
import { auditOwnerLedger } from "../../src/services/refs";
import { foundationFixture } from "../fixtures/foundation";
import { mutationEnv } from "../fixtures/mutationAdmission";
import { admitted, injectBatch } from "../fixtures/uploadEnv";

beforeAll(() => applyD1Migrations(env.DB, env.TEST_MIGRATIONS));
beforeEach(async () => {
  await env.DB.prepare("UPDATE control SET maintenance=1").run();
  await env.DB.prepare("UPDATE control SET epoch=1,maintenance=0").run();
});
async function fixture() {
  const source = foundationFixture(crypto.randomUUID(), Date.now() - 1000);
  const target = foundationFixture(crypto.randomUUID(), Date.now() - 1000);
  await atomicBatch(env.DB, [
    ...source.statements,
    ...target.statements,
    {
      sql: "UPDATE users SET email=? WHERE id=?",
      values: [target.ids.user + "@example.invalid", target.ids.user],
    },
    {
      sql: "INSERT INTO blob_storage(blob_id,bytes,r2_etag,observed_at) VALUES(?,3,'source-etag',1)",
      values: [source.ids.blob],
    },
  ]);
  await env.DB.prepare(
    "UPDATE control SET bootstrap_done_at=1,bootstrap_iss='https://access.invalid',bootstrap_sub=? WHERE bootstrap_done_at IS NULL",
  )
    .bind(source.ids.user)
    .run();
  const session = {
    user_id: source.ids.user,
    credential_id: source.ids.credential,
    session_id: source.ids.session,
    role: "app_admin" as const,
    epoch: 1,
    expires_at: Date.now() + 600000,
  };
  const share = await createInternalShare(mutationEnv(), session, {
    kind: "internal",
    rootNodeId: source.ids.folder,
    recipients: [target.ids.user + "@example.invalid"],
    role: "read",
    expiresAt: null,
  });
  const principal = {
    kind: "user" as const,
    user_id: target.ids.user,
    credential_id: target.ids.credential,
    epoch: 1,
    selected_share: share,
  };
  const request = {
    principal,
    sourceSpaceId: source.ids.space,
    sourceNodeId: source.ids.folder,
    destination: { spaceId: target.ids.space, share: null },
    destinationParentId: target.ids.folder,
    name: "Copied",
    depth: "infinity" as const,
    requestId: crypto.randomUUID(),
    lockTokens: [] as string[],
  };
  const revoke = () => updateInternalShare(mutationEnv(), session, share.id, share.version, null);
  return { source, target, share, session, request, revoke };
}
async function accepted(f: Awaited<ReturnType<typeof fixture>>, db = env.DB) {
  const result = await createCopyJob(admitted(db), f.request);
  expect(result).toMatchObject({
    kind: "terminal",
    operation: { state: "committed", result: { status: 202 } },
  });
  if (result.kind !== "terminal" || !result.operation.result?.jobId)
    throw new Error("missing_copy_job");
  return { id: result.operation.result.jobId, operationId: result.operation.id, outcome: result };
}
async function counts(f: Awaited<ReturnType<typeof fixture>>) {
  return env.DB.prepare(`SELECT (SELECT COUNT(*) FROM bulk_jobs WHERE owner_id=?1) AS jobs,
    (SELECT COUNT(*) FROM reservations WHERE owner_id=?1) AS reservations,
    (SELECT COUNT(*) FROM blob_pins WHERE blob_id=?2) AS pins`)
    .bind(f.target.ids.user, f.source.ids.blob)
    .first();
}
it("atomically accepts a durable job without publishing nodes or writing R2", async () => {
  const f = await fixture(),
    result = await accepted(f);
  expect(await counts(f)).toEqual({ jobs: 1, reservations: 1, pins: 1 });
  const loaded = await loadCopyJobManifest(env.DB, result.id);
  expect(loaded.plan.source.entries).toHaveLength(2);
  expect(loaded.plan.source.blobs[0]?.etag).toBe("source-etag");
  expect(loaded.plan.principal.selected_share).toEqual(f.share);
  expect(Object.isFrozen(loaded.plan.source.entries[0])).toBe(true);
  expect(() => copyPreparationAssertions(loaded.plan)).toThrow("invalid_copy_preparation_proof");
  expect(
    await env.DB.prepare("SELECT COUNT(*) AS n FROM nodes WHERE owner_id=?")
      .bind(f.target.ids.user)
      .first("n"),
  ).toBe(3);
  expect(
    await env.DB.prepare("SELECT COUNT(*) AS n FROM blobs WHERE owner_id=?")
      .bind(f.target.ids.user)
      .first("n"),
  ).toBe(1);
  expect(await auditOwnerLedger(env.DB, f.target.ids.user)).toMatchObject({
    reserved_bytes: 3,
    used_bytes: 3,
    incorrect_refs: 0,
  });
  expect(
    await env.DB.prepare("SELECT kind,state,payload_ref FROM outbox WHERE op_id=?")
      .bind(result.operationId)
      .first(),
  ).toEqual({ kind: "copy.requested", state: "pending", payload_ref: result.id });
  expect(
    await env.DB.prepare("SELECT state FROM permits WHERE permit_id=?")
      .bind("p:" + result.operationId)
      .first("state"),
  ).toBe("released");
});
it("recovers an acceptance ACK loss and replays the frozen manifest after source edits", async () => {
  const f = await fixture();
  const db = injectBatch(
    (sql) => sql.startsWith("INSERT INTO bulk_jobs"),
    async () => {
      throw new Error("ack_lost");
    },
    true,
  );
  const first = await accepted(f, db);
  await env.DB.prepare("UPDATE nodes SET client_mtime=42 WHERE id=?").bind(f.source.ids.file).run();
  const replay = await accepted(f);
  expect(replay.outcome).toEqual(first.outcome);
  expect(await counts(f)).toEqual({ jobs: 1, reservations: 1, pins: 1 });
  expect(
    (await loadCopyJobManifest(env.DB, first.id)).plan.source.entries.find(
      (n) => n.id === f.source.ids.file,
    )?.mtime,
  ).toBeNull();
});
it("coalesces two concurrent requests into one job and one set of holds", async () => {
  const f = await fixture();
  const [a, b] = await Promise.all([accepted(f), accepted(f)]);
  expect(a.outcome).toEqual(b.outcome);
  expect(await counts(f)).toEqual({ jobs: 1, reservations: 1, pins: 1 });
});
it.each(["name", "source", "destination", "selection", "lock"])(
  "rejects an idempotency key reused with changed %s",
  async (kind) => {
    const f = await fixture();
    await accepted(f);
    const request = { ...f.request };
    if (kind === "name") request.name = "Other";
    if (kind === "source") request.sourceNodeId = f.source.ids.file;
    if (kind === "destination") request.destinationParentId = f.target.ids.root;
    if (kind === "selection")
      request.principal = { ...request.principal, selected_share: { ...f.share, version: 2 } };
    if (kind === "lock") request.lockTokens = ["opaquelocktoken:" + crypto.randomUUID()];
    await expect(createCopyJob(admitted(), request)).rejects.toThrow("idempotency_conflict");
    expect(await counts(f)).toEqual({ jobs: 1, reservations: 1, pins: 1 });
  },
);
it.each(["share", "credential", "owner"])(
  "denies receipt disclosure and replay after %s revocation",
  async (kind) => {
    const f = await fixture(),
      result = await accepted(f);
    if (kind === "share") await f.revoke();
    if (kind === "credential")
      await env.DB.prepare("UPDATE sessions SET revoked_at=1 WHERE id=?")
        .bind(f.target.ids.session)
        .run();
    if (kind === "owner")
      await env.DB.prepare("UPDATE users SET disabled_at=1 WHERE id=?")
        .bind(f.source.ids.user)
        .run();
    expect(await lookupOperation(env.DB, f.request.principal, result.operationId)).toBeNull();
    await expect(createCopyJob(admitted(), f.request)).rejects.toThrow("authorization_denied");
    expect(await counts(f)).toEqual({ jobs: 1, reservations: 1, pins: 1 });
  },
);
it.each(["quota", "share", "metadata"])(
  "rolls back job, manifest, outbox and holds after late %s failure",
  async (kind) => {
    const f = await fixture();
    const db = injectBatch(
      (sql) => sql.startsWith("INSERT INTO bulk_jobs"),
      async () => {
        if (kind === "quota")
          await env.DB.prepare("UPDATE users SET quota_bytes=used_bytes WHERE id=?")
            .bind(f.target.ids.user)
            .run();
        if (kind === "share") await f.revoke();
        if (kind === "metadata")
          await env.DB.prepare("UPDATE nodes SET client_mtime=42 WHERE id=?")
            .bind(f.source.ids.file)
            .run();
      },
      false,
    );
    const result = await createCopyJob(admitted(db), f.request);
    expect(result.kind === "commit_unknown" || result.operation.state === "failed").toBe(true);
    expect(await counts(f)).toEqual({ jobs: 0, reservations: 0, pins: 0 });
    const operationId = result.kind === "terminal" ? result.operation.id : result.operationId;
    const jobId = "copy_" + operationId.slice(3);
    expect(
      await env.DB.prepare("SELECT COUNT(*) AS n FROM copy_job_chunks WHERE job_id=?")
        .bind(jobId)
        .first("n"),
    ).toBe(0);
    expect(
      await env.DB.prepare("SELECT COUNT(*) AS n FROM outbox WHERE op_id=?")
        .bind(operationId)
        .first("n"),
    ).toBe(0);
  },
);
it("round-trips UTF-8 across multiple immutable binary chunks and rejects corrupt storage", async () => {
  const f = await fixture();
  for (let i = 0; i < 12; i++)
    await env.DB.prepare(
      "INSERT INTO node_props(node_id,namespace,name,value_xml) VALUES(?,'urn:test',?,?)",
    )
      .bind(f.source.ids.file, "p" + i, "あ".repeat(2600))
      .run();
  const result = await accepted(f),
    loaded = await loadCopyJobManifest(env.DB, result.id);
  expect(loaded.plan.source.properties).toHaveLength(12);
  expect(loaded.plan.source.properties[0]?.value).toBe("あ".repeat(2600));
  expect(
    await env.DB.prepare("SELECT chunks FROM copy_job_manifests WHERE job_id=?")
      .bind(result.id)
      .first("chunks"),
  ).toBe(2);
  await expect(
    env.DB.prepare("UPDATE copy_job_chunks SET data=zeroblob(length(data)) WHERE job_id=?")
      .bind(result.id)
      .run(),
  ).rejects.toThrow("immutable_copy_chunk");
  const trigger = await env.DB.prepare(
    "SELECT sql FROM sqlite_master WHERE name='copy_job_chunk_identity'",
  ).first<string>("sql");
  const parts = await env.DB.prepare("SELECT part,data FROM copy_job_chunks WHERE job_id=?")
    .bind(result.id)
    .all<{ part: number; data: number[] }>();
  await env.DB.prepare("DROP TRIGGER copy_job_chunk_identity").run();
  try {
    await env.DB.prepare("UPDATE copy_job_chunks SET data=zeroblob(length(data)) WHERE job_id=?")
      .bind(result.id)
      .run();
    await expect(loadCopyJobManifest(env.DB, result.id)).rejects.toThrow(
      "copy_manifest_unavailable",
    );
  } finally {
    for (const part of parts.results)
      await env.DB.prepare("UPDATE copy_job_chunks SET data=? WHERE job_id=? AND part=?")
        .bind(new Uint8Array(part.data).buffer, result.id, part.part)
        .run();
    await env.DB.prepare(trigger!).run();
  }
});
it("holds reservations and source pins through elapsed time and an epoch change", async () => {
  const f = await fixture(),
    result = await accepted(f);
  await expect(
    env.DB.prepare("UPDATE reservations SET state='released' WHERE owner_id=?")
      .bind(f.target.ids.user)
      .run(),
  ).rejects.toThrow("copy_reservation_held");
  await expect(
    env.DB.prepare("DELETE FROM blob_pins WHERE blob_id=?").bind(f.source.ids.blob).run(),
  ).rejects.toThrow();
  await env.DB.prepare("UPDATE control SET maintenance=1").run();
  await env.DB.prepare("UPDATE control SET epoch=2").run();
  expect(await releaseStaleRecoveryReservations(mutationEnv(), 2)).toBe(0);
  expect(await counts(f)).toEqual({ jobs: 1, reservations: 1, pins: 1 });
  await expect(
    inspectRecoveryPage(env.DB, env.BLOBS, 2, { stage: "outbox", afterId: result.operationId }, 1),
  ).resolves.toMatchObject({ examined: 1 });
  expect((await loadCopyJobManifest(env.DB, result.id)).plan.principal.epoch).toBe(1);
});
it("dispatches only the durable ID and retains a transfer without its required bindings", async () => {
  const f = await fixture(),
    result = await accepted(f),
    messages: OutboxMessage[] = [];
  const outboxId = result.operationId + "_copy";
  const queue: OutboxSender = {
    async send(body) {
      messages.push(body);
      return { metadata: { metrics: { backlogCount: 1, backlogBytes: 0 } } };
    },
  };
  expect(await dispatchOutbox(mutationEnv(), queue, outboxId, 1)).toBe("sent");
  expect(messages).toEqual([{ outboxId }]);
  let acked = 0,
    retried = 0;
  expect(
    await handleOutboxBatch(
      { DB: env.DB, CONTROL: mutationEnv().CONTROL },
      {
        messages: [
          {
            body: messages[0],
            ack() {
              acked++;
            },
            retry() {
              retried++;
            },
          },
        ],
      },
    ),
  ).toEqual({ acked: 0, retried: 1 });
  expect([acked, retried]).toEqual([0, 1]);
  expect(
    await env.DB.prepare("SELECT state FROM bulk_jobs WHERE id=?").bind(result.id).first("state"),
  ).toBe("pending");
});
it.each([false, true])(
  "accepts an independently selected third-owner destination, revoked=%s",
  async (revoked) => {
    const f = await fixture(),
      third = foundationFixture(crypto.randomUUID(), Date.now() - 1000);
    await atomicBatch(env.DB, third.statements);
    const session = {
      ...f.session,
      user_id: third.ids.user,
      credential_id: third.ids.credential,
      session_id: third.ids.session,
    };
    const share = await createInternalShare(mutationEnv(), session, {
      kind: "internal",
      rootNodeId: third.ids.folder,
      recipients: [f.target.ids.user + "@example.invalid"],
      role: "edit",
      expiresAt: null,
    });
    const request = {
      ...f.request,
      destination: { spaceId: third.ids.space, share },
      destinationParentId: third.ids.folder,
    };
    const db = revoked
      ? injectBatch(
          (sql) => sql.startsWith("INSERT INTO bulk_jobs"),
          () =>
            updateInternalShare(mutationEnv(), session, share.id, share.version, null).then(
              () => {},
            ),
          false,
        )
      : env.DB;
    const result = await createCopyJob(admitted(db), request);
    if (revoked)
      expect(result.kind === "commit_unknown" || result.operation.state === "failed").toBe(true);
    else {
      expect(result).toMatchObject({
        kind: "terminal",
        operation: { state: "committed", result: { status: 202 } },
      });
      if (result.kind !== "terminal" || !result.operation.result?.jobId) throw Error("missing_job");
      const saved = await loadCopyJobManifest(env.DB, result.operation.result.jobId);
      expect(saved.plan.principal.selected_share).toEqual(f.share);
      expect(saved.plan.destination.share).toEqual(share);
    }
    expect(
      await env.DB.prepare("SELECT COUNT(*) AS n FROM bulk_jobs WHERE owner_id=?")
        .bind(third.ids.user)
        .first("n"),
    ).toBe(revoked ? 0 : 1);
    expect(await auditOwnerLedger(env.DB, third.ids.user)).toMatchObject({
      reserved_bytes: revoked ? 0 : 3,
      incorrect_refs: 0,
    });
  },
);
it("keeps depth-zero jobs durable without introducing blob reservations", async () => {
  const f = await fixture();
  const result = await createCopyJob(admitted(), { ...f.request, depth: "0" });
  expect(result).toMatchObject({
    kind: "terminal",
    operation: { state: "committed", result: { status: 202 } },
  });
  expect(await counts(f)).toEqual({ jobs: 1, reservations: 0, pins: 0 });
  if (result.kind !== "terminal" || !result.operation.result?.jobId) throw Error("missing_job");
  const saved = await loadCopyJobManifest(env.DB, result.operation.result.jobId);
  expect(saved.plan.source.entries).toHaveLength(1);
  expect(saved.plan.source.blobs).toEqual([]);
});
it("rechecks destination locks in the acceptance transaction", async () => {
  const f = await fixture();
  const db = injectBatch(
    (sql) => sql.startsWith("INSERT INTO bulk_jobs"),
    async () => {
      await env.DB.prepare(
        "INSERT INTO locks(id,node_id,space_id,creator_credential_id,token_hash,depth,owner_text,epoch,expires_at) VALUES(?,?,?,?,'lock-hash','infinity','fixture',1,?)",
      )
        .bind(
          crypto.randomUUID(),
          f.target.ids.folder,
          f.target.ids.space,
          f.target.ids.credential,
          Date.now() + 60000,
        )
        .run();
    },
    false,
  );
  const result = await createCopyJob(admitted(db), f.request);
  expect(result.kind === "commit_unknown" || result.operation.state === "failed").toBe(true);
  expect(await counts(f)).toEqual({ jobs: 0, reservations: 0, pins: 0 });
});
it("stores and reads a large manifest through bounded chunk pages", async () => {
  const f = await fixture();
  await env.DB.prepare(
    "WITH RECURSIVE r(i) AS (SELECT 0 UNION ALL SELECT i+1 FROM r WHERE i<899) INSERT INTO node_props(node_id,namespace,name,value_xml) SELECT ?,'urn:large','p'||i,? FROM r",
  )
    .bind(f.source.ids.file, "x".repeat(8000))
    .run();
  const result = await accepted(f);
  expect(
    await env.DB.prepare("SELECT chunks FROM copy_job_manifests WHERE job_id=?")
      .bind(result.id)
      .first<number>("chunks"),
  ).toBeGreaterThan(100);
  const saved = await loadCopyJobManifest(env.DB, result.id);
  expect(saved.plan.source.properties).toHaveLength(900);
  expect(saved.plan.source.properties.every((p) => p.value === "x".repeat(8000))).toBe(true);
});
it("accepts all 10000 nodes without truncation or exceeding the D1 statement budget", async () => {
  const f = await fixture();
  await env.DB.prepare(
    "WITH RECURSIVE r(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM r WHERE i<9998) INSERT INTO nodes(id,space_id,owner_id,parent_id,name,name_ci,kind,created_at,updated_at) SELECT ?1||'_'||i,?2,?3,?1,'n'||i,'n'||i,'folder',1,1 FROM r",
  )
    .bind(f.source.ids.folder, f.source.ids.space, f.source.ids.user)
    .run();
  const result = await accepted(f);
  expect((await loadCopyJobManifest(env.DB, result.id)).plan.source.entries).toHaveLength(10000);
  expect(
    await env.DB.prepare("SELECT node_count FROM bulk_jobs WHERE id=?")
      .bind(result.id)
      .first("node_count"),
  ).toBe(10000);
  expect(await counts(f)).toEqual({ jobs: 1, reservations: 1, pins: 1 });
});
