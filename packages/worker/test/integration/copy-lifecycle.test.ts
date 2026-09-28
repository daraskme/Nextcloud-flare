import { applyD1Migrations } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { assertExists, atomicBatch } from "../../src/db/primary";
import { inspectRecoveryFinalFence, RECOVERY_FINAL_QUERY } from "../../src/do/recoveryAudit";
import type { Env } from "../../src/env";
import { claimCopyJob, releaseCopyJobClaim } from "../../src/jobs/copyClaim";
import {
  cancelCopyJob,
  cleanupStoppedCopyJob,
  readCopyJob,
  stopExpiredCopyJob,
} from "../../src/jobs/copyLifecycle";
import { loadCopyJobManifest } from "../../src/jobs/copyManifest";
import { copyNextBlob } from "../../src/jobs/copyMultipart";
import { publishCopyJob } from "../../src/jobs/copyPublication";
import { copyNextSmallBlob } from "../../src/jobs/copyPut";
import { auditOwnerLedger } from "../../src/services/refs";
import { copyJobFixture } from "../fixtures/copyJob";
import { clearEndedR2TestWrites, mutationEnv } from "../fixtures/mutationAdmission";
import { admitted, injectBatch } from "../fixtures/uploadEnv";

beforeAll(() => applyD1Migrations(env.DB, env.TEST_MIGRATIONS));
beforeEach(async () => {
  await env.DB.prepare("UPDATE control SET maintenance=1").run();
  await env.DB.prepare("UPDATE control SET epoch=1,maintenance=0").run();
});
afterEach(clearEndedR2TestWrites);
const app = () => ({ ...admitted(), ...mutationEnv(), BLOBS: env.BLOBS });
const cancel = (f: Awaited<ReturnType<typeof copyJobFixture>>) =>
  cancelCopyJob(mutationEnv(), f.request.principal, f.job.id);
async function ready(body?: Uint8Array) {
  const f = await copyJobFixture(false, body),
    claim = await claimCopyJob(mutationEnv(), f.job.outboxId);
  for (let i = 0; i < 8; i++)
    if ((await copyNextBlob(app(), claim, 8 * 1024 * 1024)) === "ready") return { ...f, claim };
  throw new Error("fixture_not_ready");
}
async function value(table: string, column: string, key: string, id: string) {
  return env.DB.prepare(`SELECT ${column} AS v FROM ${table} WHERE ${key}=?`).bind(id).first("v");
}
it("stops without refunding, then settles an untouched copy and passes the composed recovery fence", async () => {
  const f = await copyJobFixture();
  expect(await cancel(f)).toMatchObject({
    state: "cancelled",
    cleanupPending: 1,
    heldBytes: 3,
    errorCode: "copy_cancelled",
  });
  expect(await value("outbox", "state", "outbox_id", f.job.outboxId)).toBe("failed");
  expect(await cleanupStoppedCopyJob(mutationEnv(), f.job.id)).toEqual({
    examined: 1,
    settled: 1,
    held: 0,
    remaining: 0,
    nextAfter: null,
  });
  expect(await cancel(f)).toMatchObject({ state: "cancelled", cleanupPending: 0, heldBytes: 0 });
  expect(await cleanupStoppedCopyJob(mutationEnv(), f.job.id)).toMatchObject({
    examined: 0,
    remaining: 0,
  });
  expect(await value("blob_pins", "pin_id", "pin_id", f.job.id + "_p00001")).toBeNull();
  expect(await auditOwnerLedger(env.DB, f.target.ids.user)).toMatchObject({
    used_bytes: 3,
    reserved_bytes: 0,
    physical_bytes: 0,
    incorrect_refs: 0,
  });
  expect(await auditOwnerLedger(env.DB, f.source.ids.user)).toMatchObject({ incorrect_refs: 0 });
  await env.DB.prepare("UPDATE control SET maintenance=1").run();
  await inspectRecoveryFinalFence(env.DB, 1);
  await atomicBatch(env.DB, [assertExists(RECOVERY_FINAL_QUERY, [1])]);
});
it.each([0, 3, 9 * 1024 * 1024])(
  "hands a proven %s-byte object to GC without removing physical accounting",
  async (size) => {
    const f = await ready(new Uint8Array(size));
    await cancel(f);
    expect(await cleanupStoppedCopyJob(mutationEnv(), f.job.id)).toMatchObject({
      settled: 1,
      remaining: 0,
    });
    expect(await value("blobs", "state", "id", f.job.id + "_b00001")).toBe("orphan");
    expect(await value("gc_candidates", "state", "blob_id", f.job.id + "_b00001")).toBe(
      "candidate",
    );
    expect(await value("copy_cleanup_receipts", "disposition", "job_id", f.job.id)).toBe("stored");
    expect(
      await value("copy_multipart_uploads", "state", "destination_blob_id", f.job.id + "_b00001"),
    ).toBeNull();
    expect(await auditOwnerLedger(env.DB, f.target.ids.user)).toMatchObject({
      used_bytes: 3,
      reserved_bytes: 0,
      physical_bytes: size,
      incorrect_refs: 0,
    });
    expect((await loadCopyJobManifest(env.DB, f.job.id)).plan.digest).toBe(f.claim.plan.digest);
    expect(await publishCopyJob(admitted(), f.claim)).toMatchObject({
      kind: "terminal",
      operation: { state: "failed" },
    });
  },
);
it("rejects further reads, claims, transfer and publication after cancellation", async () => {
  const f = await copyJobFixture(),
    claim = await claimCopyJob(mutationEnv(), f.job.outboxId);
  await cancel(f);
  await expect(claimCopyJob(mutationEnv(), f.job.outboxId)).rejects.toThrow("copy_job_unavailable");
  const put = vi.fn(env.BLOBS.put.bind(env.BLOBS));
  await expect(
    copyNextSmallBlob(
      {
        ...mutationEnv(),
        BLOBS: { get: env.BLOBS.get.bind(env.BLOBS), put } as unknown as R2Bucket,
      },
      claim,
    ),
  ).rejects.toThrow();
  expect(put).not.toHaveBeenCalled();
  expect(await value("job_leases", "claim_token", "job_id", f.job.id)).toBeNull();
  await releaseCopyJobClaim(mutationEnv(), claim);
  await releaseCopyJobClaim(mutationEnv(), claim);
});
it("refuses cancellation and cleanup of a published job", async () => {
  const f = await ready();
  await publishCopyJob(admitted(), f.claim);
  await expect(cancel(f)).rejects.toThrow("copy_already_completed");
  await expect(cleanupStoppedCopyJob(mutationEnv(), f.job.id)).rejects.toThrow("copy_not_stopped");
});
it.each(["credential", "actor", "share"])(
  "requires the original current authority for read/cancel (%s)",
  async (mode) => {
    const f = await copyJobFixture();
    let principal = f.request.principal;
    if (mode === "credential") principal = { ...principal, credential_id: f.source.ids.credential };
    if (mode === "actor") principal = { ...principal, user_id: f.source.ids.user };
    if (mode === "share") await f.revoke();
    await expect(cancelCopyJob(mutationEnv(), principal, f.job.id)).rejects.toThrow();
    await expect(readCopyJob(env.DB, principal, f.job.id)).rejects.toThrow();
    expect(await value("bulk_jobs", "state", "id", f.job.id)).toBe("pending");
  },
);
it("rechecks authority in the cancellation batch", async () => {
  const f = await copyJobFixture(),
    db = injectBatch(
      (s) => s.startsWith("UPDATE bulk_jobs SET state="),
      async () => {
        await f.revoke();
      },
      false,
    );
  await expect(cancelCopyJob(mutationEnv(db), f.request.principal, f.job.id)).rejects.toThrow();
  expect(await value("bulk_jobs", "state", "id", f.job.id)).toBe("pending");
});
it("reauthorizes terminal reads, while system cleanup survives revocation and account disable", async () => {
  const f = await ready();
  await cancel(f);
  await f.revoke();
  await env.DB.prepare("UPDATE users SET disabled_at=1 WHERE id=?").bind(f.target.ids.user).run();
  await expect(readCopyJob(env.DB, f.request.principal, f.job.id)).rejects.toThrow();
  expect(await cleanupStoppedCopyJob(mutationEnv(), f.job.id)).toMatchObject({ settled: 1 });
});
it.each(["stop", "cleanup"])("recovers a committed %s batch after lost ACK", async (phase) => {
  const f = await copyJobFixture();
  const db = injectBatch(
    (s) =>
      s.startsWith(
        phase === "stop" ? "UPDATE bulk_jobs SET state=" : "INSERT INTO copy_cleanup_receipts",
      ),
    async () => {
      throw new Error("ack_lost");
    },
    true,
  );
  if (phase === "stop")
    expect(await cancelCopyJob(mutationEnv(db), f.request.principal, f.job.id)).toMatchObject({
      state: "cancelled",
    });
  else {
    await cancel(f);
    expect(await cleanupStoppedCopyJob(mutationEnv(db), f.job.id)).toMatchObject({ settled: 1 });
  }
});
it.each([
  "INSERT INTO copy_cleanup_receipts",
  "UPDATE reservations",
  "UPDATE blobs",
  "INSERT INTO gc_candidates",
  "DELETE FROM copy_multipart_parts",
  "DELETE FROM copy_multipart_uploads",
  "DELETE FROM copy_job_blobs",
  "DELETE FROM blob_pins",
])("rolls back every cleanup effect when %s fails", async (prefix) => {
  const f = await ready();
  await cancel(f);
  const db = new Proxy(env.DB, {
    get(target, key) {
      if (key === "batch") return (statements: D1PreparedStatement[]) => target.batch(statements);
      if (key === "prepare")
        return (sql: string) =>
          target.prepare(
            sql.startsWith(prefix)
              ? "INSERT INTO _assert(v) SELECT 1 WHERE ? IS NOT NULL" +
                  " OR ? IS NOT NULL".repeat((sql.match(/\?/g)?.length ?? 1) - 1)
              : sql,
          );
      const v = Reflect.get(target, key);
      return typeof v === "function" ? v.bind(target) : v;
    },
  });
  await expect(cleanupStoppedCopyJob(mutationEnv(db), f.job.id)).rejects.toThrow();
  expect(await value("copy_cleanup_receipts", "disposition", "job_id", f.job.id)).toBeNull();
  expect(await value("blobs", "state", "id", f.job.id + "_b00001")).toBe("staging");
  expect(await auditOwnerLedger(env.DB, f.target.ids.user)).toMatchObject({
    reserved_bytes: 3,
    physical_bytes: 3,
    incorrect_refs: 0,
  });
  expect(await cleanupStoppedCopyJob(mutationEnv(), f.job.id)).toMatchObject({ settled: 1 });
});
it("holds a prepared attempt with missing history after a lost preparation ACK", async () => {
  const f = await copyJobFixture(),
    claim = await claimCopyJob(mutationEnv(), f.job.outboxId);
  const db = injectBatch(
    (s) => s.startsWith("UPDATE copy_job_blobs SET transfer_state='claimed'"),
    async () => {
      throw new Error("ack_lost");
    },
    true,
  );
  await expect(
    copyNextSmallBlob({ ...mutationEnv(db), BLOBS: env.BLOBS }, claim),
  ).rejects.toThrow();
  await cancel(f);
  expect(await cleanupStoppedCopyJob(mutationEnv(), f.job.id)).toMatchObject({
    settled: 0,
    held: 1,
    remaining: 1,
  });
});
it("holds an open multipart handle after cancellation, without inferring closure from an abort or HEAD", async () => {
  const f = await copyJobFixture(false, new Uint8Array(9 * 1024 * 1024)),
    claim = await claimCopyJob(mutationEnv(), f.job.outboxId);
  expect(await copyNextBlob(app(), claim)).toBe("initialized");
  await cancel(f);
  expect(await cleanupStoppedCopyJob(mutationEnv(), f.job.id)).toMatchObject({
    held: 1,
    remaining: 1,
  });
  expect(
    await value("copy_multipart_uploads", "state", "destination_blob_id", f.job.id + "_b00001"),
  ).toBe("uploading");
});
it("retains unknown native writes even when the object is absent", async () => {
  const f = await copyJobFixture(),
    claim = await claimCopyJob(mutationEnv(), f.job.outboxId);
  const put = vi.fn(async () => {
    throw new Error("native_unknown");
  });
  await expect(
    copyNextSmallBlob(
      {
        ...mutationEnv(),
        BLOBS: { get: env.BLOBS.get.bind(env.BLOBS), put } as unknown as R2Bucket,
      },
      claim,
    ),
  ).rejects.toThrow();
  await cancel(f);
  expect(await env.BLOBS.head(`u/${f.target.ids.user}/b/${f.job.id}_b00001`)).toBeNull();
  expect(await cleanupStoppedCopyJob(mutationEnv(), f.job.id)).toMatchObject({
    held: 1,
    settled: 0,
  });
  expect(await auditOwnerLedger(env.DB, f.target.ids.user)).toMatchObject({ reserved_bytes: 3 });
});
it("records a real late PUT after cancellation and settles only after native finish", async () => {
  const f = await copyJobFixture(),
    claim = await claimCopyJob(mutationEnv(), f.job.outboxId);
  let started!: () => void, finish!: () => void;
  const entered = new Promise<void>((resolve) => {
      started = resolve;
    }),
    wait = new Promise<void>((resolve) => {
      finish = resolve;
    });
  const put = async (...args: Parameters<R2Bucket["put"]>) => {
    started();
    await wait;
    return env.BLOBS.put(...args);
  };
  const transfer = copyNextSmallBlob(
    { ...mutationEnv(), BLOBS: { get: env.BLOBS.get.bind(env.BLOBS), put } as unknown as R2Bucket },
    claim,
  ).catch((e) => e);
  await entered;
  await cancel(f);
  expect(await cleanupStoppedCopyJob(mutationEnv(), f.job.id)).toMatchObject({ held: 1 });
  finish();
  await transfer;
  expect(await value("copy_job_blobs", "transfer_state", "job_id", f.job.id)).toBe("stored");
  expect(await cleanupStoppedCopyJob(mutationEnv(), f.job.id)).toMatchObject({
    settled: 1,
    remaining: 0,
  });
});
it("blocks delayed native admission after stop, before any R2 dispatch", async () => {
  const f = await copyJobFixture(),
    claim = await claimCopyJob(mutationEnv(), f.job.outboxId);
  const db = injectBatch(
    (s) => s.startsWith("INSERT INTO r2_write_attempts"),
    async () => {
      await cancel(f);
    },
    false,
  );
  const put = vi.fn(env.BLOBS.put.bind(env.BLOBS));
  await expect(
    copyNextSmallBlob(
      {
        ...mutationEnv(db, db),
        BLOBS: { get: env.BLOBS.get.bind(env.BLOBS), put } as unknown as R2Bucket,
      },
      claim,
    ),
  ).rejects.toThrow();
  expect(put).not.toHaveBeenCalled();
});
it("settles a prepared transfer only from an explicit not-started native receipt", async () => {
  const f = await copyJobFixture(),
    claim = await claimCopyJob(mutationEnv(), f.job.outboxId),
    a = mutationEnv();
  const control = a.CONTROL.get(a.CONTROL.idFromName("singleton"));
  const b = {
    ...a,
    BLOBS: env.BLOBS,
    CONTROL: {
      idFromName: a.CONTROL.idFromName.bind(a.CONTROL),
      get: () => ({
        ...control,
        beginR2Write: async (...args: Parameters<typeof control.beginR2Write>) => {
          const grant = await control.beginR2Write(...args);
          await control.finishR2Write(grant, "not_started");
          throw new Error("not_dispatched");
        },
      }),
    } as unknown as Env["CONTROL"],
  };
  await expect(copyNextSmallBlob(b, claim)).rejects.toThrow();
  await cancel(f);
  expect(await cleanupStoppedCopyJob(mutationEnv(), f.job.id)).toMatchObject({ settled: 1 });
  expect(await value("blobs", "state", "id", f.job.id + "_b00001")).toBe("deleted");
});
it("fails a stale-epoch job in maintenance and can release proven untouched holds", async () => {
  const f = await copyJobFixture();
  await env.DB.prepare("UPDATE control SET maintenance=1").run();
  await env.DB.prepare("UPDATE control SET epoch=2").run();
  expect(await stopExpiredCopyJob(mutationEnv(), f.job.id)).toBe(true);
  expect(await value("bulk_jobs", "error_code", "id", f.job.id)).toBe("stale_epoch");
  expect(await cleanupStoppedCopyJob(mutationEnv(), f.job.id)).toMatchObject({ settled: 1 });
});
it("does not stop a healthy job or the last still-active invocation", async () => {
  const f = await copyJobFixture(),
    claim = await claimCopyJob(mutationEnv(), f.job.outboxId);
  expect(await stopExpiredCopyJob(mutationEnv(), f.job.id)).toBe(false);
  await env.DB.prepare("UPDATE bulk_jobs SET invocation_count=200 WHERE id=?").bind(f.job.id).run();
  expect(await stopExpiredCopyJob(mutationEnv(), f.job.id)).toBe(false);
  await releaseCopyJobClaim(mutationEnv(), claim);
  expect(await stopExpiredCopyJob(mutationEnv(), f.job.id)).toBe(true);
  expect(await value("bulk_jobs", "error_code", "id", f.job.id)).toBe("copy_budget_exhausted");
});
it.each([
  "UPDATE bulk_jobs SET state='cancelled' WHERE id=?",
  "UPDATE bulk_jobs SET state='failed',error_code='invented' WHERE id=?",
])("rejects unproven terminal changes in SQL: %s", async (sql) => {
  const f = await copyJobFixture();
  await expect(env.DB.prepare(sql).bind(f.job.id).run()).rejects.toThrow("copy_stop_unproven");
});
it("makes the stop and cleanup receipts immutable", async () => {
  const f = await copyJobFixture();
  await cancel(f);
  await cleanupStoppedCopyJob(mutationEnv(), f.job.id);
  for (const sql of [
    "UPDATE bulk_jobs SET state='pending' WHERE id=?",
    "UPDATE bulk_jobs SET stopped_at=NULL,stop_epoch=NULL WHERE id=?",
  ])
    await expect(env.DB.prepare(sql).bind(f.job.id).run()).rejects.toThrow();
  for (const sql of [
    "UPDATE copy_cleanup_receipts SET bytes=0 WHERE job_id=?",
    "DELETE FROM copy_cleanup_receipts WHERE job_id=?",
  ])
    await expect(env.DB.prepare(sql).bind(f.job.id).run()).rejects.toThrow();
});
it("keeps old native receipts for held copies without blocking other native settlement", async () => {
  const f = await ready();
  const id = crypto.randomUUID(),
    time = Date.now() - 2 * 86400000;
  await env.DB.prepare(`INSERT INTO r2_write_attempts(id,token,epoch,owner_id,kind,r2_key,dispatch_before,started_at,state,finished_at)
    VALUES(?,?,1,?,'manifest.delete',?, ?,?,'succeeded',?)`)
    .bind(
      id,
      crypto.randomUUID(),
      f.target.ids.user,
      `u/${f.target.ids.user}/b/${f.job.id}_b00001`,
      time + 5000,
      time,
      time,
    )
    .run();
  await expect(
    env.DB.prepare("DELETE FROM r2_write_attempts WHERE id=?").bind(id).run(),
  ).rejects.toThrow("copy_native_receipt_held");
  const other = await copyJobFixture(),
    claim = await claimCopyJob(mutationEnv(), other.job.outboxId);
  expect(await copyNextSmallBlob(app(), claim)).toBe("stored");
  expect(await value("r2_write_attempts", "state", "id", id)).toBe("succeeded");
});
it("pages cleanup without losing the manifest or reusing released holds", async () => {
  const f = await copyJobFixture();
  const blobIds = Array.from({ length: 39 }, () => crypto.randomUUID()).sort();
  for (const [i, id] of blobIds.entries())
    await atomicBatch(env.DB, [
      {
        sql: "INSERT INTO blobs(id,owner_id,r2_key,size,content_etag,state,created_at) VALUES(?,?,?,3,?,'committed',1)",
        values: [id, f.source.ids.user, `u/${f.source.ids.user}/b/${id}`, `etag-${id}`],
      },
      {
        sql: "INSERT INTO blob_storage(blob_id,bytes,r2_etag,observed_at) VALUES(?,3,'physical',1)",
        values: [id],
      },
      {
        sql: "INSERT INTO nodes(id,space_id,owner_id,parent_id,name,name_ci,kind,current_blob_id,created_at,updated_at) VALUES(?,?,?,?,?,?,'file',?,1,1)",
        values: [
          id + "-file",
          f.source.ids.space,
          f.source.ids.user,
          f.source.ids.folder,
          "file" + i,
          "file" + i,
          id,
        ],
      },
    ]);
  const job = await f.enqueue(),
    g = { ...f, job };
  await cancel(g);
  const first = await cleanupStoppedCopyJob(mutationEnv(), job.id);
  expect(first).toMatchObject({ examined: 32, settled: 32, remaining: 8 });
  expect(first.nextAfter).toBeTruthy();
  expect((await loadCopyJobManifest(env.DB, job.id)).plan.source.blobs).toHaveLength(40);
  const second = await cleanupStoppedCopyJob(mutationEnv(), job.id, { after: first.nextAfter! });
  expect(second).toEqual({ examined: 8, settled: 8, held: 0, remaining: 0, nextAfter: null });
  expect(await readCopyJob(env.DB, f.request.principal, job.id)).toMatchObject({
    cleanupPending: 0,
    heldBytes: 0,
  });
});
it("rejects invented cleanup proofs while native results are unknown", async () => {
  const f = await copyJobFixture(),
    claim = await claimCopyJob(mutationEnv(), f.job.outboxId);
  const put = async () => {
    throw new Error("unknown");
  };
  await expect(
    copyNextSmallBlob(
      {
        ...mutationEnv(),
        BLOBS: { get: env.BLOBS.get.bind(env.BLOBS), put } as unknown as R2Bucket,
      },
      claim,
    ),
  ).rejects.toThrow();
  await cancel(f);
  for (const disposition of ["unwritten", "stored"])
    await expect(
      env.DB.prepare(`INSERT INTO copy_cleanup_receipts
    SELECT cb.job_id,cb.source_blob_id,cb.destination_blob_id,cb.pin_id,cb.reservation_id,3,?,1,strftime('%s','now')*1000
    FROM copy_job_blobs cb WHERE cb.job_id=?`)
        .bind(disposition, f.job.id)
        .run(),
    ).rejects.toThrow();
  await expect(
    env.DB.prepare("DELETE FROM copy_job_blobs WHERE job_id=?").bind(f.job.id).run(),
  ).rejects.toThrow("copy_hold_unsettled");
  await expect(
    env.DB.prepare("UPDATE reservations SET state='released' WHERE id=?")
      .bind(f.job.id + "_r00001")
      .run(),
  ).rejects.toThrow("copy_reservation_held");
});
