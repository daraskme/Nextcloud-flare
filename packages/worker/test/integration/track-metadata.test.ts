import { applyD1Migrations } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { base64url } from "jose";
import { afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { AudioCursorTokens } from "../../src/auth/audioCursor";
import { contentKeyRing } from "../../src/auth/contentTokens";
import { GalleryCursorTokens } from "../../src/auth/galleryCursor";
import { consumeOutbox } from "../../src/jobs/consumeOutbox";
import { listAudio, savePlayback } from "../../src/services/audio";
import { prepareNodeBlobRead, streamImmutableBlob } from "../../src/services/blobRead";
import { listGallery } from "../../src/services/gallery";
import { putFile } from "../../src/services/putFile";
import { auditOwnerLedger } from "../../src/services/refs";
import { davBucket, davPutFixture } from "../fixtures/davPut";
import { encodedTracks, trackBytes } from "../fixtures/tracks/encoded";
import { audioBytes, encodedAudio } from "../fixtures/tracks/encodedAudio";
import { injectBatch } from "../fixtures/uploadEnv";

beforeAll(() => applyD1Migrations(env.DB, env.TEST_MIGRATIONS));
beforeEach(async () => {
  await env.DB.prepare("UPDATE control SET epoch=1,maintenance=0,gc_paused=0").run();
  await env.DB.prepare("UPDATE mutation_admissions SET state='closed' WHERE state='active'").run();
});
afterEach(() => vi.restoreAllMocks());
async function fixture(bytes = trackBytes("av1-opus.mp4")) {
  const f = await davPutFixture(bytes.length);
  const result = await putFile(f.app, {
    ...f.input,
    mime: "video/mp4",
    body: new Blob([bytes]).stream(),
  });
  if (result.kind !== "terminal" || result.operation.state !== "committed")
    throw new Error("track_fixture_write");
  const event = result.operation.id + "_event";
  await env.DB.prepare("UPDATE outbox SET state='sent' WHERE outbox_id=?").bind(event).run();
  const node = (await env.DB.prepare(
    "SELECT id,current_blob_id AS blob FROM nodes WHERE last_op_id=? AND kind='file'",
  )
    .bind(result.operation.id)
    .first<{ id: string; blob: string }>())!;
  const get = vi.fn(env.BLOBS.get.bind(env.BLOBS));
  const input = vi.fn(() => {
    throw new Error("video_must_not_use_images");
  });
  const app = {
    ...f.app,
    BLOBS: davBucket({ get }),
    IMAGES: { input } as unknown as ImagesBinding,
  };
  const principal = {
    kind: "user" as const,
    user_id: f.ids.user,
    credential_id: f.ids.credential,
    epoch: 1,
  };
  const tokens = new GalleryCursorTokens(
    await contentKeyRing("test", {
      test: base64url.encode(crypto.getRandomValues(new Uint8Array(32))),
    }),
  );
  const metadata = () =>
    env.DB.prepare("SELECT * FROM node_media WHERE node_id=?").bind(node.id).first();
  const audio = () =>
    env.DB.prepare("SELECT * FROM node_audio WHERE node_id=?").bind(node.id).first();
  const list = () => listGallery(env.DB, principal, f.ids.folder, false, tokens);
  return { ...f, app, event, node, get, input, principal, metadata, audio, list };
}
const fixtureNames = [...Object.keys(encodedTracks), ...Object.keys(encodedAudio)];
const fixtureBytes = (name: string) =>
  name in encodedAudio
    ? audioBytes(name as keyof typeof encodedAudio)
    : trackBytes(name as keyof typeof encodedTracks);
it.each(fixtureNames)(
  "extracts %s atomically and serves actual immutable byte ranges",
  async (name) => {
    const f = await fixture(fixtureBytes(name)),
      before = await auditOwnerLedger(env.DB, f.ids.user);
    expect(await consumeOutbox(f.app, f.event)).toBe("completed");
    expect(f.input).not.toHaveBeenCalled();
    expect(await f.metadata()).toMatchObject({
      blob_id: f.node.blob,
      generator_version: "track-metadata-v1",
    });
    const plan = await prepareNodeBlobRead(env.DB, f.principal, f.ids.space, f.node.id);
    expect(plan.mime).toMatch(
      /^(?:(?:video|audio)\/(?:mp4|webm|ogg); codecs="|audio\/(?:mpeg|flac|wav)$)/,
    );
    const response = await streamImmutableBlob(
      env.BLOBS,
      plan,
      new Request("https://content.invalid/original", { headers: { Range: "bytes=80-127" } }),
    );
    expect(response.status).toBe(206);
    expect(response.headers.get("Content-Disposition")).toMatch(/^inline;/);
    expect(response.headers.get("Content-Security-Policy")).toBe(
      "default-src 'none'; media-src 'self'; sandbox allow-same-origin; frame-ancestors 'none'",
    );
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(fixtureBytes(name).slice(80, 128));
    const gallery = await f.list();
    if (name.startsWith("av1"))
      expect(gallery.items).toMatchObject([
        { id: f.node.id, width: 160, height: 90, thumbnail: "unsupported" },
      ]);
    else {
      expect(gallery.items).toEqual([]);
      expect(await f.audio()).toMatchObject({
        codec:
          name === "tone.mp3"
            ? "mp3"
            : name === "tone.flac"
              ? "flac"
              : name === "tone.wav"
                ? "pcm"
                : "opus",
        title_extracted: "テスト曲",
        artist_extracted: "Local fixture",
      });
      const audioTokens = new AudioCursorTokens(
        await contentKeyRing("test", {
          test: base64url.encode(crypto.getRandomValues(new Uint8Array(32))),
        }),
      );
      const listing = await listAudio(env.DB, f.principal, f.ids.folder, audioTokens);
      expect(listing.items).toMatchObject([{ id: f.node.id, mime: plan.mime, title: "テスト曲" }]);
      const saved = await savePlayback(f.app, f.principal, f.node.id, {
        blobId: f.node.blob,
        generator: "track-metadata-v1",
        positionMs: 1000,
        previousUpdatedAt: null,
      });
      expect(
        (await listAudio(env.DB, f.principal, f.node.id, audioTokens)).items[0]?.playback,
      ).toEqual(saved);
    }
    const reads = f.get.mock.calls.length;
    expect(await consumeOutbox(f.app, f.event)).toBe("completed");
    expect(f.get).toHaveBeenCalledTimes(reads);
    expect(await auditOwnerLedger(env.DB, f.ids.user)).toEqual(before);
  },
);
it.each(["credential", "parent", "blob"])(
  "refuses stale %s before publishing track metadata",
  async (change) => {
    const f = await fixture();
    const db = injectBatch(
      (sql) => sql.includes("INSERT INTO node_media"),
      async () => {
        if (change === "credential")
          await env.DB.prepare("UPDATE app_passwords SET revoked_at=? WHERE user_id=?")
            .bind(Date.now(), f.ids.user)
            .run();
        else if (change === "parent")
          await env.DB.prepare("UPDATE nodes SET parent_id=? WHERE id=?")
            .bind(f.ids.root, f.node.id)
            .run();
        else
          await env.DB.prepare("UPDATE nodes SET current_blob_id=NULL WHERE id=?")
            .bind(f.node.id)
            .run();
      },
      false,
    );
    expect(await consumeOutbox({ ...f.app, DB: db }, f.event)).toBe("retry");
    expect(await f.metadata()).toBeNull();
    expect(await f.audio()).toBeNull();
  },
);
it("keeps malformed originals as downloads and shares the invocation read budget", async () => {
  const bytes = trackBytes("av1-opus.mp4");
  bytes[4] = 0;
  const bad = await fixture(bytes);
  expect(await consumeOutbox(bad.app, bad.event)).toBe("completed");
  expect(await bad.metadata()).toBeNull();
  const badPlan = await prepareNodeBlobRead(env.DB, bad.principal, bad.ids.space, bad.node.id);
  expect(badPlan.mime).toBe("application/octet-stream");
  const download = await streamImmutableBlob(
    env.BLOBS,
    badPlan,
    new Request("https://content.invalid/original"),
  );
  expect(download.headers.get("Content-Security-Policy")).toBe(
    "default-src 'none'; sandbox; frame-ancestors 'none'",
  );
  expect(download.headers.get("Content-Disposition")).toMatch(/^attachment;/);
  expect(new Uint8Array(await download.arrayBuffer())).toEqual(bytes);
  const f = await fixture();
  expect(
    await consumeOutbox(f.app, f.event, Date.now() + 25000, { reads: 128, bytes: 4194304 }),
  ).toBe("retry");
  expect(f.get).not.toHaveBeenCalled();
  expect(await f.metadata()).toBeNull();
});
it("recovers the metadata completion ACK and does not repeat R2 inspection", async () => {
  const f = await fixture(trackBytes("opus.ogg"));
  const db = injectBatch(
    (sql) => sql.includes("INSERT INTO node_media"),
    async () => {
      throw new Error("lost_ack");
    },
    true,
  );
  expect(await consumeOutbox({ ...f.app, DB: db }, f.event)).toBe("completed");
  expect(await f.audio()).toMatchObject({ codec: "opus" });
  const reads = f.get.mock.calls.length;
  expect(await consumeOutbox(f.app, f.event)).toBe("completed");
  expect(f.get).toHaveBeenCalledTimes(reads);
});
