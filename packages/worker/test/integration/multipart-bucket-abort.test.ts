import { applyD1Migrations, runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { atomicBatch } from "../../src/db/primary";
import { CONTROL_NAME, ControlDO } from "../../src/do/ControlDO";
import { EPOCH_PREFIX } from "../../src/do/epochHistory";
import { RECOVERY_FINAL_QUERY } from "../../src/do/recoveryAudit";
import { abortMultipartBucketHandle } from "../../src/jobs/multipartBucketAbort";
import {
  observeMultipartBucketParts,
  scanMultipartBucket,
} from "../../src/jobs/multipartBucketInventory";
import { withVerifiedR2Inventory } from "../../src/jobs/r2BindingVerification";
import { BINDING_PROBE_KEY } from "../../src/r2/bindingProbe";
import { R2S3Inventory } from "../../src/r2/s3Inventory";
import { auditOwnerLedger } from "../../src/services/refs";
import { foundationFixture } from "../fixtures/foundation";
import { inventoryEnv, partsXml, partXml, uploadsXml, uploadXml } from "../fixtures/s3Inventory";
import { injectBatch } from "../fixtures/uploadEnv";

beforeAll(async () => applyD1Migrations(env.DB, env.TEST_MIGRATIONS));
const expire = () =>
  env.DB.prepare(
    "UPDATE r2_binding_probe SET lease_expires_at=1 WHERE lease_token IS NOT NULL",
  ).run();
beforeEach(async () => {
  await env.DB.prepare("UPDATE control SET epoch=1,maintenance=1,gc_paused=1").run();
  await expire();
  await env.DB.prepare(
    "UPDATE multipart_bucket_scan SET round_id=?,pages=0,cursor_key=NULL,cursor_upload_id=NULL,completed_at=NULL",
  )
    .bind(crypto.randomUUID())
    .run();
});
afterEach(() => vi.restoreAllMocks());

async function fixture(
  options: {
    observe?: boolean;
    application?: "known" | "unknown";
    initializationLease?: number;
  } = {},
) {
  const f = foundationFixture(crypto.randomUUID(), Date.now() - 1000);
  await atomicBatch(env.DB, f.statements);
  const key = `u/${f.ids.user}/b/lost-${crypto.randomUUID()}`;
  const remote = await env.BLOBS.createMultipartUpload(key);
  await remote.uploadPart(1, new TextEncoder().encode("abc"));
  const uploadId = `up_${crypto.randomUUID().replaceAll("-", "").repeat(2)}`;
  if (options.application)
    await atomicBatch(env.DB, [
      {
        sql: "INSERT INTO reservations(id,owner_id,bytes,state,expires_at,epoch) VALUES(?,?,3,'reserved',?,1)",
        values: [uploadId, f.ids.user, Date.now() + 600000],
      },
      {
        sql: "INSERT INTO blobs(id,owner_id,r2_key,size,content_etag,state,created_at) VALUES(?,?,?,3,?,'staging',1)",
        values: [uploadId, f.ids.user, key, `\"${uploadId}\"`],
      },
      {
        sql: `INSERT INTO uploads(id,owner_id,space_id,parent_id,blob_id,credential_id,reservation_id,mode,state,declared_size,
        capability_hash,epoch,created_at,expires_at,last_progress_at,upload_name,request_digest,capability_kid,
        write_attempt_id,write_lease_expires_at,r2_upload_id,part_bytes,part_count)
        VALUES(?,?,?,?,?,?,?,'multipart','uploading',3,'fixture',1,1,?,1,'lost.bin','fixture','fixture','attempt',?,?,67108864,1)`,
        values: [
          uploadId,
          f.ids.user,
          f.ids.space,
          f.ids.folder,
          uploadId,
          f.ids.credential,
          uploadId,
          Date.now() + 600000,
          options.initializationLease ?? 0,
          options.application === "known" ? remote.uploadId : null,
        ],
      },
    ]);
  const binding = vi.fn(async () => new Response((await env.BLOBS.get(BINDING_PROBE_KEY))!.body));
  const fetch = (request: Request) => {
    const url = new URL(request.url);
    if (url.pathname.endsWith(`/${BINDING_PROBE_KEY}`)) return binding();
    return Promise.resolve(
      new Response(
        url.searchParams.has("uploads")
          ? uploadsXml({ uploads: uploadXml(key, remote.uploadId) })
          : partsXml({ key, uploadId: remote.uploadId, parts: partXml(1, 3) }),
      ),
    );
  };
  const inventory = new R2S3Inventory(inventoryEnv, { fetch });
  const scanned = await scanMultipartBucket(env.DB, env.BLOBS, inventory, 1);
  const handleId = scanned.handles[0]!.id;
  if (options.observe !== false && options.application !== "known")
    await observeMultipartBucketParts(env.DB, env.BLOBS, inventory, 1, handleId);
  const abort = vi.fn(async () => remote.abort());
  const bucket = new Proxy(env.BLOBS, {
    get(target, property) {
      if (property === "resumeMultipartUpload")
        return (targetKey: string, targetId: string) => {
          expect(targetKey).toBe(key);
          expect(targetId).toBe(remote.uploadId);
          return { key: targetKey, uploadId: targetId, abort };
        };
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  return { ...f, key, remote, uploadId, handleId, inventory, fetch, binding, abort, bucket };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
const attempt = (id: string) =>
  env.DB.prepare("SELECT * FROM multipart_bucket_abort_attempts WHERE id=?").bind(id).first();
const run = (f: Fixture, id = crypto.randomUUID(), db = env.DB) =>
  abortMultipartBucketHandle(db, f.bucket, f.inventory, 1, f.handleId, id);

it("aborts the exact lost handle while retaining the physical hold and immutable receipt", async () => {
  const f = await fixture();
  const id = crypto.randomUUID();
  expect(await run(f, id)).toEqual({
    attemptId: id,
    outcome: "confirmed",
    replayed: false,
    heldBytes: 3,
  });
  expect(await attempt(id)).toMatchObject({
    handle_id: f.handleId,
    ordinal: 1,
    outcome: "confirmed",
    held_bytes: 3,
    error: null,
  });
  await expect(f.remote.uploadPart(1, new TextEncoder().encode("abc"))).rejects.toThrow();
  expect(await auditOwnerLedger(env.DB, f.ids.user)).toMatchObject({
    physical_bytes: 3,
    observed_physical_bytes: 3,
  });
  expect(
    await env.DB.prepare("SELECT state,held_bytes FROM multipart_bucket_handles WHERE id=?")
      .bind(f.handleId)
      .first(),
  ).toEqual({ state: "quarantined", held_bytes: 3 });
  expect(await env.DB.prepare(RECOVERY_FINAL_QUERY).bind(1).first()).toBeNull();
  for (const sql of [
    "DELETE FROM multipart_bucket_abort_attempts WHERE id=?",
    "UPDATE multipart_bucket_abort_attempts SET outcome='unconfirmed',error='abort_unconfirmed' WHERE id=?",
  ])
    await expect(env.DB.prepare(sql).bind(id).run()).rejects.toThrow();
  expect(await run(f, id)).toMatchObject({ outcome: "confirmed", replayed: true });
  expect(f.abort).toHaveBeenCalledTimes(1);
});

it.each(["unobserved", "bucket-page", "part-page", "tracked"])(
  "refuses %s inventory before dispatch",
  async (kind) => {
    const f = await fixture({
      observe: kind !== "unobserved",
      ...(kind === "tracked" ? { application: "known" as const } : {}),
    });
    if (kind === "bucket-page")
      await env.DB.prepare("UPDATE multipart_bucket_scan SET round_id=?,pages=0,completed_at=NULL")
        .bind(crypto.randomUUID())
        .run();
    if (kind === "part-page")
      await env.DB.prepare(
        "UPDATE multipart_bucket_handles SET part_round_id=?,part_marker=0,part_pages=0,parts_completed_at=NULL WHERE id=?",
      )
        .bind(crypto.randomUUID(), f.handleId)
        .run();
    const id = crypto.randomUUID();
    await expect(run(f, id)).rejects.toThrow();
    expect(f.abort).not.toHaveBeenCalled();
    expect(await attempt(id)).toBeNull();
  },
);

it("preserves an active application upload that appears at a quarantined key", async () => {
  const f = await fixture({ application: "unknown" });
  await expect(run(f)).rejects.toThrow();
  expect(f.abort).not.toHaveBeenCalled();
  expect(
    await env.DB.prepare("SELECT state FROM uploads WHERE id=?").bind(f.uploadId).first("state"),
  ).toBe("uploading");
  expect(
    await env.DB.prepare("SELECT state FROM reservations WHERE id=?")
      .bind(f.uploadId)
      .first("state"),
  ).toBe("reserved");
});

it("waits for a terminal upload's outstanding initialization lease", async () => {
  const f = await fixture({ application: "unknown", initializationLease: Date.now() + 60000 });
  await env.DB.prepare("UPDATE uploads SET state='failed' WHERE id=?").bind(f.uploadId).run();
  await expect(run(f)).rejects.toThrow();
  expect(f.abort).not.toHaveBeenCalled();
  await expire();
  const expired = await fixture({ application: "unknown", initializationLease: 1 });
  await env.DB.prepare("UPDATE uploads SET state='failed' WHERE id=?").bind(expired.uploadId).run();
  expect(await run(expired)).toMatchObject({ outcome: "confirmed", heldBytes: 3 });
  expect(f.abort).not.toHaveBeenCalled();
});

it("does not dispatch or retry the same attempt after losing the claim reply", async () => {
  const f = await fixture();
  const id = crypto.randomUUID();
  const db = injectBatch(
    (sql) => sql.includes("INSERT INTO multipart_bucket_abort_attempts"),
    async () => {
      throw new Error("lost_ack");
    },
    true,
  );
  await expect(run(f, id, db)).rejects.toThrow();
  expect(f.abort).not.toHaveBeenCalled();
  expect(await attempt(id)).toMatchObject({ outcome: "started", ordinal: 1 });
  await expire();
  expect(await run(f, id)).toMatchObject({ outcome: "unconfirmed", replayed: true });
  expect(f.abort).not.toHaveBeenCalled();
  expect(await run(f)).toMatchObject({ outcome: "confirmed", replayed: false });
  expect(f.abort).toHaveBeenCalledTimes(1);
});

it("recovers an acknowledged abort receipt after losing the database reply", async () => {
  const f = await fixture();
  const id = crypto.randomUUID();
  const db = injectBatch(
    (sql) => sql.includes("SET outcome="),
    async () => {
      throw new Error("lost_ack");
    },
    true,
  );
  await expect(run(f, id, db)).rejects.toThrow();
  expect(await attempt(id)).toMatchObject({ outcome: "confirmed" });
  await expire();
  expect(await run(f, id)).toMatchObject({ outcome: "confirmed", replayed: true, heldBytes: 3 });
  expect(f.abort).toHaveBeenCalledTimes(1);
});

it.each(["claim", "receipt"])(
  "rejects a proof that expires after the %s boundary",
  async (where) => {
    const f = await fixture();
    const id = crypto.randomUUID();
    const db = injectBatch(
      (sql) =>
        sql.includes(
          where === "claim" ? "INSERT INTO multipart_bucket_abort_attempts" : "SET outcome=",
        ),
      async () => {
        await expire();
      },
      where === "claim",
    );
    await expect(run(f, id, db)).rejects.toThrow();
    expect(f.abort).toHaveBeenCalledTimes(where === "claim" ? 0 : 1);
    expect(await attempt(id)).toMatchObject({ outcome: "started" });
  },
);

it("keeps a transport failure or NoSuchUpload ambiguous and allows a separately budgeted attempt", async () => {
  const f = await fixture();
  f.abort.mockRejectedValueOnce(new Error("NoSuchUpload"));
  const id = crypto.randomUUID();
  expect(await run(f, id)).toMatchObject({ outcome: "unconfirmed", heldBytes: 3 });
  expect(await attempt(id)).toMatchObject({ outcome: "unconfirmed", error: "abort_unconfirmed" });
  expect(await run(f, id)).toMatchObject({ outcome: "unconfirmed", replayed: true });
  expect(f.abort).toHaveBeenCalledTimes(1);
  expect(await run(f)).toMatchObject({ outcome: "confirmed", heldBytes: 3 });
  expect(f.abort).toHaveBeenCalledTimes(2);
});

it("returns after its wait budget and never upgrades a late abort to a confirmed receipt", async () => {
  const f = await fixture();
  let release!: () => void;
  const pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  let finished!: () => void;
  const done = new Promise<void>((resolve) => {
    finished = resolve;
  });
  f.abort.mockImplementationOnce(async () => {
    await pending;
    await f.remote.abort();
    finished();
  });
  const id = crypto.randomUUID();
  expect(
    await abortMultipartBucketHandle(env.DB, f.bucket, f.inventory, 1, f.handleId, id, {
      maxWaitMs: 1,
    }),
  ).toMatchObject({ outcome: "unconfirmed", heldBytes: 3 });
  expect(await attempt(id)).toMatchObject({ outcome: "unconfirmed", error: "abort_timeout" });
  release();
  await done;
  expect(await run(f, id)).toMatchObject({ outcome: "unconfirmed", replayed: true, heldBytes: 3 });
  expect(f.abort).toHaveBeenCalledTimes(1);
});

it("binds the caller's attempt ID to one handle", async () => {
  const first = await fixture();
  const id = crypto.randomUUID();
  await run(first, id);
  const second = await fixture();
  await expect(run(second, id)).rejects.toThrow();
  expect(second.abort).not.toHaveBeenCalled();
});

it("requires fresh matching bucket verification even when replaying a receipt", async () => {
  const f = await fixture();
  const id = crypto.randomUUID();
  await run(f, id);
  f.binding.mockImplementationOnce(async () => new Response("0".repeat(64)));
  await expect(run(f, id)).rejects.toThrow("r2_binding_mismatch");
  expect(f.abort).toHaveBeenCalledTimes(1);
  expect(await attempt(id)).toMatchObject({ outcome: "confirmed" });
});

it("enforces the lifetime cap even when all earlier dispatch acknowledgements were lost", async () => {
  const f = await fixture();
  await withVerifiedR2Inventory(env.DB, env.BLOBS, f.inventory, 1, async (verified) => {
    const row =
      await env.DB.prepare(`SELECT p.generation,s.round_id,h.part_round_id FROM r2_binding_probe p
      JOIN multipart_bucket_scan s ON s.singleton=p.singleton JOIN multipart_bucket_handles h ON h.id=?`)
        .bind(f.handleId)
        .first<{ generation: number; round_id: string; part_round_id: string }>();
    await atomicBatch(env.DB, [
      verified.fence(),
      ...Array.from({ length: 64 }, (_, i) => ({
        sql: "INSERT INTO multipart_bucket_abort_attempts(id,handle_id,ordinal,epoch,proof_generation,scan_round_id,part_round_id,held_bytes,started_at) VALUES(?,?,?,1,?,?,?,3,1)",
        values: [
          crypto.randomUUID(),
          f.handleId,
          i + 1,
          row!.generation,
          row!.round_id,
          row!.part_round_id,
        ],
      })),
    ]);
  });
  await expect(run(f)).rejects.toThrow();
  expect(f.abort).not.toHaveBeenCalled();
  expect(
    await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM multipart_bucket_abort_attempts WHERE handle_id=?",
    )
      .bind(f.handleId)
      .first("n"),
  ).toBe(64);
});

it.each(["bad", "-".repeat(36)])(
  "rejects malformed attempt ID %s before verifying the bucket",
  async (id) => {
    const f = await fixture();
    f.binding.mockClear();
    await expect(run(f, id)).rejects.toThrow("invalid_multipart_bucket_abort");
    expect(f.binding).not.toHaveBeenCalled();
    expect(f.abort).not.toHaveBeenCalled();
  },
);

it("connects a real ControlDO abort to a restarted recovery audit without clearing holds", async () => {
  const f = await fixture();
  const stub = env.CONTROL.get(env.CONTROL.idFromName(CONTROL_NAME));
  await env.BACKUPS.put(
    `${EPOCH_PREFIX}1.json`,
    JSON.stringify({ epoch: 1, at: 1, reason: "operator" }),
  );
  expect(await stub.recover()).toMatchObject({ epoch: 2 });
  vi.spyOn(globalThis, "fetch").mockImplementation(async (request) => f.fetch(request as Request));
  await runInDurableObject(stub, async (_, state) => {
    const control = new ControlDO(state, { ...env, ...inventoryEnv });
    await control.inventoryMultipartBucket(2);
    await control.observeMultipartBucketParts(2, f.handleId);
    expect(
      await control.abortMultipartBucketHandle(2, f.handleId, crypto.randomUUID()),
    ).toMatchObject({
      abort: { outcome: "confirmed", heldBytes: 3 },
      audit: { stage: "users", pages: 0, completed: false },
    });
    expect(await control.status()).toMatchObject({ maintenance: true, gcPaused: true });
  });
  await expect(f.remote.uploadPart(1, new TextEncoder().encode("abc"))).rejects.toThrow();
});
