import { applyD1Migrations } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { base64url } from "jose";
import { afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { publicPrincipal } from "../../src/api/publicShareRead";
import { authorizeNode } from "../../src/auth/authorize";
import { contentKeyRing } from "../../src/auth/contentTokens";
import { UploadCapabilities } from "../../src/auth/uploadCapability";
import { consumeOutbox } from "../../src/jobs/consumeOutbox";
import { dispatchOutbox } from "../../src/jobs/outbox";
import { nodeEventAuthority, readOutboxEvent } from "../../src/jobs/outboxAuthority";
import { IMAGE_METADATA_GENERATOR } from "../../src/media/images/inspect";
import { prepareNodeBlobRead, streamImmutableBlob } from "../../src/services/blobRead";
import { putFile } from "../../src/services/putFile";
import { completeSingleUpload } from "../../src/services/uploads/complete";
import { writeSingleUpload } from "../../src/services/uploads/content";
import { createSingleUpload } from "../../src/services/uploads/create";
import { davBucket, davPutFixture } from "../fixtures/davPut";
import { imageBytes } from "../fixtures/images/encoded";
import { publicShareFixture } from "../fixtures/publicShare";
import { injectBatch } from "../fixtures/uploadEnv";

beforeAll(() => applyD1Migrations(env.DB, env.TEST_MIGRATIONS));
beforeEach(async () => {
  await env.DB.prepare("UPDATE control SET epoch=1,maintenance=0,gc_paused=0").run();
  await env.DB.prepare("UPDATE mutation_admissions SET state='closed' WHERE state='active'").run();
});
afterEach(() => vi.restoreAllMocks());

async function fixture(bytes: Uint8Array = imageBytes("red.png")) {
  const f = await davPutFixture(bytes.length);
  const result = await f.run({}, new Blob([new Uint8Array(bytes)]).stream());
  expect(result.kind).toBe("terminal");
  if (result.kind !== "terminal" || result.operation.state !== "committed")
    throw new Error("fixture_write_failed");
  const op = result.operation.id,
    event = `${op}_event`;
  await env.DB.prepare("UPDATE outbox SET state='sent' WHERE outbox_id=?").bind(event).run();
  const node = await env.DB.prepare(
    "SELECT id,current_blob_id AS blob FROM nodes WHERE last_op_id=? AND kind='file'",
  )
    .bind(op)
    .first<{ id: string; blob: string }>();
  if (!node) throw new Error("fixture_node_missing");
  const metadata = () =>
    env.DB.prepare("SELECT * FROM node_media WHERE node_id=?").bind(node.id).first();
  const state = () =>
    env.DB.prepare("SELECT state FROM outbox WHERE outbox_id=?").bind(event).first<string>("state");
  const release = () =>
    env.DB.prepare("UPDATE outbox SET claim_expires_at=0 WHERE outbox_id=?").bind(event).run();
  return { ...f, op, event, node, metadata, state, release };
}

it.each(["red.png", "red.avif"] as const)(
  "publishes %s metadata, sniffed MIME and event completion atomically",
  async (name) => {
    const f = await fixture(imageBytes(name));
    const get = vi.fn(env.BLOBS.get.bind(env.BLOBS));
    const app = { ...f.app, BLOBS: davBucket({ get }) };
    expect(await consumeOutbox(app, f.event)).toBe("completed");
    expect(await f.metadata()).toMatchObject({
      node_id: f.node.id,
      blob_id: f.node.blob,
      generator_version: IMAGE_METADATA_GENERATOR,
      width: 16,
      height: 12,
      orientation: 1,
      camera_make: null,
      camera_model: null,
      taken_at: null,
    });
    expect(
      await env.DB.prepare("SELECT mime_sniffed FROM blobs WHERE id=?")
        .bind(f.node.blob)
        .first("mime_sniffed"),
    ).toBe(name === "red.png" ? "image/png" : "image/avif");
    const calls = get.mock.calls.length;
    expect(await consumeOutbox(app, f.event)).toBe("completed");
    expect(get).toHaveBeenCalledTimes(calls);
    const plan = await prepareNodeBlobRead(env.DB, f.input.principal, f.ids.space, f.node.id);
    const response = await streamImmutableBlob(
      env.BLOBS,
      plan,
      new Request("https://content.invalid/original", { headers: { Range: "bytes=0-15" } }),
    );
    expect(response.status).toBe(206);
    expect(response.headers.get("Content-Type")).toBe(
      name === "red.png" ? "image/png" : "image/avif",
    );
    expect(response.headers.get("Content-Disposition")).toMatch(/^inline;/);
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(imageBytes(name).slice(0, 16));
  },
);
it("extracts an ordinary upload after its real reservation, PUT and completion", async () => {
  const f = await fixture(),
    bytes = imageBytes("red.avif");
  const principal = {
    kind: "user" as const,
    user_id: f.ids.user,
    credential_id: f.ids.credential,
    epoch: 1,
  };
  const capabilities = new UploadCapabilities(
    await contentKeyRing("test", {
      test: base64url.encode(crypto.getRandomValues(new Uint8Array(32))),
    }),
  );
  const upload = await createSingleUpload(
    f.app,
    {
      principal,
      requestId: crypto.randomUUID(),
      spaceId: f.ids.space,
      parentId: f.ids.folder,
      name: "renamed.txt",
      declaredSize: bytes.length,
    },
    capabilities,
  );
  await writeSingleUpload(
    f.app,
    principal,
    upload.id,
    upload.capability,
    capabilities,
    new Blob([bytes]).stream(),
    bytes.length,
  );
  const completed = await completeSingleUpload(
    f.app,
    principal,
    upload.id,
    upload.capability,
    capabilities,
    crypto.randomUUID(),
    [],
  );
  if (completed.kind !== "terminal") throw new Error("upload_fixture_failed");
  const event = `${completed.operation.id}_event`;
  await env.DB.prepare("UPDATE outbox SET state='sent' WHERE outbox_id=?").bind(event).run();
  expect(await consumeOutbox(f.app, event)).toBe("completed");
  const media = await env.DB.prepare(
    "SELECT m.* FROM node_media m JOIN nodes n ON n.id=m.node_id WHERE n.last_op_id=?",
  )
    .bind(completed.operation.id)
    .first();
  expect(media).toMatchObject({
    width: 16,
    height: 12,
    generator_version: IMAGE_METADATA_GENERATOR,
  });
});
it("keeps an unsupported original downloadable without false media metadata", async () => {
  const f = await fixture(new TextEncoder().encode("not an image even if named .avif"));
  expect(await consumeOutbox(f.app, f.event)).toBe("completed");
  expect(await f.metadata()).toBeNull();
});
it.each(["edit", "upload_only"] as const)(
  "extracts an anonymous %s upload with its original write authority",
  async (role) => {
    const t = await publicShareFixture(role),
      bytes = imageBytes("red.avif"),
      principal = publicPrincipal(t.session);
    const capabilities = new UploadCapabilities(await contentKeyRing("test", { test: t.key }));
    const receipt = await createSingleUpload(
      t.app,
      {
        principal,
        requestId: crypto.randomUUID(),
        spaceId: t.f.ids.space,
        parentId: t.f.ids.folder,
        name: "anonymous.avif",
        declaredSize: bytes.length,
      },
      capabilities,
    );
    await writeSingleUpload(
      t.app,
      principal,
      receipt.id,
      receipt.capability,
      capabilities,
      new Blob([bytes]).stream(),
      bytes.length,
    );
    const completed = await completeSingleUpload(
      t.app,
      principal,
      receipt.id,
      receipt.capability,
      capabilities,
      crypto.randomUUID(),
      [],
    );
    if (completed.kind !== "terminal") throw new Error("anonymous_fixture_failed");
    const event = `${completed.operation.id}_event`;
    expect(
      await dispatchOutbox(
        t.app,
        { send: async () => ({ metadata: { metrics: { backlogCount: 0, backlogBytes: 0 } } }) },
        event,
        1,
      ),
    ).toBe("sent");
    expect(await consumeOutbox(t.app, event)).toBe("completed");
    const original = (await readOutboxEvent(env.DB, event))!;
    expect(
      await nodeEventAuthority(env.DB, {
        ...original,
        operands_json: JSON.stringify({
          ...JSON.parse(original.operands_json),
          uploadId: "another-upload",
        }),
      }),
    ).toBeNull();
    expect(
      await nodeEventAuthority(env.DB, {
        ...original,
        credential_version: original.credential_version! + 1,
      }),
    ).toBeNull();
    const media = await env.DB.prepare(
      "SELECT m.* FROM node_media m JOIN nodes n ON n.id=m.node_id WHERE n.last_op_id=?",
    )
      .bind(completed.operation.id)
      .first<{ node_id: string; width: number; height: number }>();
    expect(media).toMatchObject({ width: 16, height: 12 });
    if (role === "upload_only")
      await expect(
        authorizeNode(env.DB, principal, {
          operation: "node.read",
          spaceId: t.f.ids.space,
          nodeId: media!.node_id,
        }),
      ).rejects.toThrow();
  },
);
it.each(["etag", "missing", "conditional"] as const)(
  "does not complete when the immutable source %s cannot be proved",
  async (mode) => {
    const f = await fixture();
    const bucket =
      mode === "missing"
        ? davBucket({ get: async () => null })
        : mode === "etag"
          ? davBucket({
              get: (async (...args: Parameters<R2Bucket["get"]>) => {
                const value = await env.BLOBS.get(...args);
                return value ? { ...value, etag: "changed" } : null;
              }) as R2Bucket["get"],
            })
          : davBucket({ get: ((key: string) => env.BLOBS.head(key)) as R2Bucket["get"] });
    expect(await consumeOutbox({ ...f.app, BLOBS: bucket }, f.event)).toBe("retry");
    expect(await f.metadata()).toBeNull();
    expect(await f.state()).toBe("sent");
  },
);
it.each(["image/avif", "image/png", "video/mp4", "audio/ogg", "application/pdf", "text/html"])(
  "does not permit inline delivery from a DAV declaration of %s",
  async (mime) => {
    const f = await davPutFixture(3);
    const written = await putFile(f.app, { ...f.input, mime, body: new Blob(["abc"]).stream() });
    if (written.kind !== "terminal") throw new Error("fixture_put_failed");
    const node = await env.DB.prepare("SELECT id FROM nodes WHERE last_op_id=? AND kind='file'")
      .bind(written.operation.id)
      .first<string>("id");
    const plan = await prepareNodeBlobRead(env.DB, f.input.principal, f.ids.space, node!);
    const response = await streamImmutableBlob(
      env.BLOBS,
      plan,
      new Request("https://content.invalid/original"),
    );
    expect(response.headers.get("Content-Type")).toBe("application/octet-stream");
    expect(response.headers.get("Content-Disposition")).toMatch(/^attachment;/);
    expect(new TextDecoder().decode(await response.arrayBuffer())).toBe("abc");
  },
);
it.each(["credential", "parent", "claim", "epoch", "maintenance"] as const)(
  "rejects %s changes while an R2 result is in flight",
  async (change) => {
    const f = await fixture();
    const bucket = davBucket({
      get: vi.fn(async (...args: Parameters<R2Bucket["get"]>) => {
        const value = await env.BLOBS.get(...args);
        if (change === "credential")
          await env.DB.prepare("UPDATE app_passwords SET revoked_at=? WHERE id=?")
            .bind(Date.now(), f.input.principal.credential_id.slice(3))
            .run();
        if (change === "parent")
          await env.DB.prepare("UPDATE nodes SET parent_id=? WHERE id=?")
            .bind(f.ids.root, f.node.id)
            .run();
        if (change === "claim")
          await env.DB.prepare("UPDATE outbox SET claim_token='new-worker' WHERE outbox_id=?")
            .bind(f.event)
            .run();
        if (change === "epoch") await env.DB.prepare("UPDATE control SET epoch=2").run();
        if (change === "maintenance")
          await env.DB.prepare("UPDATE control SET maintenance=1").run();
        return value;
      }) as R2Bucket["get"],
    });
    expect(await consumeOutbox({ ...f.app, BLOBS: bucket }, f.event)).toBe("retry");
    expect(await f.metadata()).toBeNull();
    expect(await f.state()).toBe("sent");
  },
);
it("rolls back metadata and MIME if event terminal publication fails", async () => {
  const f = await fixture();
  const db = injectBatch(
    (sql) => sql.includes("INSERT INTO node_media"),
    async () => {
      await env.DB.prepare("UPDATE outbox SET claim_token='replacement' WHERE outbox_id=?")
        .bind(f.event)
        .run();
    },
    false,
  );
  expect(await consumeOutbox({ ...f.app, DB: db }, f.event)).toBe("retry");
  expect(await f.metadata()).toBeNull();
  expect(await f.state()).toBe("sent");
  expect(
    await env.DB.prepare("SELECT mime_sniffed FROM blobs WHERE id=?")
      .bind(f.node.blob)
      .first("mime_sniffed"),
  ).toBe("text/plain");
});
it("reads durable terminal state after a lost completion acknowledgement", async () => {
  const f = await fixture();
  const db = injectBatch(
    (sql) => sql.includes("INSERT INTO node_media"),
    async () => {
      throw new Error("lost ack");
    },
    true,
  );
  expect(await consumeOutbox({ ...f.app, DB: db }, f.event)).toBe("completed");
  expect(await f.metadata()).toMatchObject({ width: 16, height: 12 });
});
it("does not inspect a new blob through an older write event", async () => {
  const f = await fixture(),
    get = vi.fn(env.BLOBS.get.bind(env.BLOBS));
  await env.DB.prepare("UPDATE nodes SET current_blob_id=? WHERE id=?")
    .bind(f.ids.blob, f.node.id)
    .run();
  expect(await consumeOutbox({ ...f.app, BLOBS: davBucket({ get }) }, f.event)).toBe("completed");
  expect(get).not.toHaveBeenCalled();
  expect(await f.metadata()).toBeNull();
});
it("does not read after an old create target moves beyond its original parent scope", async () => {
  const f = await fixture(),
    get = vi.fn(env.BLOBS.get.bind(env.BLOBS));
  await env.DB.prepare("UPDATE nodes SET parent_id=? WHERE id=?").bind(f.ids.root, f.node.id).run();
  expect(await consumeOutbox({ ...f.app, BLOBS: davBucket({ get }) }, f.event)).toBe("completed");
  expect(get).not.toHaveBeenCalled();
  expect(await f.metadata()).toBeNull();
});
it("shares the native read allowance instead of multiplying it per delivery", async () => {
  const f = await fixture(),
    budget = { reads: 64, bytes: 2097152 },
    get = vi.fn(env.BLOBS.get.bind(env.BLOBS));
  expect(
    await consumeOutbox(
      { ...f.app, BLOBS: davBucket({ get }) },
      f.event,
      Date.now() + 25000,
      budget,
    ),
  ).toBe("retry");
  expect(get).not.toHaveBeenCalled();
  expect(await f.metadata()).toBeNull();
  await f.release();
  expect(await consumeOutbox(f.app, f.event)).toBe("completed");
});
