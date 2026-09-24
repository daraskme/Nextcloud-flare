import { applyD1Migrations, evictDurableObject, runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { base64url } from "jose";
import { beforeAll, beforeEach, expect, it } from "vitest";
import type { Principal } from "../../src/auth/authorize";
import { contentKeyRing } from "../../src/auth/contentTokens";
import { UploadCapabilities } from "../../src/auth/uploadCapability";
import { atomicBatch } from "../../src/db/primary";
import { UploadDO } from "../../src/do/UploadDO";
import { consumeOutbox } from "../../src/jobs/consumeOutbox";
import { uploadRow } from "../../src/services/uploads/access";
import { publishMultipartUpload } from "../../src/services/uploads/complete";
import { createMultipartUpload, writeMultipartPart } from "../../src/services/uploads/multipart";
import { completeMultipartUpload } from "../../src/services/uploads/multipartComplete";
import { foundationFixture } from "../fixtures/foundation";
import { mutationEnv } from "../fixtures/mutationAdmission";
import { admitted, injectBatch } from "../fixtures/uploadEnv";

beforeAll(async () => applyD1Migrations(env.DB, env.TEST_MIGRATIONS));
beforeEach(async () => {
  await env.DB.prepare("UPDATE control SET epoch=1,maintenance=0").run();
});

async function fixture(send = true) {
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
  const input = {
    principal,
    requestId: crypto.randomUUID(),
    spaceId: f.ids.space,
    parentId: f.ids.folder,
    name: "completed.bin",
    declaredSize: 3,
  };
  const app = admitted();
  const created = await createMultipartUpload(app, input, capabilities);
  const request = { principal, uploadId: created.id, capability: created.capability };
  const stub = app.UPLOADS.get(app.UPLOADS.idFromName(created.id));
  const actual = env.UPLOADS.get(env.UPLOADS.idFromName(created.id));
  const result = { ...f, principal, input, app, created, capabilities, request, stub, actual };
  if (send) await write(result);
  return result;
}
async function write(f: Awaited<ReturnType<typeof fixture>>, value = "abc") {
  return writeMultipartPart(
    f.app,
    f.principal,
    f.created.id,
    f.created.capability,
    f.capabilities,
    1,
    "part",
    new Blob([value]).stream(),
    value.length,
  );
}
async function complete(f: Awaited<ReturnType<typeof fixture>>, app = f.app, key = "complete") {
  return completeMultipartUpload(
    app,
    f.principal,
    f.created.id,
    f.created.capability,
    f.capabilities,
    key,
    [],
  );
}
async function counters(f: Awaited<ReturnType<typeof fixture>>) {
  return env.DB.prepare("SELECT used_bytes,reserved_bytes,physical_bytes FROM users WHERE id=?")
    .bind(f.ids.user)
    .first();
}
function bucketComplete(
  effect: (upload: R2MultipartUpload, parts: R2UploadedPart[]) => Promise<R2Object>,
): R2Bucket {
  return new Proxy(env.BLOBS, {
    get(target, key) {
      if (key === "resumeMultipartUpload")
        return (...args: Parameters<R2Bucket["resumeMultipartUpload"]>) => {
          const upload = target.resumeMultipartUpload(...args);
          return new Proxy(upload, {
            get(part, method) {
              if (method === "complete") return (parts: R2UploadedPart[]) => effect(part, parts);
              const value = Reflect.get(part, method);
              return typeof value === "function" ? value.bind(part) : value;
            },
          });
        };
      const value = Reflect.get(target, key);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}
function bucketHead(effect: (key: string) => Promise<R2Object | null>): R2Bucket {
  return new Proxy(env.BLOBS, {
    get(target, key) {
      if (key === "head") return effect;
      const value = Reflect.get(target, key);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

it("completes R2, atomically publishes a file, and reconciles the DO without a whole-object hash", async () => {
  const f = await fixture();
  const result = await complete(f);
  expect(result).toMatchObject({
    kind: "terminal",
    operation: { state: "committed", result: { status: 201 } },
  });
  expect(await counters(f)).toMatchObject({ used_bytes: 6, reserved_bytes: 0, physical_bytes: 3 });
  const row = (await uploadRow(env.DB, f.created.id))!;
  expect(row).toMatchObject({ state: "completed", in_flight: 0, cleanup_pending: 0 });
  expect(row.multipart_object_etag).toBeTruthy();
  expect(
    await env.DB.prepare("SELECT state,ref_count,sha256_verified FROM blobs WHERE id=?")
      .bind(row.blob_id)
      .first(),
  ).toEqual({ state: "committed", ref_count: 1, sha256_verified: null });
  expect(await (await env.BLOBS.get(`u/${row.owner_id}/b/${row.blob_id}`))!.text()).toBe("abc");
  expect(await f.stub.status(f.request)).toMatchObject({
    state: "completed",
    completedParts: 1,
    cleanupPending: false,
  });
  await evictDurableObject(f.actual);
  expect(await complete(f)).toEqual(result);
  await expect(write(f)).rejects.toThrow(/already_completed/);
  if (result.kind !== "terminal") throw new Error("missing_terminal");
  await env.DB.prepare(
    "UPDATE outbox SET state='dispatching',dispatch_token='test',dispatch_expires_at=? WHERE op_id=?",
  )
    .bind(Date.now() + 60000, result.operation.id)
    .run();
  expect(await consumeOutbox(mutationEnv(), `${result.operation.id}_event`)).toBe("completed");
});

it("recovers an R2 complete acknowledgement loss with HEAD and never completes twice", async () => {
  const f = await fixture();
  let calls = 0;
  const app = {
    ...f.app,
    BLOBS: bucketComplete(async (upload, parts) => {
      calls++;
      await upload.complete(parts);
      throw new Error("lost_r2_complete");
    }),
  };
  const result = await complete(f, app);
  expect(result).toMatchObject({ kind: "terminal", operation: { state: "committed" } });
  expect(await complete(f, app)).toEqual(result);
  expect(calls).toBe(1);
  expect(await counters(f)).toMatchObject({ used_bytes: 6, reserved_bytes: 0, physical_bytes: 3 });
});

it("never dispatches complete after losing its D1 claim acknowledgement", async () => {
  const f = await fixture();
  const db = injectBatch(
    (sql) => sql.includes("SET multipart_complete_attempt="),
    async () => {
      throw new Error("lost_complete_claim");
    },
    true,
  );
  let calls = 0;
  const app = {
    ...admitted(db),
    BLOBS: bucketComplete(async () => {
      calls++;
      throw new Error("unexpected_r2");
    }),
  };
  await expect(complete(f, app)).rejects.toThrow(/complete_pending/);
  await expect(complete(f, app)).rejects.toThrow(/complete_pending/);
  expect(calls).toBe(0);
  expect(await counters(f)).toMatchObject({ used_bytes: 3, reserved_bytes: 3, physical_bytes: 0 });
  expect(await uploadRow(env.DB, f.created.id)).toMatchObject({
    state: "completing",
    multipart_object_etag: null,
  });
  await expect(f.stub.requestAbort(f.request)).rejects.toThrow(/complete_in_progress/);
});

it("retains the reservation when a dispatched complete has an unknown outcome and no object yet", async () => {
  const f = await fixture();
  let calls = 0;
  const app = {
    ...f.app,
    BLOBS: bucketComplete(async () => {
      calls++;
      throw new Error("unknown_complete");
    }),
  };
  await expect(complete(f, app)).rejects.toThrow(/complete_pending/);
  await expect(complete(f, app)).rejects.toThrow(/complete_pending/);
  expect(calls).toBe(1);
  expect(await counters(f)).toMatchObject({ reserved_bytes: 3, physical_bytes: 0 });
  expect(
    await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM operations WHERE kind='upload.complete' AND credential_id=?",
    )
      .bind(f.ids.credential)
      .first("n"),
  ).toBe(0);
});

it("recovers a transient HEAD failure without dispatching another complete", async () => {
  const f = await fixture();
  const app = {
    ...f.app,
    BLOBS: bucketHead(async () => {
      throw new Error("head_unavailable");
    }),
  };
  await expect(complete(f, app)).rejects.toThrow(/head_unavailable/);
  expect(await counters(f)).toMatchObject({ reserved_bytes: 3 });
  const noComplete = {
    ...f.app,
    BLOBS: bucketComplete(async () => {
      throw new Error("unexpected_complete");
    }),
  };
  expect(await complete(f, noComplete)).toMatchObject({
    kind: "terminal",
    operation: { state: "committed" },
  });
  expect(await counters(f)).toMatchObject({ used_bytes: 6, reserved_bytes: 0, physical_bytes: 3 });
});

it("reconciles a lost object-proof response after charging physical bytes once", async () => {
  const f = await fixture();
  const db = injectBatch(
    (sql) => sql.includes("SET multipart_object_etag="),
    async () => {
      throw new Error("lost_object_proof");
    },
    true,
  );
  expect(await complete(f, admitted(db))).toMatchObject({
    kind: "terminal",
    operation: { state: "committed" },
  });
  expect(await counters(f)).toMatchObject({ physical_bytes: 3, reserved_bytes: 0 });
});

it("reconciles a lost final namespace response without compensating a committed upload", async () => {
  const f = await fixture();
  const db = injectBatch(
    (sql) => sql.includes("UPDATE operations SET state='committed'"),
    async () => {
      throw new Error("lost_namespace_commit");
    },
    true,
  );
  const result = await complete(f, admitted(db));
  expect(result).toMatchObject({ kind: "terminal", operation: { state: "committed" } });
  expect(await complete(f)).toEqual(result);
  expect(await counters(f)).toMatchObject({ used_bytes: 6, physical_bytes: 3, reserved_bytes: 0 });
});

it("rejects missing parts and direct publication before R2 object proof", async () => {
  const f = await fixture(false);
  await expect(complete(f)).rejects.toThrow(/parts_incomplete/);
  await write(f);
  await f.stub.beginComplete(f.request);
  await expect(
    publishMultipartUpload(
      f.app,
      f.principal,
      f.created.id,
      f.created.capability,
      f.capabilities,
      "bypass",
      [],
    ),
  ).rejects.toThrow(/CHECK/);
  expect(await counters(f)).toMatchObject({ reserved_bytes: 3, physical_bytes: 0 });
});

it("preserves earlier content as a version during multipart overwrite", async () => {
  const f = await fixture();
  const first = await complete(f);
  if (first.kind !== "terminal" || !first.operation.result?.nodeId) throw new Error("missing_node");
  const created = await createMultipartUpload(
    f.app,
    {
      ...f.input,
      requestId: "overwrite",
      targetId: first.operation.result.nodeId,
      targetRevision: 1,
      declaredSize: 5,
    },
    f.capabilities,
  );
  const next = { ...f, created };
  await write(next, "12345");
  const result = await complete(next, f.app, "overwrite-complete");
  expect(result).toMatchObject({
    kind: "terminal",
    operation: { state: "committed", result: { status: 204, revision: 2 } },
  });
  expect(await complete(next, f.app, "overwrite-complete")).toEqual(result);
  expect(
    await env.DB.prepare("SELECT blob_id FROM node_versions WHERE node_id=?")
      .bind(first.operation.result.nodeId)
      .first("blob_id"),
  ).toBe(`${f.created.id}_blob`);
  expect(await counters(f)).toMatchObject({ used_bytes: 11, reserved_bytes: 0, physical_bytes: 8 });
});

it("retains physical charges after a filename conflict and releases only a proved reservation", async () => {
  const f = await fixture();
  await env.DB.prepare(
    `INSERT INTO nodes(id,space_id,owner_id,parent_id,name,name_ci,kind,created_at,updated_at) VALUES(?,?,?,?,'completed.bin','completed.bin','folder',1,1)`,
  )
    .bind(crypto.randomUUID(), f.ids.space, f.ids.user, f.ids.folder)
    .run();
  expect(await complete(f)).toMatchObject({
    kind: "terminal",
    operation: { state: "failed", errorCode: "name_conflict" },
  });
  expect(await uploadRow(env.DB, f.created.id)).toMatchObject({
    state: "failed",
    cleanup_pending: 1,
  });
  expect(await counters(f)).toMatchObject({ used_bytes: 3, reserved_bytes: 0, physical_bytes: 3 });
});

it("rechecks current authority in the final batch and never publishes partial metadata", async () => {
  const f = await fixture();
  const db = injectBatch(
    (sql) => sql.includes("UPDATE operations SET state='committed'"),
    async () => {
      await env.DB.prepare("UPDATE sessions SET revoked_at=? WHERE id=?")
        .bind(Date.now(), f.ids.session)
        .run();
    },
    false,
  );
  expect(await complete(f, admitted(db))).toMatchObject({ kind: "commit_unknown" });
  expect(await counters(f)).toMatchObject({ used_bytes: 3, reserved_bytes: 3, physical_bytes: 3 });
  expect(
    await env.DB.prepare("SELECT COUNT(*) AS n FROM nodes WHERE current_blob_id=?")
      .bind(`${f.created.id}_blob`)
      .first("n"),
  ).toBe(0);
});

it("charges a wrong-size completed object but never publishes it or releases its reservation", async () => {
  const f = await fixture();
  const app = {
    ...f.app,
    BLOBS: bucketHead(async (key) => {
      const object = await env.BLOBS.head(key);
      return object
        ? { ...object, size: 4, writeHttpMetadata: object.writeHttpMetadata.bind(object) }
        : null;
    }),
  };
  await expect(complete(f, app)).rejects.toThrow(/object_mismatch/);
  expect(await counters(f)).toMatchObject({ used_bytes: 3, reserved_bytes: 3, physical_bytes: 4 });
  expect((await uploadRow(env.DB, f.created.id))?.multipart_object_etag).toBeNull();
});

it("rejects changed R2 identity metadata even when the content size matches", async () => {
  const f = await fixture();
  const app = {
    ...f.app,
    BLOBS: bucketHead(async (key) => {
      const object = await env.BLOBS.head(key);
      return object
        ? {
            ...object,
            customMetadata: { ...object.customMetadata, epoch: "2" },
            writeHttpMetadata: object.writeHttpMetadata.bind(object),
          }
        : null;
    }),
  };
  await expect(complete(f, app)).rejects.toThrow(/object_mismatch/);
  expect(await counters(f)).toMatchObject({ used_bytes: 3, reserved_bytes: 3, physical_bytes: 3 });
  expect((await uploadRow(env.DB, f.created.id))?.multipart_object_etag).toBeNull();
});

it("recovers completion acknowledgement after total DO storage loss without recreating a journal", async () => {
  const f = await fixture();
  await complete(f);
  await runInDurableObject(f.actual, async (_, state) => {
    await state.storage.deleteAll();
  });
  await evictDurableObject(f.actual);
  expect(await f.stub.status(f.request)).toMatchObject({ state: "completed", completedParts: 1 });
  await expect(write(f)).rejects.toThrow(/already_completed/);
  expect(await uploadRow(env.DB, f.created.id)).toMatchObject({
    state: "completed",
    cleanup_pending: 0,
  });
  await runInDurableObject(f.actual, (_, state) => {
    expect(state.storage.sql.exec("SELECT COUNT(*) AS n FROM multipart_state").one().n).toBe(0);
  });
});

it("does not schedule a committed blob for cleanup when the authoritative epoch advances", async () => {
  const f = await fixture();
  await complete(f);
  await env.DB.prepare("UPDATE control SET epoch=2,maintenance=1").run();
  const app = admitted(env.DB, 2, true);
  await runInDurableObject(f.actual, async (_, state) => {
    await new UploadDO(state, app).alarm();
    expect(await state.storage.getAlarm()).toBeNull();
  });
  expect(await uploadRow(env.DB, f.created.id)).toMatchObject({
    state: "completed",
    cleanup_pending: 0,
  });
});

it("freezes the completed part metadata and immutable completion attempt", async () => {
  const f = await fixture();
  await expect(
    env.DB.prepare("UPDATE upload_parts SET etag='changed' WHERE upload_id=?")
      .bind(f.created.id)
      .run(),
  ).rejects.toThrow(/immutable_completed_part/);
  await complete(f);
  await expect(
    env.DB.prepare("UPDATE uploads SET multipart_complete_attempt='another' WHERE id=?")
      .bind(f.created.id)
      .run(),
  ).rejects.toThrow(/immutable_multipart_completion/);
  await expect(
    env.DB.prepare("UPDATE uploads SET multipart_object_etag='changed' WHERE id=?")
      .bind(f.created.id)
      .run(),
  ).rejects.toThrow(/immutable_multipart_completion/);
});

it("recovers a lost physical observation acknowledgement and publishes without charging twice", async () => {
  const f = await fixture();
  const db = injectBatch(
    (sql) => sql.includes("INSERT INTO blob_storage"),
    async () => {
      throw new Error("lost_physical_observation");
    },
    true,
  );
  expect(await complete(f, admitted(db))).toMatchObject({
    kind: "terminal",
    operation: { state: "committed" },
  });
  expect(await counters(f)).toMatchObject({ physical_bytes: 3, reserved_bytes: 0 });
  expect(await complete(f)).toMatchObject({ kind: "terminal", operation: { state: "committed" } });
  expect(await counters(f)).toMatchObject({ physical_bytes: 3, reserved_bytes: 0 });
});

it("dispatches only one R2 completion when two identical requests run concurrently", async () => {
  const f = await fixture();
  let calls = 0;
  const app = {
    ...f.app,
    BLOBS: bucketComplete(async (upload, parts) => {
      calls++;
      return upload.complete(parts);
    }),
  };
  const results = await Promise.allSettled([complete(f, app), complete(f, app)]);
  expect(calls).toBe(1);
  expect(
    results.some(
      (result) =>
        result.status === "fulfilled" &&
        result.value.kind === "terminal" &&
        result.value.operation.state === "committed",
    ),
  ).toBe(true);
  expect(await complete(f, app)).toMatchObject({
    kind: "terminal",
    operation: { state: "committed" },
  });
  expect(await counters(f)).toMatchObject({ used_bytes: 6, reserved_bytes: 0, physical_bytes: 3 });
});

it("excludes abort while R2 complete is in flight and accounts a late successful result", async () => {
  const f = await fixture();
  let release!: () => void;
  let reached!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const started = new Promise<void>((resolve) => {
    reached = resolve;
  });
  const app = {
    ...f.app,
    BLOBS: bucketComplete(async (upload, parts) => {
      reached();
      await gate;
      return upload.complete(parts);
    }),
  };
  const pending = complete(f, app);
  try {
    await started;
    await expect(f.stub.requestAbort(f.request)).rejects.toThrow(/complete_in_progress/);
  } finally {
    release();
  }
  expect(await pending).toMatchObject({ kind: "terminal", operation: { state: "committed" } });
  expect(await counters(f)).toMatchObject({ physical_bytes: 3, reserved_bytes: 0 });
});

it("observes physical bytes after revocation during R2 complete but prevents publication", async () => {
  const f = await fixture();
  const app = {
    ...f.app,
    BLOBS: bucketComplete(async (upload, parts) => {
      const object = await upload.complete(parts);
      await env.DB.prepare("UPDATE sessions SET revoked_at=? WHERE id=?")
        .bind(Date.now(), f.ids.session)
        .run();
      return object;
    }),
  };
  await expect(complete(f, app)).rejects.toThrow();
  expect(await counters(f)).toMatchObject({ used_bytes: 3, reserved_bytes: 3, physical_bytes: 3 });
  expect((await uploadRow(env.DB, f.created.id))?.state).toBe("completing");
  expect(
    await env.DB.prepare("SELECT COUNT(*) AS n FROM nodes WHERE current_blob_id=?")
      .bind(`${f.created.id}_blob`)
      .first("n"),
  ).toBe(0);
});

it("retries a lost terminal DO acknowledgement and protects it from later epoch cleanup", async () => {
  const f = await fixture();
  const uploads = new Proxy(f.app.UPLOADS, {
    get(target, key) {
      if (key === "get")
        return (...args: Parameters<typeof target.get>) =>
          new Proxy(target.get(...args), {
            get(stub, method) {
              if (method === "acknowledgeCompletion")
                return async () => {
                  throw new Error("ack_unavailable");
                };
              const value = Reflect.get(stub, method);
              return typeof value === "function" ? value.bind(stub) : value;
            },
          });
      const value = Reflect.get(target, key);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  expect(await complete(f, { ...f.app, UPLOADS: uploads })).toMatchObject({
    kind: "terminal",
    operation: { state: "committed" },
  });
  await runInDurableObject(f.actual, (_, state) => {
    expect(state.storage.sql.exec("SELECT state FROM multipart_state").one().state).toBe(
      "completing",
    );
  });
  await env.DB.prepare("UPDATE control SET epoch=2,maintenance=1").run();
  await runInDurableObject(f.actual, async (_, state) => {
    await new UploadDO(state, admitted(env.DB, 2, true)).alarm();
    expect(state.storage.sql.exec("SELECT state FROM multipart_state").one().state).toBe(
      "completed",
    );
  });
  expect(await uploadRow(env.DB, f.created.id)).toMatchObject({
    state: "completed",
    cleanup_pending: 0,
  });
});

it("bounds repeated missing-object HEAD reconciliation while retaining the independent cleanup budget", async () => {
  const f = await fixture();
  const app = {
    ...f.app,
    BLOBS: bucketComplete(async () => {
      throw new Error("unknown_complete");
    }),
  };
  await expect(complete(f, app)).rejects.toThrow(/complete_pending/);
  await env.DB.prepare("UPDATE uploads SET control_calls=64 WHERE id=?").bind(f.created.id).run();
  let heads = 0;
  await expect(
    complete(f, {
      ...app,
      BLOBS: bucketHead(async () => {
        heads++;
        return null;
      }),
    }),
  ).rejects.toThrow(/CHECK/);
  expect(heads).toBe(0);
  expect(await uploadRow(env.DB, f.created.id)).toMatchObject({
    control_calls: 64,
    cleanup_calls: 0,
  });
  expect(await counters(f)).toMatchObject({ reserved_bytes: 3 });
});

it("requires the part proof in the final publishing batch, not only before R2 completion", async () => {
  const f = await fixture();
  const db = injectBatch(
    (sql) => sql.includes("UPDATE operations SET state='committed'"),
    async () => {
      await env.DB.prepare("DELETE FROM upload_parts WHERE upload_id=?").bind(f.created.id).run();
    },
    false,
  );
  const outcome = await complete(f, admitted(db));
  expect(outcome).not.toMatchObject({ kind: "terminal", operation: { state: "committed" } });
  expect(
    await env.DB.prepare("SELECT COUNT(*) AS n FROM nodes WHERE current_blob_id=?")
      .bind(`${f.created.id}_blob`)
      .first("n"),
  ).toBe(0);
  expect(await counters(f)).toMatchObject({ used_bytes: 3, physical_bytes: 3 });
});

it.each([1, 2, 3, 4, 5, 6, 7, 8, 9, 10])(
  "rolls back all multipart publication when mandatory step %i fails",
  async (step) => {
    const f = await fixture();
    await env.DB.prepare(`CREATE TRIGGER inject_multipart_step BEFORE INSERT ON operation_steps
    WHEN NEW.step_no=${step} AND NEW.op_id=(SELECT completion_op_id FROM uploads WHERE id='${f.created.id}')
    BEGIN SELECT RAISE(ABORT,'injected_step'); END;`).run();
    try {
      const result = await complete(f);
      expect(result).not.toMatchObject({ kind: "terminal", operation: { state: "committed" } });
      expect(
        await env.DB.prepare("SELECT COUNT(*) AS n FROM nodes WHERE current_blob_id=?")
          .bind(`${f.created.id}_blob`)
          .first("n"),
      ).toBe(0);
      expect(
        await env.DB.prepare(
          "SELECT COUNT(*) AS n FROM operation_steps WHERE op_id=(SELECT completion_op_id FROM uploads WHERE id=?)",
        )
          .bind(f.created.id)
          .first("n"),
      ).toBe(0);
      expect(await counters(f)).toMatchObject({ used_bytes: 3, physical_bytes: 3 });
    } finally {
      await env.DB.exec("DROP TRIGGER inject_multipart_step");
    }
  },
);

it("does not trust a completed upload flag without its matching committed operation", async () => {
  const f = await fixture();
  await env.DB.prepare("UPDATE uploads SET state='completed' WHERE id=?").bind(f.created.id).run();
  await expect(f.stub.status(f.request)).rejects.toThrow(/CHECK/);
  await expect(write(f)).rejects.toThrow(/CHECK/);
  await runInDurableObject(f.actual, (_, state) => {
    expect(state.storage.sql.exec("SELECT state FROM multipart_state").one().state).toBe(
      "uploading",
    );
  });
  await expect(
    env.DB.prepare("UPDATE uploads SET state='uploading' WHERE id=?").bind(f.created.id).run(),
  ).rejects.toThrow(/terminal_multipart/);
});
