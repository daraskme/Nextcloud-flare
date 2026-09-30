import { evictDurableObject, runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { expect, it } from "vitest";
import { UploadDO } from "../../src/do/UploadDO";
import { type MultipartIdentity, MultipartLedger } from "../../src/do/uploadLedger";
import { UPLOAD_LIMITS } from "../../src/do/uploadPlan";

const PART = 8 * 1024 * 1024;
const SHA = "a".repeat(64);
const completed = (bytes = PART, etag = "part-etag") => ({
  kind: "completed" as const,
  bytes,
  etag,
  sha256: SHA,
});
function fixture(bytes = PART * 5) {
  const now = Date.now();
  const identity: MultipartIdentity = {
    uploadId: crypto.randomUUID(),
    epoch: 1,
    declaredBytes: bytes,
    partBytes: PART,
    r2UploadId: crypto.randomUUID(),
    createdAt: now,
    expiresAt: now + UPLOAD_LIMITS.lifetimeMs,
  };
  const stub = env.UPLOADS.get(env.UPLOADS.idFromName(identity.uploadId));
  return { now, identity, stub };
}

it("restores attempts after eviction and never reissues dispatch on a lost claim response", async () => {
  const f = fixture();
  await runInDurableObject(f.stub, (_, state) => {
    const journal = new MultipartLedger(state.storage);
    journal.initialize(f.identity, f.now);
    expect(journal.claim(1, 1, "attempt", PART, f.now).disposition).toBe("dispatch");
  });
  await evictDurableObject(f.stub);
  await runInDurableObject(f.stub, (_, state) => {
    const journal = new MultipartLedger(state.storage);
    journal.initialize(f.identity, f.now + 1);
    expect(journal.claim(1, 1, "attempt", PART, f.now + 1).disposition).toBe("in_flight");
    expect(() => journal.claim(1, 1, "new-attempt", PART, f.now + 1)).toThrow(/part_busy/);
    expect(journal.status(f.now + 1)).toMatchObject({ dataCalls: 1, dataBytes: PART, inFlight: 1 });
    journal.settle(1, "attempt", completed(), f.now + 2);
    expect(journal.claim(1, 1, "attempt", PART, f.now + 3).disposition).toBe("completed");
    expect(journal.settle(1, "attempt", completed(), f.now + 4)).toBe(true);
    expect(() => journal.settle(1, "attempt", completed(PART, "changed"), f.now + 4)).toThrow(
      /result_conflict/,
    );
    expect(journal.status(f.now + 4)).toMatchObject({
      dataCalls: 1,
      completedParts: 1,
      inFlight: 0,
    });
  });
});

it("bounds parallelism and releases a slot only for a confirmed outcome", async () => {
  const f = fixture();
  await runInDurableObject(f.stub, (_, state) => {
    const journal = new MultipartLedger(state.storage);
    journal.initialize(f.identity, f.now);
    for (let i = 1; i <= 4; i++) journal.claim(1, i, `p${i}`, PART, f.now);
    expect(() => journal.claim(1, 5, "p5", PART, f.now)).toThrow(/parallel_limit/);
    journal.settle(1, "p1", completed(), f.now + 1);
    expect(journal.claim(1, 5, "p5", PART, f.now + 1).disposition).toBe("dispatch");
    expect(journal.status(f.now + 1)).toMatchObject({ inFlight: 4, dataCalls: 5 });
  });
});

it("caps retries at three, retains spent bytes, and admits cleanup independently", async () => {
  const f = fixture(1);
  await runInDurableObject(f.stub, (_, state) => {
    const journal = new MultipartLedger(state.storage);
    journal.initialize(f.identity, f.now);
    for (let i = 1; i <= 3; i++) {
      journal.claim(1, 1, `attempt${i}`, 1, f.now);
      journal.settle(1, `attempt${i}`, { kind: "not_started" }, f.now);
    }
    expect(journal.claim(1, 1, "attempt3", 1, f.now).disposition).toBe("not_started");
    expect(() => journal.claim(1, 1, "attempt4", 1, f.now)).toThrow(/data_budget/);
    expect(journal.status(f.now)).toMatchObject({ dataCalls: 3, dataBytes: 3 });
    journal.requestAbort(1, f.now);
    journal.recordCleanupCall();
    journal.recordCleanupCall();
    expect(journal.status(f.now)).toMatchObject({
      cleanupCalls: 2,
      controlCalls: 1,
      cleanupPending: true,
    });
  });
});

it("fences all late responses after one part becomes unknown", async () => {
  const f = fixture();
  await runInDurableObject(f.stub, (_, state) => {
    const journal = new MultipartLedger(state.storage);
    journal.initialize(f.identity, f.now);
    journal.claim(1, 1, "lost", PART, f.now);
    journal.claim(1, 2, "late", PART, f.now);
    expect(journal.settle(1, "lost", { kind: "unknown" }, f.now + 1)).toBe(false);
    expect(journal.settle(1, "late", completed(), f.now + 2)).toBe(false);
    expect(journal.status(f.now + 2)).toMatchObject({
      state: "aborting",
      inFlight: 0,
      completedParts: 0,
      errorCode: "part_outcome_unknown",
      cleanupPending: true,
    });
    expect(() => journal.claim(1, 1, "retry", PART, f.now + 3)).toThrow(/not_accepting/);
    expect(journal.completedParts(0)).toEqual([]);
  });
});

it("persists timeout fencing even when the subsequent request throws", async () => {
  const f = fixture();
  await runInDurableObject(f.stub, (_, state) => {
    const journal = new MultipartLedger(state.storage);
    journal.initialize(f.identity, f.now);
    journal.claim(1, 1, "slow", PART, f.now);
    const later = f.now + UPLOAD_LIMITS.leaseMs;
    expect(() => journal.claim(1, 2, "next", PART, later)).toThrow(/not_accepting/);
    expect(journal.settle(1, "slow", completed(), later)).toBe(false);
    expect(journal.status(later)).toMatchObject({ state: "aborting", cleanupPending: true });
  });
  await evictDurableObject(f.stub);
  await runInDurableObject(f.stub, (_, state) => {
    const journal = new MultipartLedger(state.storage);
    journal.initialize(f.identity, f.now + UPLOAD_LIMITS.leaseMs);
    expect(journal.status(f.now + UPLOAD_LIMITS.leaseMs)?.state).toBe("aborting");
  });
});

it("requires every part and exact tail size before completion, then excludes abort and writes", async () => {
  const f = fixture(PART + 7);
  await runInDurableObject(f.stub, (_, state) => {
    const journal = new MultipartLedger(state.storage);
    journal.initialize(f.identity, f.now);
    expect(() => journal.beginComplete(1, f.now)).toThrow(/parts_incomplete/);
    expect(() => journal.claim(1, 2, "tail", 8, f.now)).toThrow(/size_mismatch/);
    journal.claim(1, 1, "first", PART, f.now);
    journal.claim(1, 2, "tail", 7, f.now);
    journal.settle(1, "tail", completed(7), f.now);
    expect(() => journal.beginComplete(1, f.now)).toThrow(/parts_incomplete/);
    journal.settle(1, "first", completed(), f.now);
    journal.beginComplete(1, f.now);
    journal.beginComplete(1, f.now + 1);
    expect(journal.status(f.now + 1)).toMatchObject({
      state: "completing",
      inFlight: 0,
      controlCalls: 1,
    });
    expect(() => journal.requestAbort(1, f.now + 1)).toThrow(/complete_in_progress/);
    expect(() => journal.claim(1, 1, "another", PART, f.now + 1)).toThrow(/not_accepting/);
    // R2 complete response loss must be reconciled, not expired into an abort.
    expect(journal.status(f.identity.expiresAt + 1)?.state).toBe("completing");
    expect(journal.nextAlarmAt()).toBeNull();
  });
});

it("preserves abort intent and cannot begin completion afterward", async () => {
  const f = fixture(1);
  await runInDurableObject(f.stub, (_, state) => {
    const journal = new MultipartLedger(state.storage);
    journal.initialize(f.identity, f.now);
    journal.claim(1, 1, "part", 1, f.now);
    journal.settle(1, "part", completed(1), f.now);
    journal.requestAbort(1, f.now);
    journal.requestAbort(1, f.now);
    expect(() => journal.beginComplete(1, f.now)).toThrow(/not_completable/);
    expect(journal.status(f.now)?.controlCalls).toBe(1);
  });
});

it("rejects forged epochs and identities without mutating the current upload", async () => {
  const f = fixture();
  await runInDurableObject(f.stub, (_, state) => {
    const journal = new MultipartLedger(state.storage);
    journal.initialize(f.identity, f.now);
    expect(() => journal.claim(2, 1, "attempt", PART, f.now)).toThrow(/epoch_conflict/);
    for (const changed of [
      { epoch: 2 },
      { uploadId: "other" },
      { r2UploadId: "other" },
      { declaredBytes: 1 },
      { partBytes: PART * 2 },
      { createdAt: f.now - 1, expiresAt: f.identity.expiresAt - 1 },
      { expiresAt: f.identity.expiresAt - 1 },
    ]) {
      expect(() => journal.initialize({ ...f.identity, ...changed }, f.now)).toThrow(
        /identity_conflict/,
      );
    }
    expect(journal.status(f.now)).toMatchObject({ state: "created", dataCalls: 0 });
  });
});

it("invalidates old-epoch attempts permanently, including after eviction", async () => {
  const f = fixture();
  await runInDurableObject(f.stub, (_, state) => {
    const journal = new MultipartLedger(state.storage);
    journal.initialize(f.identity, f.now);
    journal.claim(1, 1, "old", PART, f.now);
    journal.invalidateEpoch(2);
    expect(journal.settle(1, "old", completed(), f.now)).toBe(false);
    expect(journal.status(f.now)).toMatchObject({
      state: "failed",
      errorCode: "stale_epoch",
      cleanupPending: true,
    });
  });
  await evictDurableObject(f.stub);
  await runInDurableObject(f.stub, (_, state) => {
    const journal = new MultipartLedger(state.storage);
    expect(() => journal.initialize({ ...f.identity, epoch: 2 }, f.now)).toThrow(
      /identity_conflict/,
    );
    expect(() => journal.claim(1, 1, "retry", PART, f.now)).toThrow(/not_accepting/);
  });
});

it("expires idle uploads without extending life on polling or rejected attempts", async () => {
  const f = fixture();
  await runInDurableObject(f.stub, (_, state) => {
    const journal = new MultipartLedger(state.storage);
    journal.initialize(f.identity, f.now);
    journal.claim(1, 1, "not-started", PART, f.now + 1);
    journal.settle(1, "not-started", { kind: "not_started" }, f.now + 2);
    journal.status(f.now + UPLOAD_LIMITS.idleMs - 1);
    expect(journal.status(f.now + UPLOAD_LIMITS.idleMs)).toMatchObject({
      state: "expired",
      cleanupPending: true,
      errorCode: "upload_expired",
    });
  });
});

it("caps part leases at the fixed upload deadline", async () => {
  const f = fixture();
  const identity = { ...f.identity, expiresAt: f.now + 100 };
  await runInDurableObject(f.stub, (_, state) => {
    const journal = new MultipartLedger(state.storage);
    journal.initialize(identity, f.now);
    expect(journal.claim(1, 1, "part", PART, f.now).expiresAt).toBe(identity.expiresAt);
    expect(journal.nextAlarmAt()).toBe(identity.expiresAt);
    expect(journal.status(identity.expiresAt)?.state).toBe("aborting");
  });
});

it("atomically rolls back the attempt insert if charging the counter fails", async () => {
  const f = fixture();
  await runInDurableObject(f.stub, (_, state) => {
    const journal = new MultipartLedger(state.storage);
    journal.initialize(f.identity, f.now);
    state.storage.sql.exec(`CREATE TRIGGER fail_charge BEFORE UPDATE OF data_calls ON multipart_state
      BEGIN SELECT RAISE(ABORT,'injected'); END;`);
    expect(() => journal.claim(1, 1, "rollback", PART, f.now)).toThrow(/injected/);
    expect(journal.status(f.now)).toMatchObject({
      dataCalls: 0,
      dataBytes: 0,
      inFlight: 0,
      state: "created",
    });
    state.storage.sql.exec("DROP TRIGGER fail_charge");
    expect(journal.claim(1, 1, "rollback", PART, f.now).disposition).toBe("dispatch");
  });
});

it("bounds part pages with stable numeric ordering and no eager 10,000-part JSON", async () => {
  const f = fixture(PART * 10_000);
  await runInDurableObject(f.stub, (_, state) => {
    const journal = new MultipartLedger(state.storage);
    journal.initialize(f.identity, f.now);
    expect(state.storage.sql.exec("SELECT COUNT(*) AS n FROM multipart_attempts").one().n).toBe(0);
    for (let i = 201; i >= 1; i--) {
      journal.claim(1, i, `p${i}`, PART, f.now);
      journal.settle(1, `p${i}`, completed(PART, `etag-${i}`), f.now);
    }
    const first = journal.completedParts(0);
    expect(first).toHaveLength(200);
    expect(first[0]?.partNumber).toBe(1);
    expect(first[199]?.partNumber).toBe(200);
    expect(journal.completedParts(200)).toEqual([
      { partNumber: 201, bytes: PART, etag: "etag-201", sha256: SHA },
    ]);
    expect(() => journal.completedParts(0, 201)).toThrow(/invalid_part_page/);
    expect(() => journal.completedParts(-1)).toThrow(/invalid_part_page/);
  });
});

it("rejects attempt reuse across parts and inconsistent success metadata", async () => {
  const f = fixture();
  await runInDurableObject(f.stub, (_, state) => {
    const journal = new MultipartLedger(state.storage);
    journal.initialize(f.identity, f.now);
    journal.claim(1, 1, "attempt", PART, f.now);
    expect(() => journal.claim(1, 2, "attempt", PART, f.now)).toThrow(/attempt_conflict/);
    for (const result of [
      completed(PART - 1),
      { ...completed(), sha256: "no" },
      completed(PART, ""),
    ])
      expect(() => journal.settle(1, "attempt", result, f.now)).toThrow(/invalid_part_result/);
    expect(journal.status(f.now)?.inFlight).toBe(1);
    expect(() => journal.settle(1, "missing", completed(), f.now)).toThrow(/unknown_attempt/);
  });
});

it("uses the UploadDO alarm to fence expired attempts while keeping external admission closed", async () => {
  const f = fixture();
  await runInDurableObject(f.stub, async (_, state) => {
    const past = f.now - UPLOAD_LIMITS.leaseMs - 1000;
    const journal = new MultipartLedger(state.storage);
    journal.initialize(
      { ...f.identity, createdAt: past, expiresAt: past + UPLOAD_LIMITS.lifetimeMs },
      past,
    );
    journal.claim(1, 1, "slow", PART, past);
    await new UploadDO(state, env).alarm();
    expect(journal.status(f.now)).toMatchObject({ state: "aborting", cleanupPending: true });
    expect(await state.storage.getAlarm()).toBeNull();
  });
  expect((await f.stub.fetch("https://do.invalid/")).status).toBe(503);
});

it("extends the idle deadline only on success and never beyond the fixed lifetime", async () => {
  const f = fixture();
  await runInDurableObject(f.stub, (_, state) => {
    const journal = new MultipartLedger(state.storage);
    journal.initialize(f.identity, f.now);
    const progressAt = f.now + UPLOAD_LIMITS.idleMs - 100;
    journal.claim(1, 1, "progress", PART, progressAt);
    journal.settle(1, "progress", completed(), progressAt + 1);
    expect(journal.status(f.now + UPLOAD_LIMITS.idleMs)?.state).toBe("uploading");
    expect(journal.nextAlarmAt()).toBe(progressAt + 1 + UPLOAD_LIMITS.idleMs);
    expect(journal.status(f.identity.expiresAt)?.state).toBe("expired");
  });
});

it("rejects invalid and already expired initialization without leaving durable state", async () => {
  const f = fixture();
  await runInDurableObject(f.stub, (_, state) => {
    const journal = new MultipartLedger(state.storage);
    for (const changed of [
      { epoch: 0 },
      { r2UploadId: "" },
      { uploadId: "../invalid" },
      { createdAt: f.now + 1 },
      { expiresAt: f.identity.expiresAt + 1 },
    ])
      expect(() => journal.initialize({ ...f.identity, ...changed }, f.now)).toThrow(
        /invalid_upload_identity/,
      );
    expect(() => journal.initialize(f.identity, f.identity.expiresAt)).toThrow(/upload_expired/);
    expect(journal.status(f.now)).toBeNull();
  });
});

it("reschedules an early alarm at the next lease deadline", async () => {
  const f = fixture();
  await runInDurableObject(f.stub, async (_, state) => {
    const journal = new MultipartLedger(state.storage);
    journal.initialize(f.identity, f.now);
    const lease = journal.claim(1, 1, "active", PART, f.now);
    await new UploadDO(state, env).alarm();
    expect(await state.storage.getAlarm()).toBe(lease.expiresAt);
    expect(journal.status(f.now)?.inFlight).toBe(1);
    await state.storage.deleteAlarm();
  });
});
