import { applyD1Migrations, runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { atomicBatch } from "../../src/db/primary";
import { CONTROL_NAME, ControlDO } from "../../src/do/ControlDO";
import { EPOCH_PREFIX } from "../../src/do/epochHistory";
import { inspectRecoveryFinalFence } from "../../src/do/recoveryAudit";
import { repairMultipartUploads } from "../../src/jobs/multipartCleanup";
import { repairUnidentifiedMultipartUploads } from "../../src/jobs/multipartInventoryRepair";
import { R2S3Inventory } from "../../src/r2/s3Inventory";
import { foundationFixture } from "../fixtures/foundation";
import { inventoryEnv, uploadsXml, uploadXml } from "../fixtures/s3Inventory";
import { injectBatch } from "../fixtures/uploadEnv";

beforeAll(async () => applyD1Migrations(env.DB, env.TEST_MIGRATIONS));
beforeEach(async () => {
  await env.DB.prepare("UPDATE control SET epoch=1,maintenance=0,gc_paused=0").run();
  await env.DB.prepare(
    "UPDATE uploads SET cleanup_next_at=9999999999999 WHERE mode='multipart'",
  ).run();
});
afterEach(() => vi.restoreAllMocks());

async function fixture(options: { idle?: boolean; initLease?: number; known?: boolean } = {}) {
  const f = foundationFixture(crypto.randomUUID(), Date.now() - 1000);
  await atomicBatch(env.DB, f.statements);
  const id = `up_${crypto.randomUUID().replaceAll("-", "").repeat(2)}`;
  const blob = `${id}_blob`;
  const reservation = `${id}_reservation`;
  const key = `u/${f.ids.user}/b/${blob}`;
  const attempt = crypto.randomUUID();
  const metadata = { upload_id: id, blob_id: blob, epoch: "1", attempt_id: attempt };
  const handle = await env.BLOBS.createMultipartUpload(key, { customMetadata: metadata });
  await handle.uploadPart(1, new TextEncoder().encode("abc"));
  const created = Date.now() - (options.idle === false ? 1000 : 25 * 3600000);
  await atomicBatch(env.DB, [
    {
      sql: "INSERT INTO reservations(id,owner_id,bytes,state,expires_at,epoch) VALUES(?,?,3,'reserved',?,1)",
      values: [reservation, f.ids.user, created + 6 * 86400000],
    },
    {
      sql: "INSERT INTO blobs(id,owner_id,r2_key,size,content_etag,state,created_at) VALUES(?,?,?,3,?,'staging',?)",
      values: [blob, f.ids.user, key, `"b-${blob}"`, created],
    },
    {
      sql: `INSERT INTO uploads(id,owner_id,space_id,parent_id,blob_id,credential_id,reservation_id,mode,state,declared_size,
      capability_hash,epoch,created_at,expires_at,last_progress_at,upload_name,request_digest,capability_kid,
      write_attempt_id,write_lease_expires_at,r2_upload_id,part_bytes,part_count)
      VALUES(?,?,?,?,?,?,?,'multipart','uploading',3,'fixture',1,?,?,?,'inventory.bin','fixture','fixture',?,?,?,67108864,1)`,
      values: [
        id,
        f.ids.user,
        f.ids.space,
        f.ids.folder,
        blob,
        f.ids.credential,
        reservation,
        created,
        created + 6 * 86400000,
        created,
        attempt,
        options.initLease ?? 0,
        options.known ? handle.uploadId : null,
      ],
    },
  ]);
  return { ...f, id, blob, reservation, key, handle, metadata };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
const row = (f: Fixture) => env.DB.prepare("SELECT * FROM uploads WHERE id=?").bind(f.id).first();
const scan = (f: Fixture) =>
  env.DB.prepare("SELECT * FROM multipart_inventory_scans WHERE upload_id=?").bind(f.id).first();
const handles = async (f: Fixture) =>
  (
    await env.DB.prepare(
      "SELECT * FROM multipart_inventory_handles WHERE upload_id=? ORDER BY r2_upload_id",
    )
      .bind(f.id)
      .all()
  ).results;
const reservation = (f: Fixture) =>
  env.DB.prepare("SELECT state FROM reservations WHERE id=?").bind(f.reservation).first("state");
const due = (f: Fixture) =>
  env.DB.prepare(
    "UPDATE uploads SET cleanup_next_at=0,cleanup_lease_expires_at=CASE WHEN cleanup_token IS NULL THEN NULL ELSE 0 END WHERE id=?",
  )
    .bind(f.id)
    .run();
function inventory(
  f: Fixture,
  ids = [f.handle.uploadId],
  effect?: (request: Request) => Promise<string>,
) {
  const fetch = vi.fn(
    async (request: Request) =>
      new Response(
        effect
          ? await effect(request)
          : uploadsXml({ prefix: f.key, uploads: ids.map((id) => uploadXml(f.key, id)).join("") }),
      ),
  );
  return { client: new R2S3Inventory(inventoryEnv, { fetch }), fetch };
}
const repair = (client: R2S3Inventory, options = {}, bucket = env.BLOBS, db = env.DB, epoch = 1) =>
  repairUnidentifiedMultipartUploads(db, bucket, client, epoch, options);
const bucket = (overrides: Partial<R2Bucket>) =>
  ({
    head: env.BLOBS.head.bind(env.BLOBS),
    resumeMultipartUpload: env.BLOBS.resumeMultipartUpload.bind(env.BLOBS),
    ...overrides,
  }) as R2Bucket;
const lost = (point: string) =>
  injectBatch(
    (sql) => sql.includes(point),
    async () => {
      throw new Error("lost_ack");
    },
    true,
  );

it("recovers multiple lost IDs, aborts their real R2 parts and retains an unresolved reservation", async () => {
  const f = await fixture();
  const extra = await env.BLOBS.createMultipartUpload(f.key);
  await extra.uploadPart(1, new TextEncoder().encode("def"));
  const s3 = inventory(f, [f.handle.uploadId, extra.uploadId]);
  expect(await repair(s3.client)).toEqual({
    claimed: 1,
    pages: 1,
    observed: 2,
    aborted: 2,
    retried: 0,
    r2Calls: 5,
  });
  expect(await handles(f)).toHaveLength(2);
  expect(
    (await handles(f)).every((entry) => entry.state === "aborted" && entry.attempts === 1),
  ).toBe(true);
  expect(await row(f)).toMatchObject({
    state: "expired",
    r2_upload_id: null,
    multipart_cleanup_closed: null,
    cleanup_pending: 1,
    accept_parts: 0,
    cleanup_token: null,
  });
  expect(await reservation(f)).toBe("reserved");
  await expect(f.handle.uploadPart(1, new TextEncoder().encode("late"))).rejects.toThrow();
  await expect(extra.uploadPart(1, new TextEncoder().encode("late"))).rejects.toThrow();
  expect(await repair(s3.client)).toMatchObject({ claimed: 0 });
});

it("persists both cursor components and finishes scanning before aborting a marker handle", async () => {
  const f = await fixture();
  const extra = await env.BLOBS.createMultipartUpload(f.key);
  const s3 = inventory(f, [], async (request) => {
    const query = new URL(request.url).searchParams;
    if (!query.has("key-marker"))
      return uploadsXml({
        prefix: f.key,
        uploads: uploadXml(f.key, f.handle.uploadId),
        truncated: true,
        nextKey: f.key,
        nextId: f.handle.uploadId,
      });
    expect(query.get("key-marker")).toBe(f.key);
    expect(query.get("upload-id-marker")).toBe(f.handle.uploadId);
    return uploadsXml({
      prefix: f.key,
      keyMarker: f.key,
      idMarker: f.handle.uploadId,
      uploads: uploadXml(f.key, extra.uploadId),
    });
  });
  expect(await repair(s3.client)).toMatchObject({ pages: 1, observed: 1, aborted: 0, retried: 0 });
  expect(await scan(f)).toMatchObject({
    pages: 1,
    cursor_key: f.key,
    cursor_upload_id: f.handle.uploadId,
    completed_at: null,
  });
  await expect(f.handle.uploadPart(1, new TextEncoder().encode("abc"))).resolves.toMatchObject({
    partNumber: 1,
  });
  expect(await repair(s3.client)).toMatchObject({ pages: 1, observed: 1, aborted: 2, retried: 0 });
  expect(await scan(f)).toMatchObject({ pages: 2, cursor_key: null, cursor_upload_id: null });
});

it("does not abort a neighbouring key returned by the S3 prefix listing", async () => {
  const f = await fixture();
  const neighbor = await env.BLOBS.createMultipartUpload(`${f.key}-neighbor`);
  const s3 = inventory(f, [], async () =>
    uploadsXml({
      prefix: f.key,
      uploads: uploadXml(f.key, f.handle.uploadId) + uploadXml(neighbor.key, neighbor.uploadId),
      truncated: true,
      nextKey: neighbor.key,
      nextId: neighbor.uploadId,
    }),
  );
  expect(await repair(s3.client)).toMatchObject({ observed: 1, aborted: 1, retried: 0 });
  await expect(neighbor.uploadPart(1, new TextEncoder().encode("abc"))).resolves.toMatchObject({
    partNumber: 1,
  });
  await neighbor.abort();
});

it.each(["active", "initialization", "part", "complete", "known", "pin"])(
  "keeps %s uploads out of unknown-ID recovery",
  async (kind) => {
    const f = await fixture({
      idle: kind !== "active",
      initLease: kind === "initialization" ? Date.now() + 60000 : 0,
      known: kind === "known",
    });
    if (kind === "part")
      await env.DB.prepare(
        "INSERT INTO upload_parts(upload_id,part_number,attempts,attempt_id,state,expected_size,lease_expires_at) VALUES(?,1,1,'part','in_flight',3,?)",
      )
        .bind(f.id, Date.now() + 60000)
        .run();
    if (kind === "complete")
      await env.DB.prepare(
        "UPDATE uploads SET state='completing',multipart_complete_attempt='complete',multipart_complete_lease=? WHERE id=?",
      )
        .bind(Date.now() + 60000, f.id)
        .run();
    if (kind === "pin")
      await env.DB.prepare(
        "INSERT INTO blob_pins(pin_id,blob_id,purpose,created_at) VALUES(?,?,'backup',?)",
      )
        .bind(crypto.randomUUID(), f.blob, Date.now())
        .run();
    const s3 = inventory(f);
    expect(await repair(s3.client)).toMatchObject({ claimed: 0, r2Calls: 0 });
    expect(s3.fetch).not.toHaveBeenCalled();
    expect(await scan(f)).toBeNull();
  },
);

it.each([
  "INSERT INTO multipart_inventory_scans",
  "UPDATE multipart_inventory_scans SET cursor_key=",
  "SET state='aborted',aborted_at=",
])("recovers a committed %s acknowledgement without losing receipts", async (point) => {
  const f = await fixture();
  expect(await repair(inventory(f).client, {}, env.BLOBS, lost(point))).toMatchObject({
    claimed: 1,
    pages: 1,
    observed: 1,
    aborted: 1,
    retried: 0,
  });
  expect(await handles(f)).toHaveLength(1);
  expect(await reservation(f)).toBe("reserved");
});

it("does not dispatch after an unknown counter acknowledgement", async () => {
  const f = await fixture();
  const s3 = inventory(f);
  expect(
    await repair(
      s3.client,
      {},
      env.BLOBS,
      lost("UPDATE uploads SET cleanup_calls=cleanup_calls+1"),
    ),
  ).toMatchObject({ claimed: 1, pages: 0, aborted: 0, r2Calls: 0, retried: 1 });
  expect(s3.fetch).not.toHaveBeenCalled();
  expect(await row(f)).toMatchObject({ cleanup_calls: 1 });
  await due(f);
  expect(await repair(s3.client)).toMatchObject({ aborted: 1, retried: 0 });
});

it("keeps the old cursor after a failed page and retries it without duplicating earlier observations", async () => {
  const f = await fixture();
  const s3 = inventory(f);
  const db = injectBatch(
    (sql) => sql.includes("SET cursor_key="),
    async () => {
      throw new Error("not_committed");
    },
    false,
  );
  expect(await repair(s3.client, {}, env.BLOBS, db)).toMatchObject({
    aborted: 0,
    pages: 0,
    retried: 1,
  });
  expect(await handles(f)).toHaveLength(0);
  expect(await scan(f)).toMatchObject({ pages: 0, cursor_key: null });
  await due(f);
  expect(await repair(s3.client)).toMatchObject({ pages: 1, observed: 1, aborted: 1 });
});

it("retains an unknown abort outcome and does not convert NoSuchUpload to a receipt", async () => {
  const f = await fixture();
  const s3 = inventory(f);
  const lostAbort = bucket({
    resumeMultipartUpload: (key, uploadId) =>
      ({
        key,
        uploadId,
        abort: async () => {
          await env.BLOBS.resumeMultipartUpload(key, uploadId).abort();
          throw new Error("lost_abort");
        },
      }) as unknown as R2MultipartUpload,
  });
  expect(await repair(s3.client, {}, lostAbort)).toMatchObject({
    observed: 1,
    aborted: 0,
    retried: 1,
  });
  expect(await handles(f)).toMatchObject([
    { state: "observed", attempts: 1, last_error: "abort_unconfirmed" },
  ]);
  await due(f);
  const missing = bucket({
    resumeMultipartUpload: (key, uploadId) =>
      ({
        key,
        uploadId,
        abort: async () => {
          throw new Error("NoSuchUpload");
        },
      }) as unknown as R2MultipartUpload,
  });
  expect(await repair(s3.client, {}, missing)).toMatchObject({ pages: 0, aborted: 0, retried: 1 });
  expect(s3.fetch).toHaveBeenCalledTimes(1);
  expect(await reservation(f)).toBe("reserved");
});

it("does not mistake an empty or wrong-bucket listing for closure", async () => {
  const f = await fixture();
  expect(await repair(inventory(f, []).client)).toMatchObject({
    observed: 0,
    aborted: 0,
    retried: 0,
  });
  expect(await reservation(f)).toBe("reserved");
  await expect(f.handle.uploadPart(1, new TextEncoder().encode("abc"))).resolves.toMatchObject({
    partNumber: 1,
  });
  await expect(
    env.DB.prepare("UPDATE reservations SET state='released' WHERE id=?").bind(f.reservation).run(),
  ).rejects.toThrow("multipart_inventory_closure_required");
});

it("fences a late initialization ID out of ordinary cleanup after inventory has started", async () => {
  const f = await fixture();
  const s3 = inventory(f, []);
  await repair(s3.client);
  await env.DB.prepare("UPDATE uploads SET r2_upload_id=? WHERE id=?")
    .bind(f.handle.uploadId, f.id)
    .run();
  await due(f);
  expect(await repairMultipartUploads(env.DB, env.BLOBS, 1)).toMatchObject({ claimed: 0 });
  expect(await repair(s3.client)).toMatchObject({ pages: 0, aborted: 1, retried: 0 });
  expect(await handles(f)).toMatchObject([{ state: "aborted", initiated_at: null }]);
  expect(await reservation(f)).toBe("reserved");
  await expect(
    env.DB.prepare(
      "UPDATE uploads SET multipart_cleanup_closed='aborted',cleanup_pending=0 WHERE id=?",
    )
      .bind(f.id)
      .run(),
  ).rejects.toThrow();
});

it.each(["epoch", "token", "pause"])("rejects %s changes during the listing", async (kind) => {
  const f = await fixture();
  const s3 = inventory(f, [], async () => {
    if (kind === "epoch") await env.DB.prepare("UPDATE control SET epoch=2").run();
    if (kind === "pause")
      await env.DB.prepare("UPDATE control SET maintenance=1,gc_paused=1").run();
    if (kind === "token")
      await env.DB.prepare("UPDATE uploads SET cleanup_token='replacement' WHERE id=?")
        .bind(f.id)
        .run();
    return uploadsXml({ prefix: f.key, uploads: uploadXml(f.key, f.handle.uploadId) });
  });
  expect(await repair(s3.client)).toMatchObject({ pages: 0, observed: 0, aborted: 0, retried: 1 });
  expect(await handles(f)).toHaveLength(0);
  expect(await scan(f)).toMatchObject({ pages: 0 });
  if (kind === "token")
    expect(await row(f)).toMatchObject({ cleanup_token: "replacement", cleanup_error: null });
});

it("serializes concurrent repair callers with the existing cleanup claim", async () => {
  const f = await fixture();
  let concurrent: unknown;
  const s3 = inventory(f, [], async () => {
    concurrent = await repair(inventory(f).client);
    return uploadsXml({ prefix: f.key, uploads: uploadXml(f.key, f.handle.uploadId) });
  });
  expect(await repair(s3.client)).toMatchObject({ aborted: 1, retried: 0 });
  expect(concurrent).toMatchObject({ claimed: 0, r2Calls: 0 });
});

it("charges completed objects without deleting them or refunding reservations", async () => {
  const f = await fixture();
  await env.BLOBS.put(f.key, "unexpected");
  expect(await repair(inventory(f).client)).toMatchObject({ aborted: 1, retried: 0 });
  expect(
    await env.DB.prepare("SELECT physical_bytes,reserved_bytes FROM users WHERE id=?")
      .bind(f.ids.user)
      .first(),
  ).toMatchObject({ physical_bytes: 10, reserved_bytes: 3 });
  expect(await env.BLOBS.head(f.key)).toMatchObject({ size: 10 });
  expect(
    await env.DB.prepare("SELECT COUNT(*) n FROM gc_candidates WHERE blob_id=?")
      .bind(f.blob)
      .first("n"),
  ).toBe(0);
});

it("bounds handle abort work and resumes durable pending handles without relisting", async () => {
  const f = await fixture();
  const second = await env.BLOBS.createMultipartUpload(f.key);
  const s3 = inventory(f, [f.handle.uploadId, second.uploadId]);
  expect(await repair(s3.client, { maxHandles: 1 })).toMatchObject({ observed: 2, aborted: 1 });
  expect(await repair(s3.client, { maxHandles: 1 })).toMatchObject({ pages: 0, aborted: 1 });
  expect(s3.fetch).toHaveBeenCalledTimes(1);
  for (const options of [
    { maxHandles: 0 },
    { maxHandles: 21 },
    { maxUploads: 0 },
    { maxUploads: 21 },
    { maxWallMs: 0 },
    { maxWallMs: 25001 },
  ])
    await expect(repair(s3.client, options)).rejects.toThrow("invalid_multipart_inventory_limit");
});

it("preserves immutable observations and abort receipts against deletion and rewriting", async () => {
  const f = await fixture();
  await repair(inventory(f).client);
  for (const sql of [
    "UPDATE multipart_inventory_handles SET state='observed',aborted_at=NULL WHERE upload_id=?",
    "UPDATE multipart_inventory_handles SET r2_upload_id='replacement' WHERE upload_id=?",
    "DELETE FROM multipart_inventory_handles WHERE upload_id=?",
    "DELETE FROM multipart_inventory_scans WHERE upload_id=?",
  ])
    await expect(env.DB.prepare(sql).bind(f.id).run()).rejects.toThrow();
});

it("restarts cursors for a changed source and recovers a lost reset acknowledgement", async () => {
  const f = await fixture();
  const first = inventory(f, [], async () =>
    uploadsXml({
      prefix: f.key,
      uploads: uploadXml(f.key, f.handle.uploadId),
      truncated: true,
      nextKey: f.key,
      nextId: f.handle.uploadId,
    }),
  );
  expect(await repair(first.client)).toMatchObject({ aborted: 0, pages: 1 });
  const original = await scan(f);
  const fetch = vi.fn(async (request: Request) => {
    expect(new URL(request.url).hostname).toContain(".eu.r2.");
    expect(new URL(request.url).searchParams.has("key-marker")).toBe(false);
    return new Response(
      uploadsXml({ prefix: f.key, uploads: uploadXml(f.key, f.handle.uploadId) }),
    );
  });
  const client = new R2S3Inventory({ ...inventoryEnv, R2_INVENTORY_JURISDICTION: "eu" }, { fetch });
  expect(
    await repair(client, {}, env.BLOBS, lost("SET source=?,epoch=?,round_id=?")),
  ).toMatchObject({ pages: 1, observed: 1, aborted: 1, retried: 0 });
  expect((await scan(f))!.round_id).not.toBe(original!.round_id);
  expect(JSON.parse(String((await handles(f))[0]!.first_source)).jurisdiction).toBe("default");
});

it("restarts an old-epoch page under maintenance while preserving all handles", async () => {
  const f = await fixture();
  const first = inventory(f, [], async () =>
    uploadsXml({
      prefix: f.key,
      uploads: uploadXml(f.key, f.handle.uploadId),
      truncated: true,
      nextKey: f.key,
      nextId: f.handle.uploadId,
    }),
  );
  await repair(first.client);
  await env.DB.prepare("UPDATE control SET epoch=2,maintenance=1,gc_paused=1").run();
  expect(
    await repair(inventory(f).client, { maintenance: true }, env.BLOBS, env.DB, 2),
  ).toMatchObject({ pages: 1, aborted: 1, retried: 0 });
  expect(await scan(f)).toMatchObject({ epoch: 2, pages: 1 });
  expect(await handles(f)).toHaveLength(1);
});

it("rejects a repeated handle from an earlier page without advancing the cursor", async () => {
  const f = await fixture();
  const second = await env.BLOBS.createMultipartUpload(f.key);
  const first = inventory(f, [], async () =>
    uploadsXml({
      prefix: f.key,
      uploads: uploadXml(f.key, f.handle.uploadId) + uploadXml(f.key, second.uploadId),
      truncated: true,
      nextKey: f.key,
      nextId: second.uploadId,
    }),
  );
  await repair(first.client);
  const repeat = inventory(f, [], async () =>
    uploadsXml({
      prefix: f.key,
      keyMarker: f.key,
      idMarker: second.uploadId,
      uploads: uploadXml(f.key, f.handle.uploadId),
    }),
  );
  expect(await repair(repeat.client)).toMatchObject({ pages: 0, aborted: 0, retried: 1 });
  expect(await scan(f)).toMatchObject({
    pages: 1,
    cursor_upload_id: second.uploadId,
    completed_at: null,
  });
  expect(await handles(f)).toHaveLength(2);
});

it("keeps abort receipts if HEAD fails and resumes without repeating a confirmed abort", async () => {
  const f = await fixture();
  const s3 = inventory(f);
  let headCalls = 0;
  expect(
    await repair(
      s3.client,
      {},
      bucket({
        head: async () => {
          if (++headCalls === 1) return null;
          throw new Error("head_failed");
        },
      }),
    ),
  ).toMatchObject({ aborted: 1, retried: 1 });
  expect(await handles(f)).toMatchObject([{ state: "aborted", attempts: 1 }]);
  await due(f);
  expect(await repair(s3.client)).toMatchObject({ pages: 0, aborted: 0, r2Calls: 1, retried: 0 });
  expect(s3.fetch).toHaveBeenCalledTimes(1);
});

it("rechecks pins immediately before abort dispatch", async () => {
  const f = await fixture();
  const db = injectBatch(
    (sql) => sql.includes("SET attempts=attempts+1"),
    async () => {
      await env.DB.prepare(
        "INSERT INTO blob_pins(pin_id,blob_id,purpose,created_at) VALUES(?,?,'backup',?)",
      )
        .bind(crypto.randomUUID(), f.blob, Date.now())
        .run();
    },
    false,
  );
  expect(await repair(inventory(f).client, {}, env.BLOBS, db)).toMatchObject({
    pages: 1,
    observed: 1,
    aborted: 0,
    r2Calls: 2,
    retried: 1,
  });
  expect(await handles(f)).toMatchObject([{ state: "observed", attempts: 0 }]);
  await expect(f.handle.uploadPart(1, new TextEncoder().encode("abc"))).resolves.toMatchObject({
    partNumber: 1,
  });
});

it("does not dispatch abort when its attempt-counter reply is lost", async () => {
  const f = await fixture();
  expect(
    await repair(inventory(f).client, {}, env.BLOBS, lost("SET attempts=attempts+1")),
  ).toMatchObject({ pages: 1, observed: 1, aborted: 0, r2Calls: 2, retried: 1 });
  expect(await handles(f)).toMatchObject([{ state: "observed", attempts: 1 }]);
  await expect(f.handle.uploadPart(1, new TextEncoder().encode("abc"))).resolves.toMatchObject({
    partNumber: 1,
  });
});

it("rejects a listing after its cleanup lease expires", async () => {
  const f = await fixture();
  const s3 = inventory(f, [], async () => {
    await env.DB.prepare("UPDATE uploads SET cleanup_lease_expires_at=0 WHERE id=?")
      .bind(f.id)
      .run();
    return uploadsXml({ prefix: f.key, uploads: uploadXml(f.key, f.handle.uploadId) });
  });
  expect(await repair(s3.client)).toMatchObject({ observed: 0, aborted: 0, pages: 0, retried: 1 });
  expect(await handles(f)).toHaveLength(0);
});

it("accounts for completed bytes even when S3 inventory is unavailable", async () => {
  const f = await fixture();
  await env.BLOBS.put(f.key, "untracked-completion");
  const s3 = inventory(f, [], async () => {
    throw new Error("S3_unavailable");
  });
  expect(await repair(s3.client)).toMatchObject({
    claimed: 1,
    pages: 0,
    aborted: 0,
    retried: 1,
    r2Calls: 2,
  });
  expect(
    await env.DB.prepare("SELECT bytes FROM blob_storage WHERE blob_id=?")
      .bind(f.blob)
      .first("bytes"),
  ).toBe(20);
  expect(await reservation(f)).toBe("reserved");
});

it("runs through real ControlDO maintenance and keeps the final recovery fence closed", async () => {
  const f = await fixture();
  const stub = env.CONTROL.get(env.CONTROL.idFromName(CONTROL_NAME));
  await env.BACKUPS.put(
    `${EPOCH_PREFIX}1.json`,
    JSON.stringify({ epoch: 1, at: 1, reason: "operator" }),
  );
  expect(await stub.recover()).toMatchObject({ epoch: 2 });
  vi.spyOn(globalThis, "fetch").mockImplementation(
    async () =>
      new Response(uploadsXml({ prefix: f.key, uploads: uploadXml(f.key, f.handle.uploadId) })),
  );
  await runInDurableObject(stub, async (_instance, state) => {
    const configured = new ControlDO(state, { ...env, ...inventoryEnv });
    expect(await configured.repairUnidentifiedMultipartUploads(2, 1)).toMatchObject({
      repair: { claimed: 1, aborted: 1, retried: 0 },
      audit: { epoch: 2, stage: "users", pages: 0, completed: false },
    });
    expect(await configured.status()).toMatchObject({ maintenance: true, gcPaused: true });
    await expect(configured.repairUnidentifiedMultipartUploads(1, 1)).rejects.toThrow();
  });
  expect(await reservation(f)).toBe("reserved");
  await expect(inspectRecoveryFinalFence(env.DB, 2)).rejects.toThrow();
});
