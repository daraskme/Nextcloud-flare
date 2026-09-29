import { applyD1Migrations, evictDurableObject, runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeAll, beforeEach, expect, it, vi } from "vitest";
import { CONTROL_NAME } from "../../src/do/controlName";
import { consumeOutbox } from "../../src/jobs/consumeOutbox";
import { claimCopyJob } from "../../src/jobs/copyClaim";
import { copyNextBlob } from "../../src/jobs/copyMultipart";
import { publishCopyJob } from "../../src/jobs/copyPublication";
import { imageRequestKey } from "../../src/jobs/imageRequestAuthority";
import { auditOwnerLedger } from "../../src/services/refs";
import { requestThumbnail } from "../../src/services/requestLargeThumbnail";
import { copyJobSetup } from "../fixtures/copyJob";
import { davBucket, davPutFixture } from "../fixtures/davPut";
import { clearEndedR2TestWrites, mutationEnv } from "../fixtures/mutationAdmission";
import { trackBytes } from "../fixtures/tracks/encoded";
import { audioBytes } from "../fixtures/tracks/encodedAudio";
import { coverBytes } from "../fixtures/tracks/encodedCovers";
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

async function fixture(art: boolean | "wav" = true) {
  const bytes =
      art === "wav"
        ? audioBytes("tone.wav")
        : art
          ? coverBytes("cover.opus")
          : trackBytes("opus.ogg"),
    f = await davPutFixture(bytes.length);
  const saved = await f.run({}, new Blob([bytes]).stream());
  if (saved.kind !== "terminal") throw new Error("fixture_upload");
  const node = (await env.DB.prepare(
    "SELECT id,current_blob_id AS blob FROM nodes WHERE last_op_id=? AND kind='file'",
  )
    .bind(saved.operation.id)
    .first<{ id: string; blob: string }>())!;
  // Model a completed pre-cover deployment: immutable original and extracted/edited audio already exist.
  await env.DB.prepare("UPDATE outbox SET state='completed' WHERE op_id=?")
    .bind(saved.operation.id)
    .run();
  await env.DB.prepare("UPDATE blobs SET mime_sniffed='audio/ogg; codecs=\"opus\"' WHERE id=?")
    .bind(node.blob)
    .run();
  await env.DB.prepare(
    "INSERT INTO node_audio(node_id,blob_id,generator_version,codec,duration_ms,title_extracted,title_override) VALUES(?,?,'track-metadata-v1','opus',2000,'extracted','user title')",
  )
    .bind(node.id, node.blob)
    .run();
  await env.DB.prepare("INSERT INTO user_playback_state VALUES(?,?,?,1000,1)")
    .bind(f.ids.user, node.id, node.blob)
    .run();
  if (art === "wav") {
    await env.DB.prepare("UPDATE node_audio SET codec='pcm' WHERE node_id=?").bind(node.id).run();
    await env.DB.prepare("UPDATE blobs SET mime_sniffed='audio/wav' WHERE id=?")
      .bind(node.blob)
      .run();
  }
  const principal = {
    kind: "user" as const,
    user_id: f.ids.user,
    credential_id: f.ids.credential,
    epoch: 1,
  };
  const input = vi.fn((stream: ReadableStream<Uint8Array>) => env.IMAGES.input(stream)),
    send = vi.fn(async () => ({ metadata: { metrics: { backlogCount: 0, backlogBytes: 0 } } }));
  const app = {
    ...f.app,
    IMAGES: { input } as unknown as ImagesBinding,
    JOBS: { send } as unknown as typeof env.JOBS,
  };
  const event = await imageRequestKey(node.blob, "sm");
  const request = (key = crypto.randomUUID(), target = node.id) =>
    requestThumbnail(app, principal, target, node.blob, key, "sm");
  const outputs = () =>
    env.DB.prepare("SELECT * FROM derivative_results WHERE blob_id=? ORDER BY variant")
      .bind(node.blob)
      .all<Record<string, unknown>>();
  const release = () =>
    env.DB.prepare("UPDATE outbox SET claim_expires_at=0 WHERE outbox_id=?").bind(event).run();
  return {
    ...f,
    node,
    app,
    input,
    send,
    event,
    request,
    outputs,
    release,
    principal,
    davCredential: f.input.principal.credential_id.slice(3),
  };
}
it("extracts legacy artwork under the current reader after uploader revocation and preserves all audio state", async () => {
  const f = await fixture(),
    before = await auditOwnerLedger(env.DB, f.ids.user);
  const tags = await env.DB.prepare("SELECT * FROM node_audio WHERE node_id=?")
    .bind(f.node.id)
    .first();
  const playback = await env.DB.prepare("SELECT * FROM user_playback_state WHERE node_id=?")
    .bind(f.node.id)
    .first();
  const original = await env.DB.prepare("SELECT revision,current_blob_id FROM nodes WHERE id=?")
    .bind(f.node.id)
    .first();
  await env.DB.prepare("UPDATE app_passwords SET revoked_at=? WHERE id=?")
    .bind(Date.now(), f.davCredential)
    .run();
  expect(await f.request()).toMatchObject({
    state: "pending",
    variant: "sm",
    generator: "audio-cover-webp-v1",
  });
  expect(f.input).not.toHaveBeenCalled();
  expect(await consumeOutbox(f.app, f.event)).toBe("completed");
  expect(f.input).toHaveBeenCalledTimes(2);
  expect(await f.request()).toMatchObject({ state: "ready" });
  const outputs = (await f.outputs()).results;
  expect(outputs).toMatchObject([
    { kind: "cover", state: "ready", variant: "md" },
    { kind: "cover", state: "ready", variant: "sm" },
  ]);
  expect(
    await env.DB.prepare("SELECT * FROM node_audio WHERE node_id=?").bind(f.node.id).first(),
  ).toEqual(tags);
  expect(
    await env.DB.prepare("SELECT * FROM user_playback_state WHERE node_id=?")
      .bind(f.node.id)
      .first(),
  ).toEqual(playback);
  expect(
    await env.DB.prepare("SELECT revision,current_blob_id FROM nodes WHERE id=?")
      .bind(f.node.id)
      .first(),
  ).toEqual(original);
  expect(await auditOwnerLedger(env.DB, f.ids.user)).toMatchObject({
    used_bytes: before!.used_bytes,
    image_reserved_bytes: 0,
    incorrect_refs: 0,
    physical_bytes: before!.physical_bytes + outputs.reduce((n, r) => n + (r.size as number), 0),
  });
  expect(await consumeOutbox(f.app, f.event)).toBe("completed");
  expect(f.input).toHaveBeenCalledTimes(2);
});
it("records an absent cover without paid attempts or repeating source reads after reload", async () => {
  const f = await fixture(false),
    get = vi.fn(env.BLOBS.get.bind(env.BLOBS));
  const app = { ...f.app, BLOBS: davBucket({ get: get as R2Bucket["get"] }) };
  await f.request();
  expect(await consumeOutbox(app, f.event)).toBe("completed");
  const reads = get.mock.calls.length;
  expect(reads).toBeGreaterThan(0);
  expect(await f.request()).toMatchObject({ state: "absent" });
  expect(await consumeOutbox(app, f.event)).toBe("completed");
  expect(get).toHaveBeenCalledTimes(reads);
  expect(f.input).not.toHaveBeenCalled();
  expect((await f.outputs()).results).toMatchObject([
    { attempts: 0, error_code: "image_cover_absent" },
    { attempts: 0, error_code: "image_cover_absent" },
  ]);
});

it("shares one request and paid pair across COW aliases and overlapping consumer attempts", async () => {
  const f = await fixture(),
    alias = crypto.randomUUID();
  await env.DB.prepare(
    "INSERT INTO nodes(id,space_id,owner_id,parent_id,name,name_ci,kind,current_blob_id,created_at,updated_at) VALUES(?,?,?,?,'alias','alias','file',?,1,1)",
  )
    .bind(alias, f.ids.space, f.ids.user, f.ids.folder, f.node.blob)
    .run();
  await env.DB.prepare(
    "INSERT INTO node_audio(node_id,blob_id,generator_version,codec,duration_ms) VALUES(?,?,'track-metadata-v1','opus',2000)",
  )
    .bind(alias, f.node.blob)
    .run();
  expect(await f.request()).toMatchObject({ state: "pending" });
  expect(await f.request(crypto.randomUUID(), alias)).toMatchObject({
    state: "pending",
    nodeId: alias,
  });
  const results = await Promise.all([consumeOutbox(f.app, f.event), consumeOutbox(f.app, f.event)]);
  expect(results).toContain("completed");
  expect(f.input).toHaveBeenCalledTimes(2);
  expect(await f.request(crypto.randomUUID(), alias)).toMatchObject({
    state: "ready",
    nodeId: alias,
  });
  expect((await f.outputs()).results).toHaveLength(2);
});
it("retries an exhausted invocation budget without recording absence or native work", async () => {
  const f = await fixture();
  await f.request();
  expect(
    await consumeOutbox(f.app, f.event, Date.now() + 25000, { bytes: 4194304, reads: 128 }),
  ).toBe("retry");
  expect((await f.outputs()).results).toHaveLength(0);
  expect(f.input).not.toHaveBeenCalled();
  await f.release();
  expect(await consumeOutbox(f.app, f.event)).toBe("completed");
  expect(f.input).toHaveBeenCalledTimes(2);
});
it("refuses the saved request after reader revocation", async () => {
  const f = await fixture();
  await f.request();
  await env.DB.prepare("UPDATE sessions SET revoked_at=? WHERE id=?")
    .bind(Date.now(), f.ids.session)
    .run();
  expect(await consumeOutbox(f.app, f.event)).toBe("retry");
  expect(f.input).not.toHaveBeenCalled();
  expect((await f.outputs()).results).toHaveLength(0);
  await expect(f.request()).rejects.toThrow("authorization_denied");
});
it("reports unimplemented cover containers as unsupported instead of claiming there is no cover", async () => {
  const f = await fixture("wav");
  await f.request();
  expect(await consumeOutbox(f.app, f.event)).toBe("completed");
  expect(await f.request()).toMatchObject({ state: "unsupported" });
  expect(f.input).not.toHaveBeenCalled();
  expect((await f.outputs()).results).toMatchObject([
    { error_code: "image_unsupported_cover_container" },
    { error_code: "image_unsupported_cover_container" },
  ]);
});
it("reuses native outputs after a lost completion acknowledgement", async () => {
  const f = await fixture();
  await f.request();
  const DB = injectBatch(
    (sql) => sql.startsWith("UPDATE outbox SET state='completed'"),
    async () => {
      throw new Error("lost_ack");
    },
    true,
  );
  expect(await consumeOutbox({ ...f.app, DB }, f.event)).toBe("completed");
  expect(await consumeOutbox(f.app, f.event)).toBe("completed");
  expect(f.input).toHaveBeenCalledTimes(2);
  expect(await f.request()).toMatchObject({ state: "ready" });
});

it("generates from a real cross-owner COPY's new immutable blob, retaining the accepted override", async () => {
  const bytes = coverBytes("cover.opus"),
    f = await copyJobSetup(false, bytes);
  await env.DB.prepare("UPDATE blobs SET mime_sniffed='audio/ogg; codecs=\"opus\"' WHERE id=?")
    .bind(f.source.ids.blob)
    .run();
  await env.DB.prepare(
    "INSERT INTO node_audio(node_id,blob_id,generator_version,codec,duration_ms,title_extracted,title_override) VALUES(?,?,'track-metadata-v1','opus',2000,'source','accepted title')",
  )
    .bind(f.source.ids.file, f.source.ids.blob)
    .run();
  const job = await f.enqueue(),
    claim = await claimCopyJob(mutationEnv(), job.outboxId);
  const copy = { ...admitted(), ...mutationEnv(), BLOBS: env.BLOBS };
  expect(await copyNextBlob(copy, claim, 8 * 1024 * 1024)).toBe("stored");
  expect(await copyNextBlob(copy, claim, 8 * 1024 * 1024)).toBe("ready");
  expect(await publishCopyJob(admitted(), claim)).toMatchObject({
    kind: "terminal",
    operation: { state: "committed" },
  });
  const nodeId = claim.id + "_n00002",
    blobId = claim.id + "_b00001";
  expect(blobId).not.toBe(f.source.ids.blob);
  const principal = {
    kind: "user" as const,
    user_id: f.target.ids.user,
    credential_id: f.target.ids.credential,
    epoch: 1,
  };
  const input = vi.fn((stream: ReadableStream<Uint8Array>) => env.IMAGES.input(stream));
  const app = {
    ...admitted(),
    IMAGES: { input } as unknown as ImagesBinding,
    JOBS: {
      send: async () => ({ metadata: { metrics: { backlogCount: 0, backlogBytes: 0 } } }),
    } as unknown as typeof env.JOBS,
  };
  const before = await env.DB.prepare("SELECT * FROM node_audio WHERE node_id=?")
    .bind(nodeId)
    .first();
  expect(before).toMatchObject({ blob_id: blobId, title_override: "accepted title" });
  // Destination ownership no longer depends on the source share or the original upload credential.
  await env.DB.prepare("UPDATE shares SET disabled_at=? WHERE owner_id=?")
    .bind(Date.now(), f.source.ids.user)
    .run();
  expect(
    await requestThumbnail(app, principal, nodeId, blobId, crypto.randomUUID(), "sm"),
  ).toMatchObject({ state: "pending" });
  expect(await consumeOutbox(app, await imageRequestKey(blobId, "sm"))).toBe("completed");
  expect(input).toHaveBeenCalledTimes(2);
  expect(
    await env.DB.prepare("SELECT * FROM node_audio WHERE node_id=?").bind(nodeId).first(),
  ).toEqual(before);
  expect(
    (
      await env.DB.prepare("SELECT state FROM derivative_results WHERE blob_id=?")
        .bind(blobId)
        .all()
    ).results,
  ).toEqual([{ state: "ready" }, { state: "ready" }]);
  expect(
    await env.DB.prepare("SELECT COUNT(*) AS n FROM image_transform_attempts WHERE blob_id=?")
      .bind(f.source.ids.blob)
      .first("n"),
  ).toBe(0);
});
