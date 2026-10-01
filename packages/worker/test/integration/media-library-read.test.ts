import { applyD1Migrations } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { base64url } from "jose";
import { beforeAll, expect, it } from "vitest";
import { handleAudioHttp } from "../../src/api/audio";
import { handleGalleryHttp } from "../../src/api/gallery";
import { AudioCursorTokens } from "../../src/auth/audioCursor";
import { contentKeyRing } from "../../src/auth/contentTokens";
import { GalleryCursorTokens } from "../../src/auth/galleryCursor";
import { NodeCursorTokens } from "../../src/auth/nodeCursor";
import { atomicBatch } from "../../src/db/primary";
import { AUDIO_GENERATOR_VERSION } from "../../src/media/audio";
import { IMAGE_METADATA_GENERATOR } from "../../src/media/images/metadata";
import {
  IMAGE_THUMBNAIL_GENERATOR,
  IMAGE_THUMBNAIL_VARIANT,
} from "../../src/media/images/thumbnail";
import { listAudio } from "../../src/services/audio";
import { listGallery } from "../../src/services/gallery";
import { foundationFixture } from "../fixtures/foundation";

beforeAll(async () => applyD1Migrations(env.DB, env.TEST_MIGRATIONS));

it("lists only current private image and audio metadata with derivative separation", async () => {
  const now = Date.now() - 1_000;
  const f = foundationFixture(crypto.randomUUID(), now);
  const audioBlob = `${f.ids.blob}-audio`;
  const audioNode = `${f.ids.file}-audio`;
  const staleBlob = `${f.ids.blob}-stale`;
  const staleCurrentBlob = `${f.ids.blob}-current`;
  const staleNode = `${f.ids.file}-stale`;
  const derivativeId = crypto.randomUUID();
  const derivativeKey = `u/${f.ids.user}/d/${f.ids.blob}/${IMAGE_THUMBNAIL_GENERATOR}/${IMAGE_THUMBNAIL_VARIANT}/${crypto.randomUUID()}.webp`;
  await atomicBatch(env.DB, f.statements);
  await atomicBatch(env.DB, [
    {
      sql: "UPDATE control SET maintenance=0,epoch=1 WHERE singleton=1",
    },
    {
      sql: "UPDATE blobs SET mime_sniffed='image/jpeg' WHERE id=?",
      values: [f.ids.blob],
    },
    {
      sql: "INSERT INTO blob_storage(blob_id,bytes,r2_etag,observed_at) VALUES(?,3,'image-etag',?)",
      values: [f.ids.blob, now],
    },
    {
      sql: "INSERT INTO node_media(node_id,blob_id,generator_version,width,height) VALUES(?,?,?,?,?)",
      values: [f.ids.file, f.ids.blob, IMAGE_METADATA_GENERATOR, 1600, 900],
    },
    {
      sql: `INSERT INTO derivative_results
        (id,blob_id,kind,variant,generator_version,state,epoch,attempts,r2_key,size,r2_etag)
        VALUES(?,?,'thumbnail',?,?,'ready',1,1,?,128,'thumb-etag')`,
      values: [
        derivativeId,
        f.ids.blob,
        IMAGE_THUMBNAIL_VARIANT,
        IMAGE_THUMBNAIL_GENERATOR,
        derivativeKey,
      ],
    },
    {
      sql: `INSERT INTO blobs(id,owner_id,r2_key,size,content_etag,state,mime_sniffed,created_at)
        VALUES(?,?,?,12,'audio-etag','committed','audio/mpeg',?)`,
      values: [audioBlob, f.ids.user, `u/${f.ids.user}/b/${audioBlob}`, now],
    },
    {
      sql: `INSERT INTO nodes
        (id,space_id,owner_id,parent_id,name,name_ci,kind,current_blob_id,created_at,updated_at)
        VALUES(?,?,?,?,'Track.mp3','track.mp3','file',?,?,?)`,
      values: [audioNode, f.ids.space, f.ids.user, f.ids.folder, audioBlob, now, now],
    },
    {
      sql: "INSERT INTO blob_storage(blob_id,bytes,r2_etag,observed_at) VALUES(?,12,'audio-etag',?)",
      values: [audioBlob, now],
    },
    {
      sql: `INSERT INTO node_audio
        (node_id,blob_id,generator_version,duration_ms,codec,title_extracted,artist_extracted,album_extracted,track_number,disc_number)
        VALUES(?,?,?,185000,'mp3','Track title','Artist','Album',4,1)`,
      values: [audioNode, audioBlob, AUDIO_GENERATOR_VERSION],
    },
    {
      sql: `INSERT INTO blobs(id,owner_id,r2_key,size,content_etag,state,mime_sniffed,created_at)
        VALUES(?,?,?,4,'stale-etag','committed','image/png',?)`,
      values: [staleBlob, f.ids.user, `u/${f.ids.user}/b/${staleBlob}`, now],
    },
    {
      sql: `INSERT INTO blobs(id,owner_id,r2_key,size,content_etag,state,mime_sniffed,created_at)
        VALUES(?,?,?,5,'current-etag','committed','image/png',?)`,
      values: [staleCurrentBlob, f.ids.user, `u/${f.ids.user}/b/${staleCurrentBlob}`, now],
    },
    {
      sql: `INSERT INTO nodes
        (id,space_id,owner_id,parent_id,name,name_ci,kind,current_blob_id,created_at,updated_at)
        VALUES(?,?,?,?,'Stale.png','stale.png','file',?,?,?)`,
      values: [staleNode, f.ids.space, f.ids.user, f.ids.folder, staleCurrentBlob, now, now],
    },
    {
      sql: "INSERT INTO blob_storage(blob_id,bytes,r2_etag,observed_at) VALUES(?,5,'current-etag',?)",
      values: [staleCurrentBlob, now],
    },
    {
      sql: "INSERT INTO node_media(node_id,blob_id,generator_version,width,height) VALUES(?,?,?,?,?)",
      values: [staleNode, staleBlob, IMAGE_METADATA_GENERATOR, 100, 100],
    },
  ]);
  const principal = {
    kind: "user" as const,
    user_id: f.ids.user,
    credential_id: f.ids.credential,
    epoch: 1,
  };
  const ring = await contentKeyRing("cursor", {
    cursor: base64url.encode(crypto.getRandomValues(new Uint8Array(32))),
  });
  const gallery = await listGallery(
    env.DB,
    principal,
    f.ids.root,
    true,
    new GalleryCursorTokens(ring),
  );
  expect(gallery.items).toEqual([
    expect.objectContaining({
      id: f.ids.file,
      currentBlobId: f.ids.blob,
      mime: "image/jpeg",
      width: 1600,
      height: 900,
      thumbnail: "ready",
    }),
  ]);
  expect(gallery.truncated).toBe(false);
  expect(
    (await listGallery(env.DB, principal, f.ids.root, false, new GalleryCursorTokens(ring))).items,
  ).toEqual([]);
  const audio = await listAudio(env.DB, principal, f.ids.root, true, new AudioCursorTokens(ring));
  expect(audio.items).toEqual([
    expect.objectContaining({
      id: audioNode,
      currentBlobId: audioBlob,
      title: "Track title",
      artist: "Artist",
      album: "Album",
      durationMs: 185000,
      trackNumber: 4,
      discNumber: 1,
    }),
  ]);
  await expect(
    listGallery(
      env.DB,
      { ...principal, user_id: "other" },
      f.ids.root,
      true,
      new GalleryCursorTokens(ring),
    ),
  ).rejects.toThrow();
  const shareId = crypto.randomUUID();
  const unlockId = crypto.randomUUID();
  const sharePrincipal = {
    kind: "link_share" as const,
    share_id: shareId,
    share_version: 1,
    credential_id: `ss:${unlockId}`,
    epoch: 1,
  };
  await atomicBatch(env.DB, [
    {
      sql: "INSERT INTO shares(id,owner_id,root_node_id,kind,created_at) VALUES(?,?,?,'link',?)",
      values: [shareId, f.ids.user, f.ids.root, now],
    },
    { sql: "INSERT INTO share_actions(share_id,action) VALUES(?,'read')", values: [shareId] },
    {
      sql: `INSERT INTO share_sessions(id,share_id,share_version,secret_digest,epoch,issued_at,expires_at)
        VALUES(?,?,1,?,1,?,?)`,
      values: [unlockId, shareId, `digest-${unlockId}`, now, now + 600_000],
    },
    {
      sql: "INSERT INTO credentials(id,kind,share_session_id) VALUES(?,'share',?)",
      values: [sharePrincipal.credential_id, unlockId],
    },
  ]);
  expect(
    (await listGallery(env.DB, sharePrincipal, f.ids.root, true, new GalleryCursorTokens(ring)))
      .items,
  ).toHaveLength(1);
  expect(
    (await listAudio(env.DB, sharePrincipal, f.ids.root, true, new AudioCursorTokens(ring))).items,
  ).toHaveLength(1);
  const generation = await env.DB.prepare("SELECT tree_generation FROM spaces WHERE id=?")
    .bind(f.ids.space)
    .first<number>("tree_generation");
  expect(generation).toBeTypeOf("number");
  const galleryTokens = new GalleryCursorTokens(ring);
  for (const changes of [{ credentialId: "ss:other" }, { epoch: 2 }, { userId: "other-share" }]) {
    const cursor = await galleryTokens.issue({
      rootId: f.ids.root,
      spaceId: f.ids.space,
      ownerId: f.ids.user,
      userId: shareId,
      credentialId: sharePrincipal.credential_id,
      epoch: 1,
      generation: generation!,
      recursive: true,
      lastSort: now,
      lastId: f.ids.file,
      ...changes,
    });
    await expect(
      listGallery(env.DB, sharePrincipal, f.ids.root, true, galleryTokens, cursor),
    ).rejects.toThrow("invalid_gallery_cursor");
  }
});

it("rejects malformed media list query parameters before reading metadata", async () => {
  const ring = await contentKeyRing("cursor", {
    cursor: base64url.encode(crypto.getRandomValues(new Uint8Array(32))),
  });
  const cursors = new NodeCursorTokens(ring);
  const principal = {
    kind: "user" as const,
    user_id: "user",
    credential_id: "as:session",
    epoch: 1,
  };
  const app = { ...env, APP_ORIGIN: "https://app.invalid" };
  expect(
    (
      await handleGalleryHttp(
        new Request("https://app.invalid/api/v1/nodes/root/gallery?recursive=yes"),
        app,
        principal,
        cursors,
      )
    ).status,
  ).toBe(400);
  expect(
    (
      await handleAudioHttp(
        new Request("https://app.invalid/api/v1/nodes/root/tracks?cursor=a&cursor=b"),
        app,
        principal,
        cursors,
      )
    ).status,
  ).toBe(400);
});
