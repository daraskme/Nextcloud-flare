import { applyD1Migrations } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeAll, beforeEach, expect, it, vi } from "vitest";
import { atomicBatch } from "../../src/db/primary";
import { COPY_EXECUTION_LIMITS, claimCopyJob, releaseCopyJobClaim } from "../../src/jobs/copyClaim";
import { readCopyJobRange } from "../../src/jobs/copyRead";
import { dispatchOutbox } from "../../src/jobs/outbox";
import { createCopyJob } from "../../src/services/createCopyJob";
import { createInternalShare, updateInternalShare } from "../../src/services/internalShares";
import {
  copyJobCounters as counters,
  copyJobFixture as fixture,
  copyReaderEnv as readerEnv,
} from "../fixtures/copyJob";
import { foundationFixture } from "../fixtures/foundation";
import { mutationEnv } from "../fixtures/mutationAdmission";
import { admitted, injectBatch } from "../fixtures/uploadEnv";

beforeAll(() => applyD1Migrations(env.DB, env.TEST_MIGRATIONS));
beforeEach(async () => {
  await env.DB.prepare("UPDATE control SET maintenance=1").run();
  await env.DB.prepare("UPDATE control SET epoch=1,maintenance=0").run();
});
it("claims a delivered job and reads the exact R2 range without publishing or advancing", async () => {
  const f = await fixture(),
    claim = await claimCopyJob(mutationEnv(), f.job.outboxId);
  const app = readerEnv();
  expect(
    new TextDecoder().decode(
      await readCopyJobRange(app, claim, { ...f.range, offset: 1, length: 2 }),
    ),
  ).toBe("bc");
  expect(app.BLOBS.get).toHaveBeenCalledWith(f.key, {
    onlyIf: { etagMatches: f.stored.etag },
    range: { offset: 1, length: 2 },
  });
  expect(await counters(f.job.id)).toEqual({
    state: "running",
    invocation_count: 1,
    r2_calls: 1,
    attempt: 1,
    lease_calls: 1,
  });
  expect(
    await env.DB.prepare("SELECT checkpoint FROM bulk_jobs WHERE id=?")
      .bind(f.job.id)
      .first("checkpoint"),
  ).toBe('{"v":1,"blob":0,"offset":0}');
  expect(
    await env.DB.prepare("SELECT COUNT(*) AS n FROM nodes WHERE owner_id=?")
      .bind(f.target.ids.user)
      .first("n"),
  ).toBe(3);
});
it("allows only one concurrent claimant and retains the lease attempt after release", async () => {
  const f = await fixture();
  const results = await Promise.allSettled([
    claimCopyJob(mutationEnv(), f.job.outboxId),
    claimCopyJob(mutationEnv(), f.job.outboxId),
  ]);
  expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
  const won = results.find((r) => r.status === "fulfilled")!;
  if (won.status !== "fulfilled") throw new Error("missing_claim");
  await releaseCopyJobClaim(mutationEnv(), won.value);
  const next = await claimCopyJob(mutationEnv(), f.job.outboxId);
  expect(next.token).not.toBe(won.value.token);
  expect(await counters(f.job.id)).toMatchObject({ invocation_count: 2, attempt: 2 });
  const app = readerEnv();
  await expect(readCopyJobRange(app, won.value, f.range)).rejects.toThrow("copy_claim_released");
  expect(app.BLOBS.get).not.toHaveBeenCalled();
});
it("fences a stale claimant after a lease expires and cannot release its successor", async () => {
  const f = await fixture(),
    old = await claimCopyJob(mutationEnv(), f.job.outboxId);
  await env.DB.prepare("UPDATE job_leases SET expires_at=0 WHERE job_id=?").bind(f.job.id).run();
  const next = await claimCopyJob(mutationEnv(), f.job.outboxId),
    app = readerEnv();
  await expect(readCopyJobRange(app, old, f.range)).rejects.toThrow();
  await expect(releaseCopyJobClaim(mutationEnv(), old)).rejects.toThrow();
  expect(app.BLOBS.get).not.toHaveBeenCalled();
  expect(await readCopyJobRange(app, next, f.range)).toEqual(new TextEncoder().encode("abc"));
});
it("bounds live claims per destination owner", async () => {
  const f = await fixture(),
    second = await f.enqueue(),
    third = await f.enqueue();
  await claimCopyJob(mutationEnv(), f.job.outboxId);
  await claimCopyJob(mutationEnv(), second.outboxId);
  await expect(claimCopyJob(mutationEnv(), third.outboxId)).rejects.toThrow();
  expect(await counters(third.id)).toMatchObject({
    state: "pending",
    invocation_count: 0,
    attempt: null,
  });
});
it.each(["attempt", "invocations", "calls"])(
  "persists the %s budget across deliveries",
  async (kind) => {
    const f = await fixture(),
      claim = await claimCopyJob(mutationEnv(), f.job.outboxId);
    await releaseCopyJobClaim(mutationEnv(), claim);
    if (kind === "attempt")
      await env.DB.prepare("UPDATE job_leases SET attempt=10 WHERE job_id=?").bind(f.job.id).run();
    if (kind === "invocations")
      await env.DB.prepare("UPDATE bulk_jobs SET invocation_count=200 WHERE id=?")
        .bind(f.job.id)
        .run();
    if (kind === "calls")
      await env.DB.prepare("UPDATE bulk_jobs SET r2_calls=20000 WHERE id=?").bind(f.job.id).run();
    await expect(claimCopyJob(mutationEnv(), f.job.outboxId)).rejects.toThrow();
  },
);
it("recovers a claim ACK loss, but a read ACK loss cannot dispatch R2", async () => {
  const f = await fixture();
  const lostClaim = injectBatch(
    (sql) => sql.startsWith("INSERT INTO job_leases"),
    async () => {
      throw new Error("claim_ack_lost");
    },
    true,
  );
  const claim = await claimCopyJob(mutationEnv(lostClaim), f.job.outboxId);
  const lostRead = injectBatch(
    (sql) => sql.startsWith("UPDATE job_leases SET r2_calls"),
    async () => {
      throw new Error("read_ack_lost");
    },
    true,
  );
  const app = readerEnv(undefined, lostRead);
  await expect(readCopyJobRange(app, claim, f.range)).rejects.toThrow("read_ack_lost");
  expect(app.BLOBS.get).not.toHaveBeenCalled();
  expect(await counters(f.job.id)).toMatchObject({
    invocation_count: 1,
    lease_calls: 1,
    r2_calls: 1,
  });
});
it.each(["share", "session", "source-owner", "destination-owner", "maintenance", "epoch"])(
  "denies a new claim after %s changes",
  async (kind) => {
    const f = await fixture();
    if (kind === "share") await f.revoke();
    if (kind === "session")
      await env.DB.prepare("UPDATE sessions SET revoked_at=1 WHERE id=?")
        .bind(f.target.ids.session)
        .run();
    if (kind.endsWith("owner"))
      await env.DB.prepare("UPDATE users SET disabled_at=1 WHERE id=?")
        .bind(kind === "source-owner" ? f.source.ids.user : f.target.ids.user)
        .run();
    if (kind === "maintenance" || kind === "epoch")
      await env.DB.prepare("UPDATE control SET maintenance=1").run();
    if (kind === "epoch") await env.DB.prepare("UPDATE control SET epoch=2").run();
    await expect(claimCopyJob(mutationEnv(), f.job.outboxId)).rejects.toThrow();
    expect(await counters(f.job.id)).toMatchObject({ state: "pending", invocation_count: 0 });
  },
);
it.each(["claim", "read"])("rechecks grants inside the %s batch", async (phase) => {
  const f = await fixture();
  const db = injectBatch(
    (sql) =>
      sql.startsWith(
        phase === "claim" ? "INSERT INTO job_leases" : "UPDATE job_leases SET r2_calls",
      ),
    async () => {
      await f.revoke();
    },
    false,
  );
  if (phase === "claim") {
    await expect(claimCopyJob(mutationEnv(db), f.job.outboxId)).rejects.toThrow();
    expect(await counters(f.job.id)).toMatchObject({ invocation_count: 0 });
  } else {
    const claim = await claimCopyJob(mutationEnv(), f.job.outboxId),
      app = readerEnv(undefined, db);
    await expect(readCopyJobRange(app, claim, f.range)).rejects.toThrow();
    expect(app.BLOBS.get).not.toHaveBeenCalled();
    expect(await counters(f.job.id)).toMatchObject({ r2_calls: 0 });
  }
});
it("does not replace the selected source share with a broader remaining grant", async () => {
  const f = await fixture(),
    claim = await claimCopyJob(mutationEnv(), f.job.outboxId);
  await createInternalShare(mutationEnv(), f.session, {
    kind: "internal",
    rootNodeId: f.source.ids.root,
    recipients: [f.target.ids.user + "@example.invalid"],
    role: "read",
    expiresAt: null,
  });
  await f.revoke();
  const app = readerEnv();
  await expect(readCopyJobRange(app, claim, f.range)).rejects.toThrow();
  expect(app.BLOBS.get).not.toHaveBeenCalled();
});
it("rechecks an independently selected destination grant on every range", async () => {
  const f = await fixture(),
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
  const share = await createInternalShare(mutationEnv(), session, {
    kind: "internal",
    rootNodeId: owner.ids.folder,
    recipients: [f.target.ids.user + "@example.invalid"],
    role: "edit",
    expiresAt: null,
  });
  const result = await createCopyJob(admitted(), {
    ...f.request,
    requestId: crypto.randomUUID(),
    destination: { spaceId: owner.ids.space, share },
    destinationParentId: owner.ids.folder,
  });
  if (result.kind !== "terminal" || !result.operation.result?.jobId)
    throw new Error("fixture_copy_failed");
  const outboxId = result.operation.id + "_copy";
  expect(
    await dispatchOutbox(
      mutationEnv(),
      { send: async () => ({ metadata: { metrics: { backlogCount: 1, backlogBytes: 0 } } }) },
      outboxId,
      1,
    ),
  ).toBe("sent");
  const claim = await claimCopyJob(mutationEnv(), outboxId);
  expect(new TextDecoder().decode(await readCopyJobRange(readerEnv(), claim, f.range))).toBe("abc");
  await updateInternalShare(mutationEnv(), session, share.id, share.version, null);
  const app = readerEnv();
  await expect(readCopyJobRange(app, claim, f.range)).rejects.toThrow();
  expect(app.BLOBS.get).not.toHaveBeenCalled();
});
it("reads the pinned original after the live file changes its content", async () => {
  const f = await fixture(),
    claim = await claimCopyJob(mutationEnv(), f.job.outboxId),
    id = crypto.randomUUID();
  await atomicBatch(env.DB, [
    {
      sql: "INSERT INTO blobs(id,owner_id,r2_key,size,content_etag,state,created_at) VALUES(?,?,?,3,'new','committed',1)",
      values: [id, f.source.ids.user, `u/${f.source.ids.user}/b/${id}`],
    },
    {
      sql: "UPDATE nodes SET current_blob_id=?,revision=revision+1 WHERE id=?",
      values: [id, f.source.ids.file],
    },
  ]);
  expect(new TextDecoder().decode(await readCopyJobRange(readerEnv(), claim, f.range))).toBe("abc");
});
it("denies a fixed source witness moved outside the selected share", async () => {
  const f = await fixture(),
    claim = await claimCopyJob(mutationEnv(), f.job.outboxId),
    app = readerEnv();
  await env.DB.prepare("UPDATE nodes SET parent_id=?,revision=revision+1 WHERE id=?")
    .bind(f.source.ids.root, f.source.ids.file)
    .run();
  await expect(readCopyJobRange(app, claim, f.range)).rejects.toThrow();
  expect(app.BLOBS.get).not.toHaveBeenCalled();
});
it("withholds data when a grant is revoked while R2 is reading", async () => {
  const f = await fixture(),
    claim = await claimCopyJob(mutationEnv(), f.job.outboxId);
  const get = vi.fn(async (...args: Parameters<R2Bucket["get"]>) => {
    const result = await env.BLOBS.get(...args);
    await f.revoke();
    return result;
  });
  await expect(readCopyJobRange(readerEnv(get), claim, f.range)).rejects.toThrow();
  await releaseCopyJobClaim(mutationEnv(), claim);
  expect(
    await env.DB.prepare("SELECT COUNT(*) AS n FROM copy_job_blobs WHERE job_id=?")
      .bind(claim.id)
      .first("n"),
  ).toBe(1);
});
it("rejects physical source replacement using the recorded conditional ETag", async () => {
  const f = await fixture(),
    claim = await claimCopyJob(mutationEnv(), f.job.outboxId);
  await env.BLOBS.put(f.key, "xyz");
  await expect(readCopyJobRange(readerEnv(), claim, f.range)).rejects.toThrow(
    "copy_source_changed",
  );
});
it("reads and verifies an empty source without an invalid zero-length Range", async () => {
  const f = await fixture(true),
    claim = await claimCopyJob(mutationEnv(), f.job.outboxId),
    app = readerEnv();
  expect(await readCopyJobRange(app, claim, f.range)).toEqual(new Uint8Array(0));
  expect(app.BLOBS.get).toHaveBeenCalledWith(f.key, { onlyIf: { etagMatches: f.stored.etag } });
});
it.each(["offset", "length", "unknown", "oversized", "forged"])(
  "rejects %s input before R2 dispatch",
  async (kind) => {
    const f = await fixture(),
      claim = await claimCopyJob(mutationEnv(), f.job.outboxId),
      app = readerEnv();
    const range = { ...f.range };
    if (kind === "offset") range.offset = -1;
    if (kind === "length") range.length = 0;
    if (kind === "unknown") range.blobId = f.target.ids.blob;
    if (kind === "oversized") range.length = COPY_EXECUTION_LIMITS.rangeBytes + 1;
    await expect(
      readCopyJobRange(app, kind === "forged" ? { ...claim } : claim, range),
    ).rejects.toThrow();
    expect(app.BLOBS.get).not.toHaveBeenCalled();
  },
);
it("refuses reads beyond the persistent invocation budget", async () => {
  const f = await fixture(),
    claim = await claimCopyJob(mutationEnv(), f.job.outboxId),
    app = readerEnv();
  await env.DB.prepare("UPDATE job_leases SET r2_calls=? WHERE job_id=?")
    .bind(COPY_EXECUTION_LIMITS.rangeReads, claim.id)
    .run();
  await expect(readCopyJobRange(app, claim, f.range)).rejects.toThrow();
  expect(app.BLOBS.get).not.toHaveBeenCalled();
  expect(await counters(f.job.id)).toMatchObject({
    r2_calls: 0,
    lease_calls: COPY_EXECUTION_LIMITS.rangeReads,
  });
});

function fakeBody(
  f: Awaited<ReturnType<typeof fixture>>,
  body: ReadableStream<Uint8Array>,
  overrides = {},
) {
  return {
    key: f.key,
    etag: f.stored.etag,
    size: 3,
    range: { offset: 0, length: 3 },
    body,
    ...overrides,
  } as R2ObjectBody;
}
it("retains an expired claim when a destination write has an unknown outcome", async () => {
  const f = await fixture(),
    claim = await claimCopyJob(mutationEnv(), f.job.outboxId);
  await releaseCopyJobClaim(mutationEnv(), claim);
  const id = crypto.randomUUID(),
    now = Math.floor(Date.now() / 1000) * 1000;
  // Synthetic ledger receipt only; this test does not initiate a native write.
  await env.DB.prepare(`INSERT INTO r2_write_attempts(id,token,epoch,owner_id,kind,r2_key,dispatch_before,started_at,state,source_ref)
    VALUES(?,?,1,?,'upload.put',?,?,?,'pending',?)`)
    .bind(
      id,
      crypto.randomUUID(),
      f.target.ids.user,
      `u/${f.target.ids.user}/b/${claim.id}_b00001`,
      now + 5000,
      now,
      id,
    )
    .run();
  try {
    await expect(claimCopyJob(mutationEnv(), f.job.outboxId)).rejects.toThrow();
    expect(await counters(claim.id)).toMatchObject({ invocation_count: 1, attempt: 1 });
  } finally {
    await env.DB.prepare(
      "UPDATE r2_write_attempts SET state='not_started',finished_at=started_at WHERE id=?",
    )
      .bind(id)
      .run();
  }
});
it("cancels an unread body when R2 metadata differs", async () => {
  const f = await fixture(),
    claim = await claimCopyJob(mutationEnv(), f.job.outboxId);
  const cancel = vi.fn(),
    body = new ReadableStream<Uint8Array>({ cancel });
  await expect(
    readCopyJobRange(readerEnv(vi.fn(async () => fakeBody(f, body, { size: 4 }))), claim, f.range),
  ).rejects.toThrow("copy_source_changed");
  expect(cancel).toHaveBeenCalled();
});
it("cancels a body that overflows before it closes", async () => {
  const f = await fixture(),
    claim = await claimCopyJob(mutationEnv(), f.job.outboxId);
  const cancel = vi.fn(),
    body = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(new Uint8Array(4));
      },
      cancel,
    });
  await expect(
    readCopyJobRange(readerEnv(vi.fn(async () => fakeBody(f, body))), claim, f.range),
  ).rejects.toThrow("copy_source_length_mismatch");
  expect(cancel).toHaveBeenCalled();
});
it("stops an active read when its claim is released and keeps quota and pins", async () => {
  const f = await fixture(),
    claim = await claimCopyJob(mutationEnv(), f.job.outboxId);
  let entered!: () => void;
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const cancel = vi.fn(),
    body = new ReadableStream<Uint8Array>({ cancel });
  const get = vi.fn(async () => {
    entered();
    return fakeBody(f, body);
  });
  const reading = readCopyJobRange(readerEnv(get), claim, f.range);
  const rejected = expect(reading).rejects.toThrow("copy_claim_released");
  await started;
  await releaseCopyJobClaim(mutationEnv(), claim);
  await rejected;
  expect(cancel).toHaveBeenCalled();
  expect(
    await env.DB.prepare("SELECT reserved_bytes FROM users WHERE id=?")
      .bind(f.target.ids.user)
      .first("reserved_bytes"),
  ).toBe(3);
  expect(
    await env.DB.prepare("SELECT COUNT(*) AS n FROM blob_pins WHERE blob_id=?")
      .bind(f.source.ids.blob)
      .first("n"),
  ).toBe(1);
});
it.each(["size", "range", "key", "short", "long"])(
  "rejects a mismatched %s response",
  async (kind) => {
    const f = await fixture(),
      claim = await claimCopyJob(mutationEnv(), f.job.outboxId);
    const cancel = vi.fn();
    const body = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(
          new TextEncoder().encode(kind === "short" ? "ab" : kind === "long" ? "abcd" : "abc"),
        );
        c.close();
      },
      cancel,
    });
    const overrides =
      kind === "size"
        ? { size: 4 }
        : kind === "range"
          ? { range: { offset: 1, length: 2 } }
          : kind === "key"
            ? { key: "other" }
            : {};
    const get = vi.fn(async () => fakeBody(f, body, overrides));
    await expect(readCopyJobRange(readerEnv(get), claim, f.range)).rejects.toThrow();
  },
);
it("rejects concurrent reads and cancels a stalled body at the invocation deadline", async () => {
  const f = await fixture(),
    claim = await claimCopyJob(mutationEnv(), f.job.outboxId, Date.now() + 5000);
  const cancel = vi.fn(),
    body = new ReadableStream<Uint8Array>({ cancel });
  let entered!: () => void;
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const get = vi.fn(async () => {
    entered();
    return fakeBody(f, body);
  });
  const app = readerEnv(get),
    reading = readCopyJobRange(app, claim, f.range);
  const rejected = expect(reading).rejects.toThrow("copy_claim_expired");
  await started;
  await expect(readCopyJobRange(app, claim, f.range)).rejects.toThrow("copy_claim_busy");
  await rejected;
  expect(cancel).toHaveBeenCalled();
  expect(get).toHaveBeenCalledTimes(1);
});
it("cancels a late native response without returning its bytes", async () => {
  const f = await fixture(),
    claim = await claimCopyJob(mutationEnv(), f.job.outboxId, Date.now() + 5000);
  let resolve!: (object: R2ObjectBody) => void;
  const get = vi.fn(
    () =>
      new Promise<R2ObjectBody>((done) => {
        resolve = done;
      }),
  );
  await expect(readCopyJobRange(readerEnv(get), claim, f.range)).rejects.toThrow(
    "copy_claim_expired",
  );
  const cancel = vi.fn();
  resolve(fakeBody(f, new ReadableStream<Uint8Array>({ cancel })));
  await vi.waitFor(() => expect(cancel).toHaveBeenCalled());
});
