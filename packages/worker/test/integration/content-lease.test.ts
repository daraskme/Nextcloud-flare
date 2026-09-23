import { applyD1Migrations, runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { base64url } from "jose";
import { beforeAll, expect, it } from "vitest";
import { handleContentHttp } from "../../src/api/content";
import { acceptContentTicket } from "../../src/auth/contentAccept";
import { ContentTokens, contentKeyRing } from "../../src/auth/contentTokens";
import { atomicBatch } from "../../src/db/primary";
import {
  BudgetDO,
  type BudgetLease,
  type BudgetReserveRequest,
  type BudgetSettleRequest,
} from "../../src/do/BudgetDO";
import type { Env } from "../../src/env";
import { streamBudgetedContentBlob } from "../../src/services/blobRead";
import { issueContentTicket } from "../../src/services/contentTicket";
import { foundationFixture } from "../fixtures/foundation";

beforeAll(async () => applyD1Migrations(env.DB, env.TEST_MIGRATIONS));

async function fixture() {
  const f = foundationFixture(crypto.randomUUID(), Date.now() - 1000);
  await atomicBatch(env.DB, f.statements);
  await env.DB.prepare("UPDATE control SET maintenance=0 WHERE singleton=1").run();
  const key = `u/${f.ids.user}/b/${f.ids.blob}`;
  const stored = await env.BLOBS.put(key, "abc");
  if (!stored) throw new Error("fixture_put_failed");
  await env.DB.prepare(
    "INSERT INTO blob_storage(blob_id,bytes,r2_etag,observed_at) VALUES(?,3,?,?)",
  )
    .bind(f.ids.blob, stored.etag, Date.now())
    .run();
  const ring = await contentKeyRing("test", {
    test: base64url.encode(crypto.getRandomValues(new Uint8Array(32))),
  });
  const tokens = new ContentTokens(ring, ring, "https://content.invalid");
  const principal = {
    kind: "user" as const,
    user_id: f.ids.user,
    credential_id: f.ids.credential,
    epoch: 1,
  };
  const targets = [{ spaceId: f.ids.space, nodeId: f.ids.file }];
  const boundary = Date.now() + 5000;
  const first = await issueContentTicket(
    env.DB,
    env.BLOBS,
    tokens,
    principal,
    targets,
    "content",
    boundary,
  );
  const acceptedFirst = await acceptContentTicket(env.DB, tokens, first.ticket);
  const stub = env.BUDGETS.get(env.BUDGETS.idFromName(first.budgetId));
  const grants: BudgetLease[] = [];
  const invoke = async <T>(callback: (budget: BudgetDO) => Promise<T>) => {
    const result = await runInDurableObject(stub, async (_, state) => {
      try {
        return { ok: true as const, value: await callback(new BudgetDO(state, env)) };
      } catch (error) {
        return {
          ok: false as const,
          message: error instanceof Error ? error.message : String(error),
        };
      }
    });
    if (!result.ok) throw new Error(result.message);
    return result.value;
  };
  // Catch expected expired-lease RPC errors inside workerd's test callback.
  // All admission, storage and settlement still execute the real BudgetDO methods.
  const budget = {
    async reserve(request: BudgetReserveRequest) {
      const lease = await invoke((budget) => budget.reserve(request));
      grants.push(lease);
      return lease;
    },
    settle: (request: BudgetSettleRequest) => invoke((budget) => budget.settle(request)),
  };
  const seedId = crypto.randomUUID();
  await budget.reserve({
    budgetId: first.budgetId,
    sessionId: acceptedFirst.sessionId,
    requestId: seedId,
    epoch: 1,
    bytes: 0,
  });
  await budget.settle({ budgetId: first.budgetId, requestId: seedId, deliveredBytes: 0 });
  const renewed = await issueContentTicket(
    env.DB,
    env.BLOBS,
    tokens,
    principal,
    targets,
    "content",
    Date.now() + 120_000,
  );
  expect(renewed.budgetId).toBe(first.budgetId);
  const accepted = await acceptContentTicket(env.DB, tokens, renewed.ticket);
  const budgets = {
    idFromName: env.BUDGETS.idFromName.bind(env.BUDGETS),
    get: () => budget,
  } as unknown as Env["BUDGETS"];
  const cookie = accepted.setCookie.split(";", 1)[0]!;
  const url = `https://content.invalid/c/${f.ids.file}/${f.ids.blob}`;
  const request = (signal?: AbortSignal) =>
    new Request(url, {
      ...(signal ? { signal } : {}),
      headers: { Cookie: cookie, Origin: "https://app.invalid" },
    });
  const read = (bucket: R2Bucket, signal?: AbortSignal) =>
    streamBudgetedContentBlob(
      env.DB,
      bucket,
      budgets,
      tokens,
      cookie,
      f.ids.space,
      f.ids.file,
      "content",
      request(signal),
    );
  const http = (bucket: R2Bucket) =>
    handleContentHttp(
      request(),
      {
        ...env,
        BLOBS: bucket,
        BUDGETS: budgets,
        APP_ORIGIN: "https://app.invalid",
        CONTENT_ORIGIN: "https://content.invalid",
      },
      tokens,
    );
  const afterBoundary = () =>
    new Promise<void>((resolve) => setTimeout(resolve, Math.max(0, boundary - Date.now() + 50)));
  return { f, key, boundary, grants, stub, read, http, afterBoundary };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;

function bucket(
  f: Fixture,
  overrides: { head?: () => Promise<R2Object | null>; get?: () => Promise<R2ObjectBody | null> },
): R2Bucket {
  return new Proxy(env.BLOBS, {
    get(target, method) {
      if (method === "head" && overrides.head)
        return (key: string) => (key === f.key ? overrides.head!() : target.head(key));
      if (method === "get" && overrides.get)
        return (key: string, options?: R2GetOptions) =>
          key === f.key ? overrides.get!() : target.get(key, options);
      const value = Reflect.get(target, method);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

async function objectWithBody(f: Fixture, body: ReadableStream<Uint8Array>) {
  const object = await env.BLOBS.get(f.key);
  if (!object) throw new Error("fixture_object_missing");
  await object.body.cancel();
  return new Proxy(object, {
    get: (target, key) => (key === "body" ? body : Reflect.get(target, key, target)),
  });
}

it("enforces the real lease while a body stalls after its ticket budget was extended", async () => {
  const f = await fixture();
  let source!: ReadableStreamDefaultController<Uint8Array>;
  let cancelled = false;
  const object = await objectWithBody(
    f,
    new ReadableStream<Uint8Array>({
      start(controller) {
        source = controller;
      },
      cancel() {
        cancelled = true;
      },
    }),
  );
  const response = await f.read(bucket(f, { get: async () => object }));
  const reader = response.body!.getReader();
  const result = reader.read().then(
    (value) => ({ kind: "chunk", bytes: value.value?.byteLength }),
    (error) => ({ kind: "error", message: error instanceof Error ? error.message : String(error) }),
  );
  await f.afterBoundary();
  // The pre-fix path delivers this late chunk because it ignores the returned lease.
  if (!cancelled) {
    source.enqueue(new TextEncoder().encode("abc"));
    source.close();
  }
  const outcome = await result;
  await reader.cancel().catch(() => undefined);
  expect(outcome).toEqual({ kind: "error", message: "content_lease_expired" });
  expect(cancelled).toBe(true);
  expect(f.grants[1]!.expiresAt).toBe(f.boundary);
  await expect.poll(async () => (await f.stub.status())?.active).toBe(0);
  expect(await f.stub.status()).toMatchObject({ bytesCharged: 3, requests: 2 });
});

it("returns a CORS-visible timeout for a late R2 HEAD without dispatching GET", async () => {
  const f = await fixture();
  let release!: (object: R2Object | null) => void;
  let gets = 0;
  const pending = new Promise<R2Object | null>((resolve) => {
    release = resolve;
  });
  const result = f.http(
    bucket(f, {
      head: () => pending,
      get: async () => {
        gets++;
        return env.BLOBS.get(f.key);
      },
    }),
  );
  const response = await result;
  expect(response.status).toBe(503);
  expect(response.headers.get("Access-Control-Allow-Origin")).toBe("https://app.invalid");
  release(await env.BLOBS.head(f.key));
  await new Promise((resolve) => setTimeout(resolve, 20));
  expect(gets).toBe(0);
  expect(f.grants[1]!.expiresAt).toBe(f.boundary);
});

it("cancels a late R2 GET body after returning the deadline error", async () => {
  const f = await fixture();
  let release!: (object: R2ObjectBody | null) => void;
  let cancelled = false;
  const pending = new Promise<R2ObjectBody | null>((resolve) => {
    release = resolve;
  });
  const object = await objectWithBody(
    f,
    new ReadableStream({
      cancel() {
        cancelled = true;
      },
    }),
  );
  const response = await f.http(bucket(f, { get: () => pending }));
  expect(response.status).toBe(503);
  release(object);
  await expect.poll(() => cancelled).toBe(true);
  expect(f.grants[1]!.expiresAt).toBe(f.boundary);
});

it("explicitly cancels and fully charges an aborted partially delivered response", async () => {
  const f = await fixture();
  let cancelled = false;
  let source!: ReadableStreamDefaultController<Uint8Array>;
  const object = await objectWithBody(
    f,
    new ReadableStream<Uint8Array>({
      start(controller) {
        source = controller;
      },
      cancel() {
        cancelled = true;
      },
    }),
  );
  const abort = new AbortController();
  const response = await f.read(bucket(f, { get: async () => object }), abort.signal);
  const reader = response.body!.getReader();
  source.enqueue(new TextEncoder().encode("a"));
  expect(new TextDecoder().decode((await reader.read()).value)).toBe("a");
  abort.abort(new Error("request_cancelled"));
  await expect(reader.read()).rejects.toThrow("request_cancelled");
  await expect.poll(() => cancelled).toBe(true);
  await expect.poll(async () => (await f.stub.status())?.active).toBe(0);
  expect(await f.stub.status()).toMatchObject({ bytesCharged: 3, requests: 2 });
});

it("rejects an already aborted request before another reservation or blob read", async () => {
  const f = await fixture();
  const abort = new AbortController();
  abort.abort(new Error("request_cancelled"));
  let heads = 0;
  await expect(
    f.read(
      bucket(f, {
        head: async () => {
          heads++;
          return null;
        },
      }),
      abort.signal,
    ),
  ).rejects.toThrow("request_cancelled");
  expect(heads).toBe(0);
  expect(f.grants).toHaveLength(1);
  expect(await f.stub.status()).toMatchObject({ bytesCharged: 0, requests: 1, active: 0 });
});
