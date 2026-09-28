import { applyD1Migrations } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { inspectRecoveryFinalFence } from "../../src/do/recoveryAudit";
import type { Env } from "../../src/env";
import { claimCopyJob } from "../../src/jobs/copyClaim";
import {
  cancelCopyJob,
  cleanupStoppedCopyJob,
  stopExpiredCopyJob,
} from "../../src/jobs/copyLifecycle";
import { loadCopyJobManifest } from "../../src/jobs/copyManifest";
import { copyNextBlob } from "../../src/jobs/copyMultipart";
import { abortStoppedCopyMultipart } from "../../src/jobs/copyMultipartAbort";
import { auditOwnerLedger } from "../../src/services/refs";
import { copyJobFixture } from "../fixtures/copyJob";
import { clearEndedR2TestWrites, mutationEnv } from "../fixtures/mutationAdmission";
import { injectBatch } from "../fixtures/uploadEnv";

const MiB = 1024 * 1024,
  body = new Uint8Array(9 * MiB);
beforeAll(() => applyD1Migrations(env.DB, env.TEST_MIGRATIONS));
beforeEach(async () => {
  await env.DB.prepare("UPDATE control SET maintenance=1").run();
  await env.DB.prepare("UPDATE control SET epoch=1,maintenance=0,gc_paused=1").run();
});
afterEach(clearEndedR2TestWrites);
const step = (a: Env, claim: Awaited<ReturnType<typeof claimCopyJob>>) =>
  copyNextBlob(a, claim, 8 * MiB);
async function fixture(parts = 0) {
  const f = await copyJobFixture(false, body),
    claim = await claimCopyJob(mutationEnv(), f.job.outboxId);
  const id = f.job.id + "_b00001",
    key = `u/${f.target.ids.user}/b/${id}`;
  expect(await step(mutationEnv(), claim)).toBe("initialized");
  for (let i = 0; i < parts; i++) expect(await step(mutationEnv(), claim)).toBe("part");
  const upload = await env.DB.prepare(
    "SELECT r2_upload_id FROM copy_multipart_uploads WHERE destination_blob_id=?",
  )
    .bind(id)
    .first<string>("r2_upload_id");
  const abort = vi.fn(() => env.BLOBS.resumeMultipartUpload(key, upload!).abort());
  const app = (db = env.DB) => ({
    ...mutationEnv(db, db),
    BLOBS: {
      resumeMultipartUpload: (k: string, u: string) => {
        expect([k, u]).toEqual([key, upload]);
        return { abort };
      },
    } as unknown as R2Bucket,
  });
  const stop = () => cancelCopyJob(mutationEnv(), f.request.principal, f.job.id);
  const run = (a = app()) => abortStoppedCopyMultipart(a, f.job.id, f.source.ids.blob);
  return { ...f, claim, id, key, upload: upload!, abort, app, stop, run };
}
const cleanup = (f: Awaited<ReturnType<typeof fixture>>) =>
  cleanupStoppedCopyJob(mutationEnv(), f.job.id);
const held = async (f: Awaited<ReturnType<typeof fixture>>) => {
  expect(await cleanup(f)).toMatchObject({ held: 1, settled: 0, remaining: 1 });
  expect(await auditOwnerLedger(env.DB, f.target.ids.user)).toMatchObject({
    reserved_bytes: body.length,
    physical_bytes: 0,
    incorrect_refs: 0,
  });
};

it.each([0, 1, 2])(
  "aborts once after %s parts and atomically settles its immutable receipt",
  async (parts) => {
    const f = await fixture(parts);
    await f.stop();
    await held(f);
    expect(await f.run()).toBe("confirmed");
    expect(await f.run()).toBe("confirmed");
    expect(f.abort).toHaveBeenCalledTimes(1);
    expect(await auditOwnerLedger(env.DB, f.target.ids.user)).toMatchObject({
      reserved_bytes: body.length,
    });
    expect(await cleanup(f)).toMatchObject({ settled: 1, held: 0, remaining: 0 });
    expect(await f.run()).toBe("confirmed");
    expect(f.abort).toHaveBeenCalledTimes(1);
    expect(await auditOwnerLedger(env.DB, f.target.ids.user)).toMatchObject({
      reserved_bytes: 0,
      physical_bytes: 0,
      incorrect_refs: 0,
    });
    expect(
      await env.DB.prepare("SELECT state FROM blobs WHERE id=?").bind(f.id).first("state"),
    ).toBe("deleted");
    expect(
      await env.DB.prepare("SELECT disposition FROM copy_cleanup_receipts WHERE job_id=?")
        .bind(f.job.id)
        .first("disposition"),
    ).toBe("aborted");
    expect(
      await env.DB.prepare("SELECT 1 FROM blob_pins WHERE pin_id=?")
        .bind(f.job.id + "_p00001")
        .first(),
    ).toBeNull();
    expect(
      await env.DB.prepare("SELECT 1 FROM copy_multipart_uploads WHERE destination_blob_id=?")
        .bind(f.id)
        .first(),
    ).toBeNull();
    expect((await loadCopyJobManifest(env.DB, f.job.id)).plan.digest).toBe(f.claim.plan.digest);
    await expect(
      env.BLOBS.resumeMultipartUpload(f.key, f.upload).uploadPart(1, new Uint8Array(8 * MiB)),
    ).rejects.toThrow();
    if (parts === 0) {
      await env.DB.prepare("UPDATE control SET maintenance=1").run();
      await inspectRecoveryFinalFence(env.DB, 1);
    }
  },
);
it("requires durable stop before any native abort", async () => {
  const f = await fixture();
  await expect(f.run()).rejects.toThrow("copy_not_stopped");
  expect(f.abort).not.toHaveBeenCalled();
});
it.each(["part", "complete"])(
  "holds a prepared %s whose native history is missing",
  async (phase) => {
    const f = await fixture(phase === "complete" ? 2 : 0);
    const db = injectBatch(
      (s) =>
        s.startsWith(
          phase === "part"
            ? "INSERT INTO copy_multipart_parts"
            : "UPDATE copy_multipart_uploads SET state='completing'",
        ),
      async () => {
        throw new Error("lost_prepare_ack");
      },
      true,
    );
    await expect(step(mutationEnv(db), f.claim)).rejects.toThrow();
    await f.stop();
    expect(await f.run()).toBe("held");
    expect(f.abort).not.toHaveBeenCalled();
    await held(f);
  },
);
it.each(["part", "complete"])(
  "allows a prepared %s with an exact never-dispatched receipt",
  async (phase) => {
    const f = await fixture(phase === "complete" ? 2 : 0),
      a = mutationEnv();
    const control = a.CONTROL.get(a.CONTROL.idFromName("singleton"));
    a.CONTROL = {
      idFromName: a.CONTROL.idFromName.bind(a.CONTROL),
      get: () => ({
        ...control,
        beginR2Write: async (request: Parameters<typeof control.beginR2Write>[0]) => {
          const grant = await control.beginR2Write(request);
          await control.finishR2Write(grant, "not_started");
          throw new Error("never_dispatched");
        },
      }),
    } as unknown as Env["CONTROL"];
    await expect(step(a, f.claim)).rejects.toThrow();
    await f.stop();
    expect(await f.run()).toBe("confirmed");
    expect(await cleanup(f)).toMatchObject({ settled: 1, remaining: 0 });
  },
);
it.each(["part", "complete"])(
  "holds a %s with an unknown native result even when no object is visible",
  async (phase) => {
    const f = await fixture(phase === "complete" ? 2 : 0);
    const a = {
      ...mutationEnv(),
      BLOBS: {
        get: env.BLOBS.get.bind(env.BLOBS),
        resumeMultipartUpload: (key: string, upload: string) => ({
          uploadPart: async (n: number, data: ReadableStream) => {
            await env.BLOBS.resumeMultipartUpload(key, upload).uploadPart(n, data);
            throw new Error("native_reply_lost");
          },
          complete: async (parts: R2UploadedPart[]) => {
            await env.BLOBS.resumeMultipartUpload(key, upload).complete(parts);
            throw new Error("native_reply_lost");
          },
        }),
      } as unknown as R2Bucket,
    };
    await expect(step(a, f.claim)).rejects.toThrow();
    await f.stop();
    expect(await f.run()).toBe("held");
    expect(f.abort).not.toHaveBeenCalled();
    await held(f);
  },
);
it.each([false, true])(
  "does not dispatch after abort preparation failure (committed=%s)",
  async (committed) => {
    const f = await fixture();
    await f.stop();
    const db = injectBatch(
      (s) => s.startsWith("UPDATE copy_multipart_uploads SET abort_attempt="),
      async () => {
        throw new Error("prepare_failure");
      },
      committed,
    );
    await expect(f.run(f.app(db))).rejects.toThrow();
    expect(f.abort).not.toHaveBeenCalled();
    await held(f);
    expect(await f.run()).toBe(committed ? "held" : "confirmed");
    expect(f.abort).toHaveBeenCalledTimes(committed ? 0 : 1);
  },
);
it("never retries an unconfirmed abort or releases capacity on absence", async () => {
  const f = await fixture(1);
  await f.stop();
  f.abort.mockImplementation(async () => {
    await env.BLOBS.resumeMultipartUpload(f.key, f.upload).abort();
    throw new Error("abort_reply_lost");
  });
  expect(await f.run()).toBe("held");
  expect(await f.run()).toBe("held");
  expect(f.abort).toHaveBeenCalledTimes(1);
  expect(await env.BLOBS.head(f.key)).toBeNull();
  await held(f);
});
it("reconciles an actual abort when only its finish reply was lost", async () => {
  const f = await fixture(1);
  await f.stop();
  const a = f.app(),
    control = a.CONTROL.get(a.CONTROL.idFromName("singleton"));
  a.CONTROL = {
    idFromName: a.CONTROL.idFromName.bind(a.CONTROL),
    get: () => ({
      ...control,
      finishR2Write: async (...args: Parameters<typeof control.finishR2Write>) => {
        await control.finishR2Write(...args);
        throw new Error("lost_finish_ack");
      },
    }),
  } as unknown as Env["CONTROL"];
  expect(await f.run(a)).toBe("confirmed");
  expect(await cleanup(f)).toMatchObject({ settled: 1 });
  expect(f.abort).toHaveBeenCalledTimes(1);
});
it("retains holds while a real abort is in flight and records completion after epoch change", async () => {
  const f = await fixture(1);
  await f.stop();
  let enter!: () => void, finish!: () => void;
  const entered = new Promise<void>((r) => {
      enter = r;
    }),
    waiting = new Promise<void>((r) => {
      finish = r;
    });
  f.abort.mockImplementation(async () => {
    enter();
    await waiting;
    await env.BLOBS.resumeMultipartUpload(f.key, f.upload).abort();
  });
  const running = f.run();
  await entered;
  expect(await f.run()).toBe("held");
  await held(f);
  await env.DB.prepare("UPDATE control SET maintenance=1,epoch=2").run();
  finish();
  expect(await running).toBe("confirmed");
  expect(await cleanup(f)).toMatchObject({ settled: 1 });
  expect(f.abort).toHaveBeenCalledTimes(1);
});
it("aborts a stopped old-epoch job after grant revocation and owner disable", async () => {
  const f = await fixture(1);
  await f.revoke();
  await env.DB.prepare("UPDATE users SET disabled_at=1 WHERE id=?").bind(f.target.ids.user).run();
  await env.DB.prepare("UPDATE control SET maintenance=1,epoch=2").run();
  expect(await stopExpiredCopyJob(mutationEnv(), f.job.id)).toBe(true);
  expect(await f.run()).toBe("confirmed");
  expect(await cleanup(f)).toMatchObject({ settled: 1 });
});
it.each(["epoch", "maintenance", "backup", "restore"])(
  "blocks new native abort when %s changes after preparation",
  async (phase) => {
    const f = await fixture();
    await f.stop();
    const db = injectBatch(
      (s) => s.startsWith("UPDATE copy_multipart_uploads SET abort_attempt="),
      async () => {
        if (phase === "epoch")
          await env.DB.prepare("UPDATE control SET maintenance=1,epoch=2").run();
        if (phase === "maintenance") await env.DB.prepare("UPDATE control SET maintenance=1").run();
        if (phase === "restore")
          await env.DB.prepare("UPDATE control SET maintenance=1,restore_freeze_token=?")
            .bind(crypto.randomUUID())
            .run();
        if (phase === "backup") {
          const token = crypto.randomUUID();
          await env.DB.prepare(
            "INSERT INTO backup_runs(id,epoch,state,created_at,barrier_token) VALUES(?,1,'pending',1,?)",
          )
            .bind(crypto.randomUUID(), token)
            .run();
          await env.DB.prepare("UPDATE control SET backup_token=?").bind(token).run();
        }
      },
      true,
    );
    try {
      if (phase === "restore")
        await expect(f.run(f.app(db))).rejects.toThrow("restore_freeze_not_drained");
      else expect(await f.run(f.app(db))).toBe("held");
      expect(f.abort).not.toHaveBeenCalled();
    } finally {
      await env.DB.prepare("UPDATE control SET backup_token=NULL,restore_freeze_token=NULL").run();
    }
    await held(f);
  },
);
it("rolls back aborted settlement and can retry the DB-only cleanup", async () => {
  const f = await fixture(1);
  await f.stop();
  expect(await f.run()).toBe("confirmed");
  const db = injectBatch(
    (s) => s.startsWith("DELETE FROM copy_multipart_uploads"),
    async () => {
      throw new Error("cleanup_failure");
    },
    false,
  );
  await expect(cleanupStoppedCopyJob(mutationEnv(db), f.job.id)).rejects.toThrow();
  expect(
    await env.DB.prepare("SELECT 1 FROM copy_cleanup_receipts WHERE job_id=?")
      .bind(f.job.id)
      .first(),
  ).toBeNull();
  expect(await auditOwnerLedger(env.DB, f.target.ids.user)).toMatchObject({
    reserved_bytes: body.length,
  });
  expect(await cleanup(f)).toMatchObject({ settled: 1 });
});
it("waits for a late part to finish before aborting, even after cancellation", async () => {
  const f = await fixture();
  let enter!: () => void, finish!: () => void;
  const entered = new Promise<void>((r) => {
      enter = r;
    }),
    waiting = new Promise<void>((r) => {
      finish = r;
    });
  const a = {
    ...mutationEnv(),
    BLOBS: {
      get: env.BLOBS.get.bind(env.BLOBS),
      resumeMultipartUpload: (key: string, upload: string) => ({
        uploadPart: async (n: number, data: ReadableStream) => {
          const part = await env.BLOBS.resumeMultipartUpload(key, upload).uploadPart(n, data);
          enter();
          await waiting;
          return part;
        },
      }),
    } as unknown as R2Bucket,
  };
  const writing = step(a, f.claim).catch((error) => error);
  await entered;
  try {
    await f.stop();
    expect(await f.run()).toBe("held");
    expect(f.abort).not.toHaveBeenCalled();
    await held(f);
  } finally {
    finish();
  }
  await writing;
  expect(await f.run()).toBe("confirmed");
  expect(await cleanup(f)).toMatchObject({ settled: 1 });
});
it("retains a timed-out abort until its actual late completion without redispatch", async () => {
  const f = await fixture();
  await f.stop();
  let enter!: () => void, finish!: () => void, settled!: () => void;
  const entered = new Promise<void>((r) => {
      enter = r;
    }),
    waiting = new Promise<void>((r) => {
      finish = r;
    }),
    finished = new Promise<void>((r) => {
      settled = r;
    });
  f.abort.mockImplementation(async () => {
    enter();
    await waiting;
    await env.BLOBS.resumeMultipartUpload(f.key, f.upload).abort();
  });
  const a = f.app(),
    control = a.CONTROL.get(a.CONTROL.idFromName("singleton"));
  a.CONTROL = {
    idFromName: a.CONTROL.idFromName.bind(a.CONTROL),
    get: () => ({
      ...control,
      finishR2Write: async (...args: Parameters<typeof control.finishR2Write>) => {
        await control.finishR2Write(...args);
        settled();
      },
    }),
  } as unknown as Env["CONTROL"];
  const running = f.run(a);
  await entered;
  try {
    expect(await running).toBe("held");
    expect(await f.run()).toBe("held");
    expect(f.abort).toHaveBeenCalledTimes(1);
    await held(f);
  } finally {
    finish();
  }
  await finished;
  expect(await f.run()).toBe("confirmed");
  expect(await cleanup(f)).toMatchObject({ settled: 1 });
}, 90_000);
it.each(["part", "complete"])(
  "distinguishes a lost %s observation from its actual native success",
  async (phase) => {
    const f = await fixture(phase === "complete" ? 2 : 0);
    const prefix =
      phase === "part"
        ? "UPDATE copy_multipart_parts SET state='stored'"
        : "INSERT INTO blob_storage";
    const db = new Proxy(env.DB, {
      get(target, key) {
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
    await expect(step(mutationEnv(db), f.claim)).rejects.toThrow();
    await f.stop();
    expect(await f.run()).toBe(phase === "part" ? "confirmed" : "held");
    if (phase === "part") expect(await cleanup(f)).toMatchObject({ settled: 1 });
    else {
      expect(f.abort).not.toHaveBeenCalled();
      await held(f);
    }
  },
);
it.each(["owner", "key", "source", "attempt", "handle", "epoch"])(
  "refuses a changed %s at the native grant boundary",
  async (field) => {
    const f = await fixture();
    await f.stop();
    const a = f.app(),
      control = a.CONTROL.get(a.CONTROL.idFromName("singleton"));
    a.CONTROL = {
      idFromName: a.CONTROL.idFromName.bind(a.CONTROL),
      get: () => ({
        ...control,
        beginR2Write: async (request: Parameters<typeof control.beginR2Write>[0]) =>
          control.beginR2Write({
            ...request,
            ...(field === "owner" ? { ownerId: f.source.ids.user } : {}),
            ...(field === "key" ? { key: request.key + "x" } : {}),
            ...(field === "epoch" ? { epoch: request.epoch + 1 } : {}),
            abort: {
              ...request.abort!,
              ...(field === "source" ? { sourceBlobId: f.target.ids.blob } : {}),
              ...(field === "attempt" ? { attemptId: crypto.randomUUID() } : {}),
              ...(field === "handle" ? { r2UploadId: request.abort!.r2UploadId + "x" } : {}),
            },
          }),
      }),
    } as unknown as Env["CONTROL"];
    expect(await f.run(a)).toBe("held");
    expect(f.abort).not.toHaveBeenCalled();
    expect(
      await env.DB.prepare(
        "SELECT COUNT(*) AS n FROM r2_write_attempts WHERE kind='multipart.abort' AND json_extract(source_ref,'$[1]')=? AND state='pending'",
      )
        .bind(f.job.id)
        .first("n"),
    ).toBe(0);
    await held(f);
  },
);
it("rejects forged abort preparation and cleanup and keeps its proven identity immutable", async () => {
  const f = await fixture();
  await f.stop();
  await expect(
    env.DB.prepare(
      "UPDATE copy_multipart_uploads SET abort_attempt=?,abort_epoch=1,abort_started_at=?,abort_deadline=? WHERE destination_blob_id=?",
    )
      .bind(crypto.randomUUID(), Date.now(), Date.now() + 4000, f.id)
      .run(),
  ).rejects.toThrow("copy_abort_unproven");
  await expect(
    env.DB.prepare(`INSERT INTO copy_cleanup_receipts(job_id,source_blob_id,destination_blob_id,pin_id,reservation_id,bytes,disposition,epoch,settled_at)
    SELECT job_id,source_blob_id,destination_blob_id,pin_id,reservation_id,?,'aborted',1,? FROM copy_job_blobs WHERE job_id=?`)
      .bind(body.length, Date.now(), f.job.id)
      .run(),
  ).rejects.toThrow("copy_abort_unconfirmed");
  expect(await f.run()).toBe("confirmed");
  for (const set of [
    "abort_attempt=NULL,abort_epoch=NULL,abort_started_at=NULL,abort_deadline=NULL",
    "abort_deadline=abort_deadline+1",
    "abort_epoch=2",
  ])
    await expect(
      env.DB.prepare(`UPDATE copy_multipart_uploads SET ${set} WHERE destination_blob_id=?`)
        .bind(f.id)
        .run(),
    ).rejects.toThrow("immutable_copy_abort");
  expect(await cleanup(f)).toMatchObject({ settled: 1 });
  await expect(
    env.DB.prepare("DELETE FROM copy_cleanup_receipts WHERE job_id=?").bind(f.job.id).run(),
  ).rejects.toThrow("copy_cleanup_receipt_required");
});
it("aborts and settles through the real ControlDO while admission remains closed", async () => {
  const f = await fixture(1);
  await f.stop();
  await env.BACKUPS.put(
    "sys/epoch/1.json",
    JSON.stringify({ epoch: 1, at: 1, reason: "operator" }),
  );
  const control = env.CONTROL.get(env.CONTROL.idFromName("singleton"));
  const status = await control.recover();
  expect(status.maintenance).toBe(true);
  expect(await f.run({ ...env, BLOBS: f.app().BLOBS })).toBe("confirmed");
  expect(await cleanupStoppedCopyJob(env, f.job.id)).toMatchObject({ settled: 1, remaining: 0 });
  expect(f.abort).toHaveBeenCalledTimes(1);
  expect(await control.status()).toMatchObject({ epoch: status.epoch, maintenance: true });
  expect(await auditOwnerLedger(env.DB, f.target.ids.user)).toMatchObject({
    reserved_bytes: 0,
    physical_bytes: 0,
  });
});
