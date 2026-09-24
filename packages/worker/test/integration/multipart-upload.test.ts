import { applyD1Migrations, evictDurableObject, runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { base64url } from "jose";
import { beforeAll, beforeEach, expect, it } from "vitest";
import type { Principal } from "../../src/auth/authorize";
import { contentKeyRing } from "../../src/auth/contentTokens";
import { UploadCapabilities } from "../../src/auth/uploadCapability";
import { atomicBatch } from "../../src/db/primary";
import { UploadDO } from "../../src/do/UploadDO";
import { UPLOAD_LIMITS } from "../../src/do/uploadPlan";
import { uploadRow } from "../../src/services/uploads/access";
import { reserveMultipartUpload } from "../../src/services/uploads/create";
import { createMultipartUpload, writeMultipartPart } from "../../src/services/uploads/multipart";
import { completeMultipartUpload } from "../../src/services/uploads/multipartComplete";
import { foundationFixture } from "../fixtures/foundation";
import { admitted, injectBatch } from "../fixtures/uploadEnv";

beforeAll(async () => applyD1Migrations(env.DB, env.TEST_MIGRATIONS));
beforeEach(async () => {
  await env.DB.prepare("UPDATE control SET epoch=1,maintenance=0").run();
});
const SHA = "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad";
const stream = (text = "abc") => new Blob([text]).stream();

async function fixture(size = 3, initialize = true) {
  const f = foundationFixture(crypto.randomUUID(), Date.now() - 1000);
  await atomicBatch(env.DB, f.statements);
  await env.DB.prepare("UPDATE users SET quota_bytes=1000000000000 WHERE id=?")
    .bind(f.ids.user)
    .run();
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
  const input = {
    principal,
    requestId: crypto.randomUUID(),
    spaceId: f.ids.space,
    parentId: f.ids.folder,
    name: "multipart.bin",
    declaredSize: size,
  };
  const app = admitted();
  const created = initialize
    ? await createMultipartUpload(app, input, capabilities)
    : await reserveMultipartUpload(admitted(), input, capabilities);
  const request = { uploadId: created.id, principal, capability: created.capability };
  const stub = app.UPLOADS.get(app.UPLOADS.idFromName(created.id));
  const actual = env.UPLOADS.get(env.UPLOADS.idFromName(created.id));
  return { ...f, principal, capabilities, input, app, created, request, stub, actual };
}
async function write(
  f: Awaited<ReturnType<typeof fixture>>,
  app = f.app,
  attempt = "part1",
  text = "abc",
) {
  return writeMultipartPart(
    app,
    f.principal,
    f.created.id,
    f.created.capability,
    f.capabilities,
    1,
    attempt,
    stream(text),
    3,
  );
}
async function part(f: Awaited<ReturnType<typeof fixture>>) {
  return env.DB.prepare("SELECT * FROM upload_parts WHERE upload_id=? AND part_number=1")
    .bind(f.created.id)
    .first();
}

it("reserves once, creates R2 once, fixes geometry, and arms the first idle alarm", async () => {
  const f = await fixture();
  const row = (await uploadRow(env.DB, f.created.id))!;
  expect(row).toMatchObject({
    mode: "multipart",
    part_bytes: UPLOAD_LIMITS.defaultPartBytes,
    part_count: 1,
    state: "created",
    control_calls: 1,
    data_calls: 0,
  });
  expect(row.r2_upload_id).toBeTruthy();
  expect(row.multipart_ledger_id).toBeTruthy();
  expect(row.expires_at - row.created_at).toBe(UPLOAD_LIMITS.lifetimeMs);
  expect(await createMultipartUpload(f.app, f.input, f.capabilities)).toEqual(f.created);
  expect(
    await env.DB.prepare("SELECT reserved_bytes FROM users WHERE id=?")
      .bind(f.ids.user)
      .first("reserved_bytes"),
  ).toBe(3);
  await runInDurableObject(f.actual, async (_, state) => {
    expect(await state.storage.getAlarm()).toBe(row.created_at + UPLOAD_LIMITS.idleMs);
  });
});

it("streams a part into real R2, mirrors its hash, and never presents it as a whole-object hash", async () => {
  const f = await fixture();
  expect(await write(f)).toMatchObject({ disposition: "completed" });
  expect(await part(f)).toMatchObject({
    state: "completed",
    attempts: 1,
    sha256: SHA,
    expected_size: 3,
  });
  expect(await uploadRow(env.DB, f.created.id)).toMatchObject({
    in_flight: 0,
    data_calls: 1,
    data_bytes: 3,
    state: "uploading",
  });
  const pages = await f.stub.completedParts({ ...f.request, after: 0 });
  expect(pages).toMatchObject([{ partNumber: 1, bytes: 3, sha256: SHA }]);
  const row = (await uploadRow(env.DB, f.created.id))!;
  const key = `u/${row.owner_id}/b/${row.blob_id}`;
  expect(await env.BLOBS.head(key)).toBeNull();
  // This direct fixture call proves bytes reached R2; application publication is intentionally absent.
  await env.BLOBS.resumeMultipartUpload(key, row.r2_upload_id!).complete([
    { partNumber: 1, etag: pages[0]!.etag! },
  ]);
  expect(await (await env.BLOBS.get(key))!.text()).toBe("abc");
  expect(
    await env.DB.prepare("SELECT sha256_verified,state,ref_count FROM blobs WHERE id=?")
      .bind(row.blob_id)
      .first(),
  ).toMatchObject({ sha256_verified: null, state: "staging", ref_count: 0 });
});

it("replays a completed part after eviction without another R2 call or byte charge", async () => {
  const f = await fixture();
  await write(f);
  await evictDurableObject(f.actual);
  let calls = 0;
  const app = {
    ...f.app,
    BLOBS: new Proxy(env.BLOBS, {
      get(target, key) {
        if (key === "resumeMultipartUpload")
          return () => {
            calls++;
            throw new Error("unexpected_r2");
          };
        const value = Reflect.get(target, key);
        return typeof value === "function" ? value.bind(target) : value;
      },
    }),
  };
  expect(await write(f, app)).toMatchObject({ disposition: "completed" });
  expect(calls).toBe(0);
  expect(await uploadRow(env.DB, f.created.id)).toMatchObject({ data_calls: 1, data_bytes: 3 });
  await expect(write(f, app, "replacement")).rejects.toThrow(/part_busy/);
});

it("does not recreate R2 when create succeeds but its response is lost", async () => {
  const f = await fixture(3, false);
  let calls = 0;
  const app = {
    ...f.app,
    BLOBS: new Proxy(env.BLOBS, {
      get(target, key) {
        if (key === "createMultipartUpload")
          return async (...args: Parameters<R2Bucket["createMultipartUpload"]>) => {
            calls++;
            await target.createMultipartUpload(...args);
            throw new Error("lost_r2_create");
          };
        const value = Reflect.get(target, key);
        return typeof value === "function" ? value.bind(target) : value;
      },
    }),
  };
  await expect(createMultipartUpload(app, f.input, f.capabilities)).rejects.toThrow(
    /lost_r2_create/,
  );
  await expect(createMultipartUpload(app, f.input, f.capabilities)).rejects.toThrow(
    /upload_init_unknown/,
  );
  expect(calls).toBe(1);
  expect(await uploadRow(env.DB, f.created.id)).toMatchObject({
    state: "failed",
    cleanup_pending: 1,
    r2_upload_id: null,
  });
  expect(
    await env.DB.prepare("SELECT state FROM reservations WHERE id=?")
      .bind(`${f.created.id}_reservation`)
      .first("state"),
  ).toBe("reserved");
});

it("recovers the R2 ID when its D1 acknowledgement is lost", async () => {
  const f = await fixture(3, false);
  const db = injectBatch(
    (sql) => sql.includes("SET r2_upload_id="),
    async () => {
      throw new Error("lost_id_ack");
    },
    true,
  );
  expect((await createMultipartUpload(admitted(db), f.input, f.capabilities)).id).toBe(
    f.created.id,
  );
  expect((await uploadRow(env.DB, f.created.id))?.multipart_ledger_id).toBeTruthy();
});

it("refuses to initialize an empty DO after a D1 marker acknowledgement is lost", async () => {
  const f = await fixture(3, false);
  const db = injectBatch(
    (sql) => sql.includes("SET multipart_ledger_id="),
    async () => {
      throw new Error("lost_marker_ack");
    },
    true,
  );
  await expect(createMultipartUpload(admitted(db), f.input, f.capabilities)).rejects.toThrow(
    /lost_marker_ack/,
  );
  await expect(createMultipartUpload(f.app, f.input, f.capabilities)).rejects.toThrow(
    /recovery_required/,
  );
  expect(await uploadRow(env.DB, f.created.id)).toMatchObject({
    state: "failed",
    cleanup_pending: 1,
    accept_parts: 0,
  });
});

it("fences total DO storage loss without resetting the persisted attempts or reservation", async () => {
  const f = await fixture();
  await f.stub.claimPart({ ...f.request, partNumber: 1, attemptId: "lost", bytes: 3 });
  await runInDurableObject(f.actual, async (_, state) => {
    await state.storage.deleteAll();
  });
  await evictDurableObject(f.actual);
  await expect(write(f)).rejects.toThrow(/recovery_required/);
  expect(await uploadRow(env.DB, f.created.id)).toMatchObject({
    state: "failed",
    data_calls: 1,
    data_bytes: 3,
    cleanup_pending: 1,
  });
  expect(await part(f)).toMatchObject({ state: "unknown", attempts: 1 });
});

it("retains a charged claim when the D1 mirror acknowledgement is lost and never returns dispatch twice", async () => {
  const f = await fixture();
  const db = injectBatch(
    (sql) => sql.includes("INSERT INTO upload_parts"),
    async () => {
      throw new Error("lost_mirror_ack");
    },
    true,
  );
  await expect(write(f, admitted(db))).rejects.toThrow(/lost_mirror_ack/);
  expect(await write(f)).toMatchObject({ disposition: "in_flight" });
  expect(await uploadRow(env.DB, f.created.id)).toMatchObject({
    data_calls: 1,
    data_bytes: 3,
    in_flight: 1,
  });
});

it("reconciles a failed mirror before replay, retaining the original lease without dispatch", async () => {
  const f = await fixture();
  const db = injectBatch(
    (sql) => sql.includes("INSERT INTO upload_parts"),
    async () => {
      throw new Error("mirror_unavailable");
    },
    false,
  );
  await expect(write(f, admitted(db))).rejects.toThrow(/mirror_unavailable/);
  expect(await part(f)).toBeNull();
  await evictDurableObject(f.actual);
  expect(await write(f)).toMatchObject({ disposition: "in_flight" });
  expect(await part(f)).toMatchObject({ state: "in_flight", attempts: 1 });
});

it("stops an entire upload after R2 accepted bytes but its part response was lost", async () => {
  const f = await fixture();
  let calls = 0;
  const app = {
    ...f.app,
    BLOBS: new Proxy(env.BLOBS, {
      get(target, key) {
        if (key === "resumeMultipartUpload")
          return (...args: Parameters<R2Bucket["resumeMultipartUpload"]>) => {
            const upload = target.resumeMultipartUpload(...args);
            return {
              uploadPart: async (...parts: Parameters<R2MultipartUpload["uploadPart"]>) => {
                calls++;
                await upload.uploadPart(...parts);
                throw new Error("lost_part_response");
              },
            };
          };
        const value = Reflect.get(target, key);
        return typeof value === "function" ? value.bind(target) : value;
      },
    }),
  };
  await expect(write(f, app)).rejects.toThrow(/lost_part_response/);
  await expect(write(f, app, "retry")).rejects.toThrow(/not_accepting/);
  expect(calls).toBe(1);
  expect(await uploadRow(env.DB, f.created.id)).toMatchObject({
    state: "aborting",
    accept_parts: 0,
    cleanup_pending: 1,
    data_calls: 1,
  });
  expect(await part(f)).toMatchObject({ state: "unknown" });
});

it("allows a new bounded attempt only when R2 was definitely never invoked", async () => {
  const f = await fixture();
  const app = {
    ...f.app,
    BLOBS: new Proxy(env.BLOBS, {
      get(target, key) {
        if (key === "resumeMultipartUpload")
          return () => {
            throw new Error("before_r2");
          };
        const value = Reflect.get(target, key);
        return typeof value === "function" ? value.bind(target) : value;
      },
    }),
  };
  await expect(write(f, app)).rejects.toThrow(/before_r2/);
  expect(await part(f)).toMatchObject({ state: "pending", attempts: 1 });
  expect(await write(f, f.app, "second")).toMatchObject({ disposition: "completed" });
  expect(await part(f)).toMatchObject({ state: "completed", attempts: 2 });
  expect(await uploadRow(env.DB, f.created.id)).toMatchObject({ data_calls: 2, data_bytes: 6 });
});

it("rejects current credential revocation, forged capabilities, and a wrong DO namespace before charging", async () => {
  const f = await fixture();
  await expect(
    f.stub.claimPart({
      ...f.request,
      capability: "forged",
      partNumber: 1,
      attemptId: "a",
      bytes: 3,
    }),
  ).rejects.toThrow(/capability/);
  const wrong = f.app.UPLOADS.get(f.app.UPLOADS.idFromName("wrong"));
  await expect(wrong.status(f.request)).rejects.toThrow(/namespace/);
  await env.DB.prepare("UPDATE sessions SET revoked_at=? WHERE id=?")
    .bind(Date.now(), f.ids.session)
    .run();
  await expect(write(f)).rejects.toThrow();
  expect(await uploadRow(env.DB, f.created.id)).toMatchObject({ data_calls: 0 });
});

it("checks revocation in the same D1 batch that grants a part claim", async () => {
  const f = await fixture();
  const db = injectBatch(
    (sql) => sql.includes("INSERT INTO upload_parts"),
    async () => {
      await env.DB.prepare("UPDATE sessions SET revoked_at=? WHERE id=?")
        .bind(Date.now(), f.ids.session)
        .run();
    },
    false,
  );
  await expect(write(f, admitted(db))).rejects.toThrow();
  expect(await part(f)).toBeNull();
  expect(await uploadRow(env.DB, f.created.id)).toMatchObject({ data_calls: 0 });
});

it("mirrors an expired part alarm after credential revocation, without refunding its reservation", async () => {
  const f = await fixture();
  await f.stub.claimPart({ ...f.request, partNumber: 1, attemptId: "slow", bytes: 3 });
  await env.DB.prepare("UPDATE sessions SET revoked_at=? WHERE id=?")
    .bind(Date.now(), f.ids.session)
    .run();
  await runInDurableObject(f.actual, async (_, state) => {
    state.storage.sql.exec(
      "UPDATE multipart_attempts SET lease_expires_at=? WHERE attempt_id='slow'",
      Date.now() - 1,
    );
    await new UploadDO(state, f.app).alarm();
    expect(await state.storage.getAlarm()).toBeNull();
  });
  expect(await uploadRow(env.DB, f.created.id)).toMatchObject({
    state: "aborting",
    cleanup_pending: 1,
    in_flight: 0,
  });
  expect(await part(f)).toMatchObject({ state: "unknown" });
  expect(
    await env.DB.prepare("SELECT reserved_bytes FROM users WHERE id=?")
      .bind(f.ids.user)
      .first("reserved_bytes"),
  ).toBe(3);
});

it("excludes complete and abort, checks missing parts, and mirrors the winning transition", async () => {
  const f = await fixture();
  await expect(f.stub.beginComplete(f.request)).rejects.toThrow(/parts_incomplete/);
  await write(f);
  await f.stub.beginComplete(f.request);
  await f.stub.beginComplete(f.request);
  await expect(f.stub.requestAbort(f.request)).rejects.toThrow(/complete_in_progress/);
  expect(await uploadRow(env.DB, f.created.id)).toMatchObject({
    state: "completing",
    accept_parts: 0,
    control_calls: 2,
  });
  const aborted = await fixture();
  await aborted.stub.requestAbort(aborted.request);
  await expect(aborted.stub.beginComplete(aborted.request)).rejects.toThrow(/not_completable/);
  expect(await uploadRow(env.DB, aborted.created.id)).toMatchObject({
    state: "aborting",
    cleanup_pending: 1,
  });
});

it("validates fixed sizes, pagination, zero-byte mode, and immutable D1 geometry", async () => {
  const f = await fixture();
  await expect(
    f.stub.claimPart({ ...f.request, partNumber: 1, attemptId: "bad", bytes: 2 }),
  ).rejects.toThrow(/size_mismatch/);
  await expect(f.stub.completedParts({ ...f.request, after: 0, limit: 201 })).rejects.toThrow(
    /invalid_part_page/,
  );
  await expect(
    reserveMultipartUpload(
      admitted(),
      { ...f.input, requestId: "zero", declaredSize: 0 },
      f.capabilities,
    ),
  ).rejects.toThrow(/invalid_multipart_plan/);
  await expect(
    env.DB.prepare("UPDATE uploads SET part_bytes=8388608 WHERE id=?").bind(f.created.id).run(),
  ).rejects.toThrow(/immutable_multipart/);
  await expect(
    env.DB.prepare("UPDATE uploads SET r2_upload_id='other' WHERE id=?").bind(f.created.id).run(),
  ).rejects.toThrow(/immutable_multipart/);
  expect(await uploadRow(env.DB, f.created.id)).toMatchObject({ data_calls: 0 });
});

it("preserves successful part settlement after its D1 response is lost", async () => {
  const f = await fixture();
  let mirrors = 0;
  const db = injectBatch(
    (sql) => sql.includes("INSERT INTO upload_parts") && ++mirrors === 2,
    async () => {
      throw new Error("lost_settle_ack");
    },
    true,
  );
  await expect(write(f, admitted(db))).rejects.toThrow(/lost_settle_ack/);
  expect(await write(f)).toMatchObject({ disposition: "completed" });
  expect(await part(f)).toMatchObject({ state: "completed", attempts: 1, sha256: SHA });
  expect(await uploadRow(env.DB, f.created.id)).toMatchObject({
    state: "uploading",
    cleanup_pending: 0,
    data_calls: 1,
  });
});

it("never calls R2 after losing the initialization claim acknowledgement", async () => {
  const f = await fixture(3, false);
  const db = injectBatch(
    (sql) => sql.includes("SET write_attempt_id="),
    async () => {
      throw new Error("lost_init_claim");
    },
    true,
  );
  let calls = 0;
  const app = admitted(db);
  app.BLOBS = new Proxy(env.BLOBS, {
    get(target, key) {
      if (key === "createMultipartUpload")
        return () => {
          calls++;
          throw new Error("unexpected_r2");
        };
      const value = Reflect.get(target, key);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  await expect(createMultipartUpload(app, f.input, f.capabilities)).rejects.toThrow(
    /lost_init_claim/,
  );
  await expect(createMultipartUpload(app, f.input, f.capabilities)).rejects.toThrow(
    /upload_init_unknown/,
  );
  expect(calls).toBe(0);
  expect(await uploadRow(env.DB, f.created.id)).toMatchObject({
    state: "failed",
    cleanup_pending: 1,
    r2_upload_id: null,
  });
});

it("fails the part grant atomically if its reservation is released before the mirror batch", async () => {
  const f = await fixture();
  const db = injectBatch(
    (sql) => sql.includes("INSERT INTO upload_parts"),
    async () => {
      await env.DB.prepare("UPDATE reservations SET state='released' WHERE id=?")
        .bind(`${f.created.id}_reservation`)
        .run();
    },
    false,
  );
  await expect(write(f, admitted(db))).rejects.toThrow(/CHECK/);
  expect(await part(f)).toBeNull();
  expect(await uploadRow(env.DB, f.created.id)).toMatchObject({ data_calls: 0 });
});

it("keeps both authoritative maintenance and current D1 maintenance gates closed", async () => {
  const f = await fixture();
  await expect(write(f, admitted(env.DB, 1, true))).rejects.toThrow(/admission_closed/);
  await env.DB.prepare("UPDATE control SET maintenance=1").run();
  await expect(write(f)).rejects.toThrow();
  expect(await uploadRow(env.DB, f.created.id)).toMatchObject({ data_calls: 0 });
});

it("mirrors an authoritative epoch change into old upload cleanup while maintenance is closed", async () => {
  const f = await fixture();
  await f.stub.claimPart({ ...f.request, partNumber: 1, attemptId: "old", bytes: 3 });
  await env.DB.prepare("UPDATE control SET epoch=2,maintenance=1").run();
  const app = admitted(env.DB, 2, true);
  await expect(write(f, app)).rejects.toThrow(/admission_closed/);
  await runInDurableObject(f.actual, async (_, state) => {
    await new UploadDO(state, app).alarm();
  });
  expect(await uploadRow(env.DB, f.created.id)).toMatchObject({
    state: "failed",
    cleanup_pending: 1,
    error_code: "stale_epoch",
  });
  expect(await part(f)).toMatchObject({ state: "unknown" });
});

it("stores fixed 64 MiB geometry and the short final part in R2 without buffering the whole file", async () => {
  const bytes = UPLOAD_LIMITS.defaultPartBytes;
  const f = await fixture(bytes + 3);
  let remaining = bytes;
  const source = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (remaining === 0) {
        controller.close();
        return;
      }
      const chunk = new Uint8Array(Math.min(65536, remaining));
      remaining -= chunk.byteLength;
      controller.enqueue(chunk);
    },
  });
  await writeMultipartPart(
    f.app,
    f.principal,
    f.created.id,
    f.created.capability,
    f.capabilities,
    1,
    "large",
    source,
    bytes,
  );
  await expect(f.stub.beginComplete(f.request)).rejects.toThrow(/parts_incomplete/);
  await writeMultipartPart(
    f.app,
    f.principal,
    f.created.id,
    f.created.capability,
    f.capabilities,
    2,
    "tail",
    stream(),
    3,
  );
  const first = await f.stub.completedParts({ ...f.request, after: 0, limit: 1 });
  const second = await f.stub.completedParts({ ...f.request, after: 1, limit: 1 });
  expect(first[0]).toMatchObject({ partNumber: 1, bytes });
  expect(second[0]).toMatchObject({ partNumber: 2, bytes: 3, sha256: SHA });
  await f.stub.beginComplete(f.request);
  const row = (await uploadRow(env.DB, f.created.id))!;
  const key = `u/${row.owner_id}/b/${row.blob_id}`;
  expect(
    await completeMultipartUpload(
      f.app,
      f.principal,
      f.created.id,
      f.created.capability,
      f.capabilities,
      "complete-large",
      [],
    ),
  ).toMatchObject({ kind: "terminal", operation: { state: "committed" } });
  expect((await env.BLOBS.head(key))?.size).toBe(bytes + 3);
  expect(await (await env.BLOBS.get(key, { range: { offset: bytes, length: 3 } }))!.text()).toBe(
    "abc",
  );
});

it("serializes concurrent metadata claims and enforces four in-flight parts in the D1 mirror", async () => {
  const bytes = UPLOAD_LIMITS.defaultPartBytes;
  const f = await fixture(bytes * 5);
  const results = await Promise.all(
    [1, 2, 3, 4].map((partNumber) =>
      f.stub.claimPart({ ...f.request, partNumber, attemptId: `p${partNumber}`, bytes }),
    ),
  );
  expect(results.every((result) => result.disposition === "dispatch")).toBe(true);
  await expect(
    f.stub.claimPart({ ...f.request, partNumber: 5, attemptId: "p5", bytes }),
  ).rejects.toThrow(/parallel_limit/);
  expect(await uploadRow(env.DB, f.created.id)).toMatchObject({
    data_calls: 4,
    data_bytes: bytes * 4,
    in_flight: 4,
  });
  await f.stub.settlePart({ ...f.request, attemptId: "p1", outcome: { kind: "not_started" } });
  expect(
    (await f.stub.claimPart({ ...f.request, partNumber: 5, attemptId: "p5", bytes })).disposition,
  ).toBe("dispatch");
  expect(await uploadRow(env.DB, f.created.id)).toMatchObject({ data_calls: 5, in_flight: 4 });
});

it("grants exactly one transition when complete and abort race", async () => {
  const f = await fixture();
  await write(f);
  const results = await Promise.allSettled([
    f.stub.beginComplete(f.request),
    f.stub.requestAbort(f.request),
  ]);
  expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
  const row = (await uploadRow(env.DB, f.created.id))!;
  expect(["completing", "aborting"]).toContain(row.state);
  expect(row.accept_parts).toBe(0);
});

it("creates only one R2 upload ID when identical creation requests race", async () => {
  const f = await fixture(3, false);
  let calls = 0;
  const app = {
    ...f.app,
    BLOBS: new Proxy(env.BLOBS, {
      get(target, key) {
        if (key === "createMultipartUpload")
          return (...args: Parameters<R2Bucket["createMultipartUpload"]>) => {
            calls++;
            return target.createMultipartUpload(...args);
          };
        const value = Reflect.get(target, key);
        return typeof value === "function" ? value.bind(target) : value;
      },
    }),
  };
  const results = await Promise.allSettled([
    createMultipartUpload(app, f.input, f.capabilities),
    createMultipartUpload(app, f.input, f.capabilities),
  ]);
  expect(results.some((result) => result.status === "fulfilled")).toBe(true);
  expect(calls).toBe(1);
  expect(await uploadRow(env.DB, f.created.id)).toMatchObject({
    state: "created",
    cleanup_pending: 0,
    control_calls: 1,
  });
  expect(
    await env.DB.prepare("SELECT reserved_bytes FROM users WHERE id=?")
      .bind(f.ids.user)
      .first("reserved_bytes"),
  ).toBe(3);
});

it("keeps a durable retry alarm when mirroring a stopped upload fails", async () => {
  const f = await fixture();
  await f.stub.claimPart({ ...f.request, partNumber: 1, attemptId: "active", bytes: 3 });
  const db = injectBatch(
    (sql) => sql.includes("INSERT INTO upload_parts"),
    async () => {
      throw new Error("stop_mirror_unavailable");
    },
    false,
  );
  const app = admitted(db);
  await expect(
    app.UPLOADS.get(app.UPLOADS.idFromName(f.created.id)).requestAbort(f.request),
  ).rejects.toThrow(/stop_mirror_unavailable/);
  expect(await uploadRow(env.DB, f.created.id)).toMatchObject({
    state: "uploading",
    cleanup_pending: 0,
  });
  await runInDurableObject(f.actual, async (_, state) => {
    expect(await state.storage.getAlarm()).toBeGreaterThan(Date.now());
    await new UploadDO(state, f.app).alarm();
    expect(await state.storage.getAlarm()).toBeNull();
  });
  expect(await uploadRow(env.DB, f.created.id)).toMatchObject({
    state: "aborting",
    cleanup_pending: 1,
  });
  expect(await part(f)).toMatchObject({ state: "unknown" });
});

it("arms cleanup after epoch invalidation even if completing had already removed the part alarm", async () => {
  const f = await fixture();
  await write(f);
  await f.stub.beginComplete(f.request);
  await runInDurableObject(f.actual, async (_, state) => {
    expect(await state.storage.getAlarm()).toBeNull();
  });
  const app = admitted(env.DB, 2, true);
  await expect(
    app.UPLOADS.get(app.UPLOADS.idFromName(f.created.id)).status(f.request),
  ).rejects.toThrow(/admission_closed/);
  await runInDurableObject(f.actual, async (_, state) => {
    expect(await state.storage.getAlarm()).toBeGreaterThan(Date.now());
    await new UploadDO(state, app).alarm();
  });
  expect(await uploadRow(env.DB, f.created.id)).toMatchObject({
    state: "failed",
    cleanup_pending: 1,
    error_code: "stale_epoch",
  });
});
