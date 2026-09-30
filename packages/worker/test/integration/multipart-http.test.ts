import { applyD1Migrations, runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { base64url } from "jose";
import { beforeAll, beforeEach, expect, it } from "vitest";
import { handlePrivateAppHttp } from "../../src/api/privateApp";
import { handleUploadHttp, uploadRoute } from "../../src/api/uploads";
import type { Principal } from "../../src/auth/authorize";
import { ContentTokens, contentKeyRing } from "../../src/auth/contentTokens";
import { CsrfTokens, csrfKeyRing } from "../../src/auth/csrf";
import { UploadCapabilities } from "../../src/auth/uploadCapability";
import { atomicBatch } from "../../src/db/primary";
import type { Env } from "../../src/env";
import { repairMultipartUploads } from "../../src/jobs/multipartCleanup";
import { digestJson } from "../../src/jobs/operations";
import { uploadRow } from "../../src/services/uploads/access";
import type { UploadPartReceipt } from "../../src/services/uploads/read";
import { accessFixture } from "../fixtures/access";
import { foundationFixture } from "../fixtures/foundation";
import { mutationEnv } from "../fixtures/mutationAdmission";
import { admitted, injectBatch } from "../fixtures/uploadEnv";

beforeAll(async () => applyD1Migrations(env.DB, env.TEST_MIGRATIONS));
beforeEach(async () => {
  await env.DB.prepare("UPDATE control SET epoch=1,maintenance=0,gc_paused=0").run();
  await env.DB.prepare(
    "UPDATE uploads SET cleanup_next_at=9999999999999 WHERE mode='multipart'",
  ).run();
});
interface Receipt {
  id: string;
  capability: string;
  state: string;
  cleanupPending: boolean;
  parts: UploadPartReceipt[];
  nextAfter: number | null;
  revision: number;
}
async function fixture() {
  const f = foundationFixture(crypto.randomUUID(), Date.now() - 1000);
  await atomicBatch(env.DB, f.statements);
  await env.DB.prepare("UPDATE users SET quota_bytes=1000000000000 WHERE id=?")
    .bind(f.ids.user)
    .run();
  const principal: Principal = {
    kind: "user",
    user_id: f.ids.user,
    credential_id: f.ids.credential,
    epoch: 1,
  };
  const app = admitted();
  app.APP_ORIGIN = "https://app.invalid";
  const secret = base64url.encode(crypto.getRandomValues(new Uint8Array(32)));
  const capabilities = new UploadCapabilities(await contentKeyRing("test", { test: secret }));
  const ring = await csrfKeyRing("test", { test: secret });
  const csrf = new CsrfTokens(ring, ring, app.APP_ORIGIN);
  const issued = await csrf.issue(
    env.DB,
    new Request(`${app.APP_ORIGIN}/api/v1/csrf`, {
      method: "POST",
      headers: { "Sec-Fetch-Site": "same-origin" },
    }),
    { kind: "access", credentialId: principal.credential_id, epoch: 1 },
  );
  const send = (
    path: string,
    method: string,
    body?: BodyInit,
    extra: Record<string, string> = {},
  ) =>
    handleUploadHttp(
      new Request(`${app.APP_ORIGIN}${path}`, {
        method,
        headers: {
          Origin: app.APP_ORIGIN,
          "Content-Type": "application/json",
          "Sec-Fetch-Site": "same-origin",
          "X-CSRF-Token": issued.token,
          "Idempotency-Key": "request",
          ...extra,
        },
        ...(body !== undefined ? { body } : {}),
      }),
      app,
      principal,
      csrf,
      capabilities,
    );
  const create = (body: Record<string, unknown> = {}, key = crypto.randomUUID()) =>
    send(
      "/api/v1/uploads",
      "POST",
      JSON.stringify({
        mode: "multipart",
        spaceId: f.ids.space,
        parentId: f.ids.folder,
        name: "http.bin",
        declared_size: 3,
        ...body,
      }),
      { "Idempotency-Key": key },
    );
  return { ...f, app, principal, csrf, capabilities, send, create };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
async function created(f: Fixture, body: Record<string, unknown> = {}) {
  const response = await f.create(body);
  expect(response.status).toBe(201);
  return response.json<Receipt>();
}
const path = (r: Receipt) => `/api/v1/uploads/${r.id}`;
const cap = (r: Receipt) => ({ "Upload-Capability": r.capability });
const part = (f: Fixture, r: Receipt, headers: Record<string, string> = {}) =>
  f.send(`${path(r)}/parts/1`, "PUT", "abc", {
    ...cap(r),
    "Content-Length": "3",
    "Upload-Attempt-Id": "one",
    "Content-Type": "application/octet-stream",
    "X-CSRF-Token": "",
    ...headers,
  });
function replaceBucket(app: Env, overrides: Partial<R2Bucket>) {
  app.BLOBS = new Proxy(env.BLOBS, {
    get(target, key) {
      const value = Reflect.get(overrides, key) ?? Reflect.get(target, key);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}
const stub = (f: Fixture, r: Receipt) => f.app.UPLOADS.get(f.app.UPLOADS.idFromName(r.id));
const rpc = (f: Fixture, r: Receipt) => ({
  principal: f.principal,
  uploadId: r.id,
  capability: r.capability,
});

it("connects multipart HTTP create/part/status/complete and replays without another R2 write", async () => {
  const f = await fixture();
  const r = await created(f);
  expect(r).toMatchObject({ state: "created", parts: [], nextAfter: null });
  expect(await uploadRow(env.DB, r.id)).toMatchObject({ declared_size: 3, part_count: 1 });
  expect((await part(f, r)).status).toBe(200);
  expect((await part(f, r)).status).toBe(200);
  expect(await uploadRow(env.DB, r.id)).toMatchObject({ data_calls: 1, data_bytes: 3 });
  const progress = await f.send(`${path(r)}?after=0&limit=1`, "GET", undefined, cap(r));
  expect(progress.status).toBe(200);
  expect(progress.headers.get("Cache-Control")).toBe("private, no-store");
  expect(await progress.json()).toMatchObject({
    parts: [
      {
        partNumber: 1,
        attemptId: "one",
        state: "completed",
        expectedBytes: 3,
        sha256: "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
      },
    ],
    nextAfter: null,
  });
  const done = await f.send(`${path(r)}/complete`, "POST", "{}", cap(r));
  expect(done.status).toBe(200);
  const operation = await done.json<{ opId: string; result: { nodeId: string } }>();
  expect(await (await f.send(`${path(r)}/complete`, "POST", "{}", cap(r))).json()).toEqual(
    operation,
  );
  expect(await (await f.send(path(r), "GET", undefined, cap(r))).json()).toMatchObject({
    state: "completed",
  });
  expect(
    await env.DB.prepare("SELECT current_blob_id FROM nodes WHERE id=?")
      .bind(operation.result.nodeId)
      .first("current_blob_id"),
  ).toBe(`${r.id}_blob`);
  const object = await env.BLOBS.get(`u/${f.ids.user}/b/${r.id}_blob`);
  expect(await object!.text()).toBe("abc");
  expect((await f.send(path(r), "DELETE", "{}", cap(r))).status).toBe(409);
});

it("requires the current If-Match before multipart overwrite parts and retains the old version", async () => {
  const f = await fixture();
  const first = await created(f);
  expect((await part(f, first)).status).toBe(200);
  const initial = await (await f.send(`${path(first)}/complete`, "POST", "{}", cap(first))).json<{
    result: { nodeId: string };
  }>();
  const r = await created(f, { targetId: initial.result.nodeId, targetRevision: 1 });
  expect((await part(f, r)).status).toBe(428);
  expect((await part(f, r, { "If-Match": '"wrong"' })).status).toBe(412);
  expect(await uploadRow(env.DB, r.id)).toMatchObject({ data_calls: 0 });
  expect((await part(f, r, { "If-Match": `"b-${first.id}_blob"` })).status).toBe(200);
  expect(
    (
      await f.send(`${path(r)}/complete`, "POST", "{}", {
        ...cap(r),
        "Idempotency-Key": "overwrite",
      })
    ).status,
  ).toBe(200);
  expect(
    await env.DB.prepare("SELECT blob_id FROM node_versions WHERE node_id=?")
      .bind(initial.result.nodeId)
      .first("blob_id"),
  ).toBe(`${first.id}_blob`);
});

it.each(["single", "multipart"] as const)(
  "recovers the same %s create receipt after a competing overwrite without permitting a stale write",
  async (mode) => {
    const f = await fixture();
    let initialized = 0;
    replaceBucket(f.app, {
      async createMultipartUpload(key, options) {
        initialized++;
        return env.BLOBS.createMultipartUpload(key, options);
      },
    });
    const seed = await created(f, { mode: "single", name: "receipt-target.bin" });
    expect(
      (
        await f.send(`${path(seed)}/content`, "PUT", "abc", {
          ...cap(seed),
          "Content-Length": "3",
        })
      ).status,
    ).toBe(200);
    const seeded = await f.send(`${path(seed)}/complete`, "POST", "{}", {
      ...cap(seed),
      "Idempotency-Key": "seed-complete",
    });
    expect(seeded.status).toBe(200);
    const {
      result: { nodeId },
    } = await seeded.json<{ result: { nodeId: string } }>();
    const body = { mode, name: "receipt-target.bin", targetId: nodeId, targetRevision: 1 };
    const first = await f.create(body, "lost-receipt");
    expect(first.status).toBe(201);
    const original = await first.json<Receipt>();

    // This actor commits newer content while the original caller has no receipt.
    const competing = await created(f, { ...body, mode: "single" });
    expect(
      (
        await f.send(`${path(competing)}/content`, "PUT", "new", {
          ...cap(competing),
          "Content-Length": "3",
          "If-Match": `"b-${seed.id}_blob"`,
        })
      ).status,
    ).toBe(200);
    expect((await f.send(`${path(competing)}/complete`, "POST", "{}", cap(competing))).status).toBe(
      200,
    );
    const counters = () =>
      env.DB.prepare("SELECT used_bytes,reserved_bytes,physical_bytes FROM users WHERE id=?")
        .bind(f.ids.user)
        .first();
    const before = await counters();
    const node = () =>
      env.DB.prepare("SELECT revision,current_blob_id FROM nodes WHERE id=?").bind(nodeId).first();
    const newer = await node();
    expect(newer).toMatchObject({ revision: 2, current_blob_id: `${competing.id}_blob` });

    const replay = await f.create(body, "lost-receipt");
    expect(replay.status).toBe(mode === "single" ? 201 : 202);
    expect(await replay.json()).toEqual(original);
    expect(initialized).toBe(mode === "multipart" ? 1 : 0);
    expect(await counters()).toEqual(before);
    expect(await uploadRow(env.DB, original.id)).toMatchObject({
      target_id: nodeId,
      target_revision: 1,
      state: "created",
      data_calls: 0,
    });
    expect((await f.create({ ...body, declared_size: 4 }, "lost-receipt")).status).toBe(409);
    expect((await f.create(body, "new-stale-request")).status).toBe(409);
    const stale = await f.send(
      `${path(original)}/${mode === "single" ? "content" : "parts/1"}`,
      "PUT",
      "old",
      {
        ...cap(original),
        "Content-Length": "3",
        "Upload-Attempt-Id": "old",
        "If-Match": `"b-${seed.id}_blob"`,
      },
    );
    expect(stale.status).toBe(409);
    expect(
      (
        await f.send(`${path(original)}/complete`, "POST", "{}", {
          ...cap(original),
          "Idempotency-Key": "stale-complete",
        })
      ).status,
    ).toBe(409);
    expect(await counters()).toEqual(before);
    expect(await node()).toEqual(newer);
    expect((await f.send(path(original), "DELETE", "{}", cap(original))).status).toBe(
      mode === "single" ? 200 : 202,
    );
    expect(await uploadRow(env.DB, original.id)).toMatchObject({
      state: mode === "single" ? "aborted" : "aborting",
      data_calls: 0,
      cleanup_pending: 1,
    });
    expect(await node()).toEqual(newer);
    expect(await (await env.BLOBS.get(`u/${f.ids.user}/b/${competing.id}_blob`))?.text()).toBe(
      "new",
    );
    expect(await counters()).toMatchObject({ reserved_bytes: mode === "single" ? 0 : 3 });
    expect(initialized).toBe(mode === "multipart" ? 1 : 0);
  },
);

it.each(["single", "multipart"] as const)(
  "rechecks current authority before returning a changed-target %s create receipt",
  async (mode) => {
    const f = await fixture();
    const body = { mode, name: "File", targetId: f.ids.file, targetRevision: 1 };
    const original = await (await f.create(body, "revoke-replay")).json<Receipt>();
    const before = await uploadRow(env.DB, original.id);
    await env.DB.prepare("UPDATE nodes SET revision=revision+1 WHERE id=?").bind(f.ids.file).run();
    let revoked = false;
    f.app.DB = injectBatch(
      (sql) => sql.includes("SELECT 1 FROM uploads u JOIN control c"),
      async () => {
        revoked = true;
        await env.DB.prepare("UPDATE sessions SET revoked_at=? WHERE id=?")
          .bind(Date.now(), f.ids.session)
          .run();
      },
      false,
    );
    const response = await f.create(body, "revoke-replay");
    expect(revoked).toBe(true);
    expect(response.ok).toBe(false);
    const text = await response.text();
    expect(text).not.toContain(original.capability);
    expect(text).not.toContain(original.id);
    expect(await uploadRow(env.DB, original.id)).toEqual(before);
    expect(
      await env.DB.prepare("SELECT reserved_bytes FROM users WHERE id=?")
        .bind(f.ids.user)
        .first("reserved_bytes"),
    ).toBe(3);
  },
);

it("returns a cancellable receipt without initializing R2 when the target changes after reservation", async () => {
  const f = await fixture();
  let initialized = 0;
  replaceBucket(f.app, {
    async createMultipartUpload() {
      initialized++;
      throw new Error("must_not_initialize");
    },
  });
  f.app.DB = injectBatch(
    (sql) => sql.includes("INSERT INTO uploads"),
    async () => {
      await env.DB.prepare("UPDATE nodes SET revision=revision+1 WHERE id=?")
        .bind(f.ids.file)
        .run();
    },
    true,
  );
  const body = { name: "File", targetId: f.ids.file, targetRevision: 1 };
  const response = await f.create(body, "changed-before-init");
  expect(response.status).toBe(202);
  const receipt = await response.json<Receipt>();
  expect(await uploadRow(env.DB, receipt.id)).toMatchObject({
    state: "created",
    target_revision: 1,
    r2_upload_id: null,
    write_attempt_id: null,
    control_calls: 0,
  });
  const replay = await f.create(body, "changed-before-init");
  expect(replay.status).toBe(202);
  expect(await replay.json()).toEqual(receipt);
  expect((await f.send(path(receipt), "DELETE", "{}", cap(receipt))).status).toBe(202);
  expect(await uploadRow(env.DB, receipt.id)).toMatchObject({
    state: "aborting",
    cleanup_pending: 1,
  });
  expect(initialized).toBe(0);
});

it("returns a pending attempt without consuming or dispatching its replay body", async () => {
  const f = await fixture();
  const r = await created(f);
  await stub(f, r).claimPart({ ...rpc(f, r), partNumber: 1, attemptId: "one", bytes: 3 });
  replaceBucket(f.app, {
    resumeMultipartUpload: () => {
      throw new Error("must_not_dispatch");
    },
  });
  let cancelled = false;
  const response = await f.send(
    `${path(r)}/parts/1`,
    "PUT",
    new ReadableStream({
      cancel() {
        cancelled = true;
      },
    }),
    { ...cap(r), "Content-Length": "3", "Upload-Attempt-Id": "one" },
  );
  expect(response.status).toBe(202);
  expect(response.headers.get("Retry-After")).toBe("1");
  expect(await response.json()).toMatchObject({ disposition: "in_flight" });
  expect(cancelled).toBe(true);
  expect(await uploadRow(env.DB, r.id)).toMatchObject({ data_calls: 1 });
});

it("exposes bounded D1 part pages without resetting a lost DO journal", async () => {
  const f = await fixture();
  const r = await created(f, { declared_size: 201 * 67108864 });
  for (let start = 1; start <= 201; start += 50)
    await atomicBatch(
      env.DB,
      Array.from({ length: Math.min(50, 202 - start) }, (_, i) => ({
        sql: "INSERT INTO upload_parts(upload_id,part_number,attempts,attempt_id,state,expected_size,lease_expires_at,etag,sha256) VALUES(?,?,1,?,'completed',67108864,0,?,?)",
        values: [r.id, start + i, `p${start + i}`, `e${start + i}`, "a".repeat(64)],
      })),
    );
  await env.DB.prepare("UPDATE uploads SET data_calls=201,data_bytes=declared_size WHERE id=?")
    .bind(r.id)
    .run();
  await runInDurableObject(env.UPLOADS.get(env.UPLOADS.idFromName(r.id)), async (_, state) => {
    await state.storage.deleteAll();
  });
  const first = await (await f.send(path(r), "GET", undefined, cap(r))).json<Receipt>();
  expect(first.parts).toHaveLength(200);
  expect(first.nextAfter).toBe(200);
  const last = await (
    await f.send(`${path(r)}?after=200&limit=200`, "GET", undefined, cap(r))
  ).json<Receipt>();
  expect(last.parts).toHaveLength(1);
  expect(last.parts[0]!.partNumber).toBe(201);
  expect(last.nextAfter).toBeNull();
  expect(await uploadRow(env.DB, r.id)).toMatchObject({ data_calls: 201 });
  await runInDurableObject(env.UPLOADS.get(env.UPLOADS.idFromName(r.id)), async (_, state) => {
    expect(
      state.storage.sql
        .exec("SELECT COUNT(*) n FROM sqlite_master WHERE name='multipart_state'")
        .one().n,
    ).toBe(0);
  });
});

it.each([
  "?after=-1",
  "?after=01",
  "?after=10001",
  "?limit=0",
  "?limit=201",
  "?limit=1&limit=2",
  "?after=0&after=1",
  "?cursor=secret",
])("rejects malformed status pagination %s", async (query) => {
  const f = await fixture();
  const r = await created(f);
  expect((await f.send(`${path(r)}${query}`, "GET", undefined, cap(r))).status).toBe(400);
});

it.each([
  ["/parts/0", "PUT", 404],
  ["/parts/01", "PUT", 404],
  ["/parts/10001", "PUT", 400],
  ["/parts/1", "GET", 404],
  ["/parts/1/", "PUT", 404],
  ["/parts/1?limit=2", "PUT", 404],
  ["?after=0", "DELETE", 404],
] as const)("rejects a route/profile mismatch %s %s", async (suffix, method, status) => {
  const f = await fixture();
  const r = await created(f);
  expect(
    (
      await f.send(path(r) + suffix, method, method === "GET" ? undefined : "{}", {
        ...cap(r),
        "Content-Length": "2",
        "Upload-Attempt-Id": "one",
      })
    ).status,
  ).toBe(status);
  expect(await uploadRow(env.DB, r.id)).toMatchObject({ data_calls: 0 });
});

it.each([
  [{ "Content-Length": "" }, 400],
  [{ "Content-Length": "+3" }, 400],
  [{ "Content-Length": "95000001" }, 413],
  [{ "Content-Length": "2" }, 400],
  [{ "Upload-Attempt-Id": "" }, 400],
  [{ "Upload-Attempt-Id": "a,b" }, 400],
  [{ Origin: "https://other.invalid" }, 403],
  [{ "Upload-Capability": "invalid" }, 403],
] as const)("rejects invalid binary metadata %j", async (headers, status) => {
  const f = await fixture();
  const r = await created(f);
  expect((await part(f, r, headers)).status).toBe(status);
  expect(await uploadRow(env.DB, r.id)).toMatchObject({ data_calls: 0 });
});

it("rejects missing length, wrong mode, JSON CSRF omission, and incomplete completion", async () => {
  const f = await fixture();
  const r = await created(f);
  expect(
    (await f.send(`${path(r)}/parts/1`, "PUT", "abc", { ...cap(r), "Upload-Attempt-Id": "one" }))
      .status,
  ).toBe(411);
  expect(
    (await f.send(`${path(r)}/content`, "PUT", "abc", { ...cap(r), "Content-Length": "3" })).status,
  ).toBe(409);
  expect(
    (await f.send(`${path(r)}/complete`, "POST", "{}", { ...cap(r), "X-CSRF-Token": "" })).status,
  ).toBe(403);
  expect((await f.send(path(r), "DELETE", "{}", { ...cap(r), "X-CSRF-Token": "" })).status).toBe(
    403,
  );
  expect((await f.send(`${path(r)}/complete`, "POST", "{}", cap(r))).status).toBe(409);
  expect((await f.create({ mode: "multipart", declared_size: 0 })).status).toBe(400);
  const single = await created(f, { mode: "single", name: "single.bin" });
  expect((await part(f, single)).status).toBe(409);
  expect((await f.send(`${path(single)}?after=0`, "GET", undefined, cap(single))).status).toBe(400);
});

it("stops an upload through HTTP, refuses late parts, and keeps its receipt after R2 cleanup", async () => {
  const f = await fixture();
  const r = await created(f);
  expect((await f.send(path(r), "DELETE", "{}", cap(r))).status).toBe(202);
  expect((await part(f, r)).status).toBe(409);
  expect((await f.send(path(r), "DELETE", "{}", cap(r))).status).toBe(202);
  expect(await uploadRow(env.DB, r.id)).toMatchObject({
    state: "aborting",
    cleanup_pending: 1,
    data_calls: 0,
  });
  await repairMultipartUploads(mutationEnv(), env.BLOBS, 1);
  expect(await (await f.send(path(r), "GET", undefined, cap(r))).json()).toMatchObject({
    state: "aborted",
    cleanupPending: false,
  });
  expect((await f.send(path(r), "DELETE", "{}", cap(r))).status).toBe(202);
  expect((await part(f, r)).status).toBe(409);
  expect(
    await env.DB.prepare("SELECT reserved_bytes FROM users WHERE id=?")
      .bind(f.ids.user)
      .first("reserved_bytes"),
  ).toBe(0);
});

it("recovers an abort claim acknowledgement without a second counter increment", async () => {
  const f = await fixture();
  const r = await created(f);
  f.app.DB = injectBatch(
    (sql) => sql.includes("SET state='aborting'"),
    async () => {
      throw new Error("lost_ack");
    },
    true,
  );
  expect((await f.send(path(r), "DELETE", "{}", cap(r))).status).toBe(202);
  const calls = (await uploadRow(env.DB, r.id))!.control_calls;
  expect((await f.send(path(r), "DELETE", "{}", cap(r))).status).toBe(202);
  expect((await uploadRow(env.DB, r.id))!.control_calls).toBe(calls);
});

it("keeps completing uploads protected from HTTP abort", async () => {
  const f = await fixture();
  const r = await created(f);
  expect((await part(f, r)).status).toBe(200);
  await stub(f, r).beginComplete(rpc(f, r));
  expect((await f.send(path(r), "DELETE", "{}", cap(r))).status).toBe(409);
  expect(await uploadRow(env.DB, r.id)).toMatchObject({ state: "completing", cleanup_pending: 0 });
});

it("returns a recoverable receipt on lost R2 initialization and never creates a second ID", async () => {
  const f = await fixture();
  let creates = 0;
  replaceBucket(f.app, {
    createMultipartUpload: async (key, options) => {
      creates++;
      await env.BLOBS.createMultipartUpload(key, options);
      throw new Error("lost_create_response");
    },
  });
  const response = await f.create({}, "lost-create");
  expect(response.status).toBe(202);
  const r = await response.json<Receipt>();
  expect(r).toMatchObject({ state: "failed", cleanupPending: true });
  expect((await f.create({}, "lost-create")).status).toBe(202);
  expect(creates).toBe(1);
  expect((await f.send(path(r), "GET", undefined, cap(r))).status).toBe(200);
  expect((await f.send(path(r), "DELETE", "{}", cap(r))).status).toBe(202);
  expect((await part(f, r)).status).toBe(409);
});

it.each([25 * 3600000, 7 * 86400000])(
  "reads expired history (%i ms old) while denying transfers and allowing a stop",
  async (age) => {
    const f = await fixture();
    const id = `up_${crypto.randomUUID().replaceAll("-", "").repeat(2)}`;
    const blob = `${id}_blob`;
    const reservation = `${id}_reservation`;
    const createdAt = Date.now() - age;
    const expiresAt = createdAt + 6 * 86400000;
    const capability = await f.capabilities.issue({
      id,
      credential_id: f.ids.credential,
      epoch: 1,
      capability_kid: "test",
      expires_at: expiresAt,
    });
    await atomicBatch(env.DB, [
      {
        sql: "INSERT INTO reservations(id,owner_id,bytes,state,expires_at,epoch) VALUES(?,?,3,'reserved',?,1)",
        values: [reservation, f.ids.user, expiresAt],
      },
      {
        sql: "INSERT INTO blobs(id,owner_id,r2_key,size,content_etag,state,created_at) VALUES(?,?,?,3,?,'staging',?)",
        values: [blob, f.ids.user, `u/${f.ids.user}/b/${blob}`, `"b-${blob}"`, createdAt],
      },
      {
        sql: `INSERT INTO uploads(id,owner_id,space_id,parent_id,blob_id,credential_id,reservation_id,mode,state,
      declared_size,capability_hash,epoch,created_at,expires_at,last_progress_at,upload_name,request_digest,capability_kid,part_bytes,part_count)
      VALUES(?,?,?,?,?,?,?,'multipart','created',3,?,1,?,?,?,'expired.bin','history','test',67108864,1)`,
        values: [
          id,
          f.ids.user,
          f.ids.space,
          f.ids.folder,
          blob,
          f.ids.credential,
          reservation,
          await digestJson(capability),
          createdAt,
          expiresAt,
          createdAt,
        ],
      },
    ]);
    const r = { id, capability } as Receipt;
    expect((await f.send(path(r), "GET", undefined, cap(r))).status).toBe(200);
    expect((await part(f, r)).status).toBe(409);
    expect((await f.send(path(r), "DELETE", "{}", cap(r))).status).toBe(202);
    expect(await uploadRow(env.DB, r.id)).toMatchObject({ state: "aborting", data_calls: 0 });
  },
);

it.each(["credential", "parent", "maintenance", "epoch"])(
  "rechecks current %s authority for receipts and stops",
  async (kind) => {
    const f = await fixture();
    const r = await created(f);
    if (kind === "credential")
      await env.DB.prepare("UPDATE sessions SET revoked_at=? WHERE id=?")
        .bind(Date.now(), f.ids.session)
        .run();
    if (kind === "parent") {
      const op = crypto.randomUUID();
      await atomicBatch(env.DB, [
        {
          sql: "INSERT INTO trash_ops(op_id,actor_id,space_id,root_node_id,state,created_at,epoch) VALUES(?,?,?,?,'trashed',?,1)",
          values: [op, f.ids.user, f.ids.space, f.ids.folder, Date.now()],
        },
        {
          sql: "UPDATE nodes SET deleted_at=?,deleted_op_id=? WHERE id=?",
          values: [Date.now(), op, f.ids.folder],
        },
      ]);
    }
    if (kind === "maintenance") await env.DB.prepare("UPDATE control SET maintenance=1").run();
    if (kind === "epoch") await env.DB.prepare("UPDATE control SET epoch=2").run();
    expect((await f.send(path(r), "GET", undefined, cap(r))).status).not.toBe(200);
    expect((await f.send(path(r), "DELETE", "{}", cap(r))).status).not.toBe(202);
    expect(await uploadRow(env.DB, r.id)).toMatchObject({
      state: "created",
      data_calls: 0,
      cleanup_pending: 0,
    });
  },
);

it("refuses a capability from another upload and a different current principal", async () => {
  const f = await fixture();
  const r = await created(f);
  const other = await fixture();
  const wrong = await created(f, { name: "other.bin" });
  expect((await f.send(path(r), "GET", undefined, cap(wrong))).status).toBe(403);
  expect((await other.send(path(r), "GET", undefined, cap(r))).status).toBe(403);
});

it("maps parallel admission to 429 without consuming another attempt", async () => {
  const f = await fixture();
  const r = await created(f, { declared_size: 5 * 67108864 });
  for (let i = 1; i <= 4; i++)
    await stub(f, r).claimPart({
      ...rpc(f, r),
      partNumber: i,
      attemptId: `part${i}`,
      bytes: 67108864,
    });
  const response = await f.send(`${path(r)}/parts/5`, "PUT", "", {
    ...cap(r),
    "Content-Length": "67108864",
    "Upload-Attempt-Id": "five",
  });
  expect(response.status).toBe(429);
  expect(response.headers.get("Retry-After")).toBe("1");
  expect(await uploadRow(env.DB, r.id)).toMatchObject({ data_calls: 4, in_flight: 4 });
});

it("maps unknown complete to a retryable response without repeating R2 complete", async () => {
  const f = await fixture();
  const r = await created(f);
  expect((await part(f, r)).status).toBe(200);
  let calls = 0;
  replaceBucket(f.app, {
    resumeMultipartUpload: (key, id) =>
      ({
        key,
        uploadId: id,
        complete: async () => {
          calls++;
          throw new Error("unknown_complete");
        },
      }) as unknown as R2MultipartUpload,
  });
  for (let i = 0; i < 2; i++) {
    const response = await f.send(`${path(r)}/complete`, "POST", "{}", cap(r));
    expect(response.status).toBe(503);
    expect(response.headers.get("Retry-After")).toBe("1");
  }
  expect(calls).toBe(1);
  expect(await uploadRow(env.DB, r.id)).toMatchObject({ state: "completing" });
});

it("recognizes only the catalogued upload methods", () => {
  const base = "https://app.invalid/api/v1/uploads/up_" + "a".repeat(64);
  expect(uploadRoute(new Request(base + "/parts/1", { method: "PUT" }))).toBe(true);
  expect(uploadRoute(new Request(base + "/parts/1", { method: "POST" }))).toBe(false);
  expect(uploadRoute(new Request(base + "/parts", { method: "GET" }))).toBe(false);
});

it("routes authenticated Access requests through privateApp including bounded status queries", async () => {
  const f = await fixture();
  await env.DB.prepare("UPDATE control SET bootstrap_done_at=1").run();
  const access = await accessFixture();
  const jwt = (
    await access.sign({ sub: f.ids.user, email: "fixture@example.invalid" })
  ).headers.get("Cf-Access-Jwt-Assertion")!;
  const dependencies = {
    verifier: access.verifier,
    csrf: f.csrf,
    tokens: new ContentTokens(f.capabilities.ring, f.capabilities.ring, "https://content.invalid"),
    uploadCapabilities: f.capabilities,
    bootstrap: { ownerEmails: [], ownerIdentities: [], quotaBytes: 10000000 },
  };
  const send = (url: string, method: string, body?: string, headers: Record<string, string> = {}) =>
    handlePrivateAppHttp(
      new Request(f.app.APP_ORIGIN + url, {
        method,
        headers: {
          "Cf-Access-Jwt-Assertion": jwt,
          "Sec-Fetch-Site": "same-origin",
          Origin: f.app.APP_ORIGIN,
          "Content-Type": "application/json",
          ...headers,
        },
        ...(body === undefined ? {} : { body }),
      }),
      f.app,
      1,
      dependencies,
    );
  const csrfResponse = await send("/api/v1/csrf", "POST");
  expect(csrfResponse.status).toBe(201);
  const { token } = await csrfResponse.json<{ token: string }>();
  const response = await send(
    "/api/v1/uploads",
    "POST",
    JSON.stringify({
      mode: "multipart",
      spaceId: f.ids.space,
      parentId: f.ids.folder,
      name: "access.bin",
      declared_size: 3,
    }),
    { "X-CSRF-Token": token, "Idempotency-Key": "access-upload" },
  );
  expect(response.status).toBe(201);
  const r = await response.json<Receipt>();
  expect(
    (
      await send(`${path(r)}/parts/1`, "PUT", "abc", {
        ...cap(r),
        "Content-Length": "3",
        "Upload-Attempt-Id": "one",
        "Content-Type": "application/octet-stream",
      })
    ).status,
  ).toBe(200);
  const progress = await send(`${path(r)}?after=0&limit=1`, "GET", undefined, cap(r));
  expect(progress.status).toBe(200);
  expect(await progress.json()).toMatchObject({ parts: [{ state: "completed" }] });
  expect((await send(`${path(r)}?limit=201`, "GET", undefined, cap(r))).status).toBe(400);
  expect(
    (await send(`${path(r)}?after=0`, "DELETE", "{}", { ...cap(r), "X-CSRF-Token": token })).status,
  ).toBe(404);
  expect(
    (await send(path(r), "GET", undefined, { ...cap(r), "Cf-Access-Jwt-Assertion": "" })).status,
  ).toBe(401);
});

it("lets a D1 abort win before a complete mirror without dispatching R2 complete", async () => {
  const f = await fixture();
  const r = await created(f);
  expect((await part(f, r)).status).toBe(200);
  let abortStatus = 0;
  let completes = 0;
  replaceBucket(f.app, {
    resumeMultipartUpload: (key, id) =>
      ({
        key,
        uploadId: id,
        complete: async () => {
          completes++;
          throw new Error("must_not_complete");
        },
      }) as unknown as R2MultipartUpload,
  });
  f.app.DB = injectBatch(
    (sql) => sql.includes("UPDATE uploads SET state=?,accept_parts"),
    async () => {
      abortStatus = (await f.send(path(r), "DELETE", "{}", cap(r))).status;
    },
    false,
  );
  expect((await f.send(`${path(r)}/complete`, "POST", "{}", cap(r))).status).not.toBe(200);
  expect(abortStatus).toBe(202);
  expect(completes).toBe(0);
  expect(await uploadRow(env.DB, r.id)).toMatchObject({ state: "aborting", cleanup_pending: 1 });
  expect(
    await env.DB.prepare("SELECT COUNT(*) n FROM nodes WHERE current_blob_id=?")
      .bind(`${r.id}_blob`)
      .first("n"),
  ).toBe(0);
});

it("retains the reservation when HTTP abort races a late R2 part reply", async () => {
  const f = await fixture();
  const r = await created(f);
  let aborted = false;
  replaceBucket(f.app, {
    resumeMultipartUpload: (key, id) => {
      const real = env.BLOBS.resumeMultipartUpload(key, id);
      return {
        key,
        uploadId: id,
        uploadPart: async (number: number, value: ReadableStream<Uint8Array>) => {
          const result = await real.uploadPart(number, value);
          expect((await f.send(path(r), "DELETE", "{}", cap(r))).status).toBe(202);
          aborted = true;
          return result;
        },
      } as unknown as R2MultipartUpload;
    },
  });
  expect((await part(f, r)).status).not.toBe(200);
  expect(aborted).toBe(true);
  expect(await uploadRow(env.DB, r.id)).toMatchObject({
    state: "aborting",
    data_calls: 1,
    cleanup_pending: 1,
  });
  expect(await repairMultipartUploads(mutationEnv(), env.BLOBS, 1)).toMatchObject({ claimed: 0 });
  expect(
    await env.DB.prepare("SELECT reserved_bytes FROM users WHERE id=?")
      .bind(f.ids.user)
      .first("reserved_bytes"),
  ).toBe(3);
});

it("does not expose a receipt after revocation between its preflight and snapshot batch", async () => {
  const f = await fixture();
  const r = await created(f);
  f.app.DB = injectBatch(
    (sql) => sql.startsWith("SELECT * FROM uploads WHERE id=?"),
    async () => {
      await env.DB.prepare("UPDATE sessions SET revoked_at=? WHERE id=?")
        .bind(Date.now(), f.ids.session)
        .run();
    },
    false,
  );
  const response = await f.send(`${path(r)}?limit=1`, "GET", undefined, cap(r));
  expect(response.status).not.toBe(200);
  expect(await response.text()).not.toContain(r.id);
});
