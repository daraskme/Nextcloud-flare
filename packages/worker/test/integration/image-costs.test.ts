import { applyD1Migrations, evictDurableObject, runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import {
  type ImageTransformGrant,
  type ImageTransformRequest,
  imageOutputJson,
} from "../../src/db/imageTransform";
import { atomicBatch } from "../../src/db/primary";
import { ControlImageTransforms } from "../../src/do/controlImageTransforms";
import { CONTROL_NAME } from "../../src/do/controlName";
import { openImageObject } from "../../src/media/images/objectStream";
import {
  IMAGE_TRANSFORM_GENERATOR,
  planImageTransform,
  transformImage,
} from "../../src/media/images/transform";
import { trackedImageTransform } from "../../src/services/imageTransform";
import { davPutFixture } from "../fixtures/davPut";
import { imageBytes } from "../fixtures/images/encoded";
import { acquireGlobalMutation, acquireMutation } from "../fixtures/mutationAdmission";
import { injectBatch } from "../fixtures/uploadEnv";

const control = () => env.CONTROL.get(env.CONTROL.idFromName(CONTROL_NAME));
const output = () => ({
  bytes: imageBytes("red.webp"),
  mime: "image/webp" as const,
  width: 16,
  height: 12,
  sha256: "a".repeat(64),
});
const receipt = () => ({ bytes: 68, width: 16, height: 12, sha256: "a".repeat(64) });
const row = (id: string) =>
  env.DB.prepare("SELECT * FROM image_transform_attempts WHERE id=?")
    .bind(id)
    .first<Record<string, unknown>>();
const ledger = (state: DurableObjectState, db = env.DB, current = () => {}) =>
  new ControlImageTransforms(
    state.storage,
    db,
    current,
    (request) => acquireMutation(request),
    async () =>
      acquireGlobalMutation({
        permitId: `global:images.settle:${crypto.randomUUID()}`,
        epoch: (await env.DB.prepare("SELECT epoch FROM control WHERE singleton=1").first<number>(
          "epoch",
        ))!,
        deadline: Date.now() + 5000,
      }),
  );
const invoke = <T>(action: (l: ControlImageTransforms) => Promise<T>, db = env.DB) =>
  runInDurableObject(control(), (_, state) => action(ledger(state, db)));
const begin = (r: ImageTransformRequest) => invoke((l) => l.begin(r));
const finish = (
  g: ImageTransformGrant,
  state: "succeeded" | "not_started",
  out = state === "succeeded" ? receipt() : null,
) => invoke((l) => l.finish(g, state, out));
const app = () => ({
  ...env,
  CONTROL: {
    idFromName: env.CONTROL.idFromName.bind(env.CONTROL),
    get: () => ({ beginImageTransform: begin, finishImageTransform: finish }),
  } as unknown as typeof env.CONTROL,
});

beforeAll(() => applyD1Migrations(env.DB, env.TEST_MIGRATIONS));
beforeEach(async () => {
  // Every fake native action from the preceding test has ended; only isolated fixture holds are reset.
  await env.DB.prepare(
    "UPDATE image_transform_attempts SET state='not_started',finished_at=MAX(started_at,strftime('%s','now')*1000) WHERE state='pending'",
  ).run();
  await env.DB.prepare(
    "UPDATE control SET epoch=1,maintenance=0,gc_paused=0,backup_token=NULL,backup_frozen=0,restore_freeze_token=NULL",
  ).run();
  await env.DB.prepare("UPDATE mutation_admissions SET state='closed' WHERE state='active'").run();
  await runInDurableObject(control(), (_, state) => state.storage.deleteAll());
  await evictDurableObject(control());
});
afterEach(() => vi.restoreAllMocks());

async function fixture() {
  const bytes = imageBytes("red.png"),
    f = await davPutFixture(bytes.length);
  const result = await f.run({}, new Blob([bytes]).stream());
  if (result.kind !== "terminal" || result.operation.state !== "committed")
    throw new Error("fixture_upload_failed");
  const op = result.operation.id,
    node =
      await env.DB.prepare(`SELECT n.id,n.current_blob_id AS blob,b.r2_key AS key,b.size,s.r2_etag AS etag
    FROM nodes n JOIN blobs b ON b.id=n.current_blob_id JOIN blob_storage s ON s.blob_id=b.id
    WHERE n.last_op_id=? AND n.kind='file'`)
        .bind(op)
        .first<{ id: string; blob: string; key: string; size: number; etag: string }>();
  if (!node) throw new Error("fixture_node_missing");
  const claimToken = crypto.randomUUID(),
    outboxId = op + "_event";
  await env.DB.prepare(
    "UPDATE outbox SET state='sent',claim_token=?,claim_expires_at=? WHERE outbox_id=?",
  )
    .bind(claimToken, Date.now() + 30000, outboxId)
    .run();
  const request = (): ImageTransformRequest => ({
    id: crypto.randomUUID(),
    epoch: 1,
    ownerId: f.ids.user,
    blobId: node.blob,
    outboxId,
    claimToken,
    variant: "sm",
    generator: IMAGE_TRANSFORM_GENERATOR,
    deadline: Date.now() + 5000,
    expiresAt: Date.now() + 24000,
    source: {
      nodeId: node.id,
      parentId: f.ids.folder,
      key: node.key,
      etag: node.etag,
      size: node.size,
      width: 16,
      height: 12,
    },
  });
  return { ...f, node, request };
}
async function rewind(
  g: ImageTransformGrant,
  changes: Record<string, string | number | null> = {},
) {
  const sql = (await env.DB.prepare(
    "SELECT sql FROM sqlite_master WHERE name='image_attempt_immutable'",
  ).first<string>("sql"))!;
  await atomicBatch(env.DB, [
    { sql: "DROP TRIGGER image_attempt_immutable" },
    {
      sql: `UPDATE image_transform_attempts SET state='pending',finished_at=NULL,output_json=NULL${Object.keys(
        changes,
      )
        .map((k) => `,${k}=?`)
        .join("")} WHERE id=?`,
      values: [...Object.values(changes), g.id],
    },
    { sql },
  ]);
}

it("records a native result once and rejects a second transform of the same tuple", async () => {
  const f = await fixture(),
    g = await begin(f.request());
  expect(await row(g.id)).toMatchObject({ state: "pending", blob_id: f.node.blob });
  await finish(g, "succeeded");
  await finish(g, "succeeded");
  expect(await row(g.id)).toMatchObject({
    state: "succeeded",
    output_json: imageOutputJson(g, receipt()),
  });
  await expect(begin(f.request())).rejects.toThrow();
  await invoke(async (l) => l.assertEmpty());
});
it("uses independent claims for variants without permitting duplicate concurrent cost", async () => {
  const f = await fixture();
  const results = await Promise.allSettled([begin(f.request()), begin(f.request())]);
  expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
  for (const r of results) if (r.status === "fulfilled") await finish(r.value, "not_started");
  const g = await begin({ ...f.request(), variant: "md" });
  await finish(g, "succeeded");
});
it("releases only a proven not-started cost and retains its immutable terminal proof", async () => {
  const f = await fixture(),
    g = await begin(f.request());
  await finish(g, "not_started");
  const next = await begin(f.request());
  await finish(next, "succeeded");
  expect(await row(g.id)).toMatchObject({ state: "not_started" });
  await expect(finish(g, "succeeded")).rejects.toThrow("conflict");
  await expect(
    env.DB.prepare("DELETE FROM image_transform_attempts WHERE id=?").bind(g.id).run(),
  ).rejects.toThrow();
});
it.each(["claim", "etag", "parent", "blob", "credential"])(
  "rejects changed %s authority before granting native work",
  async (kind) => {
    const f = await fixture(),
      r = f.request();
    if (kind === "claim") r.claimToken = crypto.randomUUID();
    if (kind === "etag") r.source.etag = "replaced";
    if (kind === "parent") r.source.parentId = f.ids.root;
    if (kind === "blob") {
      r.blobId = f.ids.blob;
      r.source.key = `u/${r.ownerId}/b/${r.blobId}`;
    }
    if (kind === "credential")
      await env.DB.prepare("UPDATE app_passwords SET revoked_at=? WHERE id=?")
        .bind(Date.now(), f.input.principal.credential_id.slice(3))
        .run();
    await expect(begin(r)).rejects.toThrow();
    expect(await row(r.id)).toMatchObject({ state: "not_started" });
    await invoke(async (l) => l.assertEmpty());
  },
);
it("does not dispatch after a lost grant reply", async () => {
  const f = await fixture();
  let grant: ImageTransformGrant | undefined;
  const configured = app();
  configured.CONTROL.get = (() => ({
    beginImageTransform: async (r: ImageTransformRequest) => {
      grant = await begin(r);
      throw new Error("lost grant");
    },
    finishImageTransform: finish,
  })) as unknown as typeof configured.CONTROL.get;
  const action = vi.fn(async () => output());
  await expect(
    trackedImageTransform(configured, f.request(), action, async () => {}),
  ).rejects.toThrow("lost grant");
  expect(action).not.toHaveBeenCalled();
  expect(await row(grant!.id)).toMatchObject({ state: "pending" });
  await invoke(async (l) => expect(() => l.assertEmpty()).toThrow("unsettled"));
  await finish(grant!, "not_started");
});
it("does not dispatch after failed last-minute authority and permits a fresh grant", async () => {
  const f = await fixture(),
    action = vi.fn(async () => output());
  await expect(
    trackedImageTransform(app(), f.request(), action, async () => {
      throw new Error("revoked");
    }),
  ).rejects.toThrow("revoked");
  expect(action).not.toHaveBeenCalled();
  expect(await trackedImageTransform(app(), f.request(), action, async () => {})).toEqual(output());
  expect(action).toHaveBeenCalledTimes(1);
});
it("keeps a rejected native action unknown, never retries or clears it by age", async () => {
  const f = await fixture(),
    action = vi.fn(async () => {
      throw new Error("native response lost");
    });
  await expect(trackedImageTransform(app(), f.request(), action, async () => {})).rejects.toThrow(
    "native response lost",
  );
  expect(action).toHaveBeenCalledTimes(1);
  await evictDurableObject(control());
  expect(await invoke((l) => l.repair())).toMatchObject({ pending: 1, unknown: 1, reconciled: 0 });
  await expect(begin(f.request())).rejects.toThrow();
});
it("recovers an acknowledged native result after the finish RPC reply is lost", async () => {
  const f = await fixture(),
    configured = app(),
    action = vi.fn(async () => output());
  configured.CONTROL.get = (() => ({
    beginImageTransform: begin,
    finishImageTransform: async (...args: Parameters<typeof finish>) => {
      await finish(...args);
      throw new Error("finish ACK lost");
    },
  })) as unknown as typeof configured.CONTROL.get;
  expect(await trackedImageTransform(configured, f.request(), action, async () => {})).toEqual(
    output(),
  );
  expect(action).toHaveBeenCalledTimes(1);
});
it("retains a successful native receipt through eviction and repairs a D1 rollback", async () => {
  const f = await fixture(),
    g = await begin(f.request());
  await finish(g, "succeeded");
  await rewind(g);
  await evictDurableObject(control());
  expect(await invoke((l) => l.repair())).toMatchObject({ reconciled: 1, pending: 0, unknown: 0 });
  expect(await row(g.id)).toMatchObject({ state: "succeeded" });
  await expect(begin(f.request())).rejects.toThrow();
});
it("also retains never-dispatched evidence through a D1 rollback", async () => {
  const f = await fixture(),
    g = await begin(f.request());
  await finish(g, "not_started");
  await rewind(g);
  await evictDurableObject(control());
  expect(await invoke((l) => l.repair())).toMatchObject({ reconciled: 1, pending: 0 });
  expect(await row(g.id)).toMatchObject({ state: "not_started" });
});
it("does not apply a native receipt to a substituted D1 identity", async () => {
  const f = await fixture(),
    g = await begin(f.request());
  await finish(g, "succeeded");
  await rewind(g, { token: crypto.randomUUID() });
  expect(await invoke((l) => l.repair())).toMatchObject({ reconciled: 0 });
  expect(await row(g.id)).toMatchObject({ state: "pending" });
});
it("retains local terminal evidence when D1 settlement fails, then repairs without transforming", async () => {
  const f = await fixture(),
    g = await begin(f.request());
  await env.DB.prepare(
    "CREATE TRIGGER fixture_image_failure BEFORE UPDATE ON image_transform_attempts BEGIN SELECT RAISE(ABORT,'fixture'); END",
  ).run();
  await expect(finish(g, "succeeded")).rejects.toThrow("unsettled");
  await evictDurableObject(control());
  await invoke(async (l) => expect(() => l.assertEmpty()).toThrow("unsettled"));
  await env.DB.prepare("DROP TRIGGER fixture_image_failure").run();
  expect(await invoke((l) => l.repair())).toMatchObject({ reconciled: 1, pending: 0 });
});
it("does not expose a grant whose D1 claim acknowledgement was lost", async () => {
  const f = await fixture(),
    r = f.request();
  const db = injectBatch(
    (sql) => sql.includes("INSERT INTO image_transform_attempts"),
    async () => {
      throw new Error("claim ACK lost");
    },
    true,
  );
  await expect(invoke((l) => l.begin(r), db)).rejects.toThrow("claim ACK lost");
  expect(await row(r.id)).toMatchObject({ state: "not_started" });
});
it("settles actual completion after maintenance begins, but blocks restart while pending", async () => {
  const f = await fixture(),
    g = await begin(f.request());
  await env.DB.prepare("UPDATE control SET maintenance=1,gc_paused=1").run();
  await expect(env.DB.prepare("UPDATE control SET maintenance=0").run()).rejects.toThrow(
    "image_transform_unsettled",
  );
  await finish(g, "succeeded");
  await env.DB.prepare("UPDATE control SET maintenance=0").run();
});
it("closes backup and recovery audit before a pending transform can be forgotten", async () => {
  const f = await fixture(),
    g = await begin(f.request());
  await runInDurableObject(control(), (_, state) =>
    state.storage.sql.exec("UPDATE control_state SET phase='ready',epoch=1 WHERE singleton=1"),
  );
  const errors = await runInDurableObject(control(), async (instance) => {
    const found: string[] = [];
    for (const action of [
      () => instance.beginBackup(1, crypto.randomUUID()),
      () => instance.nextRecoveryAuditPage(1),
    ]) {
      try {
        await action();
        found.push("unexpected_success");
      } catch (error) {
        found.push(String(error));
      }
    }
    return found;
  });
  expect(errors).toEqual(["Error: image_transform_unsettled", "Error: image_transform_unsettled"]);
  await finish(g, "succeeded");
});
it("rejects altered completion output and another claim token", async () => {
  const f = await fixture(),
    g = await begin(f.request());
  await expect(finish({ ...g, token: crypto.randomUUID() }, "succeeded")).rejects.toThrow(
    "conflict",
  );
  await expect(finish(g, "succeeded", { ...receipt(), width: 17 })).rejects.toThrow(
    "invalid_image_transform_output",
  );
  expect(await row(g.id)).toMatchObject({ state: "pending" });
  await finish(g, "not_started");
});
it("performs a real R2/Images transformation under the durable cost record", async () => {
  const f = await fixture(),
    bytes = imageBytes("red.png");
  const plan = await planImageTransform(
    { size: bytes.length, read: async (offset, length) => bytes.slice(offset, offset + length) },
    "sm",
  );
  const transformed = await trackedImageTransform(
    app(),
    f.request(),
    async (signal) => {
      const input = await openImageObject(env.BLOBS, f.node, signal, async () => {});
      return transformImage(env.IMAGES, plan, input, signal);
    },
    async () => {},
  );
  expect(transformed).toMatchObject({ mime: "image/webp", width: 16, height: 12 });
  expect(
    await env.DB.prepare(
      "SELECT state,output_json FROM image_transform_attempts WHERE blob_id=? AND state='succeeded'",
    )
      .bind(f.node.blob)
      .first(),
  ).toEqual({
    state: "succeeded",
    output_json: JSON.stringify({
      bytes: transformed.bytes.length,
      width: 16,
      height: 12,
      sha256: transformed.sha256,
    }),
  });
});

it("runs through the real ControlDO admission and completion methods", async () => {
  const f = await fixture();
  // Initialize only the isolated coordinator fixture's already-open epoch and matching D1 mirror.
  const mirror = await env.DB.prepare(
    "SELECT admission_revision,admission_token,gc_paused,gc_operator_paused,gc_hold_token,gc_hold_operation,gc_hold_expires_at FROM control WHERE singleton=1",
  ).first<{
    admission_revision: number;
    admission_token: string | null;
    gc_paused: number;
    gc_operator_paused: number;
    gc_hold_token: string | null;
    gc_hold_operation: string | null;
    gc_hold_expires_at: number | null;
  }>();
  await runInDurableObject(control(), (_, state) => {
    state.storage.sql.exec("UPDATE control_state SET phase='ready',epoch=1 WHERE singleton=1");
    state.storage.sql.exec(
      "UPDATE control_admission SET epoch=1,revision=?,token=?,phase='open',gc_paused=? WHERE singleton=1",
      mirror!.admission_revision,
      mirror!.admission_token,
      mirror!.gc_paused,
    );
    state.storage.sql.exec(
      "UPDATE control_gc_policy SET epoch=1,operator_paused=?,hold_token=?,hold_operation=?,hold_expires_at=?,prior_gc_paused=? WHERE singleton=1",
      mirror!.gc_operator_paused,
      mirror!.gc_hold_token,
      mirror!.gc_hold_operation,
      mirror!.gc_hold_expires_at,
      mirror!.gc_paused,
    );
  });
  const result = await runInDurableObject(control(), async (instance) => {
    try {
      const g = await instance.beginImageTransform(f.request());
      await instance.finishImageTransform(g, "succeeded", receipt());
      return { id: g.id, error: null };
    } catch (error) {
      return { id: null, error: String(error) };
    }
  });
  expect(result.error).toBeNull();
  expect(await row(result.id!)).toMatchObject({ state: "succeeded" });
});
it("rechecks saved authority in the same transaction as cost admission", async () => {
  const f = await fixture(),
    r = f.request();
  const db = injectBatch(
    (sql) => sql.includes("INSERT INTO image_transform_attempts"),
    async () => {
      await env.DB.prepare("UPDATE app_passwords SET revoked_at=? WHERE id=?")
        .bind(Date.now(), f.input.principal.credential_id.slice(3))
        .run();
    },
    false,
  );
  await expect(invoke((l) => l.begin(r), db)).rejects.toThrow();
  expect(await row(r.id)).toMatchObject({ state: "not_started" });
});
it("bounds unresolved native work to eight slots and preserves the ninth cost", async () => {
  const grants: ImageTransformGrant[] = [];
  for (let n = 0; n < 8; n++) grants.push(await begin((await fixture()).request()));
  const f = await fixture(),
    request = f.request();
  await expect(begin(request)).rejects.toThrow("capacity");
  expect(await row(request.id)).toBeNull();
  await finish(grants[0]!, "not_started");
  const next = await begin(f.request());
  await finish(next, "succeeded");
  for (const g of grants.slice(1)) await finish(g, "not_started");
});
it("does not discard old cost evidence when the bounded permanent ledger is full", async () => {
  const f = await fixture();
  await runInDurableObject(control(), (_, state) => {
    state.storage.sql.exec(
      "UPDATE control_image_transform_usage SET entries=1000000 WHERE singleton=1",
    );
  });
  await expect(begin(f.request())).rejects.toThrow();
  expect(
    await env.DB.prepare("SELECT 1 FROM image_transform_attempts WHERE blob_id=?")
      .bind(f.node.blob)
      .first(),
  ).toBeNull();
});
it("records a late actual result after caller timeout without returning it for publication", async () => {
  const f = await fixture();
  let complete!: () => void;
  const action = vi.fn(async () => {
    await new Promise<void>((resolve) => {
      complete = resolve;
    });
    return output();
  });
  const request = { ...f.request(), expiresAt: Date.now() + 1500 };
  const pending = trackedImageTransform(app(), request, action, async () => {});
  const rejected = expect(pending).rejects.toThrow("deadline");
  await vi.waitFor(() => expect(action).toHaveBeenCalledTimes(1));
  await rejected;
  const saved = await env.DB.prepare(
    "SELECT id,state FROM image_transform_attempts WHERE blob_id=?",
  )
    .bind(f.node.blob)
    .first<{ id: string; state: string }>();
  expect(saved!.state).toBe("pending");
  complete();
  await vi.waitFor(async () => expect(await row(saved!.id)).toMatchObject({ state: "succeeded" }));
  await expect(begin(f.request())).rejects.toThrow();
  expect(action).toHaveBeenCalledTimes(1);
});
