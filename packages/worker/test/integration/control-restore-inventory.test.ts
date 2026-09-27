import { applyD1Migrations, evictDurableObject, runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import type { RestoreInventoryRequest } from "../../../shared/src/restoreInventory";
import { atomicBatch } from "../../src/db/primary";
import { insertR2Write, type R2WriteGrant } from "../../src/db/r2Write";
import { ControlDO } from "../../src/do/ControlDO";
import { KdfSettlements } from "../../src/do/kdfSettlements";
import { NativeHistory, nativeIdentity } from "../../src/do/nativeHistory";
import type { Env } from "../../src/env";
import { BINDING_PROBE_KEY } from "../../src/r2/bindingProbe";
import { multipartBucketFixture } from "../fixtures/multipartBucket";
import { multipartInventoryFixture } from "../fixtures/multipartInventory";
import { orphanBucket } from "../fixtures/orphanInventory";
import { restoredDatabaseFixture } from "../fixtures/restoredDatabase";
import { inventoryEnv, partsXml, partXml, uploadsXml, uploadXml } from "../fixtures/s3Inventory";
import { injectBatch } from "../fixtures/uploadEnv";

let restored: Awaited<ReturnType<typeof restoredDatabaseFixture>>;
beforeAll(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
  await env.BACKUPS.put(
    "sys/epoch/1.json",
    JSON.stringify({ epoch: 1, at: 1, reason: "operator" }),
  );
  restored = await restoredDatabaseFixture();
});
beforeEach(async () => {
  await env.DB.prepare(
    "UPDATE r2_binding_probe SET lease_expires_at=1 WHERE lease_token IS NOT NULL",
  ).run();
  await env.DB.prepare("UPDATE uploads SET cleanup_next_at=9999999999999").run();
});
afterEach(() => vi.restoreAllMocks());
async function invoke<T>(
  action: (instance: ControlDO) => Promise<T>,
  overrides: Partial<Env> = {},
) {
  const result = await runInDurableObject(restored.control, async (_, state) => {
    try {
      return {
        ok: true as const,
        value: await action(
          new ControlDO(state, {
            ...env,
            ...inventoryEnv,
            RESTORE_WRITE_ENABLED: "true",
            ...overrides,
          }),
        ),
      };
    } catch (error) {
      return { ok: false as const, error: String(error) };
    }
  });
  if (!result.ok) throw new Error(result.error);
  return result.value;
}
const run = (request: RestoreInventoryRequest, overrides: Partial<Env> = {}) =>
  invoke(
    (instance) => instance.repairDatabaseRestoreInventory(restored.epoch, restored.id, request),
    overrides,
  );
type Remote = { key: string; handle: R2MultipartUpload; bytes?: number[] };
function serve(handles: Remote[] = [], after?: (method: string) => Promise<void>) {
  return vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
    const url = new URL((input as Request).url);
    let response: Response, method: string;
    if (url.pathname.endsWith(BINDING_PROBE_KEY)) {
      method = "probe";
      response = new Response((await env.BLOBS.get(BINDING_PROBE_KEY))!.body);
    } else if (url.searchParams.has("uploads")) {
      method = "uploads";
      const prefix = url.searchParams.get("prefix")!,
        limit = Number(url.searchParams.get("max-uploads")),
        marker = url.searchParams.get("key-marker") ?? "",
        idMarker = url.searchParams.get("upload-id-marker") ?? "";
      const matching = handles
        .filter(
          (h) =>
            h.key.startsWith(prefix) &&
            (h.key > marker || (h.key === marker && h.handle.uploadId > idMarker)),
        )
        .sort((a, b) => a.key.localeCompare(b.key));
      const page = matching.slice(0, limit),
        truncated = matching.length > limit,
        last = page.at(-1);
      response = new Response(
        uploadsXml({
          prefix,
          limit,
          uploads: page.map((h) => uploadXml(h.key, h.handle.uploadId)).join(""),
          keyMarker: marker,
          idMarker,
          truncated,
          nextKey: truncated ? last!.key : "",
          nextId: truncated ? last!.handle.uploadId : "",
        }),
      );
    } else {
      method = "parts";
      const remote = handles.find((h) => h.handle.uploadId === url.searchParams.get("uploadId"))!;
      const marker = Number(url.searchParams.get("part-number-marker")),
        limit = Number(url.searchParams.get("max-parts"));
      const all = (remote.bytes ?? [3])
          .map((bytes, i) => ({ bytes, number: i + 1 }))
          .filter((p) => p.number > marker),
        page = all.slice(0, limit),
        truncated = all.length > limit;
      response = new Response(
        partsXml({
          key: remote.key,
          uploadId: remote.handle.uploadId,
          marker,
          limit,
          parts: page.map((p) => partXml(p.number, p.bytes)).join(""),
          truncated,
          next: truncated ? page.at(-1)!.number : 0,
        }),
      );
    }
    await after?.(method);
    return response;
  });
}
const balance = (id: string) =>
  env.DB.prepare("SELECT physical_bytes,reserved_bytes FROM users WHERE id=?").bind(id).first();
const discover = async (f: Remote) => {
  serve([f]);
  const result = (await run({ action: "bucket", limit: 20 })).inventory;
  if (!("bucket" in result)) throw new Error("unexpected_inventory_result");
  return result.bucket.handles[0]!.id;
};
const settleFixtureNatives = async () =>
  runInDurableObject(restored.control, async (instance, state) => {
    for (const row of state.storage.sql
      .exec("SELECT grant_json FROM control_r2_write_receipts")
      .toArray())
      await instance.finishR2Write(JSON.parse(row.grant_json as string), "succeeded");
  });

it("requires adoption, write enablement, the same request and explicit valid arguments", async () => {
  await expect(run({ action: "verify" })).rejects.toThrow(/recovery_unavailable/);
  await restored.adopted();
  await expect(run({ action: "verify" }, { RESTORE_WRITE_ENABLED: "false" })).rejects.toThrow(
    /write_disabled/,
  );
  await expect(
    invoke((i) =>
      i.repairDatabaseRestoreInventory(restored.epoch, crypto.randomUUID(), { action: "verify" }),
    ),
  ).rejects.toThrow();
  await expect(run({ action: "parts", handleId: "bad", limit: 1 })).rejects.toThrow(
    /invalid_inventory_request/,
  );
  await expect(run({ action: "bucket", limit: 21 })).rejects.toThrow(/invalid_inventory_request/);
});

it.each(["verify", "uploads", "bucket"] as const)(
  "runs empty %s with a fresh proof and invalidates the completed audit",
  async (action) => {
    serve();
    for (let n = 0; n < 30; n++)
      if (
        (await restored.control.auditDatabaseRestoreRecovery(restored.epoch, restored.id, 20)).audit
          .completed
      )
        break;
    const request = action === "verify" ? { action } : { action, limit: 20 };
    expect((await run(request)).inventory).toMatchObject({ action, pending: false });
    await expect(
      invoke((i) => i.releaseDatabaseRestoreRecovery(restored.epoch, restored.id)),
    ).rejects.toThrow(/audit_incomplete/);
    expect(await restored.control.recover()).toMatchObject({ maintenance: true, gcPaused: true });
  },
);

it.each(["target", "credentials", "binding"])(
  "refuses an invalid %s before inventory mutation",
  async (kind) => {
    const remote = await multipartBucketFixture(),
      fetch = serve([remote]);
    if (kind === "binding") fetch.mockImplementation(async () => new Response("d".repeat(64)));
    const options =
      kind === "target"
        ? { R2_INVENTORY_BUCKET: "another-bucket" }
        : kind === "credentials"
          ? { R2_INVENTORY_ACCESS_KEY_ID: "" }
          : {};
    await expect(run({ action: "bucket", limit: 20 }, options)).rejects.toThrow(
      /target_mismatch|unconfigured|unconfirmed/,
    );
    if (kind !== "binding") expect(fetch).not.toHaveBeenCalled();
    expect(
      await env.DB.prepare("SELECT 1 FROM multipart_bucket_handles WHERE r2_key=?")
        .bind(remote.key)
        .first(),
    ).toBeNull();
  },
);

it("persists bucket and part pages through eviction, aborts once, and keeps capacity after empty inventory", async () => {
  const a = await multipartBucketFixture(),
    b = await multipartBucketFixture();
  serve([a, b]);
  const first = (await run({ action: "bucket", limit: 1 })).inventory;
  expect(first).toMatchObject({ pending: true, bucket: { examined: 1, completed: false } });
  await evictDurableObject(restored.control);
  const second = (await run({ action: "bucket", limit: 1 })).inventory;
  expect(second).toMatchObject({ pending: true, bucket: { examined: 1, completed: true } });
  const id = await env.DB.prepare("SELECT id FROM multipart_bucket_handles WHERE r2_key=?")
    .bind(a.key)
    .first<string>("id");
  const remote = { ...a, bytes: [3, 5] };
  await a.handle.uploadPart(2, new TextEncoder().encode("12345"));
  serve([remote]);
  expect((await run({ action: "parts", handleId: id!, limit: 1 })).inventory).toMatchObject({
    pending: true,
    parts: { heldBytes: 3, completed: false },
  });
  await evictDurableObject(restored.control);
  expect((await run({ action: "parts", handleId: id!, limit: 1 })).inventory).toMatchObject({
    pending: true,
    parts: { heldBytes: 8, completed: true },
  });
  const attemptId = crypto.randomUUID(),
    request = { action: "abort" as const, handleId: id!, attemptId };
  expect((await run(request)).inventory).toMatchObject({
    pending: true,
    abort: { outcome: "confirmed", replayed: false, heldBytes: 8 },
  });
  await evictDurableObject(restored.control);
  expect((await run(request)).inventory).toMatchObject({
    abort: { outcome: "confirmed", replayed: true },
  });
  expect(await balance(a.ids.user)).toMatchObject({ physical_bytes: 8 });
  await expect(a.handle.uploadPart(1, new TextEncoder().encode("abc"))).rejects.toThrow();
  serve([]);
  expect((await run({ action: "bucket", limit: 20 })).inventory).toMatchObject({
    pending: true,
    bucket: { examined: 0, completed: true },
  });
  expect(await balance(a.ids.user)).toMatchObject({ physical_bytes: 8 });
  expect(
    await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM multipart_bucket_abort_attempts WHERE handle_id=?",
    )
      .bind(id)
      .first("n"),
  ).toBe(1);
});

it("repairs unidentified upload handles but keeps the reservation and whole-upload closure hold", async () => {
  const f = await multipartInventoryFixture();
  serve([f]);
  expect((await run({ action: "uploads", limit: 1 })).inventory).toMatchObject({
    pending: true,
    uploads: { claimed: 1, pages: 1, observed: 1, aborted: 1, retried: 0, r2Calls: 4 },
  });
  expect(await balance(f.ids.user)).toMatchObject({ reserved_bytes: 3 });
  expect(
    await env.DB.prepare("SELECT multipart_cleanup_closed,cleanup_error FROM uploads WHERE id=?")
      .bind(f.id)
      .first(),
  ).toMatchObject({
    multipart_cleanup_closed: null,
    cleanup_error: "multipart_inventory_closure_required",
  });
  await expect(f.handle.uploadPart(1, new TextEncoder().encode("abc"))).rejects.toThrow();
});

it("does not dispatch an abort after losing the insert acknowledgement and replays the same attempt", async () => {
  const f = await multipartBucketFixture(),
    id = await discover(f);
  await run({ action: "parts", handleId: id, limit: 20 });
  const attemptId = crypto.randomUUID(),
    request = { action: "abort" as const, handleId: id, attemptId };
  const db = injectBatch(
    (sql) => sql.startsWith("INSERT INTO multipart_bucket_abort_attempts"),
    async () => {
      throw new Error("lost_ack");
    },
    true,
  );
  await expect(run(request, { DB: db })).rejects.toThrow();
  await env.DB.prepare(
    "UPDATE r2_binding_probe SET lease_expires_at=1 WHERE lease_token IS NOT NULL",
  ).run();
  expect((await run(request)).inventory).toMatchObject({
    pending: true,
    abort: { outcome: "unconfirmed", replayed: true },
  });
  await expect(f.handle.uploadPart(1, new TextEncoder().encode("abc"))).resolves.toBeDefined();
});

it.each(["probe", "uploads", "parts"])(
  "rejects a late S3 %s response after the stop changes",
  async (phase) => {
    const f = await multipartBucketFixture(),
      id = phase === "parts" ? await discover(f) : null;
    const request: RestoreInventoryRequest =
      phase === "parts"
        ? { action: "parts", handleId: id!, limit: 20 }
        : { action: "bucket", limit: 20 };
    await invoke(async (instance) => {
      serve([f], async (method) => {
        if (method === phase) await instance.quiesce(restored.epoch + 1);
      });
      await expect(
        instance.repairDatabaseRestoreInventory(restored.epoch, restored.id, request),
      ).rejects.toThrow();
    });
    expect(await balance(f.ids.user)).toMatchObject({ physical_bytes: 0 });
    if (phase !== "parts")
      expect(
        await env.DB.prepare("SELECT 1 FROM multipart_bucket_handles WHERE r2_key=?")
          .bind(f.key)
          .first(),
      ).toBeNull();
  },
);

it.each(["probe.put", "bucket.abort"] as const)(
  "records not_started when the stop changes after a %s grant",
  async (kind) => {
    const f = await multipartBucketFixture(),
      id = kind === "bucket.abort" ? await discover(f) : null;
    serve([f]);
    if (id) await run({ action: "parts", handleId: id, limit: 20 });
    const request: RestoreInventoryRequest = id
      ? { action: "abort", handleId: id, attemptId: crypto.randomUUID() }
      : { action: "verify" };
    await invoke(async (instance) => {
      const begin = instance.beginR2Write.bind(instance);
      instance.beginR2Write = async (input) => {
        const grant = await begin(input);
        if (input.kind === kind) await instance.quiesce(restored.epoch + 1);
        return grant;
      };
      await expect(
        instance.repairDatabaseRestoreInventory(restored.epoch, restored.id, request),
      ).rejects.toThrow();
    });
    expect(
      await env.DB.prepare(
        "SELECT state FROM r2_write_attempts WHERE kind=? ORDER BY started_at DESC LIMIT 1",
      )
        .bind(kind)
        .first("state"),
    ).toBe("not_started");
    await expect(f.handle.uploadPart(1, new TextEncoder().encode("abc"))).resolves.toBeDefined();
  },
);

it("recovers actual late abort success after eviction and preserves the original diagnostic and capacity", async () => {
  const f = await multipartBucketFixture(),
    id = await discover(f);
  await run({ action: "parts", handleId: id, limit: 20 });
  const attemptId = crypto.randomUUID();
  await runInDurableObject(restored.control, async (_, state) => {
    let instance: ControlDO;
    const bucket = orphanBucket({
      resumeMultipartUpload: (key, uploadId) => {
        const handle = env.BLOBS.resumeMultipartUpload(key, uploadId);
        return {
          key,
          uploadId,
          uploadPart: handle.uploadPart.bind(handle),
          complete: handle.complete.bind(handle),
          abort: async () => {
            await handle.abort();
            await instance.quiesce(restored.epoch + 1);
          },
        };
      },
    });
    instance = new ControlDO(state, {
      ...env,
      ...inventoryEnv,
      BLOBS: bucket,
      RESTORE_WRITE_ENABLED: "true",
    });
    await expect(
      instance.repairDatabaseRestoreInventory(restored.epoch, restored.id, {
        action: "abort",
        handleId: id,
        attemptId,
      }),
    ).rejects.toThrow();
    expect(
      state.storage.sql.exec("SELECT 1 FROM control_r2_write_receipts").toArray(),
    ).toHaveLength(0);
  });
  expect(
    await env.DB.prepare(
      "SELECT state FROM r2_write_attempts WHERE r2_key=? AND kind='bucket.abort'",
    )
      .bind(f.key)
      .first("state"),
  ).toBe("succeeded");
  expect(
    await env.DB.prepare("SELECT outcome FROM multipart_bucket_abort_attempts WHERE id=?")
      .bind(attemptId)
      .first("outcome"),
  ).toBe("started");
  expect(await balance(f.ids.user)).toMatchObject({ physical_bytes: 3 });
  await env.DB.prepare(
    "UPDATE r2_binding_probe SET lease_expires_at=1 WHERE lease_token IS NOT NULL",
  ).run();
  await evictDurableObject(restored.control);
  const abort = vi.fn(async () => {
    throw new Error("unexpected_abort");
  });
  const bucket = orphanBucket({
    resumeMultipartUpload: (key, uploadId) =>
      ({ key, uploadId, abort }) as unknown as R2MultipartUpload,
  });
  const request = { action: "abort" as const, handleId: id, attemptId };
  expect((await run(request, { BLOBS: bucket })).inventory).toMatchObject({
    pending: true,
    abort: { outcome: "confirmed", replayed: true, heldBytes: 3 },
  });
  expect(
    await env.DB.prepare("SELECT outcome FROM multipart_bucket_abort_attempts WHERE id=?")
      .bind(attemptId)
      .first("outcome"),
  ).toBe("started");
  expect(
    await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM multipart_bucket_abort_reconciliations WHERE attempt_id=?",
    )
      .bind(attemptId)
      .first("n"),
  ).toBe(1);
  await evictDurableObject(restored.control);
  expect(
    (
      await run(request, {
        BLOBS: bucket,
        DB: rewriteNativeReceipt(() => {
          throw new Error("native_receipt_was_reloaded");
        }),
      })
    ).inventory,
  ).toMatchObject({ abort: { outcome: "confirmed", replayed: true } });
  expect(abort).not.toHaveBeenCalled();
  expect(await balance(f.ids.user)).toMatchObject({ physical_bytes: 3 });
  for (const sql of [
    "UPDATE multipart_bucket_abort_reconciliations SET epoch=epoch+1 WHERE attempt_id=?",
    "DELETE FROM multipart_bucket_abort_reconciliations WHERE attempt_id=?",
    "UPDATE multipart_bucket_handles SET held_bytes=0 WHERE id=?",
  ])
    await expect(
      env.DB.prepare(sql)
        .bind(sql.includes("handles") ? id : attemptId)
        .run(),
    ).rejects.toThrow();
});

function rewriteNativeReceipt(rewrite: (row: Record<string, unknown>) => unknown): D1Database {
  return new Proxy(env.DB, {
    get(target, key) {
      if (key === "prepare")
        return (query: string) => {
          const wrap = (statement: D1PreparedStatement): D1PreparedStatement =>
            new Proxy(statement, {
              get(s, prop) {
                if (prop === "bind") return (...values: unknown[]) => wrap(s.bind(...values));
                if (prop === "first" && query.includes("SELECT r.* FROM r2_write_attempts"))
                  return async () => {
                    const row = await s.first<Record<string, unknown>>();
                    return row ? rewrite(row) : null;
                  };
                const value = Reflect.get(s, prop);
                return typeof value === "function" ? value.bind(s) : value;
              },
            });
          return wrap(target.prepare(query));
        };
      const value = Reflect.get(target, key);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

async function lostBucketAbort() {
  const f = await multipartBucketFixture(),
    id = await discover(f);
  await run({ action: "parts", handleId: id, limit: 20 });
  const request = { action: "abort" as const, handleId: id, attemptId: crypto.randomUUID() };
  const DB = injectBatch(
    (sql) => sql.startsWith("UPDATE multipart_bucket_abort_attempts SET outcome="),
    async () => {
      throw new Error("domain_write_failed");
    },
    false,
  );
  await expect(run(request, { DB })).rejects.toThrow();
  await env.DB.prepare(
    "UPDATE r2_binding_probe SET lease_expires_at=1 WHERE lease_token IS NOT NULL",
  ).run();
  return { f, request };
}

it.each([
  "id",
  "token",
  "epoch",
  "owner_id",
  "kind",
  "r2_key",
  "dispatch_before",
  "started_at",
  "source_ref",
])("does not reconcile a native receipt with a mismatched %s", async (field) => {
  const { f, request } = await lostBucketAbort();
  const DB = rewriteNativeReceipt((row) => ({
    ...row,
    [field]: typeof row[field] === "number" ? row[field] + 1 : `${row[field]}-wrong`,
  }));
  expect((await run(request, { DB })).inventory).toMatchObject({
    pending: true,
    abort: { outcome: "unconfirmed", replayed: true },
  });
  expect(
    await env.DB.prepare("SELECT 1 FROM multipart_bucket_abort_reconciliations WHERE attempt_id=?")
      .bind(request.attemptId)
      .first(),
  ).toBeNull();
  expect(await balance(f.ids.user)).toMatchObject({ physical_bytes: 3 });
});

it.each(["missing", "not_started", "deadline"])(
  "requires matching DO history: %s",
  async (fault) => {
    const { request } = await lostBucketAbort();
    const row = (await env.DB.prepare(
      "SELECT * FROM r2_write_attempts WHERE kind='bucket.abort' AND source_ref=?",
    )
      .bind(JSON.stringify(["bucket", request.handleId, request.attemptId, null]))
      .first<Record<string, unknown>>())!;
    const digest = new Uint8Array(
      await nativeIdentity("r2", [
        row.id,
        row.token,
        row.epoch,
        row.owner_id,
        row.kind,
        row.r2_key,
        row.dispatch_before,
        row.started_at,
        row.source_ref,
      ]),
    ).join(",");
    const find = NativeHistory.prototype.find;
    const spy = vi.spyOn(NativeHistory.prototype, "find").mockImplementation(function (
      this: NativeHistory,
      identity,
    ) {
      const saved = find.call(this, identity);
      if (!saved || new Uint8Array(identity).join(",") !== digest) return saved;
      return fault === "missing"
        ? undefined
        : fault === "deadline"
          ? { ...saved, deadline: saved.deadline + 1 }
          : { ...saved, outcome: "not_started" };
    });
    try {
      expect((await run(request)).inventory).toMatchObject({
        abort: { outcome: "unconfirmed", replayed: true },
      });
    } finally {
      spy.mockRestore();
    }
  },
);

it.each([false, true])(
  "recovers reconciliation batch acknowledgement loss (after commit: %s)",
  async (after) => {
    const { request } = await lostBucketAbort();
    const DB = injectBatch(
      (sql) => sql.startsWith("INSERT INTO multipart_bucket_abort_reconciliations"),
      async () => {
        throw new Error("lost_ack");
      },
      after,
    );
    if (after)
      expect((await run(request, { DB })).inventory).toMatchObject({
        abort: { outcome: "confirmed", replayed: true },
      });
    else {
      await expect(run(request, { DB })).rejects.toThrow();
      await env.DB.prepare(
        "UPDATE r2_binding_probe SET lease_expires_at=1 WHERE lease_token IS NOT NULL",
      ).run();
      expect((await run(request)).inventory).toMatchObject({
        abort: { outcome: "confirmed", replayed: true },
      });
    }
  },
);

it.each(["same_round", "new_round", "wrong_source", "wrong_token"])(
  "checks an upload handle's previous native abort after claim changes: %s",
  async (mode) => {
    const f = await multipartInventoryFixture();
    serve([f]);
    const DB = injectBatch(
      (sql) => sql.startsWith("UPDATE multipart_inventory_handles SET state='aborted'"),
      async () => {
        throw new Error("lost_domain_write");
      },
      false,
    );
    expect((await run({ action: "uploads", limit: 1 }, { DB })).inventory).toMatchObject({
      uploads: { retried: 1, aborted: 0 },
    });
    const before = await env.DB.prepare("SELECT cleanup_token FROM uploads WHERE id=?")
      .bind(f.id)
      .first("cleanup_token");
    const handle = (await env.DB.prepare(
      "SELECT id,abort_source,abort_token FROM multipart_inventory_handles WHERE upload_id=?",
    )
      .bind(f.id)
      .first<{ id: string; abort_source: string; abort_token: string }>())!;
    expect(handle.abort_token).toBe(before);
    for (const field of ["abort_source", "abort_token"])
      await expect(
        env.DB.prepare(`UPDATE multipart_inventory_handles SET ${field}=NULL WHERE id=?`)
          .bind(handle.id)
          .run(),
      ).rejects.toThrow();
    if (mode === "new_round") {
      await env.DB.prepare("UPDATE multipart_inventory_scans SET next_scan_at=0 WHERE upload_id=?")
        .bind(f.id)
        .run();
      serve();
    } else if (mode === "wrong_source") {
      const source = JSON.stringify({
        ...JSON.parse(handle.abort_source),
        bucket: "different-bucket",
      });
      await env.DB.prepare(
        "UPDATE multipart_inventory_scans SET source=?,round_id=?,pages=0,completed_at=NULL,cursor_key=NULL,cursor_upload_id=NULL WHERE upload_id=?",
      )
        .bind(source, crypto.randomUUID(), f.id)
        .run();
      await env.DB.prepare(
        "UPDATE multipart_inventory_handles SET attempts=attempts+1,abort_source=? WHERE id=?",
      )
        .bind(source, handle.id)
        .run();
      serve();
    } else if (mode === "wrong_token") {
      const token = crypto.randomUUID();
      await env.DB.prepare("UPDATE uploads SET cleanup_token=? WHERE id=?").bind(token, f.id).run();
      await env.DB.prepare(
        "UPDATE multipart_inventory_handles SET attempts=attempts+1,abort_token=? WHERE id=?",
      )
        .bind(token, handle.id)
        .run();
    }
    await env.DB.prepare(
      "UPDATE uploads SET cleanup_lease_expires_at=1,cleanup_next_at=0 WHERE id=?",
    )
      .bind(f.id)
      .run();
    await evictDurableObject(restored.control);
    const abort = vi.fn(async () => {
      throw new Error("unexpected_abort");
    });
    const BLOBS = orphanBucket({
      resumeMultipartUpload: (key, uploadId) =>
        ({ key, uploadId, abort }) as unknown as R2MultipartUpload,
    });
    const valid = mode === "same_round" || mode === "new_round";
    expect((await run({ action: "uploads", limit: 1 }, { BLOBS })).inventory).toMatchObject({
      pending: true,
      uploads: { aborted: valid ? 1 : 0, retried: valid ? 0 : 1 },
    });
    expect(abort).not.toHaveBeenCalled();
    expect(
      await env.DB.prepare("SELECT state FROM multipart_inventory_handles WHERE upload_id=?")
        .bind(f.id)
        .first("state"),
    ).toBe(valid ? "aborted" : "observed");
    expect(
      await env.DB.prepare("SELECT cleanup_token FROM uploads WHERE id=?")
        .bind(f.id)
        .first("cleanup_token"),
    ).not.toBe(before);
    expect(await balance(f.ids.user)).toMatchObject({ reserved_bytes: 3 });
    await expect(
      env.DB.prepare("UPDATE reservations SET state='released' WHERE id=?")
        .bind(f.reservation)
        .run(),
    ).rejects.toThrow();
  },
);

it("keeps an unknown native abort pending and blocks the next fresh probe", async () => {
  const f = await multipartBucketFixture(),
    id = await discover(f);
  await run({ action: "parts", handleId: id, limit: 20 });
  const request = { action: "abort" as const, handleId: id, attemptId: crypto.randomUUID() };
  const bucket = orphanBucket({
    resumeMultipartUpload: (key, uploadId) => {
      const handle = env.BLOBS.resumeMultipartUpload(key, uploadId);
      return {
        key,
        uploadId,
        uploadPart: handle.uploadPart.bind(handle),
        complete: handle.complete.bind(handle),
        abort: async () => {
          await handle.abort();
          throw new Error("lost_ack");
        },
      };
    },
  });
  try {
    expect((await run(request, { BLOBS: bucket })).inventory).toMatchObject({
      pending: true,
      abort: { outcome: "unconfirmed" },
    });
    const fetch = serve();
    fetch.mockClear();
    await expect(run({ action: "verify" })).rejects.toThrow(/unsettled|preflight_pending/);
    expect(fetch).not.toHaveBeenCalled();
    expect(await balance(f.ids.user)).toMatchObject({ physical_bytes: 3 });
  } finally {
    // Fixture-only settlement: the mocked native abort above has actually completed.
    await settleFixtureNatives();
  }
  expect((await run(request)).inventory).toMatchObject({
    pending: true,
    abort: { outcome: "confirmed", replayed: true },
  });
  expect(
    await env.DB.prepare("SELECT outcome FROM multipart_bucket_abort_attempts WHERE id=?")
      .bind(request.attemptId)
      .first("outcome"),
  ).toBe("unconfirmed");
});

it("rejects reconciliation when the D1 stop changes immediately before its atomic save", async () => {
  const { f, request } = await lostBucketAbort();
  let mirror = null as { admission_revision: number; admission_token: string } | null;
  const DB = injectBatch(
    (sql) => sql.startsWith("INSERT INTO multipart_bucket_abort_reconciliations"),
    async () => {
      mirror = await env.DB.prepare(
        "SELECT admission_revision,admission_token FROM control WHERE singleton=1",
      ).first();
      await env.DB.prepare("UPDATE control SET admission_token=? WHERE singleton=1")
        .bind(crypto.randomUUID())
        .run();
    },
    false,
  );
  try {
    await expect(run(request, { DB })).rejects.toThrow();
    expect(mirror).not.toBeNull();
    expect(
      await env.DB.prepare(
        "SELECT 1 FROM multipart_bucket_abort_reconciliations WHERE attempt_id=?",
      )
        .bind(request.attemptId)
        .first(),
    ).toBeNull();
    expect(await balance(f.ids.user)).toMatchObject({ physical_bytes: 3 });
  } finally {
    if (mirror)
      await env.DB.prepare("UPDATE control SET admission_token=? WHERE admission_revision=?")
        .bind(mirror.admission_token, mirror.admission_revision)
        .run();
    await env.DB.prepare(
      "UPDATE mutation_admissions SET state='closed' WHERE state<>'closed'",
    ).run();
    await restored.control.quiesce(restored.epoch + 1);
  }
});

it.each(["d1", "kdf", "r2"])("blocks fresh inventory while %s holds are pending", async (where) => {
  const grant: R2WriteGrant = {
    id: crypto.randomUUID(),
    token: crypto.randomUUID(),
    epoch: restored.epoch + 1,
    ownerId: "fixture",
    kind: "manifest.delete",
    key: `target-sets/${crypto.randomUUID()}`,
    startedAt: Date.now(),
    deadline: Date.now() + 5000,
  };
  if (where === "d1") await atomicBatch(env.DB, [insertR2Write(grant, "pending")]);
  else
    await runInDurableObject(restored.control, async (_, state) => {
      if (where === "kdf")
        new KdfSettlements(state.storage.sql, env.DB).reserve({
          id: grant.id,
          token: grant.token,
          epoch: 1,
          deadline: 1,
        });
      else
        state.storage.sql.exec(
          "INSERT INTO control_r2_write_receipts VALUES(?,?,?,'pending')",
          grant.id,
          grant.token,
          JSON.stringify(grant),
        );
    });
  const fetch = serve();
  try {
    await expect(run({ action: "verify" })).rejects.toThrow(/unsettled|preflight_pending/);
    expect(fetch).not.toHaveBeenCalled();
  } finally {
    // These synthetic holds were never dispatched.
    if (where === "d1")
      await env.DB.prepare(
        "UPDATE r2_write_attempts SET state='not_started',finished_at=MAX(started_at,strftime('%s','now')*1000) WHERE id=?",
      )
        .bind(grant.id)
        .run();
    else
      await runInDurableObject(restored.control, async (instance, state) => {
        if (where === "kdf") {
          state.storage.sql.exec(
            "UPDATE control_kdf_receipts SET state='not_started' WHERE id=?",
            grant.id,
          );
          state.storage.sql.exec("DELETE FROM control_kdf_receipts WHERE id=?", grant.id);
        } else await instance.finishR2Write(grant, "not_started");
      });
  }
});

it.each(["bucket", "parts"] as const)(
  "asserts the exact stop token inside the %s page batch",
  async (action) => {
    const f = await multipartBucketFixture(),
      id = action === "parts" ? await discover(f) : null;
    serve([f]);
    let changed = false;
    // The fault-injection callback assigns this after the local control-flow check.
    let mirror = null as { admission_revision: number; admission_token: string } | null;
    const db = injectBatch(
      (sql) =>
        sql.includes(
          action === "bucket"
            ? "UPDATE multipart_bucket_scan SET cursor_key="
            : "UPDATE multipart_bucket_handles SET part_marker=",
        ),
      async () => {
        changed = true;
        mirror = await env.DB.prepare(
          "SELECT admission_revision,admission_token FROM control",
        ).first<{ admission_revision: number; admission_token: string }>();
        // Simulate a changed D1 mirror after the local scope check and before its page transaction.
        await env.DB.prepare("UPDATE control SET admission_token=?")
          .bind(crypto.randomUUID())
          .run();
      },
      false,
    );
    try {
      await expect(
        run(action === "bucket" ? { action, limit: 20 } : { action, handleId: id!, limit: 20 }, {
          DB: db,
        }),
      ).rejects.toThrow();
      expect(changed).toBe(true);
      expect(await balance(f.ids.user)).toMatchObject({ physical_bytes: 0 });
      if (action === "bucket")
        expect(
          await env.DB.prepare("SELECT 1 FROM multipart_bucket_handles WHERE r2_key=?")
            .bind(f.key)
            .first(),
        ).toBeNull();
      else
        expect(
          await env.DB.prepare(
            "SELECT part_pages,parts_completed_at FROM multipart_bucket_handles WHERE id=?",
          )
            .bind(id)
            .first(),
        ).toMatchObject({ part_pages: 0, parts_completed_at: null });
    } finally {
      // Undo only the injected mirror corruption before requesting a legitimate new stop.
      if (mirror)
        await env.DB.prepare("UPDATE control SET admission_token=? WHERE admission_revision=?")
          .bind(mirror.admission_token, mirror.admission_revision)
          .run();
      // This injected, rolled-back page sent no native writes; retire its fixture-only SQL grant.
      await env.DB.prepare(
        "UPDATE mutation_admissions SET state='closed' WHERE state<>'closed'",
      ).run();
      await restored.control.quiesce(restored.epoch + 1);
    }
  },
);

it("times out a held probe read and refuses its late continuation without dispatching PUT", async () => {
  serve();
  await runInDurableObject(restored.control, async (_, state) => {
    let entered!: () => void, release!: () => void;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const hold = new Promise<void>((resolve) => {
      release = resolve;
    });
    const put = vi.fn(env.BLOBS.put.bind(env.BLOBS));
    const bucket = orphanBucket({
      get: async (key: string) => {
        entered();
        await hold;
        return env.BLOBS.get(key);
      },
      put,
    });
    const instance = new ControlDO(state, {
      ...env,
      ...inventoryEnv,
      BLOBS: bucket,
      RESTORE_WRITE_ENABLED: "true",
    });
    const pending = instance.repairDatabaseRestoreInventory(restored.epoch, restored.id, {
      action: "verify",
    });
    try {
      await Promise.race([started, pending]);
      await expect(pending).rejects.toThrow(/inventory_timeout/);
      expect(await instance.status()).toMatchObject({ maintenance: true, gcPaused: true });
    } finally {
      release();
    }
    // Keep the DO I/O context alive while the old continuation observes its expired scope.
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(put).not.toHaveBeenCalled();
    expect(await env.DB.prepare("SELECT phase FROM r2_binding_probe").first("phase")).toBe(
      "claimed",
    );
  });
}, 40000);
