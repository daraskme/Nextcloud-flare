import { applyD1Migrations } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeAll, beforeEach, expect, it } from "vitest";
import { atomicBatch } from "../../src/db/primary";
import type { Env } from "../../src/env";
import worker from "../../src/index";
import { runGarbageCollection } from "../../src/jobs/gc";
import { repairSingleUploads } from "../../src/jobs/uploadCleanup";
import { observePhysicalObject } from "../../src/services/physical";
import { acquireSystemMutation, grantPermit, mutationEnv } from "../fixtures/mutationAdmission";
import { singleCleanupFixture as fixture } from "../fixtures/uploadCleanup";

beforeAll(async () => applyD1Migrations(env.DB, env.TEST_MIGRATIONS));
beforeEach(async () => {
  await env.DB.prepare("UPDATE control SET epoch=1,maintenance=0,gc_paused=0").run();
});

type Fixture = Awaited<ReturnType<typeof fixture>>;
const store = (f: Fixture, text = "abc", metadata = f.metadata) =>
  env.BLOBS.put(f.key, text, { customMetadata: metadata });
async function counters(f: Fixture) {
  return env.DB.prepare("SELECT used_bytes,reserved_bytes,physical_bytes FROM users WHERE id=?")
    .bind(f.ids.user)
    .first();
}
async function upload(f: Fixture) {
  return env.DB.prepare(
    "SELECT state,cleanup_pending,cleanup_calls,cleanup_error,cleanup_token FROM uploads WHERE id=?",
  )
    .bind(f.id)
    .first();
}
async function due(f: Fixture) {
  await env.DB.prepare(
    "UPDATE uploads SET cleanup_lease_expires_at=CASE WHEN cleanup_token IS NULL THEN NULL ELSE 0 END,cleanup_next_at=0 WHERE id=?",
  )
    .bind(f.id)
    .run();
}
function bucket(head: R2Bucket["head"]): R2Bucket {
  return { head } as R2Bucket;
}
function lostBatch(n: number): D1Database {
  let calls = 0;
  return {
    prepare: env.DB.prepare.bind(env.DB),
    async batch(statements: D1PreparedStatement[]) {
      const result = await env.DB.batch(statements);
      if (++calls === n) throw new Error("lost_acknowledgement");
      return result;
    },
  } as D1Database;
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

it("accounts an unrecorded successful PUT, hands it to GC, and clears cleanup only after deletion", async () => {
  const f = await fixture();
  await store(f);
  expect(await counters(f)).toMatchObject({ reserved_bytes: 3, physical_bytes: 0 });
  expect(await repairSingleUploads(mutationEnv(), env.BLOBS, 1)).toEqual({
    claimed: 1,
    absent: 0,
    queued: 1,
    retried: 0,
    r2Calls: 1,
  });
  expect(await upload(f)).toMatchObject({ state: "expired", cleanup_pending: 1, cleanup_calls: 1 });
  expect(await counters(f)).toMatchObject({ used_bytes: 3, reserved_bytes: 0, physical_bytes: 3 });
  expect(await env.BLOBS.head(f.key)).not.toBeNull();
  expect(await repairSingleUploads(mutationEnv(), env.BLOBS, 1)).toMatchObject({ claimed: 0 });
  expect(await runGarbageCollection(mutationEnv(), env.BLOBS, 1)).toMatchObject({ deleted: 1 });
  expect(await upload(f)).toMatchObject({ cleanup_pending: 0 });
  expect(await counters(f)).toMatchObject({ reserved_bytes: 0, physical_bytes: 0 });
  expect(await env.BLOBS.head(f.key)).toBeNull();
});

it.each(["created", "receiving", "aborted"])(
  "settles an absent expired %s upload once",
  async (state) => {
    const f = await fixture(state);
    expect(await repairSingleUploads(mutationEnv(), env.BLOBS, 1)).toMatchObject({ absent: 1 });
    expect(await upload(f)).toMatchObject({
      state: state === "aborted" ? "aborted" : "expired",
      cleanup_pending: 0,
    });
    expect(await counters(f)).toMatchObject({ reserved_bytes: 0, physical_bytes: 0 });
    expect(await repairSingleUploads(mutationEnv(), env.BLOBS, 1)).toMatchObject({ claimed: 0 });
  },
);

it("does not treat absent R2 content before the 24-hour deadline as a failed write", async () => {
  const f = await fixture("receiving", false);
  expect(
    await repairSingleUploads(
      mutationEnv(),
      bucket(async () => {
        throw new Error("must_not_head");
      }),
      1,
    ),
  ).toMatchObject({ claimed: 0, r2Calls: 0 });
  expect(await counters(f)).toMatchObject({ reserved_bytes: 3 });
  expect(await upload(f)).toMatchObject({ state: "receiving" });
});

it("removes a previous physical charge only after observing absence", async () => {
  const f = await fixture();
  await store(f);
  await observePhysicalObject(mutationEnv(), env.BLOBS, f.blob, 1);
  await env.BLOBS.delete(f.key);
  expect(await counters(f)).toMatchObject({ reserved_bytes: 3, physical_bytes: 3 });
  expect(await repairSingleUploads(mutationEnv(), env.BLOBS, 1)).toMatchObject({ absent: 1 });
  expect(await counters(f)).toMatchObject({ reserved_bytes: 0, physical_bytes: 0 });
});

it("retains reservation on HEAD failure, waits for its lease, and retries without data budget", async () => {
  const f = await fixture();
  await env.DB.prepare("UPDATE uploads SET data_calls=3,data_bytes=declared_size*3 WHERE id=?")
    .bind(f.id)
    .run();
  expect(
    await repairSingleUploads(
      mutationEnv(),
      bucket(async () => {
        throw new Error("head_unavailable");
      }),
      1,
    ),
  ).toMatchObject({ retried: 1, r2Calls: 1 });
  expect(await counters(f)).toMatchObject({ reserved_bytes: 3 });
  expect(await repairSingleUploads(mutationEnv(), env.BLOBS, 1)).toMatchObject({ claimed: 0 });
  await due(f);
  expect(await repairSingleUploads(mutationEnv(), env.BLOBS, 1)).toMatchObject({ absent: 1 });
  expect(await upload(f)).toMatchObject({ cleanup_calls: 2, cleanup_error: null });
});

it.each([1, 2, 3])("recovers D1 acknowledgement loss in cleanup batch %i", async (batch) => {
  const f = await fixture();
  await store(f);
  const first = await repairSingleUploads(mutationEnv(lostBatch(batch)), env.BLOBS, 1);
  if (batch === 2) {
    expect(first).toMatchObject({ retried: 1, r2Calls: 0 });
    expect(await counters(f)).toMatchObject({ reserved_bytes: 3, physical_bytes: 0 });
    await due(f);
    expect(await repairSingleUploads(mutationEnv(), env.BLOBS, 1)).toMatchObject({ queued: 1 });
  } else expect(first).toMatchObject({ queued: 1, retried: 0 });
  expect(await counters(f)).toMatchObject({ reserved_bytes: 0, physical_bytes: 3 });
});

it.each([false, true])(
  "fails an expired completion claim before cleanup (bound=%s)",
  async (bound) => {
    const f = await fixture("completing");
    await store(f);
    const op = await completion(f, bound);
    expect(await repairSingleUploads(mutationEnv(), env.BLOBS, 1)).toMatchObject({ queued: 1 });
    expect(
      await env.DB.prepare("SELECT state FROM operations WHERE op_id=?").bind(op).first("state"),
    ).toBe("failed");
    expect(await upload(f)).toMatchObject({ state: "failed" });
  },
);

it.each(["committed", "partial"])(
  "refuses cleanup when the bound completion is %s",
  async (state) => {
    const f = await fixture("completing");
    await store(f);
    const op = await completion(f, true, state === "committed" ? "committed" : "claimed");
    if (state === "partial")
      await env.DB.prepare(
        "INSERT INTO operation_steps(op_id,step_no,kind,affected_id) VALUES(?,1,'node',?)",
      )
        .bind(op, f.ids.folder)
        .run();
    expect(await repairSingleUploads(mutationEnv(), env.BLOBS, 1)).toMatchObject({ claimed: 0 });
    expect(await counters(f)).toMatchObject({ reserved_bytes: 3, physical_bytes: 0 });
    expect(await upload(f)).toMatchObject({ state: "completing" });
  },
);

it("reconciles a lost acknowledgement after settling an absent object", async () => {
  const f = await fixture();
  expect(await repairSingleUploads(mutationEnv(lostBatch(3)), env.BLOBS, 1)).toMatchObject({
    absent: 1,
    retried: 0,
  });
  expect(await counters(f)).toMatchObject({ reserved_bytes: 0, physical_bytes: 0 });
  expect(await upload(f)).toMatchObject({ cleanup_pending: 0 });
});

it("ignores completed uploads", async () => {
  const f = await fixture("completed");
  await store(f);
  expect(await repairSingleUploads(mutationEnv(), env.BLOBS, 1)).toMatchObject({ claimed: 0 });
  expect(await env.BLOBS.head(f.key)).not.toBeNull();
});

it("allows only one concurrent cleanup claim to observe R2", async () => {
  const f = await fixture();
  await store(f);
  const results = await Promise.all([
    repairSingleUploads(mutationEnv(), env.BLOBS, 1),
    repairSingleUploads(mutationEnv(), env.BLOBS, 1),
  ]);
  expect(results.reduce((n, result) => n + result.r2Calls, 0)).toBe(1);
  expect(results.reduce((n, result) => n + result.queued, 0)).toBe(1);
  expect(await counters(f)).toMatchObject({ reserved_bytes: 0, physical_bytes: 3 });
});

it("converges a late HEAD result after a replacement cleanup claim has settled", async () => {
  const f = await fixture();
  await store(f);
  let replacement;
  const delayed = bucket(async (key) => {
    const object = await env.BLOBS.head(key);
    await due(f);
    replacement = await repairSingleUploads(mutationEnv(), env.BLOBS, 1);
    return object;
  });
  expect(await repairSingleUploads(mutationEnv(), delayed, 1)).toMatchObject({
    queued: 1,
    retried: 0,
  });
  expect(replacement).toMatchObject({ queued: 1 });
  const receipts = await env.DB.prepare(
    "SELECT state,committed_at FROM mutation_admissions WHERE space_id=? AND permit_id LIKE 'system:upload.cleanup-settle:%' ORDER BY seq",
  )
    .bind(f.ids.space)
    .all();
  expect(receipts.results).toEqual([
    { state: "closed", committed_at: expect.any(Number) },
    { state: "active", committed_at: null },
  ]);
  expect(await counters(f)).toMatchObject({ reserved_bytes: 0, physical_bytes: 3 });
  expect(await upload(f)).toMatchObject({ cleanup_error: null });
});

it("rejects a late observation while a replacement claim remains unresolved", async () => {
  const f = await fixture();
  await store(f);
  const delayed = bucket(async (key) => {
    const object = await env.BLOBS.head(key);
    await due(f);
    expect(
      await repairSingleUploads(
        mutationEnv(),
        bucket(async () => {
          throw new Error("unavailable");
        }),
        1,
      ),
    ).toMatchObject({ retried: 1 });
    return object;
  });
  expect(await repairSingleUploads(mutationEnv(), delayed, 1)).toMatchObject({
    retried: 1,
    queued: 0,
  });
  expect(await counters(f)).toMatchObject({ reserved_bytes: 3, physical_bytes: 0 });
});

it("fences an epoch change during HEAD and repairs revoked old-epoch uploads under maintenance", async () => {
  const f = await fixture();
  await store(f);
  const changing = bucket(async (key) => {
    await env.DB.prepare("UPDATE control SET epoch=2,maintenance=1,gc_paused=1").run();
    return env.BLOBS.head(key);
  });
  expect(await repairSingleUploads(mutationEnv(), changing, 1)).toMatchObject({ retried: 1 });
  expect(await counters(f)).toMatchObject({ reserved_bytes: 3, physical_bytes: 0 });
  await env.DB.prepare("UPDATE users SET disabled_at=? WHERE id=?")
    .bind(Date.now(), f.ids.user)
    .run();
  await env.DB.prepare("UPDATE sessions SET revoked_at=? WHERE id=?")
    .bind(Date.now(), f.ids.session)
    .run();
  await due(f);
  expect(await repairSingleUploads(mutationEnv(), env.BLOBS, 2)).toMatchObject({ claimed: 0 });
  expect(
    await repairSingleUploads(mutationEnv(), env.BLOBS, 2, { maintenance: true }),
  ).toMatchObject({
    queued: 1,
  });
  expect(await counters(f)).toMatchObject({ reserved_bytes: 0, physical_bytes: 3 });
  expect(await runGarbageCollection(mutationEnv(), env.BLOBS, 2)).toMatchObject({ deleted: 0 });
});

it("preserves a pin added after claim and before settlement", async () => {
  const f = await fixture();
  await store(f);
  const pinning = bucket(async (key) => {
    await env.DB.prepare(
      "INSERT INTO blob_pins(pin_id,blob_id,purpose,created_at) VALUES(?,?,'backup',?)",
    )
      .bind(crypto.randomUUID(), f.blob, Date.now())
      .run();
    return env.BLOBS.head(key);
  });
  expect(await repairSingleUploads(mutationEnv(), pinning, 1)).toMatchObject({ retried: 1 });
  expect(await counters(f)).toMatchObject({ reserved_bytes: 3 });
  expect(await env.BLOBS.head(f.key)).not.toBeNull();
});

it("charges unexpected objects and quarantines them without deletion or reservation refund", async () => {
  const f = await fixture();
  await store(f, "abc", { ...f.metadata, attempt_id: "unexpected" });
  expect(await repairSingleUploads(mutationEnv(), env.BLOBS, 1)).toMatchObject({
    retried: 1,
    queued: 0,
  });
  expect(await counters(f)).toMatchObject({ reserved_bytes: 3, physical_bytes: 3 });
  expect(await upload(f)).toMatchObject({
    cleanup_error: "upload_object_mismatch",
    cleanup_pending: 1,
  });
  await runGarbageCollection(mutationEnv(), env.BLOBS, 1);
  expect(await env.BLOBS.head(f.key)).not.toBeNull();
  expect(
    await env.DB.prepare("SELECT COUNT(*) AS n FROM gc_candidates WHERE blob_id=?")
      .bind(f.blob)
      .first("n"),
  ).toBe(0);
});

it("accounts the actual size of an owned malformed write before deleting it", async () => {
  const f = await fixture();
  await store(f, "ab");
  expect(await repairSingleUploads(mutationEnv(), env.BLOBS, 1)).toMatchObject({ queued: 1 });
  expect(await counters(f)).toMatchObject({ reserved_bytes: 0, physical_bytes: 2 });
  expect(await runGarbageCollection(mutationEnv(), env.BLOBS, 1)).toMatchObject({ deleted: 1 });
  expect(await counters(f)).toMatchObject({ physical_bytes: 0 });
});

it("rolls back reservation, physical observation and GC handoff together on a settlement failure", async () => {
  const f = await fixture();
  await store(f);
  await env.DB.prepare(`CREATE TRIGGER inject_cleanup_settlement BEFORE UPDATE OF cleanup_token ON uploads
    WHEN OLD.id='${f.id}' AND OLD.cleanup_token IS NOT NULL AND NEW.cleanup_token IS NULL
    BEGIN INSERT INTO _assert(v) VALUES(1); END`).run();
  try {
    expect(await repairSingleUploads(mutationEnv(), env.BLOBS, 1)).toMatchObject({ retried: 1 });
    expect(await counters(f)).toMatchObject({ reserved_bytes: 3, physical_bytes: 0 });
    expect(
      await env.DB.prepare("SELECT COUNT(*) AS n FROM gc_candidates WHERE blob_id=?")
        .bind(f.blob)
        .first("n"),
    ).toBe(0);
  } finally {
    await env.DB.exec("DROP TRIGGER inject_cleanup_settlement");
  }
  await due(f);
  expect(await repairSingleUploads(mutationEnv(), env.BLOBS, 1)).toMatchObject({ queued: 1 });
});

it("bounds each pass and advances past a failed candidate on the next invocation", async () => {
  await fixture();
  await fixture();
  await fixture();
  expect(
    await repairSingleUploads(
      mutationEnv(),
      bucket(async () => {
        throw new Error("unavailable");
      }),
      1,
      { maxUploads: 1 },
    ),
  ).toMatchObject({ claimed: 1, retried: 1, r2Calls: 1 });
  expect(await repairSingleUploads(mutationEnv(), env.BLOBS, 1, { maxUploads: 1 })).toMatchObject({
    absent: 1,
  });
  expect(await repairSingleUploads(mutationEnv(), env.BLOBS, 1, { maxUploads: 1 })).toMatchObject({
    absent: 1,
  });
  expect(await repairSingleUploads(mutationEnv(), env.BLOBS, 1)).toMatchObject({ claimed: 0 });
});

it("runs from Cron under ControlDO admission and respects the GC pause", async () => {
  const f = await fixture();
  await store(f);
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
  expect(await upload(f)).toMatchObject({ state: "receiving", cleanup_calls: 0 });
  maintenance = false;
  await env.DB.prepare("UPDATE control SET gc_paused=1").run();
  await worker.scheduled({} as ScheduledController, runtime);
  expect(await counters(f)).toMatchObject({ reserved_bytes: 0, physical_bytes: 3 });
  expect(await upload(f)).toMatchObject({ cleanup_pending: 1 });
  gcPaused = false;
  await env.DB.prepare("UPDATE control SET gc_paused=0").run();
  await worker.scheduled({} as ScheduledController, runtime);
  expect(await counters(f)).toMatchObject({ physical_bytes: 0 });
  expect(await upload(f)).toMatchObject({ cleanup_pending: 0 });
});
