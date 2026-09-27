import { applyD1Migrations } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import type { UploadWriteKind } from "../../src/db/r2Upload";
import type { R2WriteGrant, R2WriteRequest } from "../../src/db/r2Write";
import type { Env } from "../../src/env";
import { repairMultipartUploads } from "../../src/jobs/multipartCleanup";
import { trackedR2Write } from "../../src/services/r2Write";
import { writeMultipartPart } from "../../src/services/uploads/multipart";
import { clearEndedR2TestWrites, mutationEnv, r2WriteFixture } from "../fixtures/mutationAdmission";
import { multipartCleanupFixture } from "../fixtures/uploadCleanup";
import { cleanupTransferObjects, transferFixture } from "../fixtures/uploadTransfer";

beforeAll(() => applyD1Migrations(env.DB, env.TEST_MIGRATIONS));
beforeEach(async () => {
  await clearEndedR2TestWrites();
  await env.DB.prepare("UPDATE control SET maintenance=1").run();
  await env.DB.prepare("UPDATE control SET epoch=1,maintenance=0,gc_paused=0").run();
});
afterEach(async () => {
  vi.restoreAllMocks();
  vi.useRealTimers();
  await cleanupTransferObjects();
});
const kinds: UploadWriteKind[] = [
  "upload.put",
  "multipart.create",
  "multipart.part",
  "multipart.complete",
];
async function fixture(kind: UploadWriteKind) {
  const f = await transferFixture(
    kind === "upload.put"
      ? "single-start"
      : kind === "multipart.complete"
        ? "multipart-complete"
        : "multipart-start",
  );
  if (kind === "multipart.part") await f.run();
  const app = f.configure();
  let request: R2WriteRequest | undefined;
  let dispatches = 0;
  let nativeError = false;
  let change = async () => {};
  const stub = app.CONTROL.get(app.CONTROL.idFromName("fixture"));
  app.CONTROL = {
    idFromName: env.CONTROL.idFromName.bind(env.CONTROL),
    get: () => ({
      ...stub,
      beginR2Write: async (r: R2WriteRequest) => {
        request = r;
        await change();
        return stub.beginR2Write(r);
      },
    }),
  } as unknown as Env["CONTROL"];
  const native = async <T>(run: () => Promise<T>) => {
    dispatches++;
    expect(
      await env.DB.prepare("SELECT state FROM r2_write_attempts WHERE id=?")
        .bind(request!.id)
        .first("state"),
    ).toBe("pending");
    const value = await run();
    if (nativeError) throw new Error("native_ack_lost");
    return value;
  };
  app.BLOBS = new Proxy(app.BLOBS, {
    get(target, field) {
      if (field === "put" && kind === "upload.put")
        return (...args: Parameters<R2Bucket["put"]>) => native(() => target.put(...args));
      if (field === "createMultipartUpload" && kind === "multipart.create")
        return (...args: Parameters<R2Bucket["createMultipartUpload"]>) =>
          native(() => target.createMultipartUpload(...args));
      if (field === "resumeMultipartUpload")
        return (...args: Parameters<R2Bucket["resumeMultipartUpload"]>) => {
          const handle = target.resumeMultipartUpload(...args);
          return new Proxy(handle, {
            get(multipart, name) {
              if (name === "uploadPart" && kind === "multipart.part")
                return (...args: Parameters<R2MultipartUpload["uploadPart"]>) =>
                  native(() => multipart.uploadPart(...args));
              if (name === "complete" && kind === "multipart.complete")
                return (...args: Parameters<R2MultipartUpload["complete"]>) =>
                  native(() => multipart.complete(...args));
              const value = Reflect.get(multipart, name);
              return typeof value === "function" ? value.bind(multipart) : value;
            },
          });
        };
      const value = Reflect.get(target, field);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  const run = async () =>
    kind === "multipart.part"
      ? writeMultipartPart(
          app,
          f.input.principal,
          f.created.id,
          f.created.capability,
          f.capabilities,
          1,
          "part-one",
          new Blob(["abc"]).stream(),
          3,
        )
      : f.run(app);
  const row = () =>
    env.DB.prepare("SELECT * FROM r2_write_attempts WHERE id=?").bind(request!.id).first();
  return {
    ...f,
    app,
    run,
    row,
    request: () => request!,
    dispatches: () => dispatches,
    loseAck: () => {
      nativeError = true;
    },
    change: (callback: () => Promise<void>) => {
      change = callback;
    },
  };
}
it.each(kinds)(
  "persists %s before dispatch and refuses a new grant ID for the same completed attempt",
  async (kind) => {
    const f = await fixture(kind);
    await f.run();
    expect(f.dispatches()).toBe(1);
    expect(await f.row()).toMatchObject({
      kind,
      state: "succeeded",
      source_ref: JSON.stringify([f.created.id, f.request().upload!.attemptId]),
    });
    await expect(
      r2WriteFixture().beginR2Write({
        ...f.request(),
        id: crypto.randomUUID(),
        deadline: Date.now() + 5000,
      }),
    ).rejects.toThrow();
    expect(f.dispatches()).toBe(1);
  },
);
it.each(kinds)("keeps %s pending when the native acknowledgement is lost", async (kind) => {
  const f = await fixture(kind);
  f.loseAck();
  await f.run().catch(() => {});
  expect(f.dispatches()).toBe(1);
  expect(await f.row()).toMatchObject({ state: "pending", finished_at: null });
  await env.DB.prepare("UPDATE control SET maintenance=1,gc_paused=1").run();
  await expect(env.DB.prepare("UPDATE control SET maintenance=0").run()).rejects.toThrow(
    /r2_write_unsettled/,
  );
  await expect(
    env.DB.prepare("UPDATE control SET restore_freeze_token=?").bind(crypto.randomUUID()).run(),
  ).rejects.toThrow(/restore_freeze_not_drained/);
});
it.each(kinds)("rechecks credentials immediately before the %s native call", async (kind) => {
  const f = await fixture(kind);
  f.change(async () => {
    await env.DB.prepare("UPDATE sessions SET revoked_at=1 WHERE id=?").bind(f.f.ids.session).run();
  });
  await expect(f.run()).rejects.toThrow();
  expect(f.dispatches()).toBe(0);
  expect(await f.row()).toMatchObject({ state: "not_started" });
});
it("deduplicates a still-pending upload attempt without leaving a second local hold", async () => {
  const f = await fixture("upload.put");
  f.loseAck();
  await expect(f.run()).rejects.toThrow("native_ack_lost");
  const duplicate = { ...f.request(), id: crypto.randomUUID(), deadline: Date.now() + 5000 };
  await expect(r2WriteFixture().beginR2Write(duplicate)).rejects.toThrow();
  expect(
    await env.DB.prepare("SELECT state FROM r2_write_attempts WHERE id=?")
      .bind(duplicate.id)
      .first("state"),
  ).toBe("not_started");
  expect(await f.row()).toMatchObject({ state: "pending" });
});
it("keeps the original 15-minute streaming lease and records actual success after timeout", async () => {
  const now = Date.now();
  let release!: () => void;
  let entered!: () => void;
  const wait = new Promise<void>((r) => {
    release = r;
  });
  const started = new Promise<void>((r) => {
    entered = r;
  });
  const finish = vi.fn(async () => {});
  const source = {
    DB: env.DB,
    systemControl: {
      beginR2Write: async (r: R2WriteRequest): Promise<R2WriteGrant> => ({
        ...r,
        token: crypto.randomUUID(),
        startedAt: Date.now(),
      }),
      finishR2Write: finish,
    },
  };
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  let settled = false;
  const writing = trackedR2Write(
    source,
    {
      epoch: 1,
      ownerId: "owner",
      kind: "upload.put",
      key: "u/owner/b/blob",
      upload: {
        id: "up_" + "a".repeat(64),
        attemptId: "attempt",
        expiresAt: now + 900000,
        principal: { kind: "user", user_id: "owner", credential_id: "credential", epoch: 1 },
      },
    },
    async () => {
      entered();
      await wait;
      return "done";
    },
  ).finally(() => {
    settled = true;
  });
  const outcome = expect(writing).rejects.toThrow(/mutation_unavailable/);
  try {
    await started;
    await vi.advanceTimersByTimeAsync(25000);
    expect(settled).toBe(false);
    expect(finish).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(875000);
    await outcome;
    expect(finish).not.toHaveBeenCalled();
    release();
    await vi.advanceTimersByTimeAsync(0);
    expect(finish).toHaveBeenCalledExactlyOnceWith(expect.any(Object), "succeeded");
  } finally {
    release();
    vi.useRealTimers();
  }
});

it.each(["claim", "mode"])(
  "rechecks the cleanup %s after waiting for an abort grant",
  async (field) => {
    await env.DB.prepare("UPDATE uploads SET cleanup_next_at=9999999999999").run();
    const f = await multipartCleanupFixture();
    const app = mutationEnv();
    const stub = app.CONTROL.get(app.CONTROL.idFromName("fixture"));
    let request!: R2WriteRequest;
    app.CONTROL = {
      idFromName: env.CONTROL.idFromName.bind(env.CONTROL),
      get: () => ({
        ...stub,
        beginR2Write: async (r: R2WriteRequest) => {
          request = r;
          if (field === "claim")
            await env.DB.prepare("UPDATE uploads SET cleanup_token=? WHERE id=?")
              .bind(crypto.randomUUID(), f.id)
              .run();
          else await env.DB.prepare("UPDATE control SET maintenance=1,gc_paused=1").run();
          return stub.beginR2Write(r);
        },
      }),
    } as unknown as Env["CONTROL"];
    const abort = vi.fn(async () => f.multipart!.abort());
    const bucket = {
      head: env.BLOBS.head.bind(env.BLOBS),
      resumeMultipartUpload: () => ({ abort }),
    } as unknown as R2Bucket;
    expect(await repairMultipartUploads(app, bucket, 1)).toMatchObject({ retried: 1, absent: 0 });
    expect(abort).not.toHaveBeenCalled();
    expect(
      await env.DB.prepare("SELECT state FROM r2_write_attempts WHERE id=?")
        .bind(request.id)
        .first("state"),
    ).toBe("not_started");
    expect(
      await env.DB.prepare("SELECT state FROM reservations WHERE id=?")
        .bind(f.reservation)
        .first("state"),
    ).toBe("reserved");
    await f.multipart!.abort();
  },
);

it("retains an abort timeout until its actual late success and only then allows cleanup", async () => {
  await env.DB.prepare("UPDATE uploads SET cleanup_next_at=9999999999999").run();
  const f = await multipartCleanupFixture();
  let release!: () => void, entered!: () => void, finished!: () => void;
  const wait = new Promise<void>((r) => {
    release = r;
  });
  const started = new Promise<void>((r) => {
    entered = r;
  });
  const ended = new Promise<void>((r) => {
    finished = r;
  });
  const app = mutationEnv();
  const stub = app.CONTROL.get(app.CONTROL.idFromName("fixture"));
  app.CONTROL = {
    idFromName: env.CONTROL.idFromName.bind(env.CONTROL),
    get: () => ({
      ...stub,
      finishR2Write: async (grant: R2WriteGrant, outcome: "succeeded" | "not_started") => {
        await stub.finishR2Write(grant, outcome);
        finished();
      },
    }),
  } as unknown as Env["CONTROL"];
  const bucket = {
    head: env.BLOBS.head.bind(env.BLOBS),
    resumeMultipartUpload: () => ({
      abort: async () => {
        entered();
        await wait;
        await f.multipart!.abort();
      },
    }),
  } as unknown as R2Bucket;
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  try {
    const repair = repairMultipartUploads(app, bucket, 1);
    await started;
    await vi.advanceTimersByTimeAsync(20000);
    expect(await repair).toMatchObject({ retried: 1, absent: 0 });
    expect(
      await env.DB.prepare("SELECT state FROM r2_write_attempts WHERE r2_key=?")
        .bind(f.key)
        .first("state"),
    ).toBe("pending");
    await expect(
      env.DB.prepare("UPDATE reservations SET state='released' WHERE id=?")
        .bind(f.reservation)
        .run(),
    ).rejects.toThrow(/r2_write_unsettled/);
    release();
    await ended;
    expect(
      await env.DB.prepare("SELECT state FROM r2_write_attempts WHERE r2_key=?")
        .bind(f.key)
        .first("state"),
    ).toBe("succeeded");
    vi.useRealTimers();
    await env.DB.prepare(
      "UPDATE uploads SET cleanup_next_at=0,cleanup_lease_expires_at=0 WHERE id=?",
    )
      .bind(f.id)
      .run();
    expect(await repairMultipartUploads(mutationEnv(), env.BLOBS, 1)).toMatchObject({ absent: 1 });
  } finally {
    release();
    vi.useRealTimers();
  }
});
