import { applyD1Migrations } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { base64url } from "jose";
import { afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { handleDeadLetterReadHttp } from "../../src/api/deadLetters";
import { privateAppRoute } from "../../src/api/privateApp";
import { contentKeyRing } from "../../src/auth/contentTokens";
import { ListCursorTokens } from "../../src/auth/listCursor";
import { readAccessSession } from "../../src/auth/sessions";
import { atomicBatch } from "../../src/db/primary";
import worker from "../../src/index";
import { consumeOutbox } from "../../src/jobs/consumeOutbox";
import { cancelCopyJob } from "../../src/jobs/copyLifecycle";
import { handleDeadLetterBatch } from "../../src/jobs/deadLetters";
import { dispatchOutbox } from "../../src/jobs/outbox";
import { listDeadLetters } from "../../src/services/deadLetterRead";
import type { GlobalMutationSource } from "../../src/services/globalMutation";
import { copyJobCounters, copyJobFixture } from "../fixtures/copyJob";
import { acquireGlobalMutation, mutationEnv } from "../fixtures/mutationAdmission";
import { outboxFixture } from "../fixtures/outbox";
import { systemMutationFault } from "../fixtures/systemMutationFault";

beforeAll(() => applyD1Migrations(env.DB, env.TEST_MIGRATIONS));
beforeEach(async () => {
  await env.DB.prepare("UPDATE control SET maintenance=1").run();
  await env.DB.prepare("UPDATE control SET epoch=1,maintenance=0").run();
  await env.DB.prepare("DELETE FROM queue_dead_letters").run();
});
afterEach(() => vi.restoreAllMocks());
const message = (body: unknown = { outboxId: "missing" }) => ({
  id: crypto.randomUUID(),
  timestamp: new Date(1000),
  body,
  ack: vi.fn(),
  retry: vi.fn(),
});
const deliver = (m: ReturnType<typeof message>, app: GlobalMutationSource = mutationEnv()) =>
  handleDeadLetterBatch(app, { messages: [m] });
const rows = () => env.DB.prepare("SELECT * FROM queue_dead_letters ORDER BY message_id").all();
async function admin() {
  const f = await outboxFixture();
  await env.DB.prepare("UPDATE users SET role='app_admin' WHERE id=?").bind(f.ids.user).run();
  const session = (await readAccessSession(env.DB, f.ids.credential, 1))!;
  const cursors = new ListCursorTokens(
    await contentKeyRing("test", { test: base64url.encode(new Uint8Array(32).fill(5)) }),
  );
  return { ...f, session, cursors };
}
const source = (gate: typeof acquireGlobalMutation): GlobalMutationSource => ({
  DB: env.DB,
  systemControl: {
    status: () => mutationEnv().CONTROL.get(env.CONTROL.idFromName("fixture")).status(),
    acquireGlobalMutation: gate,
  },
});

it("records a failed delivery once without executing or changing its durable event", async () => {
  const f = await outboxFixture(),
    m = message({ outboxId: f.id });
  const before = await env.DB.prepare("SELECT * FROM outbox WHERE outbox_id=?").bind(f.id).first();
  expect(await deliver(m)).toEqual({ acked: 1, retried: 0 });
  const saved = (await rows()).results;
  expect(saved).toEqual([
    { message_id: m.id, outbox_id: f.id, sent_at: 1000, received_at: expect.any(Number), epoch: 1 },
  ]);
  expect(
    await deliver(
      m,
      source(async () => {
        throw new Error("full");
      }),
    ),
  ).toEqual({ acked: 1, retried: 0 });
  expect((await rows()).results).toEqual(saved);
  expect(await env.DB.prepare("SELECT * FROM outbox WHERE outbox_id=?").bind(f.id).first()).toEqual(
    before,
  );
});
it.each([
  null,
  "secret content",
  { outboxId: "missing", kind: "copy.requested" },
  { outboxId: "../../secret" },
  ["secret"],
  { payload: "secret" },
])("persists malformed payload classification without retaining the body: %j", async (body) => {
  const m = message(body);
  expect(await deliver(m)).toEqual({ acked: 1, retried: 0 });
  expect((await rows()).results).toEqual([
    { message_id: m.id, outbox_id: null, sent_at: 1000, received_at: expect.any(Number), epoch: 1 },
  ]);
});
it("retains an absent outbox reference and does not infer that its work completed", async () => {
  const m = message();
  expect(await deliver(m)).toEqual({ acked: 1, retried: 0 });
  expect((await rows()).results[0]).toMatchObject({ outbox_id: "missing" });
  expect(await consumeOutbox(mutationEnv(), "missing")).toBe("retry");
});
it.each(["timestamp", "reference"])("retains a conflicting redelivery %s", async (field) => {
  const m = message();
  await deliver(m);
  const conflict = {
    ...m,
    ...(field === "timestamp" ? { timestamp: new Date(2000) } : { body: { outboxId: "other" } }),
    ack: vi.fn(),
    retry: vi.fn(),
  };
  expect(await deliver(conflict)).toEqual({ acked: 0, retried: 1 });
  expect(conflict.ack).not.toHaveBeenCalled();
  expect((await rows()).results[0]).toMatchObject({ outbox_id: "missing", sent_at: 1000 });
});
it.each(["ack", "rollback", "reads"] as const)(
  "handles a %s failure without acknowledging unrecorded delivery",
  async (mode) => {
    const m = message(),
      fault = systemMutationFault("global:queue.dead-letter:", mode);
    expect(await deliver(m, mutationEnv(fault.db))).toEqual({
      acked: mode === "ack" ? 1 : 0,
      retried: mode === "ack" ? 0 : 1,
    });
    expect(fault.fired()).toBe(true);
    expect((await rows()).results.length).toBe(mode === "rollback" ? 0 : 1);
    if (mode !== "rollback") expect(await deliver(m)).toEqual({ acked: 1, retried: 0 });
  },
);
it("recovers a lost Queue ACK from the exact saved observation", async () => {
  const m = message();
  m.ack.mockImplementationOnce(() => {
    throw new Error("lost");
  });
  expect(await deliver(m)).toEqual({ acked: 0, retried: 1 });
  expect(await deliver(m)).toEqual({ acked: 1, retried: 0 });
  expect((await rows()).results).toHaveLength(1);
});
it("converges concurrent duplicate deliveries on one immutable observation", async () => {
  const first = message(),
    second = { ...first, ack: vi.fn(), retry: vi.fn() };
  const results = await Promise.all([deliver(first), deliver(second)]);
  expect(results).toEqual([
    { acked: 1, retried: 0 },
    { acked: 1, retried: 0 },
  ]);
  expect((await rows()).results).toHaveLength(1);
});
it.each(["epoch", "maintenance"])("rejects a waiting %s transition", async (change) => {
  const m = message();
  expect(
    await deliver(
      m,
      source(async (r) => {
        const grant = await acquireGlobalMutation(r);
        await env.DB.prepare(
          change === "epoch" ? "UPDATE control SET epoch=2" : "UPDATE control SET maintenance=1",
        ).run();
        return grant;
      }),
    ),
  ).toEqual({ acked: 0, retried: 1 });
  expect((await rows()).results).toEqual([]);
});
it("retains deliveries when admission is unavailable or returns beyond the invocation deadline", async () => {
  const m = message();
  expect(
    await deliver(
      m,
      source(async () => {
        throw new Error("full");
      }),
    ),
  ).toEqual({ acked: 0, retried: 1 });
  const now = Date.now.bind(Date);
  let late = false;
  vi.spyOn(Date, "now").mockImplementation(() => now() + (late ? 30000 : 0));
  const next = message();
  expect(
    await handleDeadLetterBatch(
      source(async (r) => {
        const grant = await acquireGlobalMutation(r);
        late = true;
        return grant;
      }),
      { messages: [m, next] },
    ),
  ).toEqual({ acked: 0, retried: 2 });
  expect((await rows()).results).toEqual([]);
});
it.each(["", "bad.id", "x".repeat(129)])("rejects invalid envelope id %s", async (id) => {
  expect(await deliver({ ...message(), id })).toEqual({ acked: 0, retried: 1 });
  expect((await rows()).results).toEqual([]);
});
it("does not release the holds or restart a cancelled copy", async () => {
  const f = await copyJobFixture();
  await cancelCopyJob(mutationEnv(), f.request.principal, f.job.id);
  const before = await copyJobCounters(f.job.id);
  const holds = (
    await env.DB.prepare("SELECT * FROM copy_job_blobs WHERE job_id=?").bind(f.job.id).all()
  ).results;
  expect(holds.length).toBeGreaterThan(0);
  expect(await deliver(message({ outboxId: f.job.outboxId }))).toEqual({ acked: 1, retried: 0 });
  expect(await copyJobCounters(f.job.id)).toEqual(before);
  expect(
    (await env.DB.prepare("SELECT * FROM copy_job_blobs WHERE job_id=?").bind(f.job.id).all())
      .results,
  ).toEqual(holds);
  const administrator = await admin();
  const page = await listDeadLetters(env.DB, administrator.session, administrator.cursors);
  expect(page.items[0]).toMatchObject({
    jobId: f.job.id,
    jobState: "cancelled",
    eventKind: "copy.requested",
    eventState: "failed",
  });
});
it("lets normal dispatch finish work after a DLQ observation", async () => {
  const f = await outboxFixture();
  await deliver(message({ outboxId: f.id }));
  expect(
    await dispatchOutbox(
      mutationEnv(),
      { send: async () => ({ metadata: { metrics: { backlogCount: 0, backlogBytes: 0 } } }) },
      f.id,
      1,
    ),
  ).toBe("sent");
  expect(await consumeOutbox(mutationEnv(), f.id)).toBe("completed");
  expect((await rows()).results).toHaveLength(1);
});
it("routes the trusted Queue name separately and refuses unknown or ambiguous bindings", async () => {
  const f = await outboxFixture(),
    m = message({ outboxId: f.id });
  const batch = {
    queue: env.JOBS_DLQ_NAME!,
    messages: [m],
    retryAll: vi.fn(),
    ackAll: vi.fn(),
  } as unknown as MessageBatch;
  await worker.queue(batch, mutationEnv());
  expect(m.ack).toHaveBeenCalledOnce();
  expect(
    await env.DB.prepare("SELECT state FROM outbox WHERE outbox_id=?").bind(f.id).first("state"),
  ).toBe("pending");
  for (const [queue, app] of [
    ["unknown", mutationEnv()],
    [env.JOBS_DLQ_NAME!, { ...mutationEnv(), JOBS_QUEUE_NAME: env.JOBS_DLQ_NAME! }],
    [env.JOBS_DLQ_NAME!, { ...mutationEnv(), JOBS_QUEUE_NAME: "" }],
  ] as const) {
    const retryAll = vi.fn();
    await worker.queue({ ...batch, queue, retryAll }, app);
    expect(retryAll).toHaveBeenCalledOnce();
  }
  await env.DB.prepare("UPDATE control SET maintenance=1").run();
  const retryAll = vi.fn();
  await worker.queue({ ...batch, retryAll }, mutationEnv());
  expect(retryAll).toHaveBeenCalledOnce();
});
it("lists private operational metadata with bounded signed pagination and live job state", async () => {
  const f = await admin();
  await atomicBatch(
    env.DB,
    Array.from({ length: 53 }, (_, i) => ({
      sql: "INSERT INTO queue_dead_letters VALUES(?,?,1,?,1)",
      values: [
        `receipt_${String(i).padStart(3, "0")}`,
        i === 52 ? f.id : null,
        100 + Math.floor(i / 2),
      ],
    })),
  );
  const first = await listDeadLetters(env.DB, f.session, f.cursors);
  expect(first.items).toHaveLength(50);
  expect(first.items[0]).toEqual({
    messageId: "receipt_052",
    outboxId: f.id,
    sentAt: 1,
    receivedAt: 126,
    recordedEpoch: 1,
    eventKind: "node.created",
    eventState: "pending",
    eventEpoch: 1,
    jobId: null,
    jobState: null,
  });
  expect(first.nextCursor).toBeTruthy();
  const second = await listDeadLetters(env.DB, f.session, f.cursors, first.nextCursor!);
  expect(second.items.map((i) => i.messageId)).toEqual([
    "receipt_002",
    "receipt_001",
    "receipt_000",
  ]);
  expect(second.nextCursor).toBeNull();
  expect(JSON.stringify(first)).not.toContain(f.ids.root);
  const req = new Request(env.APP_ORIGIN + "/api/v1/admin/dlq");
  expect(privateAppRoute(req)).toBe(true);
  const response = await handleDeadLetterReadHttp(req, env, f.session, f.cursors);
  expect(response.status).toBe(200);
  expect(response.headers.get("Cache-Control")).toBe("private, no-store");
});
it.each([
  "member",
  "demotion",
  "disabled",
  "revoked",
  "expired",
  "epoch",
  "maintenance",
  "identity",
])("rejects %s authority, including a stale admin session object", async (change) => {
  const f = await admin();
  if (change === "member" || change === "demotion")
    await env.DB.prepare("UPDATE users SET role='member' WHERE id=?").bind(f.ids.user).run();
  if (change === "disabled")
    await env.DB.prepare("UPDATE users SET disabled_at=1 WHERE id=?").bind(f.ids.user).run();
  if (change === "revoked")
    await env.DB.prepare("UPDATE sessions SET revoked_at=1 WHERE id=?").bind(f.ids.session).run();
  if (change === "expired")
    await env.DB.prepare("UPDATE sessions SET expires_at=issued_at+1 WHERE id=?")
      .bind(f.ids.session)
      .run();
  if (change === "epoch") await env.DB.prepare("UPDATE control SET epoch=2").run();
  if (change === "maintenance") await env.DB.prepare("UPDATE control SET maintenance=1").run();
  const session = {
    ...f.session,
    ...(change === "member" ? { role: "member" as const } : {}),
    ...(change === "identity" ? { user_id: "other" } : {}),
  };
  const response = await handleDeadLetterReadHttp(
    new Request(env.APP_ORIGIN + "/api/v1/admin/dlq"),
    env,
    session,
    f.cursors,
  );
  expect(response.status).toBe(403);
});
it("binds cursor purpose, actor, credential, epoch and expiry", async () => {
  const f = await admin();
  const claims = {
    aud: "admin-dlq" as const,
    scopeId: "dlq",
    generation: 1,
    userId: f.session.user_id,
    credentialId: f.session.credential_id,
    epoch: 1,
    lastSort: 100,
    lastId: "a",
  };
  for (const change of [
    { aud: "trash" as const },
    { scopeId: "other" },
    { generation: 2 },
    { userId: "other" },
    { credentialId: "other" },
    { epoch: 2 },
  ]) {
    const token = await f.cursors.issue({ ...claims, ...change });
    await expect(listDeadLetters(env.DB, f.session, f.cursors, token)).rejects.toThrow(
      "invalid_list_cursor",
    );
  }
  const token = await f.cursors.issue(claims);
  await expect(listDeadLetters(env.DB, f.session, f.cursors, token + "x")).rejects.toThrow(
    "invalid_list_cursor",
  );
  const expired = new ListCursorTokens(f.cursors.ring, () => Date.now() + 601000);
  await expect(listDeadLetters(env.DB, f.session, expired, token)).rejects.toThrow(
    "invalid_list_cursor",
  );
});
it("returns an authorized empty list and rejects invalid query parameters or unavailable cursor keys", async () => {
  const f = await admin(),
    request = (query = "") => new Request(env.APP_ORIGIN + "/api/v1/admin/dlq" + query);
  expect(await listDeadLetters(env.DB, f.session, f.cursors)).toEqual({
    items: [],
    nextCursor: null,
  });
  for (const query of [
    "?cursor=",
    "?cursor=a&cursor=b",
    "?ownerId=other",
    "?cursor=" + "a".repeat(4097),
  ])
    expect((await handleDeadLetterReadHttp(request(query), env, f.session, f.cursors)).status).toBe(
      400,
    );
  expect((await handleDeadLetterReadHttp(request(), env, f.session)).status).toBe(503);
  expect(
    (
      await handleDeadLetterReadHttp(
        new Request("https://other.invalid/api/v1/admin/dlq"),
        env,
        f.session,
        f.cursors,
      )
    ).status,
  ).toBe(404);
});
