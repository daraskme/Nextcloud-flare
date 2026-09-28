import { applyD1Migrations, evictDurableObject, runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { CONTROL_NAME } from "../../src/do/controlName";
import { consumeOutbox } from "../../src/jobs/consumeOutbox";
import { dispatchOutbox } from "../../src/jobs/outbox";
import { handleOutboxBatch } from "../../src/jobs/queue";
import { pngCrc } from "../../src/media/images/inspect";
import { auditOwnerLedger } from "../../src/services/refs";
import { davBucket, davPutFixture } from "../fixtures/davPut";
import { imageBytes } from "../fixtures/images/encoded";
import { clearEndedR2TestWrites } from "../fixtures/mutationAdmission";
import { injectBatch } from "../fixtures/uploadEnv";

const control = () => env.CONTROL.get(env.CONTROL.idFromName(CONTROL_NAME));
beforeAll(() => applyD1Migrations(env.DB, env.TEST_MIGRATIONS));
beforeEach(async () => {
  await env.DB.prepare(
    "UPDATE control SET backup_token=NULL,backup_frozen=0,restore_freeze_token=NULL",
  ).run();
  // Only completed synthetic failure callbacks remain here; no real native action is outstanding.
  await env.DB.prepare(
    "UPDATE image_transform_attempts SET state='not_started',finished_at=MAX(started_at,strftime('%s','now')*1000) WHERE state='pending'",
  ).run();
  await clearEndedR2TestWrites();
  await env.DB.prepare("UPDATE control SET epoch=1,maintenance=0,gc_paused=0").run();
  await env.DB.prepare("UPDATE mutation_admissions SET state='closed' WHERE state='active'").run();
  await runInDurableObject(control(), (_, state) => state.storage.deleteAll());
  await evictDurableObject(control());
});
afterEach(() => vi.restoreAllMocks());

async function fixture(bytes = imageBytes("pattern.png")) {
  const f = await davPutFixture(bytes.length);
  const upload = await f.run({}, new Blob([bytes]).stream());
  if (upload.kind !== "terminal") throw new Error("fixture_upload");
  const event = upload.operation.id + "_event";
  const node = (await env.DB.prepare(
    "SELECT id,current_blob_id AS blob FROM nodes WHERE last_op_id=? AND kind='file'",
  )
    .bind(upload.operation.id)
    .first<{ id: string; blob: string }>())!;
  expect(
    await dispatchOutbox(
      f.app,
      { send: async () => ({ metadata: { metrics: { backlogCount: 0, backlogBytes: 0 } } }) },
      event,
      1,
    ),
  ).toBe("sent");
  const input = vi.fn((stream: ReadableStream<Uint8Array>) => env.IMAGES.input(stream));
  const app = { ...f.app, IMAGES: { input } as unknown as ImagesBinding };
  const costs = async () =>
    (
      await env.DB.prepare(
        "SELECT * FROM image_transform_attempts WHERE blob_id=? ORDER BY variant",
      )
        .bind(node.blob)
        .all<Record<string, unknown>>()
    ).results;
  const results = async () =>
    (
      await env.DB.prepare("SELECT * FROM derivative_results WHERE blob_id=? ORDER BY variant")
        .bind(node.blob)
        .all<Record<string, unknown>>()
    ).results;
  const release = () =>
    env.DB.prepare("UPDATE outbox SET claim_expires_at=0 WHERE outbox_id=?").bind(event).run();
  const state = () =>
    env.DB.prepare("SELECT state FROM outbox WHERE outbox_id=?").bind(event).first("state");
  return {
    ...f,
    app,
    node,
    event,
    input,
    costs,
    results,
    release,
    state,
    credentialId: f.input.principal.credential_id.slice(3),
  };
}
function rejectedBinding(code?: number): ImagesBinding {
  return {
    input: (stream: ReadableStream<Uint8Array>) => ({
      transform: () => ({
        output: async () => {
          await new Response(stream).arrayBuffer();
          throw code
            ? Object.assign(new Error("IMAGES_TRANSFORM_ERROR"), { code })
            : new Error("transport unknown");
        },
      }),
    }),
  } as unknown as ImagesBinding;
}

it("generates real sm/md WebP after upload and leaves lg lazy, original bytes and logical usage intact", async () => {
  const f = await fixture();
  const before = await auditOwnerLedger(env.DB, f.ids.user);
  expect(await consumeOutbox(f.app, f.event)).toBe("completed");
  expect(f.input).toHaveBeenCalledTimes(2);
  const outputs = await f.results();
  expect(outputs.map((row) => [row.variant, row.state, row.attempts])).toEqual([
    ["md", "ready", 1],
    ["sm", "ready", 1],
  ]);
  for (const row of outputs) {
    const stored = await env.BLOBS.get(row.r2_key as string);
    expect(stored?.size).toBe(row.size);
    const info = await env.IMAGES.info(stored!.body);
    expect(info).toMatchObject({
      format: "image/webp",
      width: row.variant === "sm" ? 256 : 768,
      height: row.variant === "sm" ? 144 : 432,
    });
  }
  const original = await env.DB.prepare("SELECT r2_key FROM blobs WHERE id=?")
    .bind(f.node.blob)
    .first<string>("r2_key");
  expect(new Uint8Array(await (await env.BLOBS.get(original!))!.arrayBuffer())).toEqual(
    imageBytes("pattern.png"),
  );
  expect(await auditOwnerLedger(env.DB, f.ids.user)).toMatchObject({
    used_bytes: before!.used_bytes,
    image_reserved_bytes: 0,
    incorrect_refs: 0,
    physical_bytes:
      before!.physical_bytes + outputs.reduce((n, row) => n + (row.size as number), 0),
  });
  expect(await consumeOutbox(f.app, f.event)).toBe("completed");
  expect(f.input).toHaveBeenCalledTimes(2);
});

it.each(["stored", "published"])(
  "resumes %s outputs after a lost publication step without paying or PUTting twice",
  async (stage) => {
    const f = await fixture(imageBytes("red.png"));
    const put = vi.fn(env.BLOBS.put.bind(env.BLOBS));
    const db = injectBatch(
      (sql) =>
        sql.includes(
          stage === "stored"
            ? "UPDATE derivative_results SET state='ready'"
            : "INSERT INTO node_media",
        ),
      async () => {
        throw new Error("simulated interruption");
      },
      false,
    );
    const app = { ...f.app, BLOBS: davBucket({ put }) };
    expect(await consumeOutbox({ ...app, DB: db }, f.event)).toBe("retry");
    expect(await f.state()).toBe("sent");
    const initial = await f.costs();
    expect(initial).toHaveLength(stage === "stored" ? 1 : 2);
    await f.release();
    expect(await consumeOutbox(app, f.event)).toBe("completed");
    expect(f.input).toHaveBeenCalledTimes(2);
    expect(put).toHaveBeenCalledTimes(2);
    expect(await f.costs()).toEqual(expect.arrayContaining(initial));
    expect((await f.results()).every((row) => row.state === "ready")).toBe(true);
  },
);

it("recovers a lost terminal ACK without repeating any native operation", async () => {
  const f = await fixture();
  const db = injectBatch(
    (sql) => sql.includes("INSERT INTO node_media"),
    async () => {
      throw new Error("lost ACK");
    },
    true,
  );
  expect(await consumeOutbox({ ...f.app, DB: db }, f.event)).toBe("completed");
  expect(await consumeOutbox(f.app, f.event)).toBe("completed");
  expect(f.input).toHaveBeenCalledTimes(2);
});

it("shares two paid attempts across all deliveries in one Queue invocation", async () => {
  const first = await fixture(),
    second = await fixture();
  const messages = [first, second].map((f) => ({
    body: { outboxId: f.event },
    ack: vi.fn(),
    retry: vi.fn(),
  }));
  expect(await handleOutboxBatch(first.app, { messages })).toEqual({ acked: 1, retried: 1 });
  expect(first.input).toHaveBeenCalledTimes(2);
  expect(await second.costs()).toHaveLength(0);
  expect(messages[0]!.ack).toHaveBeenCalledOnce();
  expect(messages[1]!.retry).toHaveBeenCalledOnce();
  await second.release();
  expect(await handleOutboxBatch(second.app, { messages: [messages[1]!] })).toEqual({
    acked: 1,
    retried: 0,
  });
  expect(second.input).toHaveBeenCalledTimes(2);
});

it("concurrent deliveries publish each variant once", async () => {
  const f = await fixture();
  const results = await Promise.all([consumeOutbox(f.app, f.event), consumeOutbox(f.app, f.event)]);
  expect(results).toContain("completed");
  expect(f.input).toHaveBeenCalledTimes(2);
  expect(await f.costs()).toHaveLength(2);
});

it.each(["animation", "dimensions"])(
  "records unsupported %s without native transform or derivative storage",
  async (kind) => {
    const bytes = imageBytes(kind === "animation" ? "sequence.avif" : "red.png");
    if (kind === "dimensions") {
      new DataView(bytes.buffer).setUint32(16, 12001);
      new DataView(bytes.buffer).setUint32(29, pngCrc(bytes.subarray(12, 29)));
    }
    const f = await fixture(bytes);
    expect(await consumeOutbox(f.app, f.event)).toBe("completed");
    expect(f.input).not.toHaveBeenCalled();
    expect(await f.costs()).toHaveLength(0);
    expect((await f.results()).map((r) => [r.state, r.attempts, r.error_code])).toEqual(
      Array(2).fill(["failed", 0, "image_unsupported_" + (kind === "animation" ? kind : "size")]),
    );
    expect(
      await env.DB.prepare("SELECT width FROM node_media WHERE node_id=?").bind(f.node.id).first(),
    ).not.toBeNull();
  },
);

it.each(["red.png", "red.avif"] as const)(
  "records a known binding rejection for %s and completes without a paid retry",
  async (name) => {
    const f = await fixture(imageBytes(name));
    const binding = rejectedBinding(9520),
      input = vi.fn(binding.input.bind(binding));
    const app = { ...f.app, IMAGES: { input } as unknown as ImagesBinding };
    const db = injectBatch(
      (sql) => sql.includes("INSERT INTO node_media"),
      async () => {
        throw new Error("completion interrupted");
      },
      false,
    );
    expect(await consumeOutbox({ ...app, DB: db }, f.event)).toBe("retry");
    expect((await f.costs()).map((r) => r.state)).toEqual(["failed", "failed"]);
    await f.release();
    expect(await consumeOutbox(app, f.event)).toBe("completed");
    expect(input).toHaveBeenCalledTimes(2);
    expect((await f.results()).map((r) => [r.state, r.attempts, r.error_code])).toEqual(
      Array(2).fill([
        "failed",
        1,
        name === "red.avif" ? "image_unsupported_binding" : "image_transform_failed",
      ]),
    );
  },
);

it("retains an unknown Images outcome and never invokes it again on redelivery", async () => {
  const f = await fixture();
  const binding = rejectedBinding(),
    input = vi.fn(binding.input.bind(binding));
  const app = { ...f.app, IMAGES: { input } as unknown as ImagesBinding };
  expect(await consumeOutbox(app, f.event)).toBe("retry");
  await f.release();
  expect(await consumeOutbox(app, f.event)).toBe("retry");
  expect(input).toHaveBeenCalledOnce();
  expect(await f.costs()).toMatchObject([{ state: "pending", variant: "sm" }]);
  expect(await f.results()).toHaveLength(0);
});

it("keeps an unknown derivative PUT held across Queue redelivery", async () => {
  const f = await fixture(imageBytes("red.png"));
  const put = vi.fn(async () => {
    throw new Error("unknown PUT response");
  });
  const app = { ...f.app, BLOBS: davBucket({ put: put as unknown as R2Bucket["put"] }) };
  expect(await consumeOutbox(app, f.event)).toBe("retry");
  await f.release();
  expect(await consumeOutbox(app, f.event)).toBe("retry");
  expect(put).toHaveBeenCalledOnce();
  expect(f.input).toHaveBeenCalledOnce();
  expect(await f.costs()).toMatchObject([{ state: "succeeded", variant: "sm" }]);
  const results = await f.results();
  expect(results).toMatchObject([{ state: "running" }]);
  expect(
    await env.DB.prepare(
      "SELECT state FROM r2_write_attempts WHERE kind='image.put' AND owner_id=?",
    )
      .bind(f.ids.user)
      .first("state"),
  ).toBe("pending");
  expect(await auditOwnerLedger(env.DB, f.ids.user)).toMatchObject({
    image_reserved_bytes: results[0]!.size,
    incorrect_refs: 0,
  });
});

it("does not call Images after current authorization is revoked during original GET", async () => {
  const f = await fixture();
  const get: R2Bucket["get"] = (async (...args: Parameters<R2Bucket["get"]>) => {
    const result = await env.BLOBS.get(...args);
    if (!(args[1] && "range" in args[1]))
      await env.DB.prepare("UPDATE app_passwords SET revoked_at=? WHERE id=?")
        .bind(Date.now(), f.credentialId)
        .run();
    return result;
  }) as R2Bucket["get"];
  expect(await consumeOutbox({ ...f.app, BLOBS: davBucket({ get }) }, f.event)).toBe("retry");
  expect(f.input).not.toHaveBeenCalled();
  expect(await f.results()).toHaveLength(0);
  expect(await f.state()).toBe("sent");
  expect(await f.costs()).toMatchObject([{ state: "not_started", variant: "sm" }]);
});

it("retries a proven pre-Images GET failure with a new claim, without retaining an unknown cost", async () => {
  const f = await fixture();
  const get = (async (...args: Parameters<R2Bucket["get"]>) => {
    if (!(args[1] && "range" in args[1])) throw new Error("original GET unavailable");
    return env.BLOBS.get(...args);
  }) as R2Bucket["get"];
  expect(await consumeOutbox({ ...f.app, BLOBS: davBucket({ get }) }, f.event)).toBe("retry");
  expect(f.input).not.toHaveBeenCalled();
  expect(await f.costs()).toMatchObject([{ state: "not_started" }]);
  await f.release();
  expect(await consumeOutbox(f.app, f.event)).toBe("completed");
  expect(f.input).toHaveBeenCalledTimes(2);
  expect((await f.costs()).map((r) => r.state).sort()).toEqual([
    "not_started",
    "succeeded",
    "succeeded",
  ]);
});

it.each(["credential", "claim", "parent"])(
  "does not finish the event when %s changes after both outputs were stored",
  async (change) => {
    const f = await fixture();
    const db = injectBatch(
      (sql) => sql.includes("INSERT INTO node_media"),
      async () => {
        if (change === "credential")
          await env.DB.prepare("UPDATE app_passwords SET revoked_at=? WHERE id=?")
            .bind(Date.now(), f.credentialId)
            .run();
        if (change === "claim")
          await env.DB.prepare("UPDATE outbox SET claim_token='replacement' WHERE outbox_id=?")
            .bind(f.event)
            .run();
        if (change === "parent")
          await env.DB.prepare("UPDATE nodes SET parent_id=? WHERE id=?")
            .bind(f.ids.root, f.node.id)
            .run();
      },
      false,
    );
    expect(await consumeOutbox({ ...f.app, DB: db }, f.event)).toBe("retry");
    expect(await f.state()).toBe("sent");
    expect(
      await env.DB.prepare("SELECT 1 FROM node_media WHERE node_id=?").bind(f.node.id).first(),
    ).toBeNull();
    expect(f.input).toHaveBeenCalledTimes(2);
  },
);

it("generates through the actual ControlDO RPC and admission then survives eviction", async () => {
  const f = await fixture();
  const mirror = (await env.DB.prepare(
    "SELECT admission_revision,admission_token,gc_paused,gc_operator_paused,gc_hold_token,gc_hold_operation,gc_hold_expires_at FROM control WHERE singleton=1",
  ).first<Record<string, string | number | null>>())!;
  await runInDurableObject(control(), (_, state) => {
    state.storage.sql.exec("UPDATE control_state SET phase='ready',epoch=1 WHERE singleton=1");
    state.storage.sql.exec(
      "UPDATE control_admission SET epoch=1,revision=?,token=?,phase='open',gc_paused=? WHERE singleton=1",
      mirror.admission_revision!,
      mirror.admission_token!,
      mirror.gc_paused!,
    );
    state.storage.sql.exec(
      "UPDATE control_gc_policy SET epoch=1,operator_paused=?,hold_token=?,hold_operation=?,hold_expires_at=?,prior_gc_paused=? WHERE singleton=1",
      mirror.gc_operator_paused!,
      mirror.gc_hold_token!,
      mirror.gc_hold_operation!,
      mirror.gc_hold_expires_at!,
      mirror.gc_paused!,
    );
  });
  const db = injectBatch(
    (sql) => sql.includes("INSERT INTO node_media"),
    async () => {
      throw new Error("interrupted");
    },
    false,
  );
  expect(await consumeOutbox({ ...env, DB: db, IMAGES: f.app.IMAGES }, f.event)).toBe("retry");
  expect(await f.costs()).toHaveLength(2);
  await f.release();
  await evictDurableObject(control());
  expect(await consumeOutbox({ ...env, IMAGES: f.app.IMAGES }, f.event)).toBe("completed");
  expect(f.input).toHaveBeenCalledTimes(2);
});
