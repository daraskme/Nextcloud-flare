import { applyD1Migrations } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { deadLetterRoute, handleDeadLetterHttp } from "../../src/api/deadLetters";
import { readAccessSession } from "../../src/auth/sessions";
import { atomicBatch } from "../../src/db/primary";
import type { Env } from "../../src/env";
import { claimCopyJob, releaseCopyJobClaim } from "../../src/jobs/copyClaim";
import { cancelCopyJob } from "../../src/jobs/copyLifecycle";
import { copyNextBlob } from "../../src/jobs/copyMultipart";
import { handleDeadLetterBatch } from "../../src/jobs/deadLetters";
import { dispatchOutbox } from "../../src/jobs/outbox";
import { handleOutboxBatch } from "../../src/jobs/queue";
import { createInternalShare } from "../../src/services/internalShares";
import { requeueDeadLetter } from "../../src/services/requeueDeadLetter";
import { copyJobCounters, copyJobFixture } from "../fixtures/copyJob";
import { foundationFixture } from "../fixtures/foundation";
import {
  acquireMutation,
  clearEndedR2TestWrites,
  mutationEnv,
} from "../fixtures/mutationAdmission";
import { outboxFixture } from "../fixtures/outbox";
import { systemMutationFault } from "../fixtures/systemMutationFault";
import { admitted, injectBatch } from "../fixtures/uploadEnv";

beforeAll(() => applyD1Migrations(env.DB, env.TEST_MIGRATIONS));
beforeEach(async () => {
  await env.DB.prepare("UPDATE control SET maintenance=1").run();
  await env.DB.prepare("UPDATE control SET epoch=1,maintenance=0").run();
});
afterEach(async () => {
  vi.restoreAllMocks();
  await clearEndedR2TestWrites();
});
const metadata = { metadata: { metrics: { backlogCount: 0, backlogBytes: 0 } } };
async function administrator(epoch = 1) {
  const f = foundationFixture(crypto.randomUUID(), Date.now() - 1000);
  await atomicBatch(
    env.DB,
    f.statements.map((s) =>
      s.sql.startsWith("INSERT INTO sessions")
        ? {
            ...s,
            sql: s.sql.replace("'access',?,1,", "'access',?,?,"),
            values: [...s.values!.slice(0, 3), epoch, ...s.values!.slice(3)],
          }
        : s,
    ),
  );
  await env.DB.prepare("UPDATE users SET role='app_admin' WHERE id=?").bind(f.ids.user).run();
  return { ...f, session: (await readAccessSession(env.DB, f.ids.credential, epoch))! };
}
async function observation(outboxId: string, expire = true) {
  const messageId = crypto.randomUUID(),
    ack = vi.fn();
  expect(
    await handleDeadLetterBatch(mutationEnv(), {
      messages: [
        { id: messageId, timestamp: new Date(1000), body: { outboxId }, ack, retry: vi.fn() },
      ],
    }),
  ).toEqual({ acked: 1, retried: 0 });
  if (expire)
    await env.DB.prepare("UPDATE outbox SET dispatch_expires_at=0 WHERE outbox_id=?")
      .bind(outboxId)
      .run();
  return messageId;
}
async function fixture() {
  const original = await outboxFixture(),
    admin = await administrator();
  expect(await dispatchOutbox(mutationEnv(), { send: async () => metadata }, original.id, 1)).toBe(
    "sent",
  );
  const messageId = await observation(original.id),
    key = crypto.randomUUID();
  const run = (app = mutationEnv(), requestKey = key) =>
    requeueDeadLetter(app, admin.session, original.id, messageId, requestKey);
  const row = () =>
    env.DB.prepare("SELECT * FROM queue_dead_letters WHERE message_id=?").bind(messageId).first();
  const event = () =>
    env.DB.prepare("SELECT * FROM outbox WHERE outbox_id=?").bind(original.id).first();
  return { original, admin, messageId, key, run, row, event };
}
async function dispatchAndConsume(id: string, app = mutationEnv()) {
  const send = vi.fn(async () => metadata);
  expect(await dispatchOutbox(app, { send }, id, 1)).toBe("sent");
  expect(send).toHaveBeenCalledExactlyOnceWith({ outboxId: id }, { contentType: "json" });
  const ack = vi.fn();
  expect(
    await handleOutboxBatch(
      { ...app, LOCKS: admitted().LOCKS },
      { messages: [{ body: { outboxId: id }, ack, retry: vi.fn() }] },
    ),
  ).toEqual({ acked: 1, retried: 0 });
}

it("atomically records administrator intent and wakes the same Outbox for normal dispatch", async () => {
  const f = await fixture(),
    before = await f.event();
  const result = await f.run();
  expect(result).toMatchObject({
    messageId: f.messageId,
    outboxId: f.original.id,
    requeueId: expect.stringMatching(/^dlq_[a-f0-9]{64}$/),
    epoch: 1,
  });
  expect(await f.row()).toMatchObject({
    requeue_id: result.requeueId,
    requeue_actor_id: f.admin.ids.user,
    requeue_credential_id: f.admin.ids.credential,
    requeued_at: result.requeuedAt,
  });
  expect(await f.event()).toMatchObject({
    ...before,
    state: "pending",
    dispatch_token: null,
    dispatch_expires_at: null,
    updated_at: expect.any(Number),
  });
  expect(
    await env.DB.prepare("SELECT * FROM activity WHERE id=?").bind(result.requeueId).first(),
  ).toEqual({
    id: result.requeueId,
    op_id: f.original.id,
    actor_id: f.admin.ids.user,
    kind: "admin.dlq",
    affected_id: f.messageId,
    created_at: result.requeuedAt,
  });
  await dispatchAndConsume(f.original.id);
  const terminal = await f.event();
  await env.DB.prepare("UPDATE sessions SET revoked_at=1 WHERE id=?")
    .bind(f.original.ids.session)
    .run();
  expect(await f.run()).toEqual(result);
  expect(await f.event()).toEqual(terminal);
});
it.each([false, true])(
  "deduplicates concurrent requests, with different keys=%s",
  async (different) => {
    const f = await fixture();
    const results = await Promise.allSettled([
      f.run(),
      f.run(mutationEnv(), different ? crypto.randomUUID() : f.key),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(different ? 1 : 2);
    if (!different) expect(results[0]).toEqual(results[1]);
    else
      expect(
        String((results.find((r) => r.status === "rejected") as PromiseRejectedResult).reason),
      ).toContain("dead_letter_already_requeued");
    expect(
      await env.DB.prepare(
        "SELECT COUNT(*) n FROM activity WHERE kind='admin.dlq' AND affected_id=?",
      )
        .bind(f.messageId)
        .first("n"),
    ).toBe(1);
  },
);
it("does not bind the same key to another observation or allow another credential to reuse its receipt", async () => {
  const f = await fixture(),
    saved = await f.run(),
    second = await observation(f.original.id);
  await expect(
    requeueDeadLetter(mutationEnv(), f.admin.session, f.original.id, second, f.key),
  ).rejects.toThrow("requeue_key_conflict");
  await expect(f.run(mutationEnv(), crypto.randomUUID())).rejects.toThrow(
    "dead_letter_already_requeued",
  );
  const other = await administrator();
  await expect(
    requeueDeadLetter(mutationEnv(), other.session, f.original.id, f.messageId, f.key),
  ).rejects.toThrow("dead_letter_already_requeued");
  expect(await f.run()).toEqual(saved);
});
it.each(["ack", "rollback", "reads"] as const)(
  "reconciles %s D1 failure without a second audit or state change",
  async (mode) => {
    const f = await fixture(),
      before = await f.event(),
      fault = systemMutationFault("queue.requeue:", mode);
    if (mode === "rollback") {
      await expect(f.run(mutationEnv(fault.db))).rejects.toThrow("mutation_unavailable");
      expect(await f.event()).toEqual(before);
      expect(await f.row()).toMatchObject({ requeue_id: null, requeued_at: null });
    } else {
      const result = await f.run(mutationEnv(fault.db));
      expect(await f.run()).toEqual(result);
    }
    expect(fault.fired()).toBe(true);
  },
);
it.each(["member", "disabled", "revoked", "expired"])(
  "requires current administrator authority: %s",
  async (change) => {
    const f = await fixture(),
      before = await f.event();
    const sql =
      change === "member"
        ? "UPDATE users SET role='member' WHERE id=?"
        : change === "disabled"
          ? "UPDATE users SET disabled_at=1 WHERE id=?"
          : change === "revoked"
            ? "UPDATE sessions SET revoked_at=1 WHERE id=?"
            : "UPDATE sessions SET expires_at=issued_at+1 WHERE id=?";
    await env.DB.prepare(sql)
      .bind(change === "member" || change === "disabled" ? f.admin.ids.user : f.admin.ids.session)
      .run();
    await expect(f.run()).rejects.toThrow("admin_access_required");
    expect(await f.event()).toEqual(before);
  },
);
it.each(["admin", "actor", "maintenance", "epoch", "dispatch", "claim"])(
  "fences a %s change while waiting for admission",
  async (change) => {
    const f = await fixture();
    const app = {
      ...mutationEnv(),
      CONTROL: {
        idFromName: env.CONTROL.idFromName.bind(env.CONTROL),
        get: () => ({
          acquireMutation: async (r: Parameters<typeof acquireMutation>[0]) => {
            const receipt = await acquireMutation(r);
            if (change === "admin")
              await env.DB.prepare("UPDATE users SET role='member' WHERE id=?")
                .bind(f.admin.ids.user)
                .run();
            if (change === "actor")
              await env.DB.prepare("UPDATE sessions SET revoked_at=1 WHERE id=?")
                .bind(f.original.ids.session)
                .run();
            if (change === "maintenance")
              await env.DB.prepare("UPDATE control SET maintenance=1").run();
            if (change === "epoch") await env.DB.prepare("UPDATE control SET epoch=2").run();
            if (change === "dispatch")
              await env.DB.prepare(
                "UPDATE outbox SET dispatch_token='new',dispatch_expires_at=strftime('%s','now')*1000+30000 WHERE outbox_id=?",
              )
                .bind(f.original.id)
                .run();
            if (change === "claim")
              await env.DB.prepare(
                "UPDATE outbox SET claim_token='new',claim_expires_at=strftime('%s','now')*1000+30000 WHERE outbox_id=?",
              )
                .bind(f.original.id)
                .run();
            return receipt;
          },
        }),
      } as unknown as Env["CONTROL"],
    };
    await expect(f.run(app)).rejects.toThrow();
    expect(await f.row()).toMatchObject({ requeue_id: null });
    expect(
      await env.DB.prepare(
        "SELECT COUNT(*) n FROM activity WHERE kind='admin.dlq' AND affected_id=?",
      )
        .bind(f.messageId)
        .first("n"),
    ).toBe(0);
    expect(await f.event()).toMatchObject({ state: "sent" });
  },
);
it.each(["completed", "failed", "dispatch", "claim", "credential", "kind", "step"])(
  "rejects a non-requeueable event: %s",
  async (change) => {
    const f = await fixture();
    if (change === "completed" || change === "failed")
      await env.DB.prepare("UPDATE outbox SET state=? WHERE outbox_id=?")
        .bind(change, f.original.id)
        .run();
    if (change === "dispatch" || change === "claim")
      await env.DB.prepare(
        `UPDATE outbox SET ${change}_expires_at=strftime('%s','now')*1000+30000 WHERE outbox_id=?`,
      )
        .bind(f.original.id)
        .run();
    if (change === "credential")
      await env.DB.prepare("UPDATE sessions SET revoked_at=1 WHERE id=?")
        .bind(f.original.ids.session)
        .run();
    if (change === "step")
      await env.DB.prepare("DELETE FROM operation_steps WHERE op_id=?").bind(f.original.id).run();
    if (change === "kind") {
      // A syntactically valid observation cannot invent a supported operation.
      const id = crypto.randomUUID();
      await env.DB.prepare(
        "INSERT INTO outbox(outbox_id,op_id,kind,payload_ref,state,epoch,created_at,updated_at) VALUES(?,?,'unknown','private','sent',1,1,1)",
      )
        .bind(id, f.original.id)
        .run();
      const messageId = await observation(id);
      await expect(
        requeueDeadLetter(mutationEnv(), f.admin.session, id, messageId, f.key),
      ).rejects.toThrow("requeue_unavailable");
      return;
    }
    const before = await f.event();
    await expect(f.run()).rejects.toThrow("requeue_unavailable");
    expect(await f.event()).toEqual(before);
  },
);
it("requires a matching saved observation and preserves malformed/unknown references", async () => {
  const f = await fixture();
  for (const [outboxId, messageId] of [
    [f.original.id, "missing"],
    ["other", f.messageId],
  ])
    await expect(
      requeueDeadLetter(mutationEnv(), f.admin.session, outboxId!, messageId!, f.key),
    ).rejects.toThrow("dead_letter_not_found");
  const unknown = await observation("missing-outbox");
  await expect(
    requeueDeadLetter(mutationEnv(), f.admin.session, "missing-outbox", unknown, f.key),
  ).rejects.toThrow("requeue_unavailable");
});
it.each(["pending", "multipart"])(
  "requeues %s copy with its existing manifest, counters and native holds",
  async (mode) => {
    const f = await copyJobFixture(
        false,
        mode === "multipart" ? new Uint8Array(9 * 1024 * 1024) : undefined,
      ),
      admin = await administrator();
    if (mode === "multipart") {
      const claim = await claimCopyJob(mutationEnv(), f.job.outboxId);
      expect(await copyNextBlob(mutationEnv(), claim, 8 * 1024 * 1024)).toBe("initialized");
      expect(await copyNextBlob(mutationEnv(), claim, 8 * 1024 * 1024)).toBe("part");
      await releaseCopyJobClaim(mutationEnv(), claim);
    }
    const messageId = await observation(f.job.outboxId),
      before = await copyJobCounters(f.job.id);
    const holds = (
      await env.DB.prepare("SELECT * FROM copy_job_blobs WHERE job_id=?").bind(f.job.id).all()
    ).results;
    await requeueDeadLetter(
      mutationEnv(),
      admin.session,
      f.job.outboxId,
      messageId,
      crypto.randomUUID(),
    );
    expect(await copyJobCounters(f.job.id)).toEqual(before);
    expect(
      (await env.DB.prepare("SELECT * FROM copy_job_blobs WHERE job_id=?").bind(f.job.id).all())
        .results,
    ).toEqual(holds);
    await dispatchAndConsume(f.job.outboxId);
    expect(await copyJobCounters(f.job.id)).toMatchObject({ state: "completed" });
  },
);
it.each(["cancelled", "lease", "budget", "revoked", "unrecorded"])(
  "retains all copy state and holds when %s",
  async (change) => {
    const f = await copyJobFixture(),
      admin = await administrator();
    if (change === "cancelled") await cancelCopyJob(mutationEnv(), f.request.principal, f.job.id);
    if (change === "lease") await claimCopyJob(mutationEnv(), f.job.outboxId);
    if (change === "budget")
      await env.DB.prepare("UPDATE bulk_jobs SET invocation_count=200 WHERE id=?")
        .bind(f.job.id)
        .run();
    if (change === "revoked") {
      await f.revoke();
      await createInternalShare(mutationEnv(), f.session, {
        kind: "internal",
        rootNodeId: f.source.ids.root,
        recipients: [f.target.ids.user + "@example.invalid"],
        role: "edit",
        expiresAt: null,
      });
    }
    if (change === "unrecorded") {
      const claim = await claimCopyJob(mutationEnv(), f.job.outboxId);
      const db = injectBatch(
        (s) => s.startsWith("UPDATE copy_job_blobs SET transfer_state='claimed'"),
        async () => {
          throw new Error("lost_prepare");
        },
        true,
      );
      await expect(copyNextBlob(mutationEnv(db), claim)).rejects.toThrow();
      await releaseCopyJobClaim(mutationEnv(), claim);
    }
    const messageId = await observation(f.job.outboxId),
      before = await copyJobCounters(f.job.id);
    const holds = (
      await env.DB.prepare("SELECT * FROM copy_job_blobs WHERE job_id=?").bind(f.job.id).all()
    ).results;
    await expect(
      requeueDeadLetter(
        mutationEnv(),
        admin.session,
        f.job.outboxId,
        messageId,
        crypto.randomUUID(),
      ),
    ).rejects.toThrow("requeue_unavailable");
    expect(await copyJobCounters(f.job.id)).toEqual(before);
    expect(
      (await env.DB.prepare("SELECT * FROM copy_job_blobs WHERE job_id=?").bind(f.job.id).all())
        .results,
    ).toEqual(holds);
  },
);
it("rejects a stale event epoch while the administrator has a current credential", async () => {
  const f = await fixture();
  await env.DB.prepare("UPDATE control SET epoch=2").run();
  const { session } = await administrator(2);
  await expect(
    requeueDeadLetter(mutationEnv(), session, f.original.id, f.messageId, f.key),
  ).rejects.toThrow("requeue_unavailable");
});
it("protects HTTP requeue with Access role, CSRF, exact body and idempotency key", async () => {
  const f = await fixture(),
    url = env.APP_ORIGIN + `/api/v1/admin/dlq/${f.original.id}/requeue`,
    csrf = { verify: vi.fn(async () => {}) };
  const req = (body: unknown = { messageId: f.messageId }, key = f.key) =>
    new Request(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Idempotency-Key": key },
      body: JSON.stringify(body),
    });
  expect(deadLetterRoute(req())).toBe(true);
  expect(
    (await handleDeadLetterHttp(req(), mutationEnv(), { ...f.admin.session, role: "member" }, csrf))
      .status,
  ).toBe(403);
  expect(
    (
      await handleDeadLetterHttp(req(), mutationEnv(), f.admin.session, {
        verify: async () => {
          throw new Error("csrf");
        },
      })
    ).status,
  ).toBe(403);
  for (const body of [
    {},
    { messageId: f.messageId, operands: { name: "replace" } },
    { messageId: "bad/id" },
  ])
    expect(
      (await handleDeadLetterHttp(req(body), mutationEnv(), f.admin.session, csrf)).status,
    ).toBe(400);
  expect(
    (await handleDeadLetterHttp(req(undefined, ""), mutationEnv(), f.admin.session, csrf)).status,
  ).toBe(400);
  const result = await handleDeadLetterHttp(req(), mutationEnv(), f.admin.session, csrf);
  expect(result.status).toBe(202);
  expect(result.headers.get("Cache-Control")).toBe("private, no-store");
  const replay = await handleDeadLetterHttp(req(), mutationEnv(), f.admin.session, csrf);
  expect(await replay.json()).toEqual(await result.json());
  expect(
    (await handleDeadLetterHttp(req(undefined, "different"), mutationEnv(), f.admin.session, csrf))
      .status,
  ).toBe(409);
});

it.each(["single", "multipart"] as const)(
  "requeues a proven %s success without repeating its native write",
  async (mode) => {
    const f = await copyJobFixture(
        false,
        mode === "multipart" ? new Uint8Array(9 * 1024 * 1024) : undefined,
      ),
      admin = await administrator();
    const claim = await claimCopyJob(mutationEnv(), f.job.outboxId);
    if (mode === "multipart") {
      expect(await copyNextBlob(mutationEnv(), claim, 8 * 1024 * 1024)).toBe("initialized");
      for (let i = 0; i < 2; i++)
        expect(await copyNextBlob(mutationEnv(), claim, 8 * 1024 * 1024)).toBe("part");
    }
    const db = new Proxy(env.DB, {
      get(target, key) {
        if (key === "prepare")
          return (sql: string) =>
            target.prepare(
              sql.startsWith("INSERT INTO blob_storage")
                ? "INSERT INTO _assert(v) SELECT 1 WHERE ? IS NOT NULL" +
                    " OR ? IS NOT NULL".repeat((sql.match(/\?/g)?.length ?? 1) - 1)
                : sql,
            );
        const value = Reflect.get(target, key);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    await expect(copyNextBlob(mutationEnv(db, db), claim, 8 * 1024 * 1024)).rejects.toThrow();
    await releaseCopyJobClaim(mutationEnv(), claim);
    const messageId = await observation(f.job.outboxId),
      before = await copyJobCounters(f.job.id);
    await requeueDeadLetter(
      mutationEnv(),
      admin.session,
      f.job.outboxId,
      messageId,
      crypto.randomUUID(),
    );
    expect(await copyJobCounters(f.job.id)).toEqual(before);
    const unexpected = vi.fn(() => {
      throw new Error("native_write_repeated");
    });
    const bucket = new Proxy(env.BLOBS, {
      get(target, key) {
        if (["put", "createMultipartUpload", "resumeMultipartUpload"].includes(String(key)))
          return unexpected;
        const value = Reflect.get(target, key);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    await dispatchAndConsume(f.job.outboxId, { ...mutationEnv(), BLOBS: bucket });
    expect(unexpected).not.toHaveBeenCalled();
  },
);

it.each(["single", "multipart"] as const)(
  "keeps an unknown %s native write held and refuses administrative replay",
  async (mode) => {
    const f = await copyJobFixture(
        false,
        mode === "multipart" ? new Uint8Array(9 * 1024 * 1024) : undefined,
      ),
      admin = await administrator(),
      claim = await claimCopyJob(mutationEnv(), f.job.outboxId);
    if (mode === "multipart")
      expect(await copyNextBlob(mutationEnv(), claim, 8 * 1024 * 1024)).toBe("initialized");
    const bucket = new Proxy(env.BLOBS, {
      get(target, key) {
        if (key === "put")
          return async (...args: Parameters<R2Bucket["put"]>) => {
            await target.put(...args);
            throw new Error("native_reply_lost");
          };
        if (key === "resumeMultipartUpload")
          return (...args: Parameters<R2Bucket["resumeMultipartUpload"]>) => {
            const upload = target.resumeMultipartUpload(...args);
            return new Proxy(upload, {
              get(part, property) {
                if (property === "uploadPart")
                  return async (...input: Parameters<R2MultipartUpload["uploadPart"]>) => {
                    await part.uploadPart(...input);
                    throw new Error("native_reply_lost");
                  };
                const value = Reflect.get(part, property);
                return typeof value === "function" ? value.bind(part) : value;
              },
            });
          };
        const value = Reflect.get(target, key);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    await expect(
      copyNextBlob({ ...mutationEnv(), BLOBS: bucket }, claim, 8 * 1024 * 1024),
    ).rejects.toThrow();
    await releaseCopyJobClaim(mutationEnv(), claim);
    const messageId = await observation(f.job.outboxId),
      before = await copyJobCounters(f.job.id),
      native = (
        await env.DB.prepare("SELECT * FROM r2_write_attempts WHERE owner_id=? AND state='pending'")
          .bind(f.target.ids.user)
          .all()
      ).results;
    expect(native).toHaveLength(1);
    await expect(
      requeueDeadLetter(
        mutationEnv(),
        admin.session,
        f.job.outboxId,
        messageId,
        crypto.randomUUID(),
      ),
    ).rejects.toThrow("requeue_unavailable");
    expect(await copyJobCounters(f.job.id)).toEqual(before);
    expect(
      (
        await env.DB.prepare("SELECT * FROM r2_write_attempts WHERE owner_id=? AND state='pending'")
          .bind(f.target.ids.user)
          .all()
      ).results,
    ).toEqual(native);
  },
);
