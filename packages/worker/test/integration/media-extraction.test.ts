import { applyD1Migrations, evictDurableObject, runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { handleMediaExtractionHttp } from "../../src/api/mediaExtraction";
import { readAccessSession } from "../../src/auth/sessions";
import { atomicBatch } from "../../src/db/primary";
import { CONTROL_NAME } from "../../src/do/controlName";
import { consumeOutbox } from "../../src/jobs/consumeOutbox";
import { mediaRequestKey } from "../../src/jobs/mediaRequestAuthority";
import { lookupOperation } from "../../src/jobs/operations";
import { dispatchOutbox } from "../../src/jobs/outbox";
import { AUDIO_SEARCH_VERSION } from "../../src/search/audio";
import { auditOwnerLedger } from "../../src/services/refs";
import { requestMediaExtraction } from "../../src/services/requestMediaExtraction";
import { requeueDeadLetter } from "../../src/services/requeueDeadLetter";
import { davBucket, davPutFixture } from "../fixtures/davPut";
import { foundationFixture } from "../fixtures/foundation";
import { imageBytes } from "../fixtures/images/encoded";
import { clearEndedR2TestWrites } from "../fixtures/mutationAdmission";
import { trackBytes } from "../fixtures/tracks/encoded";
import { audioBytes } from "../fixtures/tracks/encodedAudio";
import { admitted, injectBatch } from "../fixtures/uploadEnv";

const control = () => env.CONTROL.get(env.CONTROL.idFromName(CONTROL_NAME));
beforeAll(() => applyD1Migrations(env.DB, env.TEST_MIGRATIONS));
beforeEach(async () => {
  await env.DB.prepare(
    "UPDATE control SET backup_token=NULL,backup_frozen=0,restore_freeze_token=NULL",
  ).run();
  await clearEndedR2TestWrites();
  await env.DB.prepare("UPDATE control SET epoch=1,maintenance=0,gc_paused=0").run();
  await env.DB.prepare("UPDATE mutation_admissions SET state='closed' WHERE state='active'").run();
  await runInDurableObject(control(), (_, state) => state.storage.deleteAll());
  await evictDurableObject(control());
});
afterEach(() => vi.restoreAllMocks());

async function fixture(bytes = audioBytes("tone.mp3")) {
  const f = await davPutFixture(bytes.length);
  const saved = await f.run({}, new Blob([bytes]).stream());
  if (saved.kind !== "terminal") throw new Error("fixture_upload");
  const node = (await env.DB.prepare(
    "SELECT id,current_blob_id AS blob FROM nodes WHERE last_op_id=? AND kind='file'",
  )
    .bind(saved.operation.id)
    .first<{ id: string; blob: string }>())!;
  await env.DB.prepare("UPDATE outbox SET state='completed' WHERE op_id=?")
    .bind(saved.operation.id)
    .run();
  const principal = {
    kind: "user" as const,
    user_id: f.ids.user,
    credential_id: f.ids.credential,
    epoch: 1,
  };
  const get = vi.fn(env.BLOBS.get.bind(env.BLOBS)),
    input = vi.fn(() => {
      throw new Error("extraction_must_not_transform");
    });
  const app = {
    ...f.app,
    BLOBS: davBucket({ get }),
    IMAGES: { input } as unknown as ImagesBinding,
    JOBS: { send: async () => ({}) } as unknown as typeof env.JOBS,
  };
  const event = await mediaRequestKey(node.id, node.blob);
  const request = (key = crypto.randomUUID(), db = env.DB) =>
    requestMediaExtraction(
      { ...app, ...admitted(db), JOBS: app.JOBS },
      principal,
      node.id,
      node.blob,
      key,
    );
  const release = () =>
    env.DB.prepare("UPDATE outbox SET claim_expires_at=0 WHERE outbox_id=?").bind(event).run();
  const audio = () =>
    env.DB.prepare("SELECT * FROM node_audio WHERE node_id=?")
      .bind(node.id)
      .first<Record<string, unknown>>();
  return { ...f, node, app, principal, event, request, release, audio, get, input };
}

it("extracts a legacy original after uploader revocation, publishes searchable tags and keeps original/accounting", async () => {
  const f = await fixture(),
    before = await auditOwnerLedger(env.DB, f.ids.user);
  const original = await env.DB.prepare("SELECT revision,current_blob_id FROM nodes WHERE id=?")
    .bind(f.node.id)
    .first();
  await env.DB.prepare("UPDATE app_passwords SET revoked_at=? WHERE user_id=?")
    .bind(Date.now(), f.ids.user)
    .run();
  expect(await f.audio()).toBeNull();
  expect(await f.request()).toMatchObject({ state: "pending", kind: null });
  expect(f.get).not.toHaveBeenCalled();
  expect(await consumeOutbox(f.app, f.event)).toBe("completed");
  expect(await f.request()).toMatchObject({ state: "ready", kind: "audio" });
  expect(await f.audio()).toMatchObject({
    codec: "mp3",
    title_extracted: "テスト曲",
    search_version: AUDIO_SEARCH_VERSION,
  });
  expect(
    await env.DB.prepare("SELECT text_norm FROM search_index WHERE node_id=?")
      .bind(f.node.id)
      .first<string>("text_norm"),
  ).toContain("てすと曲");
  expect(
    await env.DB.prepare("SELECT revision,current_blob_id FROM nodes WHERE id=?")
      .bind(f.node.id)
      .first(),
  ).toEqual(original);
  expect(await auditOwnerLedger(env.DB, f.ids.user)).toEqual(before);
  const reads = f.get.mock.calls.length;
  expect(await consumeOutbox(f.app, f.event)).toBe("completed");
  await f.request();
  expect(f.get).toHaveBeenCalledTimes(reads);
  expect(f.input).not.toHaveBeenCalled();
});

it.each([
  ["flac", () => audioBytes("tone.flac"), "audio"],
  ["wav", () => audioBytes("tone.wav"), "audio"],
  ["opus", () => trackBytes("opus.ogg"), "audio"],
  ["aac", () => audioBytes("tone.m4a"), "audio"],
  ["vorbis", () => audioBytes("tone.ogg"), "audio"],
  ["video", () => trackBytes("av1-opus.mp4"), "video"],
  ["image", () => imageBytes("pattern.png"), "image"],
] as const)("classifies existing %s through the shared bounded parser", async (_, bytes, kind) => {
  const f = await fixture(bytes());
  await f.request();
  expect(await consumeOutbox(f.app, f.event)).toBe("completed");
  expect(await f.request()).toMatchObject({ state: "ready", kind });
  expect(
    await env.DB.prepare("SELECT blob_id FROM node_media WHERE node_id=?")
      .bind(f.node.id)
      .first<string>("blob_id"),
  ).toBe(f.node.blob);
  expect(f.input).not.toHaveBeenCalled();
});

it("retains an unsupported receipt without repeated reads or changing previous metadata", async () => {
  const f = await fixture(new Uint8Array(new TextEncoder().encode("unrecognized file")));
  await f.request();
  expect(await consumeOutbox(f.app, f.event)).toBe("completed");
  expect(await f.request()).toMatchObject({ state: "unsupported", kind: "unsupported" });
  const reads = f.get.mock.calls.length;
  await consumeOutbox(f.app, f.event);
  await f.request();
  expect(f.get).toHaveBeenCalledTimes(reads);
  expect(await f.audio()).toBeNull();
});

it.each(["credential", "hidden", "blob"])(
  "rejects %s changes before reading the source",
  async (change) => {
    const f = await fixture();
    await f.request();
    if (change === "credential")
      await env.DB.prepare("UPDATE sessions SET revoked_at=? WHERE id=?")
        .bind(Date.now(), f.ids.session)
        .run();
    else if (change === "hidden")
      await env.DB.prepare("UPDATE nodes SET hidden=1 WHERE id=?").bind(f.ids.folder).run();
    else
      await env.DB.prepare("UPDATE nodes SET current_blob_id=NULL WHERE id=?")
        .bind(f.node.id)
        .run();
    expect(await consumeOutbox(f.app, f.event)).toBe("retry");
    expect(f.get).not.toHaveBeenCalled();
    expect(await f.audio()).toBeNull();
  },
);

it("does not turn exhausted invocation budget into unsupported and resumes a fresh claim", async () => {
  const f = await fixture();
  await f.request();
  expect(
    await consumeOutbox(f.app, f.event, Date.now() + 25000, { bytes: 4 * 1024 * 1024, reads: 128 }),
  ).toBe("retry");
  expect(
    await env.DB.prepare("SELECT result_json FROM outbox WHERE outbox_id=?")
      .bind(f.event)
      .first("result_json"),
  ).toBeNull();
  await f.release();
  expect(await consumeOutbox(f.app, f.event)).toBe("completed");
});

it("keeps a concurrent same-original override and publishes the matching search projection", async () => {
  const f = await fixture();
  await f.request();
  await env.DB.prepare(
    "INSERT INTO node_audio(node_id,blob_id,generator_version,title_override) VALUES(?,?,'old','before')",
  )
    .bind(f.node.id, f.node.blob)
    .run();
  const db = injectBatch(
    (sql) => sql.includes("INSERT INTO node_audio"),
    async () => {
      await env.DB.prepare("UPDATE node_audio SET title_override='after' WHERE node_id=?")
        .bind(f.node.id)
        .run();
    },
    false,
  );
  expect(await consumeOutbox({ ...f.app, DB: db }, f.event)).toBe("retry");
  expect(await f.audio()).toMatchObject({ title_override: "after", generator_version: "old" });
  await f.release();
  expect(await consumeOutbox(f.app, f.event)).toBe("completed");
  expect(await f.audio()).toMatchObject({ title_override: "after", title_extracted: "テスト曲" });
  expect(
    await env.DB.prepare("SELECT text_norm FROM search_index WHERE node_id=?")
      .bind(f.node.id)
      .first<string>("text_norm"),
  ).toContain("after");
});

it("resolves lost acceptance and publication acknowledgements without repeating reads", async () => {
  const f = await fixture(),
    key = crypto.randomUUID();
  const lost = (sql: string) => sql.includes("INSERT INTO outbox");
  expect(
    await f.request(
      key,
      injectBatch(
        lost,
        async () => {
          throw new Error("lost_ack");
        },
        true,
      ),
    ),
  ).toMatchObject({ state: "pending" });
  expect(await f.request(key)).toMatchObject({ state: "pending" });
  const db = injectBatch(
    (sql) => sql.includes("INSERT INTO node_audio"),
    async () => {
      throw new Error("lost_ack");
    },
    true,
  );
  expect(await consumeOutbox({ ...f.app, DB: db }, f.event)).toBe("completed");
  const reads = f.get.mock.calls.length;
  expect(await consumeOutbox(f.app, f.event)).toBe("completed");
  expect(f.get).toHaveBeenCalledTimes(reads);
});

it("shares one extraction across parallel consumers and rejects reuse of an idempotency slot", async () => {
  const f = await fixture(),
    key = crypto.randomUUID();
  await f.request(key);
  await f.request();
  const both = await Promise.all([consumeOutbox(f.app, f.event), consumeOutbox(f.app, f.event)]);
  expect(both).toContain("completed");
  expect(
    await env.DB.prepare("SELECT COUNT(*) n FROM outbox WHERE payload_ref=?")
      .bind(f.event)
      .first<number>("n"),
  ).toBe(1);
  const alias = crypto.randomUUID();
  await env.DB.prepare(
    "INSERT INTO nodes(id,space_id,owner_id,parent_id,name,name_ci,kind,current_blob_id,created_at,updated_at) VALUES(?,?,?,?,'alias','alias','file',?,1,1)",
  )
    .bind(alias, f.ids.space, f.ids.user, f.ids.folder, f.node.blob)
    .run();
  await expect(requestMediaExtraction(f.app, f.principal, alias, f.node.blob, key)).rejects.toThrow(
    "idempotency_conflict",
  );
});

it("validates fixed operands and CSRF before accepting HTTP extraction", async () => {
  const f = await fixture(),
    url = env.APP_ORIGIN + `/api/v1/nodes/${f.node.id}/media`;
  const http = (body: unknown, valid = true) =>
    handleMediaExtractionHttp(
      new Request(url, {
        method: "POST",
        headers: { "Content-Type": "application/json", "Idempotency-Key": crypto.randomUUID() },
        body: JSON.stringify(body),
      }),
      f.app,
      f.principal,
      f.node.id,
      {
        verify: async () => {
          if (!valid) throw new Error("csrf");
        },
      },
    );
  expect((await http({ blobId: f.node.blob }, false)).status).toBe(403);
  for (const body of [
    { blobId: f.node.blob, source: "client" },
    { blobId: f.node.blob, generator: "other" },
    { blobId: null },
  ])
    expect((await http(body)).status).toBe(400);
  const accepted = await http({ blobId: f.node.blob });
  expect(accepted.status).toBe(202);
  expect(accepted.headers.get("Cache-Control")).toBe("private, no-store");
});

it.each(["credential", "blob", "epoch"])(
  "rejects %s changes during a native range",
  async (change) => {
    const f = await fixture();
    await f.request();
    const get = vi.fn(async (...args: Parameters<R2Bucket["get"]>) => {
      const result = await env.BLOBS.get(...args);
      if (change === "credential")
        await env.DB.prepare("UPDATE sessions SET revoked_at=? WHERE id=?")
          .bind(Date.now(), f.ids.session)
          .run();
      else if (change === "blob")
        await env.DB.prepare("UPDATE nodes SET current_blob_id=NULL WHERE id=?")
          .bind(f.node.id)
          .run();
      else await env.DB.prepare("UPDATE control SET epoch=2").run();
      return result;
    });
    expect(await consumeOutbox({ ...f.app, BLOBS: davBucket({ get }) }, f.event)).toBe("retry");
    expect(get).toHaveBeenCalledOnce();
    expect(await f.audio()).toBeNull();
    expect(
      await env.DB.prepare("SELECT result_json FROM outbox WHERE outbox_id=?")
        .bind(f.event)
        .first("result_json"),
    ).toBeNull();
  },
);

it.each(["revision", "index", "hidden"])(
  "rolls back metadata, MIME, search and receipt on a final %s conflict",
  async (change) => {
    const f = await fixture();
    await f.request();
    const mime = await env.DB.prepare("SELECT mime_sniffed FROM blobs WHERE id=?")
      .bind(f.node.blob)
      .first("mime_sniffed");
    const db = injectBatch(
      (sql) => sql.includes("INSERT INTO node_audio"),
      async () => {
        if (change === "revision")
          await env.DB.prepare("UPDATE nodes SET revision=revision+1 WHERE id=?")
            .bind(f.node.id)
            .run();
        else if (change === "index")
          await env.DB.prepare("UPDATE search_index SET revision=revision+1 WHERE node_id=?")
            .bind(f.node.id)
            .run();
        else await env.DB.prepare("UPDATE nodes SET hidden=1 WHERE id=?").bind(f.node.id).run();
      },
      false,
    );
    expect(await consumeOutbox({ ...f.app, DB: db }, f.event)).toBe("retry");
    expect(await f.audio()).toBeNull();
    expect(
      await env.DB.prepare("SELECT mime_sniffed FROM blobs WHERE id=?")
        .bind(f.node.blob)
        .first("mime_sniffed"),
    ).toBe(mime);
    expect(
      await env.DB.prepare("SELECT result_json FROM outbox WHERE outbox_id=?")
        .bind(f.event)
        .first("result_json"),
    ).toBeNull();
  },
);

it("allows terminal JSON only on a completed extraction and rejects malformed/oversized records", async () => {
  const f = await fixture();
  await f.request();
  await expect(
    env.DB.prepare("UPDATE outbox SET result_json='{}' WHERE outbox_id=?").bind(f.event).run(),
  ).rejects.toThrow();
  for (const value of ["not JSON", JSON.stringify({ kind: "a".repeat(1024) })])
    await expect(
      env.DB.prepare("UPDATE outbox SET state='completed',result_json=? WHERE outbox_id=?")
        .bind(value, f.event)
        .run(),
    ).rejects.toThrow();
  expect(await consumeOutbox(f.app, f.event)).toBe("completed");
  await expect(
    env.DB.prepare("UPDATE outbox SET state='pending' WHERE outbox_id=?").bind(f.event).run(),
  ).rejects.toThrow();
});

it.each([false, true])(
  "requeues media extraction only while saved reader authority remains current (hidden=%s)",
  async (hidden) => {
    const f = await fixture();
    await f.request();
    const opId = (await env.DB.prepare("SELECT op_id FROM outbox WHERE outbox_id=?")
      .bind(f.event)
      .first<string>("op_id"))!;
    expect(await lookupOperation(env.DB, f.principal, opId)).toMatchObject({
      state: "committed",
      result: { status: 202, nodeId: f.node.id },
    });
    const admin = foundationFixture(crypto.randomUUID(), Date.now() - 1000);
    await atomicBatch(env.DB, admin.statements);
    await env.DB.prepare("UPDATE users SET role='app_admin' WHERE id=?").bind(admin.ids.user).run();
    const session = (await readAccessSession(env.DB, admin.ids.credential, 1))!;
    const message = crypto.randomUUID();
    await env.DB.prepare(
      "INSERT INTO queue_dead_letters(message_id,outbox_id,sent_at,received_at,epoch) VALUES(?,?,1,2,1)",
    )
      .bind(message, f.event)
      .run();
    await env.DB.prepare("UPDATE outbox SET dispatch_expires_at=0 WHERE outbox_id=?")
      .bind(f.event)
      .run();
    if (hidden) await env.DB.prepare("UPDATE nodes SET hidden=1 WHERE id=?").bind(f.node.id).run();
    const run = () => requeueDeadLetter(f.app, session, f.event, message, crypto.randomUUID());
    if (hidden) {
      await expect(run()).rejects.toThrow("requeue_unavailable");
      expect(await lookupOperation(env.DB, f.principal, opId)).toBeNull();
    } else {
      expect(await run()).toMatchObject({ outboxId: f.event, messageId: message });
      expect(await dispatchOutbox(f.app, f.app.JOBS, f.event, 1)).toBe("sent");
      expect(await consumeOutbox(f.app, f.event)).toBe("completed");
      expect(await f.request()).toMatchObject({ state: "ready", kind: "audio" });
    }
  },
);
