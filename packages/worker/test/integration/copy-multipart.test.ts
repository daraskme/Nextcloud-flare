import { applyD1Migrations } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import type { Env } from "../../src/env";
import { claimCopyJob, releaseCopyJobClaim } from "../../src/jobs/copyClaim";
import { copyNextBlob } from "../../src/jobs/copyMultipart";
import { abortMultipartBucketHandle } from "../../src/jobs/multipartBucketAbort";
import {
  observeMultipartBucketParts,
  scanMultipartBucket,
} from "../../src/jobs/multipartBucketInventory";
import { hex } from "../../src/platform/stream";
import { auditOwnerLedger } from "../../src/services/refs";
import { copyJobFixture } from "../fixtures/copyJob";
import { multipartBucketClient } from "../fixtures/multipartBucket";
import { clearEndedR2TestWrites, mutationEnv } from "../fixtures/mutationAdmission";
import { injectBatch } from "../fixtures/uploadEnv";

const MiB = 1024 * 1024;
const body = new Uint8Array(9 * MiB);
for (let i = 0; i < body.length; i++) body[i] = (i * 31 + (i >>> 16)) % 251;
beforeAll(() => applyD1Migrations(env.DB, env.TEST_MIGRATIONS));
beforeEach(async () => {
  await env.DB.prepare("UPDATE control SET maintenance=1").run();
  await env.DB.prepare("UPDATE control SET epoch=1,maintenance=0").run();
});
afterEach(clearEndedR2TestWrites);
const step = (a: Env, c: Awaited<ReturnType<typeof claimCopyJob>>) => copyNextBlob(a, c, 8 * MiB);
async function fixture() {
  const f = await copyJobFixture(false, body);
  const claim = await claimCopyJob(mutationEnv(), f.job.outboxId);
  const id = claim.id + "_b00001",
    key = `u/${f.target.ids.user}/b/${id}`;
  return { ...f, claim, id, destinationKey: key };
}
function app(db = env.DB) {
  const create = vi.fn(env.BLOBS.createMultipartUpload.bind(env.BLOBS));
  const part = vi.fn((key: string, upload: string, number: number, data: ReadableStream) =>
    env.BLOBS.resumeMultipartUpload(key, upload).uploadPart(number, data),
  );
  const complete = vi.fn((key: string, upload: string, parts: R2UploadedPart[]) =>
    env.BLOBS.resumeMultipartUpload(key, upload).complete(parts),
  );
  const get = vi.fn(env.BLOBS.get.bind(env.BLOBS));
  return {
    ...mutationEnv(db, db),
    BLOBS: {
      get,
      put: env.BLOBS.put.bind(env.BLOBS),
      createMultipartUpload: create,
      resumeMultipartUpload: (key: string, upload: string) => ({
        uploadPart: (number: number, data: ReadableStream) => part(key, upload, number, data),
        complete: (parts: R2UploadedPart[]) => complete(key, upload, parts),
      }),
    } as unknown as R2Bucket,
    create,
    part,
    complete,
    get,
  };
}
const position = (id: string) =>
  env.DB.prepare("SELECT checkpoint FROM bulk_jobs WHERE id=?").bind(id).first("checkpoint");
const header = (id: string) =>
  env.DB.prepare("SELECT * FROM copy_multipart_uploads WHERE destination_blob_id=?")
    .bind(id)
    .first();
const parts = (id: string) =>
  env.DB.prepare(
    "SELECT * FROM copy_multipart_parts WHERE destination_blob_id=? ORDER BY part_number",
  )
    .bind(id)
    .all();
async function initialized() {
  const f = await fixture(),
    a = app();
  expect(await step(a, f.claim)).toBe("initialized");
  return { ...f, a };
}
async function transferred() {
  const f = await initialized();
  expect(await step(f.a, f.claim)).toBe("part");
  expect(await step(f.a, f.claim)).toBe("part");
  return f;
}
function brokenFinish(a: Env) {
  const control = a.CONTROL.get(a.CONTROL.idFromName("singleton"));
  return {
    ...a,
    CONTROL: {
      idFromName: a.CONTROL.idFromName.bind(a.CONTROL),
      get: () => ({
        ...control,
        finishR2Write: async (...args: Parameters<typeof control.finishR2Write>) => {
          await control.finishR2Write(...args);
          throw new Error("finish_ack_lost");
        },
      }),
    } as unknown as Env["CONTROL"],
  };
}
it("streams two parts across claims, preserves part hashes, and stores without publishing nodes", async () => {
  const f = await initialized();
  expect(await step(f.a, f.claim)).toBe("part");
  expect(await position(f.claim.id)).toBe(JSON.stringify({ v: 1, blob: 0, offset: 8 * MiB }));
  await releaseCopyJobClaim(mutationEnv(), f.claim);
  const resumed = await claimCopyJob(mutationEnv(), f.job.outboxId);
  expect(await step(f.a, resumed)).toBe("part");
  expect(await step(f.a, resumed)).toBe("stored");
  expect(await step(f.a, resumed)).toBe("ready");
  const object = await env.BLOBS.get(f.destinationKey);
  expect(hex(await crypto.subtle.digest("SHA-256", await object!.arrayBuffer()))).toBe(
    hex(await crypto.subtle.digest("SHA-256", body)),
  );
  const saved = (await parts(f.id)).results;
  expect(saved).toHaveLength(2);
  for (let i = 0; i < 2; i++) {
    const bytes = body.slice(i * 8 * MiB, (i + 1) * 8 * MiB);
    expect(saved[i]).toMatchObject({
      part_number: i + 1,
      expected_size: bytes.length,
      state: "stored",
      sha256: hex(await crypto.subtle.digest("SHA-256", bytes)),
    });
    expect(saved[i]!.etag).toBeTruthy();
  }
  expect(f.a.get.mock.calls.map((c) => c[1]?.range)).toEqual([
    { offset: 0, length: 8 * MiB },
    { offset: 8 * MiB, length: MiB },
  ]);
  expect(f.a.create).toHaveBeenCalledTimes(1);
  expect(f.a.part).toHaveBeenCalledTimes(2);
  expect(f.a.complete).toHaveBeenCalledTimes(1);
  expect(await auditOwnerLedger(env.DB, f.target.ids.user)).toMatchObject({
    used_bytes: 3,
    physical_bytes: body.length,
    reserved_bytes: body.length,
    incorrect_refs: 0,
  });
  expect(
    await env.DB.prepare("SELECT state,sha256_verified FROM blobs WHERE id=?").bind(f.id).first(),
  ).toEqual({ state: "staging", sha256_verified: null });
  expect(
    await env.DB.prepare("SELECT COUNT(*) AS n FROM nodes WHERE owner_id=?")
      .bind(f.target.ids.user)
      .first("n"),
  ).toBe(3);
  await releaseCopyJobClaim(mutationEnv(), resumed);
  expect(await step(f.a, await claimCopyJob(mutationEnv(), f.job.outboxId))).toBe("ready");
});
it.each(["init", "part", "complete"])(
  "never dispatches after a lost %s preparation ACK",
  async (phase) => {
    const f =
      phase === "init"
        ? { ...(await fixture()), a: app() }
        : phase === "part"
          ? await initialized()
          : await transferred();
    const prefix =
      phase === "init"
        ? "UPDATE copy_job_blobs SET transfer_mode"
        : phase === "part"
          ? "INSERT INTO copy_multipart_parts"
          : "UPDATE copy_multipart_uploads SET state='completing'";
    const a = app(
      injectBatch(
        (sql) => sql.startsWith(prefix),
        async () => {
          throw new Error("prepare_ack_lost");
        },
        true,
      ),
    );
    await expect(step(a, f.claim)).rejects.toThrow("prepare_ack_lost");
    await expect(step(a, f.claim)).rejects.toThrow(/unsettled/);
    expect(a.create).not.toHaveBeenCalled();
    expect(a.part).not.toHaveBeenCalled();
    expect(a.complete).not.toHaveBeenCalled();
    expect(await auditOwnerLedger(env.DB, f.target.ids.user)).toMatchObject({
      reserved_bytes: body.length,
    });
  },
);
it("streams a part larger than the buffered read limit", async () => {
  const f = await fixture(),
    a = app();
  expect(await copyNextBlob(a, f.claim)).toBe("initialized");
  expect(await copyNextBlob(a, f.claim)).toBe("part");
  expect(a.get.mock.calls[0]?.[1]?.range).toEqual({ offset: 0, length: body.length });
  expect(await copyNextBlob(a, f.claim)).toBe("stored");
  expect((await parts(f.id)).results).toHaveLength(1);
});
it.each(["upload", "number", "attempt"])(
  "refuses a native part with changed %s identity",
  async (changed) => {
    const f = await initialized();
    const control = f.a.CONTROL.get(f.a.CONTROL.idFromName("singleton"));
    const a = {
      ...f.a,
      CONTROL: {
        idFromName: f.a.CONTROL.idFromName.bind(f.a.CONTROL),
        get: () => ({
          ...control,
          beginR2Write: (request: Parameters<typeof control.beginR2Write>[0]) =>
            control.beginR2Write({
              ...request,
              copy: {
                ...request.copy!,
                ...(changed === "upload"
                  ? { r2UploadId: "wrong-upload" }
                  : changed === "number"
                    ? { partNumber: 2 }
                    : { attemptId: crypto.randomUUID() }),
              },
            }),
        }),
      } as unknown as Env["CONTROL"],
    };
    await expect(step(a, f.claim)).rejects.toThrow();
    expect(f.a.part).not.toHaveBeenCalled();
  },
);
it.each([true, false])(
  "protects copy multipart from bucket cleanup (known handle=%s)",
  async (known) => {
    const f = await initialized();
    const saved = await header(f.id);
    const handle = known
      ? env.BLOBS.resumeMultipartUpload(f.destinationKey, String(saved!.r2_upload_id))
      : await env.BLOBS.createMultipartUpload(f.destinationKey);
    if (!known) await handle.uploadPart(1, new TextEncoder().encode("abc"));
    await releaseCopyJobClaim(mutationEnv(), f.claim);
    await env.DB.prepare("UPDATE control SET maintenance=1,gc_paused=1").run();
    await env.DB.prepare(
      "UPDATE r2_binding_probe SET lease_expires_at=1 WHERE lease_token IS NOT NULL",
    ).run();
    await env.DB.prepare(
      "UPDATE multipart_bucket_scan SET round_id=?,pages=0,cursor_key=NULL,cursor_upload_id=NULL,completed_at=NULL",
    )
      .bind(crypto.randomUUID())
      .run();
    const client = multipartBucketClient({ ...f.target, key: f.destinationKey, handle });
    const scanned = await scanMultipartBucket(mutationEnv(), env.BLOBS, client.inventory, 1);
    expect(scanned.handles[0]?.state).toBe(known ? "tracked" : "quarantined");
    const id = scanned.handles[0]!.id;
    if (!known)
      await observeMultipartBucketParts(mutationEnv(), env.BLOBS, client.inventory, 1, id);
    const abort = vi.fn(handle.abort.bind(handle));
    const bucket = new Proxy(env.BLOBS, {
      get(target, property) {
        if (property === "resumeMultipartUpload") return () => ({ abort });
        const value = Reflect.get(target, property, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    await expect(
      abortMultipartBucketHandle(
        mutationEnv(),
        bucket,
        client.inventory,
        1,
        id,
        crypto.randomUUID(),
      ),
    ).rejects.toThrow();
    expect(abort).not.toHaveBeenCalled();
    await expect(
      env.DB.prepare(`INSERT INTO multipart_bucket_abort_attempts(id,handle_id,ordinal,epoch,proof_generation,scan_round_id,part_round_id,held_bytes,started_at)
      SELECT ?,h.id,1,1,p.generation,s.round_id,h.part_round_id,h.held_bytes,1
      FROM multipart_bucket_handles h JOIN multipart_bucket_scan s ON s.singleton=1
      JOIN r2_binding_probe p ON p.singleton=1 WHERE h.id=?`)
        .bind(crypto.randomUUID(), id)
        .run(),
    ).rejects.toThrow("copy_multipart_held");
    expect(await header(f.id)).toMatchObject({ state: "uploading" });
    // Fixture-only cleanup: this extra handle was created outside the copy protocol.
    if (!known) await handle.abort();
  },
);
it.each(["init", "part", "complete"])(
  "retains a native %s with unknown outcome and never replays it",
  async (phase) => {
    const f =
      phase === "init"
        ? { ...(await fixture()), a: app() }
        : phase === "part"
          ? await initialized()
          : await transferred();
    if (phase === "init")
      f.a.create.mockImplementation(async (...args) => {
        await env.BLOBS.createMultipartUpload(...args);
        throw new Error("native_ack_lost");
      });
    if (phase === "part")
      f.a.part.mockImplementation(async (key, upload, number, data) => {
        await env.BLOBS.resumeMultipartUpload(key, upload).uploadPart(number, data);
        throw new Error("native_ack_lost");
      });
    if (phase === "complete")
      f.a.complete.mockImplementation(async (key, upload, parts) => {
        await env.BLOBS.resumeMultipartUpload(key, upload).complete(parts);
        throw new Error("native_ack_lost");
      });
    await expect(step(f.a, f.claim)).rejects.toThrow();
    await expect(step(f.a, f.claim)).rejects.toThrow(/unsettled/);
    await releaseCopyJobClaim(mutationEnv(), f.claim);
    await expect(claimCopyJob(mutationEnv(), f.job.outboxId)).rejects.toThrow();
    expect(
      await env.DB.prepare(
        "SELECT COUNT(*) AS n FROM r2_write_attempts WHERE r2_key=? AND state='pending'",
      )
        .bind(f.destinationKey)
        .first("n"),
    ).toBe(1);
    expect(await auditOwnerLedger(env.DB, f.target.ids.user)).toMatchObject({
      reserved_bytes: body.length,
      physical_bytes: 0,
    });
  },
);
it.each(["handle", "part", "progress", "object"])(
  "reconciles a lost %s observation ACK without duplicate native calls",
  async (phase) => {
    const f =
      phase === "handle"
        ? { ...(await fixture()), a: app() }
        : phase === "object"
          ? await transferred()
          : await initialized();
    const prefix =
      phase === "handle"
        ? "UPDATE copy_multipart_uploads SET r2_upload_id"
        : phase === "part"
          ? "UPDATE copy_multipart_parts SET state='stored'"
          : phase === "progress"
            ? "UPDATE bulk_jobs SET checkpoint"
            : "INSERT INTO blob_storage";
    const a = app(
      injectBatch(
        (sql) => sql.startsWith(prefix),
        async () => {
          throw new Error("ack_lost");
        },
        true,
      ),
    );
    expect(await step(a, f.claim)).toBe(
      phase === "handle" ? "initialized" : phase === "object" ? "stored" : "part",
    );
    expect(
      a.create.mock.calls.length + a.part.mock.calls.length + a.complete.mock.calls.length,
    ).toBe(1);
  },
);
it.each(["handle", "object"])(
  "retries an uncommitted %s observation after native success",
  async (phase) => {
    const f = phase === "handle" ? await fixture() : await transferred();
    const a = app(
      injectBatch(
        (sql) =>
          sql.startsWith(
            phase === "handle"
              ? "UPDATE copy_multipart_uploads SET r2_upload_id"
              : "INSERT INTO blob_storage",
          ),
        async () => {
          throw new Error("observation_rollback");
        },
        false,
      ),
    );
    expect(await step(a, f.claim)).toBe(phase === "handle" ? "initialized" : "stored");
    expect(a.create.mock.calls.length + a.complete.mock.calls.length).toBe(1);
    expect(await header(f.id)).toMatchObject({
      state: phase === "handle" ? "uploading" : "stored",
    });
  },
);
it.each(["init", "part", "complete"])(
  "resumes known %s after a lost native finish ACK",
  async (phase) => {
    const f =
      phase === "init"
        ? { ...(await fixture()), a: app() }
        : phase === "part"
          ? await initialized()
          : await transferred();
    await expect(step(brokenFinish(f.a), f.claim)).rejects.toThrow();
    const counts = [
      f.a.create.mock.calls.length,
      f.a.part.mock.calls.length,
      f.a.complete.mock.calls.length,
    ];
    await releaseCopyJobClaim(mutationEnv(), f.claim);
    const resumed = await claimCopyJob(mutationEnv(), f.job.outboxId);
    expect(await step(f.a, resumed)).toBe(phase === "complete" ? "stored" : "part");
    expect(f.a.create.mock.calls.length).toBe(counts[0]);
    expect(f.a.part.mock.calls.length).toBe(counts[1]! + (phase === "init" ? 1 : 0));
    expect(f.a.complete.mock.calls.length).toBe(counts[2]);
  },
);
it.each(["part", "complete"])(
  "records actual %s after revocation but refuses progress",
  async (phase) => {
    const f = phase === "part" ? await initialized() : await transferred();
    if (phase === "part")
      f.a.part.mockImplementation(async (key, upload, number, data) => {
        const result = await env.BLOBS.resumeMultipartUpload(key, upload).uploadPart(number, data);
        await f.revoke();
        return result;
      });
    else
      f.a.complete.mockImplementation(async (key, upload, parts) => {
        const result = await env.BLOBS.resumeMultipartUpload(key, upload).complete(parts);
        await f.revoke();
        return result;
      });
    const before = await position(f.claim.id);
    await expect(step(f.a, f.claim)).rejects.toThrow();
    expect(await position(f.claim.id)).toBe(before);
    if (phase === "part") expect((await parts(f.id)).results[0]).toMatchObject({ state: "stored" });
    else expect(await header(f.id)).toMatchObject({ state: "stored" });
  },
);
it("denies dispatch when authorization changes in the native grant batch", async () => {
  const f = await initialized();
  const a = app(
    injectBatch(
      (sql) => sql.startsWith("INSERT INTO r2_write_attempts"),
      async () => {
        await f.revoke();
      },
      false,
    ),
  );
  await expect(step(a, f.claim)).rejects.toThrow();
  expect(a.part).not.toHaveBeenCalled();
  expect(await position(f.claim.id)).toBe('{"v":1,"blob":0,"offset":0}');
});
it("enforces part geometry, native evidence, immutable identity and retained holds", async () => {
  const f = await initialized();
  for (const sql of [
    "UPDATE copy_multipart_uploads SET part_bytes=94371840 WHERE destination_blob_id=?",
    "UPDATE copy_multipart_uploads SET r2_upload_id='wrong' WHERE destination_blob_id=?",
    "UPDATE copy_multipart_uploads SET state='completing',complete_attempt=init_attempt,complete_claim=init_claim WHERE destination_blob_id=?",
    "DELETE FROM copy_multipart_uploads WHERE destination_blob_id=?",
  ])
    await expect(env.DB.prepare(sql).bind(f.id).run()).rejects.toThrow();
  await expect(
    env.DB.prepare("INSERT INTO copy_multipart_parts VALUES(?,1,1,?,?,'claimed',NULL,NULL)")
      .bind(f.id, crypto.randomUUID(), f.claim.token)
      .run(),
  ).rejects.toThrow("invalid_copy_part");
  await step(f.a, f.claim);
  for (const sql of [
    "DELETE FROM copy_multipart_parts WHERE destination_blob_id=?",
    "UPDATE copy_multipart_parts SET sha256=lower(hex(zeroblob(32))) WHERE destination_blob_id=?",
  ])
    await expect(env.DB.prepare(sql).bind(f.id).run()).rejects.toThrow();
});
it.each(["init", "part", "complete"])(
  "retains a late successful %s after claim release without advancing the old claim",
  async (phase) => {
    const f =
      phase === "init"
        ? { ...(await fixture()), a: app() }
        : phase === "part"
          ? await initialized()
          : await transferred();
    let enter!: () => void, finish!: () => void;
    const entered = new Promise<void>((resolve) => {
        enter = resolve;
      }),
      wait = new Promise<void>((resolve) => {
        finish = resolve;
      });
    if (phase === "init")
      f.a.create.mockImplementation(async (...args) => {
        const result = await env.BLOBS.createMultipartUpload(...args);
        enter();
        await wait;
        return result;
      });
    if (phase === "part")
      f.a.part.mockImplementation(async (key, upload, number, data) => {
        const result = await env.BLOBS.resumeMultipartUpload(key, upload).uploadPart(number, data);
        enter();
        await wait;
        return result;
      });
    if (phase === "complete")
      f.a.complete.mockImplementation(async (key, upload, parts) => {
        const result = await env.BLOBS.resumeMultipartUpload(key, upload).complete(parts);
        enter();
        await wait;
        return result;
      });
    const before = await position(f.claim.id),
      copying = step(f.a, f.claim),
      rejected = expect(copying).rejects.toThrow();
    await entered;
    await releaseCopyJobClaim(mutationEnv(), f.claim);
    await expect(claimCopyJob(mutationEnv(), f.job.outboxId)).rejects.toThrow();
    finish();
    await rejected;
    await expect
      .poll(async () =>
        env.DB.prepare(
          "SELECT COUNT(*) AS n FROM r2_write_attempts WHERE r2_key=? AND state='pending'",
        )
          .bind(f.destinationKey)
          .first("n"),
      )
      .toBe(0);
    await expect
      .poll(async () =>
        phase === "part" ? (await parts(f.id)).results[0]?.state : (await header(f.id))?.state,
      )
      .toBe(phase === "init" ? "uploading" : "stored");
    expect(await position(f.claim.id)).toBe(before);
    const resumed = await claimCopyJob(mutationEnv(), f.job.outboxId);
    expect(await step(f.a, resumed)).toBe(phase === "complete" ? "stored" : "part");
  },
);
