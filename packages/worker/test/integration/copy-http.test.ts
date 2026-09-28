import { applyD1Migrations } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { searchName } from "@next-cloud-flare/shared/names";
import { base64url } from "jose";
import { afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import type { CopyJobStatus } from "../../../shared/src/copyJobs";
import { copyJobRoute, handleCopyJobHttp } from "../../src/api/copyJobs";
import { handleNodeMutationHttp } from "../../src/api/nodeMutations";
import { handlePrivateAppHttp, privateAppRoute } from "../../src/api/privateApp";
import type { Principal } from "../../src/auth/authorize";
import { ContentTokens, contentKeyRing } from "../../src/auth/contentTokens";
import { CsrfTokens, csrfKeyRing } from "../../src/auth/csrf";
import { executeCopyJob } from "../../src/jobs/copyExecutor";
import { stopExpiredCopyJob } from "../../src/jobs/copyLifecycle";
import { dispatchOutbox } from "../../src/jobs/outbox";
import { handleOutboxBatch } from "../../src/jobs/queue";
import { createCopyJob } from "../../src/services/createCopyJob";
import { createFolder } from "../../src/services/createFolder";
import { createInternalShare, updateInternalShare } from "../../src/services/internalShares";
import { auditOwnerLedger } from "../../src/services/refs";
import { accessFixture } from "../fixtures/access";
import { copyJobSetup } from "../fixtures/copyJob";
import { clearEndedR2TestWrites, mutationEnv } from "../fixtures/mutationAdmission";
import { admitted, injectBatch } from "../fixtures/uploadEnv";

const origin = "https://app.invalid";
let csrf: CsrfTokens;
beforeAll(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
  const ring = await csrfKeyRing("test", {
    test: base64url.encode(crypto.getRandomValues(new Uint8Array(32))),
  });
  csrf = new CsrfTokens(ring, ring, origin);
});
beforeEach(async () => {
  await env.DB.prepare("UPDATE control SET maintenance=1").run();
  await env.DB.prepare("UPDATE control SET epoch=1,maintenance=0").run();
});
afterEach(clearEndedR2TestWrites);
const app = (db = env.DB) => ({
  ...mutationEnv(db),
  LOCKS: admitted(db).LOCKS,
  APP_ORIGIN: origin,
});
async function fixture(bytes?: number) {
  const f = await copyJobSetup(false, bytes === undefined ? undefined : new Uint8Array(bytes));
  const principal: Principal = {
    kind: "user",
    user_id: f.target.ids.user,
    credential_id: f.target.ids.credential,
    epoch: 1,
  };
  const issued = await csrf.issue(
    env.DB,
    new Request(origin + "/api/v1/csrf", {
      method: "POST",
      headers: { "Sec-Fetch-Site": "same-origin" },
    }),
    { kind: "access", credentialId: principal.credential_id, epoch: 1 },
  );
  const headers = {
    Origin: origin,
    "Content-Type": "application/json",
    "Sec-Fetch-Site": "same-origin",
    "X-CSRF-Token": issued.token,
    "Idempotency-Key": f.request.requestId,
  };
  const call = (path: string, init: RequestInit = {}, db = env.DB, actor = principal) => {
    const requestHeaders = new Headers(headers);
    new Headers(init.headers).forEach((value, key) => requestHeaders.set(key, value));
    const request = new Request(origin + path, {
      ...init,
      headers: requestHeaders,
    });
    return path.startsWith("/api/v1/jobs/")
      ? handleCopyJobHttp(request, app(db), actor, csrf)
      : handleNodeMutationHttp(request, app(db), actor, csrf);
  };
  const path = `/api/v1/nodes/${f.source.ids.folder}/copy`;
  const body = {
    spaceId: f.source.ids.space,
    share: { id: f.share.id, version: f.share.version },
    destination: f.request.destination,
    destinationParentId: f.target.ids.folder,
    name: "HTTP copy",
    depth: "infinity",
  };
  const create = (changes = {}, db = env.DB, extra: RequestInit = {}) =>
    call(path, { method: "POST", body: JSON.stringify({ ...body, ...changes }), ...extra }, db);
  return { ...f, principal, call, path, body, headers, create };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
async function accepted(response: Response) {
  expect(response.status).toBe(202);
  expect(response.headers.get("Cache-Control")).toBe("private, no-store");
  const operation = await response.json<{
    id: string;
    state: string;
    result: { status: number; jobId: string };
  }>();
  expect(operation.state).toBe("committed");
  expect(operation.result.status).toBe(202);
  expect(response.headers.get("Operation-Id")).toBe(operation.id);
  const path = `/api/v1/jobs/${operation.result.jobId}`;
  expect(response.headers.get("Location")).toBe(path);
  return { operation, id: operation.result.jobId, path, outboxId: operation.id + "_copy" };
}
async function dispatch(id: string) {
  expect(await dispatchOutbox(mutationEnv(), { send: vi.fn() }, id, 1)).toBe("sent");
}
async function consume(id: string) {
  const message = { body: { outboxId: id }, ack: vi.fn(), retry: vi.fn() };
  const result = await handleOutboxBatch(app(), { messages: [message] });
  expect(message.ack).toHaveBeenCalledTimes(result.acked);
  expect(message.retry).toHaveBeenCalledTimes(result.retried);
  return result;
}
const status = async (f: Fixture, path: string) => {
  const response = await f.call(path);
  expect(response.status).toBe(200);
  expect(response.headers.get("X-Content-Type-Options")).toBe("nosniff");
  return response.json<CopyJobStatus>();
};
const jobCount = (owner: string) =>
  env.DB.prepare("SELECT COUNT(*) AS n FROM bulk_jobs WHERE owner_id=?").bind(owner).first("n");
async function observeTarget(f: Fixture) {
  const object = await env.BLOBS.put(`u/${f.target.ids.user}/b/${f.target.ids.blob}`, "abc");
  await env.DB.prepare(
    "INSERT INTO blob_storage(blob_id,bytes,r2_etag,observed_at) VALUES(?,3,?,1)",
  )
    .bind(f.target.ids.blob, object!.etag)
    .run();
}

it("accepts a read-share copy over REST, publishes through Queue and returns durable progress", async () => {
  const f = await fixture(),
    job = await accepted(await f.create());
  expect(await status(f, job.path)).toEqual({
    id: job.id,
    state: "pending",
    nodeCount: 2,
    blobCount: 1,
    totalBytes: 3,
    completedBytes: 0,
    completedBlobs: 0,
    cleanupPending: 0,
    heldBytes: 3,
    errorCode: null,
    publishedRootId: null,
    retryJobId: null,
  });
  expect(
    await env.DB.prepare("SELECT COUNT(*) AS n FROM nodes WHERE owner_id=? AND name='HTTP copy'")
      .bind(f.target.ids.user)
      .first("n"),
  ).toBe(0);
  expect((await f.call(`/api/v1/operations/${job.operation.id}`)).status).toBe(200);
  await dispatch(job.outboxId);
  expect(await consume(job.outboxId)).toEqual({ acked: 1, retried: 0 });
  const completed = await status(f, job.path);
  expect(completed).toMatchObject({
    state: "completed",
    completedBlobs: 1,
    completedBytes: 3,
    heldBytes: 0,
  });
  expect(completed.publishedRootId).toBe(job.id + "_n00001");
  expect((await accepted(await f.create())).id).toBe(job.id);
  expect(await jobCount(f.target.ids.user)).toBe(1);
  expect((await f.call(job.path + "/cancel", { method: "POST", body: "{}" })).status).toBe(409);
  expect(await auditOwnerLedger(env.DB, f.target.ids.user)).toMatchObject({
    used_bytes: 6,
    physical_bytes: 3,
    reserved_bytes: 0,
    incorrect_refs: 0,
  });
});

it.each([false, true])(
  "preserves synchronous same-owner COW with explicit destination=%s",
  async (explicit) => {
    const f = await fixture();
    const search = searchName("File");
    await env.DB.batch([
      env.DB.prepare(
        "INSERT INTO search_index(node_id,space_id,text_norm,tokens,normalization_version,revision) VALUES(?,?,?,?,?,1)",
      ).bind(f.target.ids.file, f.target.ids.space, search.textNorm, search.tokens, search.version),
      env.DB.prepare(
        "INSERT INTO search_fts(rowid,text_norm,tokens) SELECT rowid,text_norm,tokens FROM search_index WHERE node_id=?",
      ).bind(f.target.ids.file),
    ]);
    const response = await f.call(`/api/v1/nodes/${f.target.ids.file}/copy`, {
      method: "POST",
      body: JSON.stringify({
        spaceId: f.target.ids.space,
        destinationParentId: f.target.ids.folder,
        name: "COW",
        depth: "0",
        ...(explicit ? { destination: { spaceId: f.target.ids.space, share: null } } : {}),
      }),
    });
    expect(response.status).toBe(201);
    const operation = await response.json<{ result: { nodeId: string; jobId?: string } }>();
    expect(operation.result.jobId).toBeUndefined();
    expect(
      await env.DB.prepare("SELECT current_blob_id FROM nodes WHERE id=?")
        .bind(operation.result.nodeId)
        .first("current_blob_id"),
    ).toBe(f.target.ids.blob);
    expect(await jobCount(f.target.ids.user)).toBe(0);
  },
);

it("keeps both selected grants explicit and never substitutes another edit grant", async () => {
  const f = await fixture();
  await observeTarget(f);
  const edit = await createInternalShare(mutationEnv(), f.session, {
    kind: "internal",
    rootNodeId: f.source.ids.folder,
    recipients: [f.target.ids.user + "@example.invalid"],
    role: "edit",
    expiresAt: null,
  });
  const target = {
    spaceId: f.source.ids.space,
    share: { id: f.share.id, version: f.share.version },
  };
  const body = {
    spaceId: f.target.ids.space,
    destination: target,
    destinationParentId: f.source.ids.folder,
    name: "Into shared",
    depth: "0",
  };
  const path = `/api/v1/nodes/${f.target.ids.file}/copy`;
  expect((await f.call(path, { method: "POST", body: JSON.stringify(body) })).status).toBe(404);
  const job = await accepted(
    await f.call(path, {
      method: "POST",
      body: JSON.stringify({
        ...body,
        destination: { ...target, share: { id: edit.id, version: edit.version } },
      }),
      headers: { "Idempotency-Key": crypto.randomUUID() },
    }),
  );
  expect((await status(f, job.path)).heldBytes).toBe(3);
  // A valid overlapping edit grant cannot replace the originally chosen source read grant.
  await f.revoke();
  expect((await f.create()).status).toBe(404);
  expect((await f.create({ share: undefined })).status).toBe(404);
});

it.each([
  null,
  {},
  [],
  { spaceId: "x" },
  { spaceId: "x", share: {} },
  { spaceId: "x", share: null, extra: true },
  { spaceId: "../x", share: null },
])("rejects malformed destination selection %j before acceptance", async (destination) => {
  const f = await fixture();
  expect((await f.create({ destination })).status).toBe(400);
  expect(await jobCount(f.target.ids.user)).toBe(0);
});

it("enforces CSRF, JSON bounds and host/path constraints before creating or stopping a job", async () => {
  const f = await fixture();
  for (const headers of [
    { "X-CSRF-Token": "" },
    { Origin: "https://elsewhere.invalid" },
    { "Sec-Fetch-Site": "cross-site" },
  ])
    expect((await f.create({}, env.DB, { headers })).status).toBe(403);
  for (const body of ["[]", "null", "{", JSON.stringify({ ...f.body, name: "x".repeat(9000) })])
    expect((await f.call(f.path, { method: "POST", body })).status).toBe(400);
  expect(await jobCount(f.target.ids.user)).toBe(0);
  const job = await accepted(await f.create());
  expect(
    (
      await f.call(job.path + "/cancel", {
        method: "POST",
        body: "{}",
        headers: { "X-CSRF-Token": "" },
      })
    ).status,
  ).toBe(403);
  for (const body of ["[]", "null", "{", '{"share":null}', " ".repeat(8193)])
    expect((await f.call(job.path + "/cancel", { method: "POST", body })).status).toBe(400);
  expect((await f.call(job.path + "?share=other")).status).toBe(404);
  expect((await f.call(job.path + "/retry", { method: "POST", body: "{}" })).status).toBe(409);
  expect(
    (
      await handleCopyJobHttp(
        new Request("https://elsewhere.invalid" + job.path),
        app(),
        f.principal,
        csrf,
      )
    ).status,
  ).toBe(404);
  expect((await status(f, job.path)).state).toBe("pending");
});

it.each(["missing", "actor", "credential", "source_revoke", "destination_revoke"])(
  "hides jobs and refuses cancellation for %s",
  async (mode) => {
    const f = await fixture();
    let job;
    if (mode === "destination_revoke") {
      await observeTarget(f);
      const share = await updateInternalShare(
        mutationEnv(),
        f.session,
        f.share.id,
        f.share.version,
        {
          kind: "internal",
          rootNodeId: f.source.ids.folder,
          recipients: [f.target.ids.user + "@example.invalid"],
          role: "edit",
          expiresAt: null,
        },
      );
      job = await accepted(
        await f.call(`/api/v1/nodes/${f.target.ids.file}/copy`, {
          method: "POST",
          body: JSON.stringify({
            spaceId: f.target.ids.space,
            destination: {
              spaceId: f.source.ids.space,
              share: { id: share.id, version: share.version },
            },
            destinationParentId: f.source.ids.folder,
            name: "Revoked target",
            depth: "0",
          }),
        }),
      );
      await updateInternalShare(mutationEnv(), f.session, share.id, share.version, null);
    } else job = await accepted(await f.create());
    let actor = f.principal;
    if (mode === "actor") actor = { ...actor, user_id: f.source.ids.user };
    if (mode === "credential") actor = { ...actor, credential_id: f.source.ids.credential };
    if (mode === "source_revoke") await f.revoke();
    const path = mode === "missing" ? "/api/v1/jobs/copy_" + "0".repeat(64) : job.path;
    expect((await f.call(path, {}, env.DB, actor)).status).toBe(404);
    const response = await f.call(path + "/cancel", { method: "POST", body: "{}" }, env.DB, actor);
    expect([403, 404]).toContain(response.status);
    expect([403, 404]).toContain(
      (await f.call(path + "/retry", { method: "POST", body: "{}" }, env.DB, actor)).status,
    );
    expect(
      await env.DB.prepare("SELECT state FROM bulk_jobs WHERE id=?").bind(job.id).first("state"),
    ).toBe("pending");
  },
);

it("cancels idempotently without refunding holds until Queue proves cleanup", async () => {
  const f = await fixture(),
    job = await accepted(await f.create());
  const db = injectBatch(
    (s) => s.startsWith("UPDATE bulk_jobs SET state="),
    async () => {
      throw new Error("lost_cancel_ack");
    },
    true,
  );
  const cancel = () => f.call(job.path + "/cancel", { method: "POST", body: "{}" });
  const first = await f.call(job.path + "/cancel", { method: "POST", body: "{}" }, db);
  expect(first.status).toBe(200);
  expect(await first.json()).toMatchObject({
    state: "cancelled",
    cleanupPending: 1,
    heldBytes: 3,
    completedBytes: 0,
  });
  expect((await cancel()).status).toBe(200);
  expect(await auditOwnerLedger(env.DB, f.target.ids.user)).toMatchObject({ reserved_bytes: 3 });
  expect(await consume(job.outboxId)).toEqual({ acked: 1, retried: 0 });
  expect(await status(f, job.path)).toMatchObject({
    state: "cancelled",
    cleanupPending: 0,
    heldBytes: 0,
    completedBytes: 0,
  });
});

it("recovers acceptance ACK loss and keeps replay and changed-intent handling stable", async () => {
  const f = await fixture();
  const db = injectBatch(
    (s) => s.startsWith("INSERT INTO bulk_jobs"),
    async () => {
      throw new Error("lost_ack");
    },
    true,
  );
  const first = await accepted(await f.create({}, db));
  await env.DB.prepare("UPDATE nodes SET client_mtime=42 WHERE id=?").bind(f.source.ids.file).run();
  expect((await accepted(await f.create())).id).toBe(first.id);
  expect((await f.create({ name: "Different intent" })).status).toBe(409);
  expect(await jobCount(f.target.ids.user)).toBe(1);
});

it("exposes an uncertain acceptance through Operation-Id without accepting a duplicate job", async () => {
  const f = await fixture();
  let lost = false;
  const injected = injectBatch(
    (s) => s.startsWith("INSERT INTO bulk_jobs"),
    async () => {
      lost = true;
      throw new Error("lost_acceptance_ack");
    },
    true,
  );
  const db = new Proxy(injected, {
    get(target, key) {
      if (key === "prepare")
        return (sql: string) => {
          if (lost) throw new Error("reconciliation_unavailable");
          return target.prepare(sql);
        };
      const value = Reflect.get(target, key);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  const response = await f.create({}, db);
  expect(response.status).toBe(503);
  expect(await response.json()).toMatchObject({ title: "commit_unknown" });
  const operationId = response.headers.get("Operation-Id");
  expect(operationId).toMatch(/^op_[a-f0-9]{64}$/);
  const lookup = await f.call(`/api/v1/operations/${operationId}`);
  expect(lookup.status).toBe(200);
  expect(await lookup.json()).toMatchObject({ state: "committed", result: { status: 202 } });
  expect((await accepted(await f.create())).operation.id).toBe(operationId);
  expect(await jobCount(f.target.ids.user)).toBe(1);
});

it("reports multipart checkpoint bytes separately from completed blobs and publication", async () => {
  const f = await fixture(9 * 1024 * 1024),
    job = await accepted(await f.create());
  await dispatch(job.outboxId);
  expect(
    await executeCopyJob(app(), job.outboxId, { maxSteps: 2, partBytes: 8 * 1024 * 1024 }),
  ).toMatchObject({ state: "yielded", steps: 2 });
  expect(await status(f, job.path)).toMatchObject({
    state: "running",
    completedBlobs: 0,
    completedBytes: 8 * 1024 * 1024,
    totalBytes: 9 * 1024 * 1024,
    publishedRootId: null,
  });
  expect(await executeCopyJob(app(), job.outboxId, { partBytes: 8 * 1024 * 1024 })).toMatchObject({
    state: "completed",
  });
  expect(await status(f, job.path)).toMatchObject({
    state: "completed",
    completedBlobs: 1,
    completedBytes: 9 * 1024 * 1024,
    heldBytes: 0,
  });
});

it("reads a completed overwrite using its publication proof after the old target is trashed", async () => {
  const f = await fixture();
  await observeTarget(f);
  const job = await accepted(
    await f.call(`/api/v1/nodes/${f.source.ids.file}/copy`, {
      method: "POST",
      body: JSON.stringify({
        ...f.body,
        name: "File",
        overwriteTargetId: f.target.ids.file,
      }),
    }),
  );
  await dispatch(job.outboxId);
  expect(await consume(job.outboxId)).toEqual({ acked: 1, retried: 0 });
  expect(
    await env.DB.prepare("SELECT deleted_at FROM nodes WHERE id=?")
      .bind(f.target.ids.file)
      .first("deleted_at"),
  ).not.toBeNull();
  expect(await status(f, job.path)).toMatchObject({
    state: "completed",
    publishedRootId: job.id + "_n00001",
  });
});

it.each(["read", "cancel"])("fences a concurrent publication during job %s", async (action) => {
  const f = await fixture(),
    job = await accepted(await f.create());
  await dispatch(job.outboxId);
  const db = injectBatch(
    (s) =>
      s.startsWith(
        action === "read" ? "SELECT j.id,j.state,j.checkpoint" : "UPDATE bulk_jobs SET state=",
      ),
    async () => {
      expect(await executeCopyJob(app(), job.outboxId)).toMatchObject({ state: "completed" });
    },
    false,
  );
  const response =
    action === "read"
      ? await f.call(job.path, {}, db)
      : await f.call(job.path + "/cancel", { method: "POST", body: "{}" }, db);
  expect(response.status).toBe(action === "read" ? 503 : 409);
  expect(await status(f, job.path)).toMatchObject({ state: "completed", completedBytes: 3 });
});

it("hides a published node moved outside the originally selected destination share", async () => {
  const f = await fixture();
  await observeTarget(f);
  const share = await updateInternalShare(mutationEnv(), f.session, f.share.id, f.share.version, {
    kind: "internal",
    rootNodeId: f.source.ids.folder,
    recipients: [f.target.ids.user + "@example.invalid"],
    role: "edit",
    expiresAt: null,
  });
  const job = await accepted(
    await f.call(`/api/v1/nodes/${f.target.ids.file}/copy`, {
      method: "POST",
      body: JSON.stringify({
        spaceId: f.target.ids.space,
        destination: {
          spaceId: f.source.ids.space,
          share: { id: share.id, version: share.version },
        },
        destinationParentId: f.source.ids.folder,
        name: "Shared result",
        depth: "0",
      }),
    }),
  );
  await dispatch(job.outboxId);
  expect(await consume(job.outboxId)).toEqual({ acked: 1, retried: 0 });
  const completed = await status(f, job.path);
  expect(completed.state).toBe("completed");
  await env.DB.prepare("UPDATE nodes SET parent_id=? WHERE id=?")
    .bind(f.source.ids.root, completed.publishedRootId)
    .run();
  expect((await f.call(job.path)).status).toBe(404);
});

it("keeps uncertain native writes held after HTTP cancellation", async () => {
  const f = await fixture(),
    job = await accepted(await f.create());
  await dispatch(job.outboxId);
  await expect(
    executeCopyJob(
      {
        ...app(),
        BLOBS: {
          get: env.BLOBS.get.bind(env.BLOBS),
          put: async () => {
            throw new Error("unknown_native_result");
          },
        } as unknown as R2Bucket,
      },
      job.outboxId,
    ),
  ).rejects.toThrow();
  const cancelled = await f.call(job.path + "/cancel", { method: "POST", body: "{}" });
  expect(cancelled.status).toBe(200);
  expect(await cancelled.json()).toMatchObject({
    state: "cancelled",
    cleanupPending: 1,
    heldBytes: 3,
  });
  expect(await consume(job.outboxId)).toEqual({ acked: 0, retried: 1 });
  expect(await status(f, job.path)).toMatchObject({ cleanupPending: 1, heldBytes: 3 });
});

it("routes creation, read and cancel through real Access login and CSRF verification", async () => {
  const f = await fixture(),
    access = await accessFixture();
  const signed = await access.sign({
    sub: f.target.ids.user,
    email: f.target.ids.user + "@example.invalid",
  });
  const jwt = signed.headers.get("Cf-Access-Jwt-Assertion")!;
  const ring = await contentKeyRing("test", {
    test: base64url.encode(crypto.getRandomValues(new Uint8Array(32))),
  });
  const dependencies = {
    verifier: access.verifier,
    csrf,
    tokens: new ContentTokens(ring, ring, "https://content.invalid"),
    bootstrap: { ownerEmails: [], ownerIdentities: [], quotaBytes: 10_000_000 },
  };
  const call = (path: string, init: RequestInit = {}) => {
    const request = new Request(origin + path, {
      ...init,
      headers: { "Cf-Access-Jwt-Assertion": jwt, ...Object.fromEntries(new Headers(init.headers)) },
    });
    expect(privateAppRoute(request)).toBe(true);
    return handlePrivateAppHttp(request, app(), 1, dependencies);
  };
  expect(
    (
      await handlePrivateAppHttp(
        new Request(origin + f.path, { method: "POST" }),
        app(),
        1,
        dependencies,
      )
    ).status,
  ).toBe(401);
  const issued = await call("/api/v1/csrf", {
    method: "POST",
    headers: { "Sec-Fetch-Site": "same-origin" },
  });
  expect(issued.status).toBe(201);
  const headers = { ...f.headers, "X-CSRF-Token": (await issued.json<{ token: string }>()).token };
  const job = await accepted(
    await call(f.path, { method: "POST", headers, body: JSON.stringify(f.body) }),
  );
  expect((await call(job.path)).status).toBe(200);
  expect((await call(job.path + "/cancel", { method: "POST", headers, body: "{}" })).status).toBe(
    200,
  );
  // The fixture's other Access credential for the same user is not the initiating session.
  expect((await f.call(job.path)).status).toBe(404);
  expect(copyJobRoute(new Request(origin + job.path + "/retry", { method: "POST" }))).toBe(true);
  expect(await consume(job.outboxId)).toEqual({ acked: 1, retried: 0 });
  const retried = await accepted(
    await call(job.path + "/retry", {
      method: "POST",
      body: "{}",
      headers: { ...headers, "Idempotency-Key": crypto.randomUUID() },
    }),
  );
  expect(retried.id).not.toBe(job.id);
  expect((await f.call(retried.path)).status).toBe(404);
});

const retry = (f: Fixture, path: string, key = crypto.randomUUID(), db = env.DB) =>
  f.call(path + "/retry", { method: "POST", body: "{}", headers: { "Idempotency-Key": key } }, db);
async function stopped(f: Fixture, job: Awaited<ReturnType<typeof accepted>>) {
  expect((await f.call(job.path + "/cancel", { method: "POST", body: "{}" })).status).toBe(200);
  expect(await consume(job.outboxId)).toEqual({ acked: 1, retried: 0 });
}

it("retries a closed copy with fresh contents and keys, retaining exactly one accepted successor", async () => {
  const f = await fixture(),
    original = await accepted(await f.create());
  expect((await retry(f, original.path)).status).toBe(409);
  expect((await f.call(original.path + "/cancel", { method: "POST", body: "{}" })).status).toBe(
    200,
  );
  const held = await retry(f, original.path);
  expect(held.status).toBe(409);
  expect(await held.json()).toMatchObject({ title: "copy_retry_cleanup_pending" });
  expect(await jobCount(f.target.ids.user)).toBe(1);
  await consume(original.outboxId);
  const extra = await createFolder(app(), {
    principal: {
      kind: "user",
      user_id: f.source.ids.user,
      credential_id: f.source.ids.credential,
      epoch: 1,
    },
    idempotencyKey: crypto.randomUUID(),
    spaceId: f.source.ids.space,
    parentId: f.source.ids.folder,
    name: "Added after original acceptance",
    lockTokens: [],
  });
  expect(extra.kind).toBe("terminal");
  const key = crypto.randomUUID(),
    child = await accepted(await retry(f, original.path, key));
  expect(child.id).not.toBe(original.id);
  expect((await accepted(await retry(f, original.path, key))).id).toBe(child.id);
  expect((await accepted(await retry(f, original.path))).id).toBe(child.id);
  expect(await status(f, original.path)).toMatchObject({
    state: "cancelled",
    nodeCount: 2,
    heldBytes: 0,
    retryJobId: child.id,
  });
  expect(await status(f, child.path)).toMatchObject({
    state: "pending",
    nodeCount: 3,
    heldBytes: 3,
    retryJobId: null,
  });
  expect(await jobCount(f.target.ids.user)).toBe(2);
  await dispatch(child.outboxId);
  expect(await consume(child.outboxId)).toEqual({ acked: 1, retried: 0 });
  expect((await accepted(await retry(f, original.path))).id).toBe(child.id);
  expect(await auditOwnerLedger(env.DB, f.target.ids.user)).toMatchObject({
    used_bytes: 6,
    reserved_bytes: 0,
    physical_bytes: 3,
    incorrect_refs: 0,
  });
  expect(
    await env.BLOBS.get(`u/${f.target.ids.user}/b/${child.id}_b00001`).then((o) => o?.text()),
  ).toBe("abc");
});

it("recovers a lost retry commit acknowledgement without accepting a second successor", async () => {
  const f = await fixture(),
    original = await accepted(await f.create());
  await stopped(f, original);
  const db = injectBatch(
    (s) => s.startsWith("INSERT INTO bulk_jobs"),
    async () => {
      throw new Error("lost_retry_ack");
    },
    true,
  );
  const key = crypto.randomUUID(),
    child = await accepted(await retry(f, original.path, key, db));
  expect((await accepted(await retry(f, original.path, key))).id).toBe(child.id);
  expect(await jobCount(f.target.ids.user)).toBe(2);
  expect(await auditOwnerLedger(env.DB, f.target.ids.user)).toMatchObject({ reserved_bytes: 3 });
});

it("converges concurrent retry requests with different keys onto one accepted job", async () => {
  const f = await fixture(),
    original = await accepted(await f.create());
  await stopped(f, original);
  const keys = [crypto.randomUUID(), crypto.randomUUID()];
  const results = await Promise.all(keys.map((key) => retry(f, original.path, key)));
  for (const response of results) expect([202, 503]).toContain(response.status);
  const first = await accepted(await retry(f, original.path, keys[0]!));
  expect((await accepted(await retry(f, original.path, keys[1]!))).id).toBe(first.id);
  expect(await jobCount(f.target.ids.user)).toBe(2);
  expect(await auditOwnerLedger(env.DB, f.target.ids.user)).toMatchObject({ reserved_bytes: 3 });
});

it.each(["name", "parent", "depth", "held", "duplicate"])(
  "fences invalid retry %s in the acceptance transaction",
  async (mode) => {
    const f = await fixture(),
      original = await accepted(await f.create());
    if (mode !== "held") await stopped(f, original);
    let child: Awaited<ReturnType<typeof accepted>> | undefined;
    if (mode === "duplicate") child = await accepted(await retry(f, original.path));
    const outcome = await createCopyJob(app(), {
      ...f.request,
      name: mode === "name" ? "Different" : f.body.name,
      destinationParentId: mode === "parent" ? f.target.ids.root : f.request.destinationParentId,
      depth: mode === "depth" ? "0" : "infinity",
      requestId: crypto.randomUUID(),
      retryOf: original.id,
    });
    expect(outcome.kind === "terminal" && outcome.operation.state === "committed").toBe(false);
    expect(await jobCount(f.target.ids.user)).toBe(child ? 2 : 1);
    expect(await auditOwnerLedger(env.DB, f.target.ids.user)).toMatchObject({
      reserved_bytes: mode === "held" || child ? 3 : 0,
    });
  },
);

it("rejects authorization revocation immediately before retry acceptance", async () => {
  const f = await fixture(),
    original = await accepted(await f.create());
  await stopped(f, original);
  const db = injectBatch(
    (s) => s.startsWith("INSERT INTO bulk_jobs"),
    async () => {
      await f.revoke();
    },
    false,
  );
  expect((await retry(f, original.path, crypto.randomUUID(), db)).status).not.toBe(202);
  expect(await jobCount(f.target.ids.user)).toBe(1);
  expect(await auditOwnerLedger(env.DB, f.target.ids.user)).toMatchObject({ reserved_bytes: 0 });
});

it("requires CSRF, an idempotency key and an empty bounded JSON body for retry", async () => {
  const f = await fixture(),
    original = await accepted(await f.create());
  await stopped(f, original);
  for (const headers of [{ "X-CSRF-Token": "" }, { Origin: "https://elsewhere.invalid" }])
    expect(
      (await f.call(original.path + "/retry", { method: "POST", body: "{}", headers })).status,
    ).toBe(403);
  for (const body of ["null", "[]", "{", '{"destination":{}}', " ".repeat(8193)])
    expect((await f.call(original.path + "/retry", { method: "POST", body })).status).toBe(400);
  for (const key of ["", "x,y", "x".repeat(201)])
    expect((await retry(f, original.path, key)).status).toBe(400);
  expect(await jobCount(f.target.ids.user)).toBe(1);
});

it("replays an accepted overwrite retry after the old target was trashed by publication", async () => {
  const f = await fixture();
  await observeTarget(f);
  const original = await accepted(
    await f.call(`/api/v1/nodes/${f.source.ids.file}/copy`, {
      method: "POST",
      body: JSON.stringify({ ...f.body, name: "File", overwriteTargetId: f.target.ids.file }),
    }),
  );
  await stopped(f, original);
  const child = await accepted(await retry(f, original.path));
  await dispatch(child.outboxId);
  expect(await consume(child.outboxId)).toEqual({ acked: 1, retried: 0 });
  expect((await accepted(await retry(f, original.path))).id).toBe(child.id);
  expect(await jobCount(f.target.ids.user)).toBe(2);
});

it("retries a budget-stopped job and permits another retry only from its stopped successor", async () => {
  const f = await fixture(),
    original = await accepted(await f.create());
  await env.DB.prepare("UPDATE bulk_jobs SET invocation_count=200 WHERE id=?")
    .bind(original.id)
    .run();
  expect(await stopExpiredCopyJob(mutationEnv(), original.id)).toBe(true);
  expect(await consume(original.outboxId)).toEqual({ acked: 1, retried: 0 });
  const child = await accepted(await retry(f, original.path));
  await stopped(f, child);
  const next = await accepted(await retry(f, child.path));
  expect((await accepted(await retry(f, original.path))).id).toBe(child.id);
  expect(next.id).not.toBe(child.id);
  expect(
    await env.DB.prepare("SELECT invocation_count FROM bulk_jobs WHERE id=?")
      .bind(original.id)
      .first("invocation_count"),
  ).toBe(200);
  expect(await status(f, original.path)).toMatchObject({
    state: "failed",
    errorCode: "copy_budget_exhausted",
    retryJobId: child.id,
  });
  expect(await jobCount(f.target.ids.user)).toBe(3);
  expect(await auditOwnerLedger(env.DB, f.target.ids.user)).toMatchObject({ reserved_bytes: 3 });
});

it("allows a fresh key after a rejected retry without changing an uncertain or accepted successor", async () => {
  const f = await fixture(),
    original = await accepted(await f.create());
  await stopped(f, original);
  await env.DB.prepare("UPDATE users SET quota_bytes=3 WHERE id=?").bind(f.target.ids.user).run();
  const key = crypto.randomUUID();
  expect((await retry(f, original.path, key)).status).toBe(409);
  expect(await jobCount(f.target.ids.user)).toBe(1);
  expect((await status(f, original.path)).retryJobId).toBeNull();
  await env.DB.prepare("UPDATE users SET quota_bytes=1000000 WHERE id=?")
    .bind(f.target.ids.user)
    .run();
  expect((await retry(f, original.path, key)).status).toBe(409);
  const child = await accepted(await retry(f, original.path));
  expect((await accepted(await retry(f, original.path, key))).id).toBe(child.id);
  expect(await jobCount(f.target.ids.user)).toBe(2);
});
