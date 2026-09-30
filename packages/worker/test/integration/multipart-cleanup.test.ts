import { applyD1Migrations, evictDurableObject, runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { base64url } from "jose";
import { beforeAll, beforeEach, expect, it } from "vitest";
import type { Principal } from "../../src/auth/authorize";
import { contentKeyRing } from "../../src/auth/contentTokens";
import { UploadCapabilities } from "../../src/auth/uploadCapability";
import { atomicBatch } from "../../src/db/primary";
import { UploadDO } from "../../src/do/UploadDO";
import type { Env } from "../../src/env";
import worker from "../../src/index";
import { drainStoppedBlobGarbageCollection, runGarbageCollection } from "../../src/jobs/gc";
import { repairMultipartUploads } from "../../src/jobs/multipartCleanup";
import { uploadRow } from "../../src/services/uploads/access";
import { createMultipartUpload, writeMultipartPart } from "../../src/services/uploads/multipart";
import { foundationFixture } from "../fixtures/foundation";
import { expireGcGrace } from "../fixtures/gc";
import { acquireSystemMutation, grantPermit, mutationEnv } from "../fixtures/mutationAdmission";
import { multipartCleanupFixture as fixture } from "../fixtures/uploadCleanup";
import { admitted, injectBatch } from "../fixtures/uploadEnv";

beforeAll(async () => applyD1Migrations(env.DB, env.TEST_MIGRATIONS));
beforeEach(async () => {
  await env.DB.prepare("UPDATE control SET epoch=1,maintenance=0,gc_paused=0").run();
  // Persistent D1 per file: isolate each scan without weakening immutable upload timestamps.
  await env.DB.prepare(
    "UPDATE uploads SET cleanup_next_at=9999999999999 WHERE mode='multipart'",
  ).run();
});

it("does not let an unclosed upload bypass its reservation through a GC candidate", async () => {
  const f = await fixture({ known: false });
  await env.BLOBS.put(f.key, "abc");
  await env.DB.prepare(
    "INSERT INTO gc_candidates(blob_id,state,not_before) VALUES(?,'candidate',0)",
  )
    .bind(f.blob)
    .run();
  expect(await runGarbageCollection(mutationEnv(), env.BLOBS, 1, { maxBlobs: 1 })).toMatchObject({
    claimed: 0,
    r2Calls: 0,
  });
  await atomicBatch(env.DB, [
    { sql: "UPDATE blobs SET state='deleting' WHERE id=?", values: [f.blob] },
    {
      sql: "UPDATE gc_candidates SET state='deleting',claim_token=?,claim_expires_at=0 WHERE blob_id=?",
      values: [crypto.randomUUID(), f.blob],
    },
    { sql: "UPDATE control SET maintenance=1,gc_paused=1" },
  ]);
  expect(
    await drainStoppedBlobGarbageCollection(mutationEnv(), env.BLOBS, 1, { maxBlobs: 1 }),
  ).toMatchObject({ claimed: 0, r2Calls: 0 });
  expect(await env.BLOBS.head(f.key)).not.toBeNull();
  expect(
    await env.DB.prepare("SELECT state FROM reservations WHERE id=?")
      .bind(f.reservation)
      .first("state"),
  ).toBe("reserved");
});

type Fixture = Awaited<ReturnType<typeof fixture>>;
const counters = (f: Fixture) =>
  env.DB.prepare("SELECT used_bytes,reserved_bytes,physical_bytes FROM users WHERE id=?")
    .bind(f.ids.user)
    .first();
const row = (f: Fixture) => uploadRow(env.DB, f.id);
const repair = (bucket = env.BLOBS, db = env.DB, epoch = 1, maintenance = false) =>
  repairMultipartUploads(mutationEnv(db), bucket, epoch, { maintenance });
async function due(f: { id: string }) {
  await env.DB.prepare(
    "UPDATE uploads SET cleanup_next_at=0,cleanup_lease_expires_at=CASE WHEN cleanup_token IS NULL THEN NULL ELSE 0 END WHERE id=?",
  )
    .bind(f.id)
    .run();
}
function bucket(overrides: Partial<R2Bucket>): R2Bucket {
  return {
    head: env.BLOBS.head.bind(env.BLOBS),
    resumeMultipartUpload: env.BLOBS.resumeMultipartUpload.bind(env.BLOBS),
    ...overrides,
  } as R2Bucket;
}
function aborting(abort: () => Promise<void>): R2Bucket {
  return bucket({
    resumeMultipartUpload: (key, uploadId) => ({ key, uploadId, abort }) as R2MultipartUpload,
  });
}
const lost = (match: string) =>
  injectBatch(
    (sql) => sql.includes(match),
    async () => {
      throw new Error("lost_ack");
    },
    true,
  );
async function complete(f: Fixture, value = "abc") {
  const part = await f.multipart!.uploadPart(1, new TextEncoder().encode(value));
  await f.multipart!.complete([part]);
}
async function partLease(f: Fixture, expires: number) {
  await env.DB.prepare(`INSERT INTO upload_parts(upload_id,part_number,attempts,attempt_id,state,expected_size,lease_expires_at)
    VALUES(?,1,1,'part','in_flight',3,?)`)
    .bind(f.id, expires)
    .run();
}
async function completion(f: Fixture, bound: boolean, state = "claimed") {
  const op = crypto.randomUUID();
  const permit = crypto.randomUUID();
  const now = Date.now();
  const { expires_at: expiresAt } = await grantPermit(env.DB, permit, f.ids.space, 1);
  await atomicBatch(env.DB, [
    {
      sql: `INSERT INTO operations(op_id,principal_kind,principal_id,credential_id,space_id,kind,state,request_digest,epoch,
      permit_id,permit_expires_at,claimed_expires_at,expected_steps,operands_json,created_at,updated_at)
      VALUES(?,'user',?,?,?,'upload.complete',?,'fixture',1,?,?,?,10,?,?,?)`,
      values: [
        op,
        f.ids.user,
        f.ids.credential,
        f.ids.space,
        state,
        permit,
        expiresAt,
        expiresAt,
        JSON.stringify({ uploadId: f.id, parentId: f.ids.folder }),
        now,
        now,
      ],
    },
    ...(bound
      ? [{ sql: "UPDATE uploads SET completion_op_id=? WHERE id=?", values: [op, f.id] }]
      : []),
  ]);
  return op;
}

it("aborts real R2 parts after idle expiry and refunds only after confirmed absence", async () => {
  const f = await fixture();
  await f.multipart!.uploadPart(1, new TextEncoder().encode("abc"));
  expect(await repair()).toEqual({ claimed: 1, absent: 1, queued: 0, retried: 0, r2Calls: 2 });
  expect(await row(f)).toMatchObject({
    state: "expired",
    cleanup_pending: 0,
    multipart_cleanup_closed: "aborted",
    accept_parts: 0,
  });
  expect(await counters(f)).toMatchObject({ reserved_bytes: 0, physical_bytes: 0 });
  await expect(f.multipart!.uploadPart(1, new TextEncoder().encode("late"))).rejects.toThrow();
  expect(await repair()).toMatchObject({ claimed: 0 });
});

it("keeps an unexpired active upload and an active part lease out of cleanup", async () => {
  const active = await fixture({ idle: false });
  const inflight = await fixture();
  await partLease(inflight, Date.now() + 900000);
  expect(await repair()).toMatchObject({ claimed: 0, r2Calls: 0 });
  expect(await counters(active)).toMatchObject({ reserved_bytes: 3 });
  expect(await counters(inflight)).toMatchObject({ reserved_bytes: 3 });
});

it("repairs an expired part lease before the idle deadline", async () => {
  const f = await fixture({ idle: false });
  await partLease(f, 0);
  expect(await repair()).toMatchObject({ absent: 1 });
  expect(
    await env.DB.prepare("SELECT state FROM upload_parts WHERE upload_id=?")
      .bind(f.id)
      .first("state"),
  ).toBe("unknown");
});

it.each(["complete", "initialization"])("waits for the persisted %s lease", async (kind) => {
  const f = await fixture(
    kind === "complete"
      ? { state: "completing", completeLease: Date.now() + 900000 }
      : { known: false, initLease: Date.now() + 900000 },
  );
  expect(await repair()).toMatchObject({ claimed: 0 });
  expect(await counters(f)).toMatchObject({ reserved_bytes: 3 });
});

it("retains reservation on an unknown abort result despite absent HEAD, then retries", async () => {
  const f = await fixture();
  const missing = aborting(async () => {
    throw new Error("NoSuchUpload (10024)");
  });
  expect(await repair(missing)).toMatchObject({ retried: 1, r2Calls: 2, absent: 0 });
  expect(await counters(f)).toMatchObject({ reserved_bytes: 3 });
  expect(await row(f)).toMatchObject({ cleanup_pending: 1, multipart_cleanup_closed: null });
  expect(await repair()).toMatchObject({ claimed: 0 });
  await due(f);
  expect(await repair()).toMatchObject({ absent: 1 });
});

it("keeps an unknown creation ID quarantined regardless of idle expiry", async () => {
  const f = await fixture({ known: false, state: "failed" });
  expect(await repair()).toMatchObject({ retried: 1, r2Calls: 1, absent: 0 });
  expect(await counters(f)).toMatchObject({ reserved_bytes: 3 });
  expect(await row(f)).toMatchObject({ cleanup_pending: 1, multipart_cleanup_closed: null });
});

it("resumes an acknowledged abort after HEAD failure without another abort or data budget", async () => {
  const f = await fixture();
  await env.DB.prepare("UPDATE uploads SET data_calls=3,data_bytes=9,control_calls=64 WHERE id=?")
    .bind(f.id)
    .run();
  expect(
    await repair(
      bucket({
        head: async () => {
          throw new Error("head_unavailable");
        },
      }),
    ),
  ).toMatchObject({ retried: 1, r2Calls: 2 });
  expect(await counters(f)).toMatchObject({ reserved_bytes: 3 });
  await due(f);
  expect(
    await repair(
      aborting(async () => {
        throw new Error("must_not_abort");
      }),
    ),
  ).toMatchObject({ absent: 1, r2Calls: 1 });
  expect(await row(f)).toMatchObject({ data_calls: 3, data_bytes: 9, cleanup_calls: 3 });
});

it.each([
  "multipart_cleanup_started_at=COALESCE",
  "cleanup_calls=cleanup_calls+1",
  "multipart_cleanup_closed='aborted'",
  "cleanup_token=NULL,cleanup_lease_expires_at=NULL",
])("recovers D1 reply loss at %s", async (point) => {
  const f = await fixture();
  const result = await repair(env.BLOBS, lost(point));
  if (point.includes("cleanup_calls")) {
    expect(result).toMatchObject({ retried: 1 });
    expect(await counters(f)).toMatchObject({ reserved_bytes: 3 });
    if (point.includes("cleanup_calls")) expect(result.r2Calls).toBe(0);
    await due(f);
    expect(await repair()).toMatchObject({ absent: 1 });
  } else expect(result).toMatchObject({ absent: 1, retried: 0 });
  expect(await counters(f)).toMatchObject({ reserved_bytes: 0 });
});

it("accounts a completed object when abort cannot find its old handle, then hands it to GC", async () => {
  const queuedAfter = Date.now();
  const f = await fixture({ state: "completing" });
  await complete(f);
  expect(
    await repair(
      aborting(async () => {
        throw new Error("NoSuchUpload (10024)");
      }),
    ),
  ).toMatchObject({ queued: 1, r2Calls: 2 });
  expect(await counters(f)).toMatchObject({ reserved_bytes: 0, physical_bytes: 3 });
  expect(await row(f)).toMatchObject({
    state: "failed",
    cleanup_pending: 1,
    multipart_cleanup_closed: "completed",
  });
  expect(await runGarbageCollection(mutationEnv(), env.BLOBS, 1)).toMatchObject({
    claimed: 0,
    r2Calls: 0,
  });
  await expireGcGrace(f.blob, queuedAfter);
  expect(await runGarbageCollection(mutationEnv(), env.BLOBS, 1)).toMatchObject({ deleted: 1 });
  expect(await counters(f)).toMatchObject({ physical_bytes: 0 });
  expect(await row(f)).toMatchObject({ cleanup_pending: 0 });
});

it("counts actual bytes of an owned malformed completed object before GC", async () => {
  const f = await fixture({ state: "completing" });
  await complete(f, "ab");
  expect(await repair()).toMatchObject({ queued: 1 });
  expect(await counters(f)).toMatchObject({ reserved_bytes: 0, physical_bytes: 2 });
});

it.each(["metadata", "unknown-id", "no-complete-attempt"])(
  "quarantines a present %s object without refund or GC",
  async (kind) => {
    const f = await fixture({ known: kind !== "unknown-id" });
    await env.BLOBS.put(f.key, "abc", {
      customMetadata:
        kind === "metadata" ? { ...f.metadata, attempt_id: "unexpected" } : f.metadata,
    });
    expect(
      await repair(
        aborting(async () => {
          throw new Error("abort_unconfirmed");
        }),
      ),
    ).toMatchObject({ queued: 0, retried: 1 });
    expect(await counters(f)).toMatchObject({ reserved_bytes: 3, physical_bytes: 3 });
    expect(
      await env.DB.prepare("SELECT COUNT(*) n FROM gc_candidates WHERE blob_id=?")
        .bind(f.blob)
        .first("n"),
    ).toBe(0);
  },
);

it.each([false, true])("fences a completion claim before cleanup (bound=%s)", async (bound) => {
  const f = await fixture({ state: "completing" });
  const op = await completion(f, bound);
  await complete(f);
  expect(await repair()).toMatchObject({ queued: 1 });
  expect(
    await env.DB.prepare("SELECT state FROM operations WHERE op_id=?").bind(op).first("state"),
  ).toBe("failed");
});

it.each(["committed", "partial"])("preserves a %s namespace operation", async (state) => {
  const f = await fixture({ state: "completing" });
  const op = await completion(f, true, state === "committed" ? "committed" : "claimed");
  if (state === "partial")
    await env.DB.prepare(
      "INSERT INTO operation_steps(op_id,step_no,kind,affected_id) VALUES(?,1,'node',?)",
    )
      .bind(op, f.ids.folder)
      .run();
  expect(await repair()).toMatchObject({ claimed: 0 });
  expect(await counters(f)).toMatchObject({ reserved_bytes: 3 });
});

it("ignores completed uploads and pinned orphan candidates", async () => {
  const completed = await fixture({ state: "completed" });
  const pinned = await fixture();
  await env.DB.prepare(
    "INSERT INTO blob_pins(pin_id,blob_id,purpose,created_at) VALUES(?,?,'backup',?)",
  )
    .bind(crypto.randomUUID(), pinned.blob, Date.now())
    .run();
  expect(await repair()).toMatchObject({ claimed: 0 });
  expect(await counters(completed)).toMatchObject({ reserved_bytes: 3 });
});

it("allows one concurrent cleanup claimant to abort and HEAD", async () => {
  const f = await fixture();
  const results = await Promise.all([repair(), repair()]);
  expect(results.reduce((sum, r) => sum + r.absent, 0)).toBe(1);
  expect(results.reduce((sum, r) => sum + r.r2Calls, 0)).toBe(2);
  expect(await counters(f)).toMatchObject({ reserved_bytes: 0 });
});

it("holds reservations when epoch changes after abort dispatch", async () => {
  const f = await fixture();
  expect(
    await repair(
      aborting(async () => {
        await f.multipart!.abort();
        await env.DB.prepare("UPDATE control SET epoch=2,maintenance=1,gc_paused=1").run();
      }),
    ),
  ).toMatchObject({ retried: 1, absent: 0 });
  expect(await counters(f)).toMatchObject({ reserved_bytes: 3 });
  await due(f);
  expect(await repair(env.BLOBS, env.DB, 2, true)).toMatchObject({ absent: 1 });
  expect(await row(f)).toMatchObject({ state: "failed", error_code: "stale_epoch" });
});

it("preserves a pin inserted between R2 HEAD and settlement", async () => {
  const f = await fixture();
  expect(
    await repair(
      bucket({
        head: async (key) => {
          await env.DB.prepare(
            "INSERT INTO blob_pins(pin_id,blob_id,purpose,created_at) VALUES(?,?,'backup',?)",
          )
            .bind(crypto.randomUUID(), f.blob, Date.now())
            .run();
          return env.BLOBS.head(key);
        },
      }),
    ),
  ).toMatchObject({ retried: 1 });
  expect(await counters(f)).toMatchObject({ reserved_bytes: 3 });
});

it("atomically rolls back a failed reservation/GC handoff and retries using the saved closure", async () => {
  const f = await fixture({ state: "completing" });
  await complete(f);
  await env.DB.prepare(`CREATE TRIGGER inject_multipart_cleanup BEFORE UPDATE OF cleanup_token ON uploads
    WHEN OLD.id='${f.id}' AND OLD.cleanup_token IS NOT NULL AND NEW.cleanup_token IS NULL
    BEGIN INSERT INTO _assert(v) VALUES(1); END`).run();
  try {
    expect(await repair()).toMatchObject({ retried: 1 });
    expect(await counters(f)).toMatchObject({ reserved_bytes: 3, physical_bytes: 3 });
    expect(
      await env.DB.prepare("SELECT COUNT(*) n FROM gc_candidates WHERE blob_id=?")
        .bind(f.blob)
        .first("n"),
    ).toBe(0);
  } finally {
    await env.DB.exec("DROP TRIGGER inject_multipart_cleanup");
  }
  await due(f);
  expect(await repair()).toMatchObject({ queued: 1, r2Calls: 1 });
});

it("never lets a stale terminal journal or a lost DO re-open a repaired upload", async () => {
  const f = foundationFixture(crypto.randomUUID(), Date.now() - 1000);
  await atomicBatch(env.DB, f.statements);
  const principal: Principal = {
    kind: "user",
    user_id: f.ids.user,
    credential_id: f.ids.credential,
    epoch: 1,
  };
  const capabilities = new UploadCapabilities(
    await contentKeyRing("test", {
      test: base64url.encode(crypto.getRandomValues(new Uint8Array(32))),
    }),
  );
  const app = admitted();
  const created = await createMultipartUpload(
    app,
    {
      principal,
      requestId: crypto.randomUUID(),
      spaceId: f.ids.space,
      parentId: f.ids.folder,
      name: "abort.bin",
      declaredSize: 3,
    },
    capabilities,
  );
  const request = { principal, uploadId: created.id, capability: created.capability };
  const stub = app.UPLOADS.get(app.UPLOADS.idFromName(created.id));
  await stub.requestAbort(request);
  expect(await repair()).toMatchObject({ absent: 1 });
  expect(await uploadRow(env.DB, created.id)).toMatchObject({
    state: "aborted",
    cleanup_pending: 0,
  });
  const actual = env.UPLOADS.get(env.UPLOADS.idFromName(created.id));
  await runInDurableObject(actual, async (_, state) => {
    await new UploadDO(state, app).alarm();
    expect(await state.storage.getAlarm()).toBeNull();
  });
  await expect(
    stub.claimPart({ ...request, partNumber: 1, attemptId: "late", bytes: 3 }),
  ).rejects.toThrow(/upload_cleanup_started/);
  await runInDurableObject(actual, async (_, state) => {
    await state.storage.deleteAll();
  });
  await evictDurableObject(actual);
  await expect(
    writeMultipartPart(
      app,
      principal,
      created.id,
      created.capability,
      capabilities,
      1,
      "retry",
      new Blob(["abc"]).stream(),
      3,
    ),
  ).rejects.toThrow(/upload_cleanup_started/);
  expect(await uploadRow(env.DB, created.id)).toMatchObject({
    state: "aborted",
    data_calls: 0,
    cleanup_pending: 0,
  });
});

it("makes the cleanup stop and closure immutable in D1", async () => {
  const f = await fixture();
  expect(await repair()).toMatchObject({ absent: 1 });
  for (const set of [
    "multipart_cleanup_started_at=NULL",
    "multipart_cleanup_closed=NULL",
    "state='uploading',accept_parts=1",
    "multipart_complete_attempt='late',multipart_complete_lease=0",
    "multipart_ledger_id='new'",
  ]) {
    await expect(
      env.DB.prepare(`UPDATE uploads SET ${set} WHERE id=?`).bind(f.id).run(),
    ).rejects.toThrow(/immutable_multipart_cleanup/);
  }
});

it("runs from Cron while admission is open, with full objects waiting for unpaused GC", async () => {
  const queuedAfter = Date.now();
  const f = await fixture({ state: "completing" });
  await complete(f);
  let maintenance = true;
  let gcPaused = true;
  const runtime = {
    ...env,
    CONTROL: {
      idFromName: () => "singleton",
      get: () => ({
        acquireSystemMutation,
        status: async () => ({ epoch: 1, maintenance, gcPaused }),
      }),
    },
  } as unknown as Env;
  await worker.scheduled({} as ScheduledController, runtime);
  expect(await row(f)).toMatchObject({ state: "completing", cleanup_calls: 0 });
  maintenance = false;
  await env.DB.prepare("UPDATE control SET gc_paused=1").run();
  await worker.scheduled({} as ScheduledController, runtime);
  expect(await row(f)).toMatchObject({ cleanup_pending: 1 });
  expect(await counters(f)).toMatchObject({ reserved_bytes: 0, physical_bytes: 3 });
  await expireGcGrace(f.blob, queuedAfter);
  await worker.scheduled({} as ScheduledController, runtime);
  expect(await row(f)).toMatchObject({ cleanup_pending: 1 });
  gcPaused = false;
  await env.DB.prepare("UPDATE control SET gc_paused=0").run();
  await worker.scheduled({} as ScheduledController, runtime);
  expect(await row(f)).toMatchObject({ cleanup_pending: 0 });
  expect(await counters(f)).toMatchObject({ physical_bytes: 0 });
});

it("retries an actual abort whose successful response was lost", async () => {
  const f = await fixture();
  expect(
    await repair(
      aborting(async () => {
        await f.multipart!.abort();
        throw new Error("lost_abort_response");
      }),
    ),
  ).toMatchObject({ retried: 1, absent: 0 });
  expect(await counters(f)).toMatchObject({ reserved_bytes: 3 });
  await due(f);
  expect(await repair()).toMatchObject({ absent: 1 });
});

it("accepts a late initialization ID only for subsequent cleanup, never for part dispatch", async () => {
  const f = await fixture({ known: false, state: "failed" });
  const multipart = await env.BLOBS.createMultipartUpload(f.key, { customMetadata: f.metadata });
  const db = injectBatch(
    (sql) => sql.includes("multipart_cleanup_started_at=COALESCE"),
    async () => {
      await env.DB.prepare("UPDATE uploads SET r2_upload_id=? WHERE id=?")
        .bind(multipart.uploadId, f.id)
        .run();
    },
    true,
  );
  expect(await repair(env.BLOBS, db)).toMatchObject({ absent: 1, r2Calls: 2 });
  expect(await row(f)).toMatchObject({
    state: "failed",
    cleanup_pending: 0,
    multipart_cleanup_closed: "aborted",
  });
});

it.each(["INSERT INTO blob_storage", "multipart_cleanup_closed='completed'"])(
  "retains accounting across lost %s acknowledgement",
  async (point) => {
    const f = await fixture({ state: "completing" });
    await complete(f);
    const closed = aborting(async () => {
      throw new Error("NoSuchUpload");
    });
    expect(await repair(closed, lost(point))).toMatchObject({ retried: 0, queued: 1 });
    expect(await counters(f)).toMatchObject({ reserved_bytes: 0, physical_bytes: 3 });
    expect(await repair(closed)).toMatchObject({ claimed: 0 });
    expect(await counters(f)).toMatchObject({ reserved_bytes: 0, physical_bytes: 3 });
  },
);

it("rejects a late HEAD after another lease completed the cleanup without double refund", async () => {
  const f = await fixture();
  let replacement;
  expect(
    await repair(
      bucket({
        head: async (key) => {
          const object = await env.BLOBS.head(key);
          await due(f);
          replacement = await repair();
          return object;
        },
      }),
    ),
  ).toMatchObject({ absent: 1, retried: 0 });
  expect(replacement).toMatchObject({ absent: 1, r2Calls: 1 });
  expect(await counters(f)).toMatchObject({ reserved_bytes: 0, physical_bytes: 0 });
});

it("bounds each pass and advances past quarantined uploads", async () => {
  const first = await fixture({ known: false });
  const second = await fixture();
  const third = await fixture();
  await env.DB.prepare("UPDATE uploads SET cleanup_next_at=1 WHERE id IN (?,?)")
    .bind(second.id, third.id)
    .run();
  expect(
    await repairMultipartUploads(mutationEnv(), env.BLOBS, 1, { maxUploads: 1 }),
  ).toMatchObject({
    claimed: 1,
    retried: 1,
  });
  expect(
    await repairMultipartUploads(mutationEnv(), env.BLOBS, 1, { maxUploads: 1 }),
  ).toMatchObject({
    claimed: 1,
    absent: 1,
  });
  expect(
    await repairMultipartUploads(mutationEnv(), env.BLOBS, 1, { maxUploads: 1 }),
  ).toMatchObject({
    claimed: 1,
    absent: 1,
  });
  expect(await counters(first)).toMatchObject({ reserved_bytes: 3 });
});
