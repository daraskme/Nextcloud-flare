import { applyD1Migrations } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { base64url } from "jose";
import { afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { AudioCursorTokens } from "../../src/auth/audioCursor";
import { contentKeyRing } from "../../src/auth/contentTokens";
import { GalleryCursorTokens } from "../../src/auth/galleryCursor";
import { consumeOutbox } from "../../src/jobs/consumeOutbox";
import { AUDIO_SEARCH_CURRENT, AUDIO_SEARCH_VERSION } from "../../src/search/audio";
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
                : name.endsWith("m4a")
                  ? "aac"
                  : name.startsWith("tone") && name.endsWith("ogg")
                    ? "vorbis"
                    : "opus",
        title_extracted: "テスト曲",
        artist_extracted: "Local fixture",
        search_version: AUDIO_SEARCH_VERSION,
      });
      expect(
        await env.DB.prepare(
          `SELECT search_text_norm FROM node_audio a WHERE a.node_id=? AND ${AUDIO_SEARCH_CURRENT}`,
        )
          .bind(f.node.id)
          .first<string>("search_text_norm"),
      ).toContain("てすと曲\nlocal fixture");
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

it.each([false, true])(
  "binds extracted search text to same-blob overrides (stale=%s)",
  async (stale) => {
    const f = await fixture(trackBytes("opus.ogg"));
    await env.DB.prepare(
      "INSERT INTO node_audio(node_id,blob_id,generator_version,title_override,artist_override) VALUES(?,?,'track-metadata-v1','私の曲','My Artist')",
    )
      .bind(f.node.id, stale ? f.ids.blob : f.node.blob)
      .run();
    expect(await consumeOutbox(f.app, f.event)).toBe("completed");
    expect(await f.audio()).toMatchObject({
      title_extracted: "テスト曲",
      title_override: stale ? null : "私の曲",
      artist_override: stale ? null : "My Artist",
      search_version: AUDIO_SEARCH_VERSION,
    });
    const text = await env.DB.prepare(
      `SELECT search_text_norm FROM node_audio a WHERE a.node_id=? AND ${AUDIO_SEARCH_CURRENT}`,
    )
      .bind(f.node.id)
      .first<string>("search_text_norm");
    expect(text).toContain(stale ? "てすと曲\nlocal fixture" : "私の曲\nmy artist");
  },
);
it.each(["insert", "update", "delete"])(
  "retries an extraction when an override row changes before publication: %s",
  async (change) => {
    const f = await fixture(trackBytes("opus.ogg"));
    const insert = () =>
      env.DB.prepare(
        "INSERT INTO node_audio(node_id,blob_id,generator_version,title_override) VALUES(?,?,'track-metadata-v1','before')",
      )
        .bind(f.node.id, f.node.blob)
        .run();
    if (change !== "insert") await insert();
    const db = injectBatch(
      (sql) => sql.includes("INSERT INTO node_audio"),
      async () => {
        if (change === "insert") await insert();
        else
          await env.DB.prepare(
            change === "update"
              ? "UPDATE node_audio SET title_override='after' WHERE node_id=?"
              : "DELETE FROM node_audio WHERE node_id=?",
          )
            .bind(f.node.id)
            .run();
      },
      false,
    );
    expect(await consumeOutbox({ ...f.app, DB: db }, f.event)).toBe("retry");
    expect(await f.metadata()).toBeNull();
    if (change === "delete") expect(await f.audio()).toBeNull();
    else
      expect(await f.audio()).toMatchObject({
        title_override: change === "insert" ? "before" : "after",
        search_version: "",
      });
    await env.DB.prepare("UPDATE outbox SET claim_expires_at=0 WHERE outbox_id=?")
      .bind(f.event)
      .run();
    expect(await consumeOutbox(f.app, f.event)).toBe("completed");
    expect(
      await env.DB.prepare(
        `SELECT COUNT(*) AS n FROM node_audio a WHERE a.node_id=? AND ${AUDIO_SEARCH_CURRENT}`,
      )
        .bind(f.node.id)
        .first("n"),
    ).toBe(1);
  },
);
