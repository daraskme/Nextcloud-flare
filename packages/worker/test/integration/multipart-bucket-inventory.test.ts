import { applyD1Migrations, runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { atomicBatch } from "../../src/db/primary";
import { CONTROL_NAME, ControlDO } from "../../src/do/ControlDO";
import { EPOCH_PREFIX } from "../../src/do/epochHistory";
import { RECOVERY_FINAL_QUERY } from "../../src/do/recoveryAudit";
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
    "UPDATE multipart_bucket_scan SET epoch=1,round_id=?,cursor_key=NULL,cursor_upload_id=NULL,pages=0,completed_at=NULL",
  )
    .bind(crypto.randomUUID())
    .run();
});
afterEach(() => vi.restoreAllMocks());

async function fixture(createOwner = true, keyOverride?: string) {
  const f = foundationFixture(crypto.randomUUID(), Date.now() - 1000);
  if (createOwner) await atomicBatch(env.DB, f.statements);
  const key = keyOverride ?? `u/${f.ids.user}/b/lost-${crypto.randomUUID()}`;
  const handle = await env.BLOBS.createMultipartUpload(key);
  await handle.uploadPart(1, new TextEncoder().encode("abc"));
  return { ...f, key, handle };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
const currentScan = () => env.DB.prepare("SELECT * FROM multipart_bucket_scan").first();
const stored = (id: string) =>
  env.DB.prepare("SELECT * FROM multipart_bucket_handles WHERE id=?").bind(id).first();
const physical = (f: Fixture) =>
  env.DB.prepare("SELECT physical_bytes FROM users WHERE id=?")
    .bind(f.ids.user)
    .first("physical_bytes");
const probe = async () => new Response((await env.BLOBS.get(BINDING_PROBE_KEY))!.body);
function client(f: Fixture, jurisdiction: "default" | "eu" = "default") {
  const uploads = vi.fn(
    async (_request: Request) =>
      new Response(uploadsXml({ uploads: uploadXml(f.key, f.handle.uploadId) })),
  );
  const parts = vi.fn(
    async (_request: Request) =>
      new Response(partsXml({ key: f.key, uploadId: f.handle.uploadId, parts: partXml(1, 3) })),
  );
  const binding = vi.fn(probe);
  const fetch = (request: Request) => {
    const url = new URL(request.url);
    if (url.pathname.endsWith(`/${BINDING_PROBE_KEY}`)) return binding();
    return url.searchParams.has("uploads") ? uploads(request) : parts(request);
  };
  return {
    inventory: new R2S3Inventory(
      { ...inventoryEnv, R2_INVENTORY_JURISDICTION: jurisdiction },
      { fetch },
    ),
    uploads,
    parts,
    binding,
    fetch,
  };
}
const scan = (s3: ReturnType<typeof client>, db = env.DB) =>
  scanMultipartBucket(db, env.BLOBS, s3.inventory, 1);
const observe = (s3: ReturnType<typeof client>, id: string, db = env.DB) =>
  observeMultipartBucketParts(db, env.BLOBS, s3.inventory, 1, id);
const discover = async (s3: ReturnType<typeof client>) => (await scan(s3)).handles[0]!.id;

async function seedUpload(f: Fixture, uploadId: string | null = f.handle.uploadId) {
  const id = `up_${crypto.randomUUID().replaceAll("-", "").repeat(2)}`;
  await atomicBatch(env.DB, [
    {
      sql: "INSERT INTO reservations(id,owner_id,bytes,state,expires_at,epoch) VALUES(?,?,3,'reserved',?,1)",
      values: [id, f.ids.user, Date.now() + 600000],
    },
    {
      sql: "INSERT INTO blobs(id,owner_id,r2_key,size,content_etag,state,created_at) VALUES(?,?,?,3,?,'staging',1)",
      values: [id, f.ids.user, f.key, `\"${id}\"`],
    },
    {
      sql: `INSERT INTO uploads(id,owner_id,space_id,parent_id,blob_id,credential_id,reservation_id,mode,state,declared_size,
      capability_hash,epoch,created_at,expires_at,last_progress_at,upload_name,request_digest,capability_kid,
      write_attempt_id,write_lease_expires_at,r2_upload_id,part_bytes,part_count)
      VALUES(?,?,?,?,?,?,?,'multipart','uploading',3,'fixture',1,1,?,1,'lost.bin','fixture','fixture','attempt',0,?,67108864,1)`,
      values: [
        id,
        f.ids.user,
        f.ids.space,
        f.ids.folder,
        id,
        f.ids.credential,
        id,
        Date.now() + 600000,
        uploadId,
      ],
    },
  ]);
  return id;
}

it("finds a multipart without an upload row and charges observed parts without publishing or aborting it", async () => {
  const f = await fixture();
  const s3 = client(f);
  const result = await scan(s3);
  expect(result).toMatchObject({
    examined: 1,
    completed: true,
    handles: [{ state: "quarantined" }],
  });
  const id = result.handles[0]!.id;
  expect(id).not.toBe(f.handle.uploadId);
  expect(await stored(id)).toMatchObject({
    owner_id: f.ids.user,
    held_bytes: 0,
    part_round_id: null,
  });
  expect(await observe(s3, id)).toEqual({ observed: 1, heldBytes: 3, completed: true });
  expect(await physical(f)).toBe(3);
  expect(await auditOwnerLedger(env.DB, f.ids.user)).toMatchObject({
    physical_bytes: 3,
    observed_physical_bytes: 3,
    reserved_bytes: 0,
  });
  expect(await env.DB.prepare("SELECT 1 FROM blobs WHERE r2_key=?").bind(f.key).first()).toBeNull();
  await expect(f.handle.uploadPart(1, new TextEncoder().encode("abc"))).resolves.toMatchObject({
    partNumber: 1,
  });
  expect(s3.binding).toHaveBeenCalledTimes(2);
});

it("persists both upload markers and rejects a same-key cycle from an older page atomically", async () => {
  const f = await fixture();
  const extra = await env.BLOBS.createMultipartUpload(f.key);
  const s3 = client(f);
  s3.uploads.mockImplementationOnce(
    async () =>
      new Response(
        uploadsXml({
          uploads: uploadXml(f.key, f.handle.uploadId),
          truncated: true,
          nextKey: f.key,
          nextId: f.handle.uploadId,
        }),
      ),
  );
  expect(await scan(s3)).toMatchObject({ completed: false });
  s3.uploads.mockImplementationOnce(async (request) => {
    const query = new URL(request.url).searchParams;
    expect(query.get("key-marker")).toBe(f.key);
    expect(query.get("upload-id-marker")).toBe(f.handle.uploadId);
    return new Response(
      uploadsXml({
        keyMarker: f.key,
        idMarker: f.handle.uploadId,
        uploads: uploadXml(f.key, extra.uploadId),
        truncated: true,
        nextKey: f.key,
        nextId: extra.uploadId,
      }),
    );
  });
  await scan(s3);
  const previous = await currentScan();
  s3.uploads.mockImplementationOnce(
    async () =>
      new Response(
        uploadsXml({
          keyMarker: f.key,
          idMarker: extra.uploadId,
          uploads: uploadXml(f.key, f.handle.uploadId),
        }),
      ),
  );
  await expect(scan(s3)).rejects.toThrow();
  expect(await currentScan()).toMatchObject({ ...previous, calls: Number(previous!.calls) + 1 });
});

it("tracks only the exact known key/ID and quarantines extra IDs at the same key", async () => {
  const f = await fixture();
  await seedUpload(f);
  const extra = await env.BLOBS.createMultipartUpload(f.key);
  const s3 = client(f);
  s3.uploads.mockImplementation(
    async () =>
      new Response(
        uploadsXml({
          uploads: uploadXml(f.key, f.handle.uploadId) + uploadXml(f.key, extra.uploadId),
        }),
      ),
  );
  const result = await scan(s3);
  expect(result.handles.map((h) => h.state)).toEqual(["tracked", "quarantined"]);
  await expect(observe(s3, result.handles[0]!.id)).rejects.toThrow();
  expect(s3.parts).not.toHaveBeenCalled();
  expect(await physical(f)).toBe(0);
});

it("keeps a handle quarantined when its late initialization ID appears in D1", async () => {
  const f = await fixture();
  const upload = await seedUpload(f, null);
  const s3 = client(f);
  const id = await discover(s3);
  await env.DB.prepare("UPDATE uploads SET r2_upload_id=? WHERE id=?")
    .bind(f.handle.uploadId, upload)
    .run();
  expect(await scan(s3)).toMatchObject({ handles: [{ id, state: "quarantined" }] });
  await observe(s3, id);
  expect(await auditOwnerLedger(env.DB, f.ids.user)).toMatchObject({
    physical_bytes: 3,
    observed_physical_bytes: 3,
    reserved_bytes: 3,
  });
});

it("attaches a restored owner exactly once and keeps malformed keys unattributed", async () => {
  const f = await fixture(false);
  const s3 = client(f);
  const id = await discover(s3);
  await observe(s3, id);
  expect(await stored(id)).toMatchObject({ owner_id: null, owner_key: f.ids.user, held_bytes: 3 });
  await atomicBatch(env.DB, f.statements);
  expect(await physical(f)).toBe(3);
  await scan(s3);
  await observe(s3, id);
  expect(await physical(f)).toBe(3);
  const unknown = await fixture(false, `u/unparsed-${crypto.randomUUID()}`);
  const other = client(unknown);
  const otherId = await discover(other);
  await observe(other, otherId);
  expect(await stored(otherId)).toMatchObject({ owner_key: null, owner_id: null, held_bytes: 3 });
});

it("persists part pagination and retains high-water charges for shrinking or disappearing parts", async () => {
  const f = await fixture();
  await f.handle.uploadPart(2, new TextEncoder().encode("defg"));
  const s3 = client(f);
  const id = await discover(s3);
  s3.parts.mockImplementationOnce(
    async () =>
      new Response(
        partsXml({
          key: f.key,
          uploadId: f.handle.uploadId,
          parts: partXml(1, 3),
          truncated: true,
          next: 1,
        }),
      ),
  );
  expect(await observe(s3, id)).toEqual({ observed: 1, heldBytes: 3, completed: false });
  s3.parts.mockImplementationOnce(async (request) => {
    expect(new URL(request.url).searchParams.get("part-number-marker")).toBe("1");
    return new Response(
      partsXml({ key: f.key, uploadId: f.handle.uploadId, marker: 1, parts: partXml(2, 4) }),
    );
  });
  expect(await observe(s3, id)).toEqual({ observed: 1, heldBytes: 7, completed: true });
  await f.handle.uploadPart(1, new TextEncoder().encode("ab"));
  s3.parts.mockImplementationOnce(
    async () =>
      new Response(partsXml({ key: f.key, uploadId: f.handle.uploadId, parts: partXml(1, 2) })),
  );
  expect(await observe(s3, id)).toMatchObject({ heldBytes: 7 });
  await f.handle.uploadPart(1, new TextEncoder().encode("abcde"));
  s3.parts.mockImplementationOnce(
    async () =>
      new Response(partsXml({ key: f.key, uploadId: f.handle.uploadId, parts: partXml(1, 5) })),
  );
  expect(await observe(s3, id)).toMatchObject({ heldBytes: 9 });
  s3.parts.mockImplementationOnce(
    async () => new Response(partsXml({ key: f.key, uploadId: f.handle.uploadId, parts: "" })),
  );
  expect(await observe(s3, id)).toEqual({ observed: 0, heldBytes: 9, completed: true });
  expect(await physical(f)).toBe(9);
  expect(await auditOwnerLedger(env.DB, f.ids.user)).toMatchObject({
    physical_bytes: 9,
    observed_physical_bytes: 9,
  });
});

it.each([404, 503])("keeps recorded bytes on S3 %s and does not infer closure", async (status) => {
  const f = await fixture();
  const s3 = client(f);
  const id = await discover(s3);
  await observe(s3, id);
  s3.parts.mockImplementation(async () => new Response(null, { status }));
  await expect(observe(s3, id)).rejects.toThrow(`s3_inventory_http_${status}`);
  expect(await stored(id)).toMatchObject({
    state: "quarantined",
    held_bytes: 3,
    part_pages: 0,
    parts_completed_at: null,
  });
  expect(await physical(f)).toBe(3);
});

it("rejects a mismatched binding before listing and preserves all existing inventory", async () => {
  const f = await fixture();
  const s3 = client(f);
  const previous = await currentScan();
  s3.binding.mockImplementation(async () => new Response("0".repeat(64)));
  await expect(scan(s3)).rejects.toThrow("r2_binding_mismatch");
  expect(s3.uploads).not.toHaveBeenCalled();
  expect(await currentScan()).toEqual(previous);
});

it.each(["listing", "parts"])(
  "does not dispatch %s after a lost counter acknowledgement",
  async (kind) => {
    const f = await fixture();
    const s3 = client(f);
    const id = await discover(s3);
    s3.uploads.mockClear();
    const db = injectBatch(
      (sql) =>
        sql.includes(kind === "listing" ? "SET calls=calls+1" : "SET part_calls=part_calls+1"),
      async () => {
        throw new Error("lost_ack");
      },
      true,
    );
    await expect(kind === "listing" ? scan(s3, db) : observe(s3, id, db)).rejects.toThrow();
    expect(s3.uploads).not.toHaveBeenCalled();
    expect(s3.parts).not.toHaveBeenCalled();
    expect(await physical(f)).toBe(0);
  },
);

it.each(["listing", "parts"])(
  "fences an expired proof in the same batch as %s observations",
  async (kind) => {
    const f = await fixture();
    const s3 = client(f);
    const id = await discover(s3);
    const db = injectBatch(
      (sql) =>
        sql.includes(
          kind === "listing"
            ? "INSERT INTO multipart_bucket_handles"
            : "INSERT INTO multipart_bucket_parts",
        ),
      async () => {
        await expire();
      },
      false,
    );
    const saved = await stored(id);
    await expect(kind === "listing" ? scan(s3, db) : observe(s3, id, db)).rejects.toThrow();
    expect(await physical(f)).toBe(0);
    expect(await stored(id)).toMatchObject({ held_bytes: 0, last_round_id: saved!.last_round_id });
  },
);

it("resumes a committed listing page after losing its reply", async () => {
  const f = await fixture();
  const s3 = client(f);
  s3.uploads.mockImplementationOnce(
    async () =>
      new Response(
        uploadsXml({
          uploads: uploadXml(f.key, f.handle.uploadId),
          truncated: true,
          nextKey: f.key,
          nextId: f.handle.uploadId,
        }),
      ),
  );
  const db = injectBatch(
    (sql) => sql.includes("SET cursor_key="),
    async () => {
      throw new Error("lost_ack");
    },
    true,
  );
  await expect(scan(s3, db)).rejects.toThrow();
  expect(await currentScan()).toMatchObject({
    pages: 1,
    cursor_key: f.key,
    cursor_upload_id: f.handle.uploadId,
  });
  await expire();
  s3.uploads.mockImplementationOnce(async (request) => {
    expect(new URL(request.url).searchParams.get("upload-id-marker")).toBe(f.handle.uploadId);
    return new Response(uploadsXml({ keyMarker: f.key, idMarker: f.handle.uploadId, uploads: "" }));
  });
  expect(await scan(s3)).toMatchObject({ examined: 0, completed: true });
});

it("resumes a committed part page after reply loss without charging twice", async () => {
  const f = await fixture();
  const s3 = client(f);
  const id = await discover(s3);
  s3.parts.mockImplementationOnce(
    async () =>
      new Response(
        partsXml({
          key: f.key,
          uploadId: f.handle.uploadId,
          parts: partXml(1, 3),
          truncated: true,
          next: 1,
        }),
      ),
  );
  const db = injectBatch(
    (sql) => sql.includes("SET part_marker="),
    async () => {
      throw new Error("lost_ack");
    },
    true,
  );
  await expect(observe(s3, id, db)).rejects.toThrow();
  expect(await physical(f)).toBe(3);
  await expire();
  s3.parts.mockImplementationOnce(async (request) => {
    expect(new URL(request.url).searchParams.get("part-number-marker")).toBe("1");
    return new Response(
      partsXml({ key: f.key, uploadId: f.handle.uploadId, marker: 1, parts: partXml(2, 4) }),
    );
  });
  expect(await observe(s3, id)).toEqual({ observed: 1, heldBytes: 7, completed: true });
  expect(await physical(f)).toBe(7);
});

it("restarts listing after a source change and refuses to observe an old-source handle", async () => {
  const f = await fixture();
  const s3 = client(f);
  s3.uploads.mockImplementationOnce(
    async () =>
      new Response(
        uploadsXml({
          uploads: uploadXml(f.key, f.handle.uploadId),
          truncated: true,
          nextKey: f.key,
          nextId: f.handle.uploadId,
        }),
      ),
  );
  const old = await discover(s3);
  const next = client(f, "eu");
  const result = await scan(next);
  expect(new URL(next.uploads.mock.calls[0]![0].url).searchParams.has("key-marker")).toBe(false);
  expect(result.handles[0]!.id).not.toBe(old);
  await expect(observe(next, old)).rejects.toThrow();
  expect(next.parts).not.toHaveBeenCalled();
  expect(await stored(old)).toMatchObject({ held_bytes: 0 });
});

it("rejects malformed pages without saving partial observations", async () => {
  const f = await fixture();
  const s3 = client(f);
  s3.uploads.mockImplementationOnce(
    async () =>
      new Response(
        uploadsXml({
          uploads: uploadXml(f.key, f.handle.uploadId) + uploadXml(f.key, f.handle.uploadId),
        }),
      ),
  );
  await expect(scan(s3)).rejects.toThrow("invalid_s3_inventory_xml");
  expect(await currentScan()).toMatchObject({ pages: 0 });
  expect(
    await env.DB.prepare("SELECT 1 FROM multipart_bucket_handles WHERE r2_key=?")
      .bind(f.key)
      .first(),
  ).toBeNull();
});

it("persists maximum-size pages and restarts after the last allowed part number", async () => {
  const f = await fixture();
  const s3 = client(f);
  s3.uploads.mockImplementationOnce(
    async () =>
      new Response(
        uploadsXml({
          limit: 100,
          uploads: Array.from({ length: 100 }, (_, i) => uploadXml(f.key, `fixture-${i}`)).join(""),
        }),
      ),
  );
  const result = await scanMultipartBucket(env.DB, env.BLOBS, s3.inventory, 1, 100);
  expect(result).toMatchObject({ examined: 100, completed: true });
  expect(new Set(result.handles.map((h) => h.id)).size).toBe(100);
  const id = result.handles[0]!.id;
  s3.parts.mockImplementationOnce(
    async () =>
      new Response(
        partsXml({
          key: f.key,
          uploadId: "fixture-0",
          limit: 100,
          parts: Array.from({ length: 100 }, (_, i) => partXml(9901 + i, 1)).join(""),
        }),
      ),
  );
  expect(await observeMultipartBucketParts(env.DB, env.BLOBS, s3.inventory, 1, id, 100)).toEqual({
    observed: 100,
    heldBytes: 100,
    completed: true,
  });
  expect(await stored(id)).toMatchObject({ part_marker: 10000 });
  s3.parts.mockImplementationOnce(async (request) => {
    expect(new URL(request.url).searchParams.get("part-number-marker")).toBe("0");
    return new Response(partsXml({ key: f.key, uploadId: "fixture-0", parts: "" }));
  });
  expect(await observe(s3, id)).toEqual({ observed: 0, heldBytes: 100, completed: true });
  expect(await physical(f)).toBe(100);
});

it("serializes observations behind the live proof lease", async () => {
  const f = await fixture();
  const s3 = client(f);
  const id = await discover(s3);
  let dispatched!: () => void;
  let release!: () => void;
  const pending = new Promise<void>((resolve) => {
    dispatched = resolve;
  });
  const waiting = new Promise<void>((resolve) => {
    release = resolve;
  });
  s3.uploads.mockImplementationOnce(async () => {
    dispatched();
    await waiting;
    return new Response(uploadsXml({ uploads: uploadXml(f.key, f.handle.uploadId) }));
  });
  const first = scan(s3);
  await pending;
  try {
    await expect(observe(s3, id)).rejects.toThrow();
    expect(s3.parts).not.toHaveBeenCalled();
  } finally {
    release();
    await first;
  }
  expect(await observe(s3, id)).toMatchObject({ heldBytes: 3 });
  expect(await physical(f)).toBe(3);
});

it("rolls back a part page whose physical charge would overflow safe integers", async () => {
  const f = await fixture();
  const s3 = client(f);
  const id = await discover(s3);
  s3.parts.mockImplementationOnce(
    async () =>
      new Response(
        partsXml({
          key: f.key,
          uploadId: f.handle.uploadId,
          parts: partXml(1, Number.MAX_SAFE_INTEGER) + partXml(2, 1),
        }),
      ),
  );
  await expect(observe(s3, id)).rejects.toThrow();
  expect(await stored(id)).toMatchObject({ held_bytes: 0, part_pages: 0 });
  expect(
    await env.DB.prepare("SELECT COUNT(*) AS n FROM multipart_bucket_parts WHERE handle_id=?")
      .bind(id)
      .first("n"),
  ).toBe(0);
  expect(await physical(f)).toBe(0);
});

it("protects identity, high-water accounting and quarantined keys with database guards", async () => {
  const f = await fixture();
  const s3 = client(f);
  const id = await discover(s3);
  await observe(s3, id);
  for (const sql of [
    "DELETE FROM multipart_bucket_handles WHERE id=?",
    "UPDATE multipart_bucket_handles SET state='tracked' WHERE id=?",
    "UPDATE multipart_bucket_handles SET held_bytes=0 WHERE id=?",
    "UPDATE multipart_bucket_handles SET held_bytes=4 WHERE id=?",
    "UPDATE multipart_bucket_handles SET owner_id=NULL WHERE id=?",
    "DELETE FROM multipart_bucket_parts WHERE handle_id=?",
    "UPDATE multipart_bucket_parts SET bytes=0,observed_bytes=0 WHERE handle_id=?",
  ])
    await expect(env.DB.prepare(sql).bind(id).run()).rejects.toThrow();
  await expect(
    env.DB.prepare(
      "INSERT INTO blobs(id,owner_id,r2_key,size,content_etag,state,created_at) VALUES(?,?,?,3,'etag','staging',1)",
    )
      .bind(crypto.randomUUID(), f.ids.user, f.key)
      .run(),
  ).rejects.toThrow("multipart_key_quarantined");
  expect(await physical(f)).toBe(3);
});

it.each([0, 101, 1.5, Number.NaN])(
  "rejects invalid page limit %s before obtaining a binding proof",
  async (limit) => {
    const s3 = client(await fixture());
    await expect(scanMultipartBucket(env.DB, env.BLOBS, s3.inventory, 1, limit)).rejects.toThrow(
      "invalid_multipart_bucket_limit",
    );
    expect(s3.binding).not.toHaveBeenCalled();
  },
);

it("keeps recovery closed for unfinished scans and zero-byte unknown handles", async () => {
  const db = env.TEST_BOOTSTRAP_LOST;
  await applyD1Migrations(db, env.TEST_MIGRATIONS);
  await db.prepare("UPDATE control SET epoch=1,maintenance=1,gc_paused=1").run();
  const ready = () => db.prepare(RECOVERY_FINAL_QUERY).bind(1).first();
  expect(await ready()).not.toBeNull();
  const f = await fixture();
  const s3 = client(f);
  s3.uploads.mockImplementation(async () => new Response(uploadsXml({ uploads: "" })));
  await scanMultipartBucket(db, env.BLOBS, s3.inventory, 1);
  expect(await ready()).not.toBeNull();
  await db
    .prepare("UPDATE multipart_bucket_scan SET round_id=?,completed_at=NULL,pages=0")
    .bind(crypto.randomUUID())
    .run();
  expect(await ready()).toBeNull();
  await scanMultipartBucket(db, env.BLOBS, s3.inventory, 1);
  expect(await ready()).not.toBeNull();
  s3.uploads.mockImplementation(
    async () => new Response(uploadsXml({ uploads: uploadXml(f.key, f.handle.uploadId) })),
  );
  await scanMultipartBucket(db, env.BLOBS, s3.inventory, 1);
  expect(await ready()).toBeNull();
  await withVerifiedR2Inventory(db, env.BLOBS, s3.inventory, 1, async () => {});
  expect(await ready()).toBeNull();
});

it("connects bucket and part observations through real ControlDO and resets recovery audit", async () => {
  const f = await fixture();
  const s3 = client(f);
  const stub = env.CONTROL.get(env.CONTROL.idFromName(CONTROL_NAME));
  await env.BACKUPS.put(
    `${EPOCH_PREFIX}1.json`,
    JSON.stringify({ epoch: 1, at: 1, reason: "operator" }),
  );
  expect(await stub.recover()).toMatchObject({ epoch: 2 });
  vi.spyOn(globalThis, "fetch").mockImplementation(async (request) => s3.fetch(request as Request));
  await runInDurableObject(stub, async (_instance, state) => {
    const control = new ControlDO(state, { ...env, ...inventoryEnv });
    const result = await control.inventoryMultipartBucket(2);
    expect(result).toMatchObject({
      inventory: { examined: 1 },
      audit: { stage: "users", pages: 0, completed: false },
    });
    expect(
      await control.observeMultipartBucketParts(2, result.inventory.handles[0]!.id),
    ).toMatchObject({
      observation: { heldBytes: 3 },
      audit: { stage: "users", pages: 0, completed: false },
    });
    expect(await control.status()).toMatchObject({ maintenance: true, gcPaused: true });
  });
  expect(await physical(f)).toBe(3);
});
