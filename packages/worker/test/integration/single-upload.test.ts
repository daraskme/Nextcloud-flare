import { applyD1Migrations, runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { base64url } from "jose";
import { beforeAll, beforeEach, expect, it } from "vitest";
import { handleUploadHttp, uploadRoute } from "../../src/api/uploads";
import type { Principal } from "../../src/auth/authorize";
import { contentKeyRing } from "../../src/auth/contentTokens";
import { CsrfTokens, csrfKeyRing } from "../../src/auth/csrf";
import { UploadCapabilities } from "../../src/auth/uploadCapability";
import { atomicBatch } from "../../src/db/primary";
import { LockDO } from "../../src/do/LockDO";
import type { Env } from "../../src/env";
import { consumeOutbox } from "../../src/jobs/consumeOutbox";
import { abortSingleUpload } from "../../src/services/uploads/abort";
import { accessUpload, uploadRow } from "../../src/services/uploads/access";
import { completeSingleUpload } from "../../src/services/uploads/complete";
import { writeSingleUpload } from "../../src/services/uploads/content";
import { createSingleUpload } from "../../src/services/uploads/create";
import { foundationFixture } from "../fixtures/foundation";
import { acquireMutation, mutationEnv } from "../fixtures/mutationAdmission";

beforeAll(async () => applyD1Migrations(env.DB, env.TEST_MIGRATIONS));
beforeEach(async () => {
  await env.DB.prepare("UPDATE control SET epoch=1,maintenance=0").run();
});
const stream = (text: string) => new Blob([text]).stream();

function admitted(): Env {
  const doEnv = {
    ...env,
    CONTROL: {
      idFromName: env.CONTROL.idFromName.bind(env.CONTROL),
      get: () => ({
        acquireMutation,
        status: async () => ({ epoch: 1, maintenance: false, gcPaused: true }),
      }),
    } as unknown as Env["CONTROL"],
  };
  return {
    ...env,
    APP_ORIGIN: "https://app.invalid",
    CONTROL: doEnv.CONTROL,
    LOCKS: {
      idFromName: env.LOCKS.idFromName.bind(env.LOCKS),
      get(id: DurableObjectId) {
        const invoke = async <T>(callback: (lock: LockDO) => Promise<T>) => {
          const result = await runInDurableObject(env.LOCKS.get(id), async (_, state) => {
            try {
              return { ok: true as const, value: await callback(new LockDO(state, doEnv)) };
            } catch (error) {
              return {
                ok: false as const,
                message: error instanceof Error ? error.message : "lock_failed",
              };
            }
          });
          if (!result.ok) throw new Error(result.message);
          return result.value;
        };
        return {
          acquireCreate: (request: Parameters<LockDO["acquireCreate"]>[0]) =>
            invoke((lock) => lock.acquireCreate(request)),
          acquireNodeWrite: (request: Parameters<LockDO["acquireNodeWrite"]>[0]) =>
            invoke((lock) => lock.acquireNodeWrite(request)),
          release: (requestId: string, permit: Parameters<LockDO["release"]>[1]) =>
            invoke((lock) => lock.release(requestId, permit)),
        };
      },
    } as unknown as Env["LOCKS"],
  };
}

async function fixture(size = 3) {
  const f = foundationFixture(crypto.randomUUID(), Date.now() - 1000);
  await atomicBatch(env.DB, f.statements);
  const principal: Principal = {
    kind: "user",
    user_id: f.ids.user,
    credential_id: f.ids.credential,
    epoch: 1,
  };
  const secret = base64url.encode(crypto.getRandomValues(new Uint8Array(32)));
  const capabilities = new UploadCapabilities(await contentKeyRing("test", { test: secret }));
  const input = {
    principal,
    requestId: crypto.randomUUID(),
    spaceId: f.ids.space,
    parentId: f.ids.folder,
    name: "upload.txt",
    declaredSize: size,
  };
  const app = admitted();
  const created = await createSingleUpload(mutationEnv(), input, capabilities);
  return { ...f, principal, capabilities, input, created, app };
}
async function write(f: Awaited<ReturnType<typeof fixture>>, text = "abc", app = f.app) {
  return writeSingleUpload(
    app,
    f.principal,
    f.created.id,
    f.created.capability,
    f.capabilities,
    stream(text),
    text.length,
  );
}
async function complete(f: Awaited<ReturnType<typeof fixture>>, app = f.app, key = "complete") {
  return completeSingleUpload(
    app,
    f.principal,
    f.created.id,
    f.created.capability,
    f.capabilities,
    key,
    [],
  );
}
async function counters(f: Awaited<ReturnType<typeof fixture>>) {
  return env.DB.prepare("SELECT used_bytes,reserved_bytes,physical_bytes FROM users WHERE id=?")
    .bind(f.ids.user)
    .first();
}
function injectBatch(
  predicate: (sql: string) => boolean,
  effect: () => Promise<void>,
  after: boolean,
): D1Database {
  const sql = new WeakMap<object, string>();
  let injected = false;
  return {
    prepare(query: string) {
      const statement = env.DB.prepare(query);
      return new Proxy(statement, {
        get(target, key) {
          if (key === "bind")
            return (...values: unknown[]) => {
              const bound = target.bind(...values);
              sql.set(bound, query);
              return bound;
            };
          const value = Reflect.get(target, key);
          return typeof value === "function" ? value.bind(target) : value;
        },
      });
    },
    async batch(statements: D1PreparedStatement[]) {
      const matches =
        !injected && statements.some((statement) => predicate(sql.get(statement) ?? ""));
      if (matches) {
        injected = true;
        if (!after) await effect();
      }
      const result = await env.DB.batch(statements);
      if (matches && after) await effect();
      return result;
    },
  } as D1Database;
}

it("reserves before storing and publishes all metadata only at complete", async () => {
  const f = await fixture();
  const created = (await uploadRow(env.DB, f.created.id))!;
  expect(created.expires_at - created.created_at).toBe(86400000);
  expect(await counters(f)).toMatchObject({ used_bytes: 3, reserved_bytes: 3, physical_bytes: 0 });
  await write(f);
  expect(await counters(f)).toMatchObject({ used_bytes: 3, reserved_bytes: 3, physical_bytes: 3 });
  const result = await complete(f);
  expect(result).toMatchObject({
    kind: "terminal",
    operation: { state: "committed", result: { status: 201 } },
  });
  expect(await counters(f)).toMatchObject({ used_bytes: 6, reserved_bytes: 0, physical_bytes: 3 });
  expect(await uploadRow(env.DB, f.created.id)).toMatchObject({
    state: "completed",
    in_flight: 0,
    data_calls: 1,
  });
  const blob = await env.DB.prepare("SELECT sha256_verified,ref_count FROM blobs WHERE id=?")
    .bind(`${f.created.id}_blob`)
    .first();
  expect(blob).toMatchObject({
    sha256_verified: "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    ref_count: 1,
  });
  expect(await complete(f)).toEqual(result);
  expect(await counters(f)).toMatchObject({ used_bytes: 6, physical_bytes: 3 });
  if (result.kind !== "terminal") throw new Error("missing_terminal");
  await env.DB.prepare(
    "UPDATE outbox SET state='dispatching',dispatch_token='test',dispatch_expires_at=? WHERE op_id=?",
  )
    .bind(Date.now() + 60000, result.operation.id)
    .run();
  expect(await consumeOutbox(env.DB, `${result.operation.id}_event`)).toBe("completed");
});

it("supports zero-byte single uploads through complete", async () => {
  const f = await fixture(0);
  await write(f, "");
  expect(await complete(f)).toMatchObject({ kind: "terminal", operation: { state: "committed" } });
  expect(await counters(f)).toMatchObject({ used_bytes: 3, reserved_bytes: 0, physical_bytes: 0 });
});

it("replays a lost create response and concurrent same-key requests without double reservation", async () => {
  const f = await fixture();
  const input = { ...f.input, requestId: crypto.randomUUID(), name: "second.txt" };
  const db = injectBatch(
    (sql) => sql.includes("INSERT INTO uploads"),
    async () => {
      throw new Error("response_lost");
    },
    true,
  );
  const [a, b] = await Promise.all([
    createSingleUpload(mutationEnv(db), input, f.capabilities),
    createSingleUpload(mutationEnv(), input, f.capabilities),
  ]);
  expect(a).toEqual(b);
  expect(await counters(f)).toMatchObject({ reserved_bytes: 6 });
  await expect(
    createSingleUpload(mutationEnv(), { ...input, name: "different.txt" }, f.capabilities),
  ).rejects.toThrow(/idempotency_conflict/);
});

it("recovers a committed R2 PUT with a lost response without a second PUT", async () => {
  const f = await fixture();
  let calls = 0;
  const bucket = new Proxy(env.BLOBS, {
    get(target, key) {
      if (key === "put")
        return async (...args: Parameters<R2Bucket["put"]>) => {
          calls++;
          await target.put(...args);
          throw new Error("lost_put_response");
        };
      const value = Reflect.get(target, key);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  await expect(write(f, "abc", { ...f.app, BLOBS: bucket })).rejects.toThrow(/lost_put_response/);
  expect(await counters(f)).toMatchObject({ physical_bytes: 3, reserved_bytes: 3 });
  expect(await write(f, "xyz", { ...f.app, BLOBS: bucket })).toMatchObject({ state: "completing" });
  expect(calls).toBe(1);
  expect(await (await env.BLOBS.get(`u/${f.ids.user}/b/${f.created.id}_blob`))?.text()).toBe("abc");
  expect(await complete(f)).toMatchObject({ kind: "terminal", operation: { state: "committed" } });
});

it("does not dispatch after a lost D1 lease response and can abort the durable intent", async () => {
  const f = await fixture();
  const db = injectBatch(
    (sql) => sql.includes("write_attempt_id=?"),
    async () => {
      throw new Error("lost_claim");
    },
    true,
  );
  await expect(write(f, "abc", { ...f.app, DB: db })).rejects.toThrow(/content_pending/);
  expect(await env.BLOBS.head(`u/${f.ids.user}/b/${f.created.id}_blob`)).toBeNull();
  expect(await uploadRow(env.DB, f.created.id)).toMatchObject({
    state: "receiving",
    data_calls: 1,
  });
  expect(
    await abortSingleUpload(
      env.DB,
      f.principal,
      f.created.id,
      f.created.capability,
      f.capabilities,
    ),
  ).toMatchObject({ state: "aborted", cleanupPending: true });
  expect(await counters(f)).toMatchObject({ reserved_bytes: 3 });
  await expect(write(f)).rejects.toThrow(/not_receiving/);
});

it("reconciles a lost final D1 response without deleting the committed R2 object", async () => {
  const f = await fixture();
  await write(f);
  const db = injectBatch(
    (sql) => sql.includes("UPDATE operations SET state='committed'"),
    async () => {
      throw new Error("lost_commit");
    },
    true,
  );
  const result = await complete(f, { ...f.app, DB: db });
  expect(result).toMatchObject({ kind: "terminal", operation: { state: "committed" } });
  expect(await complete(f)).toEqual(result);
  expect(await env.BLOBS.head(`u/${f.ids.user}/b/${f.created.id}_blob`)).not.toBeNull();
  expect(await counters(f)).toMatchObject({ used_bytes: 6, reserved_bytes: 0, physical_bytes: 3 });
});

it("retains the previous blob as a version during atomic overwrite", async () => {
  const f = await fixture();
  await write(f);
  const first = await complete(f);
  if (first.kind !== "terminal" || !first.operation.result?.nodeId) throw new Error("missing_node");
  const second = await createSingleUpload(
    mutationEnv(),
    {
      ...f.input,
      requestId: "overwrite",
      targetId: first.operation.result.nodeId,
      targetRevision: 1,
      declaredSize: 5,
    },
    f.capabilities,
  );
  const next = { ...f, created: second };
  await write(next, "12345");
  expect(await complete(next, f.app, "complete-overwrite")).toMatchObject({
    kind: "terminal",
    operation: { state: "committed", result: { status: 204, revision: 2 } },
  });
  expect(
    await env.DB.prepare("SELECT blob_id FROM node_versions WHERE node_id=?")
      .bind(first.operation.result.nodeId)
      .first("blob_id"),
  ).toBe(`${f.created.id}_blob`);
  expect(await counters(f)).toMatchObject({ used_bytes: 11, reserved_bytes: 0, physical_bytes: 8 });
});

it("rolls back a conflicting filename, releases only the reservation, and retains physical charges", async () => {
  const f = await fixture();
  await write(f);
  await env.DB.prepare(`INSERT INTO nodes(id,space_id,owner_id,parent_id,name,name_ci,kind,created_at,updated_at)
    VALUES(?,?,?,?,'upload.txt','upload.txt','folder',1,1)`)
    .bind(crypto.randomUUID(), f.ids.space, f.ids.user, f.ids.folder)
    .run();
  expect(await complete(f)).toMatchObject({
    kind: "terminal",
    operation: { state: "failed", errorCode: "name_conflict" },
  });
  expect(await uploadRow(env.DB, f.created.id)).toMatchObject({
    state: "failed",
    cleanup_pending: 1,
  });
  expect(await counters(f)).toMatchObject({ used_bytes: 3, reserved_bytes: 0, physical_bytes: 3 });
});

it("rechecks session revocation in the final batch and does not publish partial metadata", async () => {
  const f = await fixture();
  await write(f);
  const db = injectBatch(
    (sql) => sql.includes("UPDATE operations SET state='committed'"),
    async () => {
      await env.DB.prepare("UPDATE sessions SET revoked_at=? WHERE id=?")
        .bind(Date.now(), f.ids.session)
        .run();
    },
    false,
  );
  expect(await complete(f, { ...f.app, DB: db })).toMatchObject({ kind: "commit_unknown" });
  expect(await counters(f)).toMatchObject({ used_bytes: 3, reserved_bytes: 3, physical_bytes: 3 });
  expect(
    await env.DB.prepare("SELECT COUNT(*) AS n FROM nodes WHERE current_blob_id=?")
      .bind(`${f.created.id}_blob`)
      .first("n"),
  ).toBe(0);
});

it("requires matching current credentials, capability and epoch", async () => {
  const f = await fixture();
  const other = await fixture();
  await expect(
    accessUpload(env.DB, other.principal, f.created.id, f.created.capability, f.capabilities),
  ).rejects.toThrow(/authorization_denied/);
  await expect(
    accessUpload(
      env.DB,
      f.principal,
      f.created.id,
      f.created.capability.slice(0, -1) + "!",
      f.capabilities,
    ),
  ).rejects.toThrow(/capability/);
  await env.DB.prepare("UPDATE control SET epoch=2").run();
  await expect(write(f)).rejects.toThrow();
  expect(await counters(f)).toMatchObject({ physical_bytes: 0 });
});

it("rejects oversize reservation before any R2 I/O", async () => {
  const f = await fixture();
  await expect(
    createSingleUpload(
      mutationEnv(),
      { ...f.input, requestId: "quota", declaredSize: 10000000 },
      f.capabilities,
    ),
  ).rejects.toThrow(/quota_exceeded/);
  expect(await counters(f)).toMatchObject({ reserved_bytes: 3, physical_bytes: 0 });
});

it("checks real stream length and blocks completion while data is missing", async () => {
  const f = await fixture();
  await expect(complete(f)).rejects.toThrow(/content_pending/);
  await expect(
    writeSingleUpload(
      f.app,
      f.principal,
      f.created.id,
      f.created.capability,
      f.capabilities,
      stream("ab"),
      3,
    ),
  ).rejects.toThrow(/invalid_length/);
  expect(await env.BLOBS.head(`u/${f.ids.user}/b/${f.created.id}_blob`)).toBeNull();
  await expect(write(f)).rejects.toThrow(/content_pending/);
});

it("does not abort a completing upload", async () => {
  const f = await fixture();
  await write(f);
  await expect(
    abortSingleUpload(env.DB, f.principal, f.created.id, f.created.capability, f.capabilities),
  ).rejects.toThrow(/abort_conflict/);
  expect(await complete(f)).toMatchObject({ kind: "terminal", operation: { state: "committed" } });
});

it("releases an unstarted upload reservation when abort wins before any write claim", async () => {
  const f = await fixture();
  await abortSingleUpload(env.DB, f.principal, f.created.id, f.created.capability, f.capabilities);
  expect(await counters(f)).toMatchObject({ reserved_bytes: 0, physical_bytes: 0 });
  await expect(write(f)).rejects.toThrow(/not_receiving/);
});

it("retains the reservation when a write claim races abort and charges a late successful PUT", async () => {
  const f = await fixture();
  let release!: () => void;
  let reached!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const started = new Promise<void>((resolve) => {
    reached = resolve;
  });
  const bucket = new Proxy(env.BLOBS, {
    get(target, key) {
      if (key === "put")
        return async (...args: Parameters<R2Bucket["put"]>) => {
          reached();
          await gate;
          return target.put(...args);
        };
      const value = Reflect.get(target, key);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  let pending: Promise<unknown> | undefined;
  const db = injectBatch(
    (sql) => sql.includes("state='aborted'"),
    async () => {
      pending = write(f, "abc", { ...f.app, BLOBS: bucket });
      // Attach a handler while abort is still running; the late write must not publish.
      void pending.catch(() => {});
      await started;
    },
    false,
  );
  try {
    await abortSingleUpload(db, f.principal, f.created.id, f.created.capability, f.capabilities);
    expect(await counters(f)).toMatchObject({ reserved_bytes: 3, physical_bytes: 0 });
  } finally {
    release();
  }
  await expect(pending).rejects.toThrow();
  expect(await counters(f)).toMatchObject({ used_bytes: 3, reserved_bytes: 3, physical_bytes: 3 });
  expect(await uploadRow(env.DB, f.created.id)).toMatchObject({
    state: "aborted",
    cleanup_pending: 1,
  });
  expect(
    await env.DB.prepare("SELECT COUNT(*) AS n FROM nodes WHERE current_blob_id=?")
      .bind(`${f.created.id}_blob`)
      .first("n"),
  ).toBe(0);
});

it("prevents concurrent content requests from dispatching a second PUT", async () => {
  const f = await fixture();
  let release!: () => void;
  let reached!: () => void;
  let puts = 0;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const started = new Promise<void>((resolve) => {
    reached = resolve;
  });
  const bucket = new Proxy(env.BLOBS, {
    get(target, key) {
      if (key === "put")
        return async (...args: Parameters<R2Bucket["put"]>) => {
          puts++;
          reached();
          await gate;
          return target.put(...args);
        };
      const value = Reflect.get(target, key);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  const first = write(f, "abc", { ...f.app, BLOBS: bucket });
  await started;
  try {
    await expect(write(f, "xyz", { ...f.app, BLOBS: bucket })).rejects.toThrow(/content_pending/);
  } finally {
    release();
  }
  await first;
  expect(puts).toBe(1);
});

it.each([1, 2, 3, 4, 5, 6, 7, 8, 9, 10])(
  "rolls back every mandatory create step when marker %i fails",
  async (step) => {
    const f = await fixture();
    await write(f);
    await env.DB.prepare(`CREATE TRIGGER inject_upload_step BEFORE INSERT ON operation_steps
    WHEN NEW.step_no=${step} AND NEW.op_id=(SELECT completion_op_id FROM uploads WHERE id='${f.created.id}')
    BEGIN INSERT INTO _assert(v) VALUES(1); END;`).run();
    try {
      expect(await complete(f)).toMatchObject({ kind: "terminal", operation: { state: "failed" } });
      expect(await counters(f)).toMatchObject({
        used_bytes: 3,
        reserved_bytes: 0,
        physical_bytes: 3,
      });
      expect(
        await env.DB.prepare("SELECT revision FROM nodes WHERE id=?")
          .bind(f.ids.folder)
          .first("revision"),
      ).toBe(1);
      expect(
        await env.DB.prepare("SELECT COUNT(*) AS n FROM nodes WHERE current_blob_id=?")
          .bind(`${f.created.id}_blob`)
          .first("n"),
      ).toBe(0);
      expect(
        await env.DB.prepare(
          "SELECT COUNT(*) AS n FROM operation_steps WHERE op_id=(SELECT completion_op_id FROM uploads WHERE id=?)",
        )
          .bind(f.created.id)
          .first("n"),
      ).toBe(0);
    } finally {
      await env.DB.exec("DROP TRIGGER inject_upload_step");
    }
  },
);

it("retries failed-operation reservation settlement after its write or response is lost", async () => {
  const f = await fixture();
  await write(f);
  await env.DB.prepare(`INSERT INTO nodes(id,space_id,owner_id,parent_id,name,name_ci,kind,created_at,updated_at)
    VALUES(?,?,?,?,'upload.txt','upload.txt','folder',1,1)`)
    .bind(crypto.randomUUID(), f.ids.space, f.ids.user, f.ids.folder)
    .run();
  const db = injectBatch(
    (sql) => sql.includes("state='failed',cleanup_pending"),
    async () => {
      throw new Error("settlement_unavailable");
    },
    false,
  );
  await expect(complete(f, { ...f.app, DB: db })).rejects.toThrow(/settlement_unavailable/);
  expect(await counters(f)).toMatchObject({ reserved_bytes: 3, physical_bytes: 3 });
  expect(await complete(f)).toMatchObject({ kind: "terminal", operation: { state: "failed" } });
  expect(await counters(f)).toMatchObject({ reserved_bytes: 0, physical_bytes: 3 });
  expect(await complete(f)).toMatchObject({ kind: "terminal", operation: { state: "failed" } });
  expect(await counters(f)).toMatchObject({ reserved_bytes: 0, physical_bytes: 3 });
});

it("connects private HTTP create/content/status/complete with CSRF and binary Origin checks", async () => {
  const f = await fixture();
  const secret = base64url.encode(crypto.getRandomValues(new Uint8Array(32)));
  const ring = await csrfKeyRing("test", { test: secret });
  const csrf = new CsrfTokens(ring, ring, f.app.APP_ORIGIN);
  const issued = await csrf.issue(
    env.DB,
    new Request(`${f.app.APP_ORIGIN}/api/v1/csrf`, {
      method: "POST",
      headers: { "Sec-Fetch-Site": "same-origin" },
    }),
    { kind: "access", credentialId: f.principal.credential_id, epoch: 1 },
  );
  const headers = {
    Origin: f.app.APP_ORIGIN,
    "Content-Type": "application/json",
    "Sec-Fetch-Site": "same-origin",
    "X-CSRF-Token": issued.token,
    "Idempotency-Key": "http-create",
  };
  const send = (path: string, method: string, body?: string, extra: Record<string, string> = {}) =>
    handleUploadHttp(
      new Request(`${f.app.APP_ORIGIN}${path}`, {
        method,
        headers: { ...headers, ...extra },
        ...(body !== undefined ? { body } : {}),
      }),
      f.app,
      f.principal,
      csrf,
      f.capabilities,
    );
  const json = JSON.stringify({
    mode: "single",
    spaceId: f.ids.space,
    parentId: f.ids.folder,
    name: "http.txt",
    declared_size: 3,
  });
  expect((await send("/api/v1/uploads", "POST", json, { "X-CSRF-Token": "" })).status).toBe(403);
  expect((await send("/api/v1/uploads", "POST", "{")).status).toBe(400);
  expect((await send("/api/v1/uploads", "POST", " ".repeat(8193))).status).toBe(400);
  const response = await send("/api/v1/uploads", "POST", json);
  expect(response.status).toBe(201);
  const upload = await response.json<{ id: string; capability: string }>();
  const path = `/api/v1/uploads/${upload.id}`;
  const cap = { "Upload-Capability": upload.capability };
  expect(uploadRoute(new Request(`${f.app.APP_ORIGIN}${path}`, { method: "GET" }))).toBe(true);
  expect((await send(`${path}/content`, "GET", undefined, cap)).status).toBe(404);
  expect((await send(`${path}/content`, "PUT", "abc", cap)).status).toBe(411);
  expect(
    (
      await send(`${path}/content`, "PUT", "abc", {
        ...cap,
        "Content-Length": "3",
        Origin: "https://other.invalid",
      })
    ).status,
  ).toBe(403);
  expect(
    (
      await send(`${path}/content`, "PUT", "abc", {
        ...cap,
        "Content-Length": "3",
        "Content-Type": "application/octet-stream",
        "X-CSRF-Token": "",
      })
    ).status,
  ).toBe(200);
  expect(await (await send(path, "GET", undefined, cap)).json()).toMatchObject({
    state: "completing",
  });
  const completed = await send(`${path}/complete`, "POST", "{}", {
    ...cap,
    "Idempotency-Key": "http-complete",
  });
  expect(completed.status).toBe(200);
  const operation = await completed.json<{ result: { nodeId: string } }>();
  const overwrite = await send(
    "/api/v1/uploads",
    "POST",
    JSON.stringify({ ...JSON.parse(json), targetId: operation.result.nodeId, targetRevision: 1 }),
    { "Idempotency-Key": "http-overwrite" },
  );
  expect(overwrite.status).toBe(201);
  const next = await overwrite.json<{ id: string; capability: string }>();
  const nextPath = `/api/v1/uploads/${next.id}/content`;
  const nextHeaders = { "Upload-Capability": next.capability, "Content-Length": "3" };
  expect((await send(nextPath, "PUT", "abc", nextHeaders)).status).toBe(428);
  expect(
    (await send(nextPath, "PUT", "abc", { ...nextHeaders, "If-Match": '"other"' })).status,
  ).toBe(412);
  expect(await uploadRow(env.DB, next.id)).toMatchObject({ state: "created", data_calls: 0 });
  expect(
    (
      await send(nextPath, "PUT", "abc", {
        ...nextHeaders,
        "If-Match": `"b-${upload.id}_blob"`,
      })
    ).status,
  ).toBe(200);
});
