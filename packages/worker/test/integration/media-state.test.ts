import { applyD1Migrations } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeAll, beforeEach, expect, it } from "vitest";
import { handleMediaStateHttp } from "../../src/api/mediaState";
import { atomicBatch } from "../../src/db/primary";
import { AUDIO_GENERATOR_VERSION } from "../../src/media/audio";
import { EPUB_INDEX_GENERATOR } from "../../src/media/epub/index";
import {
  readPlaybackState,
  readReadingState,
  writePlaybackState,
  writeReadingState,
} from "../../src/services/mediaState";
import { foundationFixture } from "../fixtures/foundation";

beforeAll(async () => applyD1Migrations(env.DB, env.TEST_MIGRATIONS));

beforeEach(async () => {
  await env.DB.prepare("UPDATE control SET epoch=1,maintenance=0").run();
});

async function audioFixture() {
  const now = Date.now() - 1_000;
  const f = foundationFixture(crypto.randomUUID(), now);
  await atomicBatch(env.DB, [
    ...f.statements,
    {
      sql: "INSERT INTO blob_storage(blob_id,bytes,r2_etag,observed_at) VALUES(?,3,'etag',?)",
      values: [f.ids.blob, now],
    },
    {
      sql: `INSERT INTO node_audio(node_id,blob_id,generator_version,duration_ms,codec)
        VALUES(?,?,?,?,?)`,
      values: [f.ids.file, f.ids.blob, AUDIO_GENERATOR_VERSION, 185_000, "mp3"],
    },
  ]);
  return {
    ...f,
    principal: {
      kind: "user" as const,
      user_id: f.ids.user,
      credential_id: f.ids.credential,
      epoch: 1,
    },
  };
}

it("clamps private playback state and resets it when the current blob changes", async () => {
  const f = await audioFixture();
  expect(await readPlaybackState(env.DB, f.principal, f.ids.file)).toMatchObject({
    blobId: f.ids.blob,
    durationMs: 185_000,
    positionMs: null,
  });
  expect(
    await writePlaybackState(env.DB, f.principal, f.ids.file, f.ids.blob, 999_999, 10_000),
  ).toMatchObject({ positionMs: 185_000, updatedAt: 10_000 });
  const otherUser = `${f.ids.user}-other`;
  await atomicBatch(env.DB, [
    {
      sql: `INSERT INTO users(id,access_iss,access_sub,email,role,quota_bytes,created_at)
        VALUES(?,'https://access.invalid',?,'other@example.invalid','member',1000,?)`,
      values: [otherUser, otherUser, 10_000],
    },
    {
      sql: `INSERT INTO user_playback_state(user_id,node_id,blob_id,position_ms,updated_at)
        VALUES(?,?,?,?,?)`,
      values: [otherUser, f.ids.file, f.ids.blob, 12_000, 10_000],
    },
  ]);
  expect(await readPlaybackState(env.DB, f.principal, f.ids.file)).toMatchObject({
    positionMs: 185_000,
  });

  const replacement = `${f.ids.blob}-replacement`;
  await atomicBatch(env.DB, [
    {
      sql: `INSERT INTO blobs(id,owner_id,r2_key,size,content_etag,state,created_at)
        VALUES(?,?,?,4,'replacement','committed',?)`,
      values: [replacement, f.ids.user, `u/${f.ids.user}/b/${replacement}`, 20_000],
    },
    {
      sql: "INSERT INTO blob_storage(blob_id,bytes,r2_etag,observed_at) VALUES(?,4,'replacement',?)",
      values: [replacement, 20_000],
    },
    {
      sql: "UPDATE nodes SET current_blob_id=?,revision=revision+1 WHERE id=?",
      values: [replacement, f.ids.file],
    },
    {
      sql: `UPDATE node_audio SET blob_id=?,duration_ms=90000,generator_version=?
        WHERE node_id=?`,
      values: [replacement, AUDIO_GENERATOR_VERSION, f.ids.file],
    },
  ]);
  expect(await readPlaybackState(env.DB, f.principal, f.ids.file)).toMatchObject({
    blobId: replacement,
    positionMs: null,
  });
  await expect(
    writePlaybackState(env.DB, f.principal, f.ids.file, f.ids.blob, 1_000),
  ).rejects.toThrow("media_state_unavailable");
  await writePlaybackState(env.DB, f.principal, f.ids.file, replacement, 8_000, 30_000);
  const rows = await env.DB.prepare(
    "SELECT blob_id,position_ms FROM user_playback_state WHERE user_id=? AND node_id=?",
  )
    .bind(f.ids.user, f.ids.file)
    .all();
  expect(rows.results).toEqual([{ blob_id: replacement, position_ms: 8_000 }]);
});

it("fences playback state on maintenance, epoch mismatch, and trash", async () => {
  const f = await audioFixture();
  await env.DB.prepare("UPDATE control SET maintenance=1").run();
  await expect(readPlaybackState(env.DB, f.principal, f.ids.file)).rejects.toThrow();
  await expect(
    writePlaybackState(env.DB, f.principal, f.ids.file, f.ids.blob, 1_000),
  ).rejects.toThrow();
  await env.DB.prepare("UPDATE control SET maintenance=0,epoch=2").run();
  await expect(readPlaybackState(env.DB, f.principal, f.ids.file)).rejects.toThrow();
  await env.DB.prepare("UPDATE control SET epoch=1").run();
  const deletedAt = Date.now();
  const trashOp = crypto.randomUUID();
  await env.DB.prepare(
    `INSERT INTO trash_ops(op_id,actor_id,space_id,root_node_id,state,created_at,epoch)
      VALUES(?,?,?,?,'trashed',?,1)`,
  )
    .bind(trashOp, f.ids.user, f.ids.space, f.ids.file, deletedAt)
    .run();
  await env.DB.prepare("UPDATE nodes SET deleted_at=?,deleted_op_id=? WHERE id=?")
    .bind(deletedAt, trashOp, f.ids.file)
    .run();
  await expect(readPlaybackState(env.DB, f.principal, f.ids.file)).rejects.toThrow();
});

it("allows current internal readers and rejects resume access after grant revocation", async () => {
  const owner = await audioFixture();
  const now = Date.now() - 1_000;
  const guest = foundationFixture(crypto.randomUUID(), now);
  const share = crypto.randomUUID();
  await atomicBatch(env.DB, [
    ...guest.statements,
    {
      sql: "INSERT INTO shares(id,owner_id,root_node_id,kind,created_at) VALUES(?,?,?,'internal',?)",
      values: [share, owner.ids.user, owner.ids.folder, now],
    },
    { sql: "INSERT INTO share_actions(share_id,action) VALUES(?,'read')", values: [share] },
    {
      sql: "INSERT INTO share_grants(share_id,user_id,version) VALUES(?,?,1)",
      values: [share, guest.ids.user],
    },
  ]);
  const principal = {
    kind: "user" as const,
    user_id: guest.ids.user,
    credential_id: guest.ids.credential,
    epoch: 1,
  };
  await writePlaybackState(env.DB, principal, owner.ids.file, owner.ids.blob, 7_000, 50_000);
  expect(await readPlaybackState(env.DB, principal, owner.ids.file)).toMatchObject({
    positionMs: 7_000,
    updatedAt: 50_000,
  });
  await env.DB.prepare("UPDATE share_grants SET disabled_at=? WHERE share_id=?")
    .bind(51_000, share)
    .run();
  await expect(readPlaybackState(env.DB, principal, owner.ids.file)).rejects.toThrow();
  await expect(
    writePlaybackState(env.DB, principal, owner.ids.file, owner.ids.blob, 8_000),
  ).rejects.toThrow();
});

it("stores only bounded current-blob EPUB locations", async () => {
  const now = Date.now() - 1_000;
  const f = foundationFixture(crypto.randomUUID(), now);
  await atomicBatch(env.DB, [
    ...f.statements,
    {
      sql: "INSERT INTO blob_storage(blob_id,bytes,r2_etag,observed_at) VALUES(?,3,'etag',?)",
      values: [f.ids.blob, now],
    },
    {
      sql: `INSERT INTO library_items(node_id,blob_id,kind,generator_version,page_count)
        VALUES(?,?,'epub',?,3)`,
      values: [f.ids.file, f.ids.blob, EPUB_INDEX_GENERATOR],
    },
    {
      sql: `INSERT INTO archive_index(
        id,node_id,blob_id,generator_version,r2_key,sha256,entry_count,json_bytes
      ) VALUES(?,?,?,?,?,'sha',3,100)`,
      values: [
        crypto.randomUUID(),
        f.ids.file,
        f.ids.blob,
        EPUB_INDEX_GENERATOR,
        `u/${f.ids.user}/d/${f.ids.blob}/${EPUB_INDEX_GENERATOR}/index/test.json`,
      ],
    },
  ]);
  const principal = {
    kind: "user" as const,
    user_id: f.ids.user,
    credential_id: f.ids.credential,
    epoch: 1,
  };
  expect(await readReadingState(env.DB, principal, f.ids.file)).toMatchObject({
    pageCount: 3,
    position: null,
  });
  await writeReadingState(
    env.DB,
    principal,
    f.ids.file,
    f.ids.blob,
    { spineIndex: 2, progress: 10_000 },
    40_000,
  );
  expect(await readReadingState(env.DB, principal, f.ids.file)).toMatchObject({
    position: { spineIndex: 2, progress: 10_000 },
    updatedAt: 40_000,
  });
  await expect(
    writeReadingState(env.DB, principal, f.ids.file, f.ids.blob, {
      spineIndex: 3,
      progress: 0,
    }),
  ).rejects.toThrow("invalid_media_state");
  await expect(
    writeReadingState(env.DB, principal, f.ids.file, f.ids.blob, {
      spineIndex: 0,
      progress: 10_001,
    }),
  ).rejects.toThrow("invalid_media_state");
});

it("enforces private route shape, strict bounded bodies, and no-store responses", async () => {
  const f = await audioFixture();
  const app = { ...env, APP_ORIGIN: "https://app.invalid" };
  const csrf = { verify: async () => undefined };
  const read = await handleMediaStateHttp(
    new Request(`https://app.invalid/api/v1/nodes/${f.ids.file}/playback-state`),
    app,
    f.principal,
    csrf,
  );
  expect(read.status).toBe(200);
  expect(read.headers.get("Cache-Control")).toBe("private, no-store");
  expect(await read.json()).toMatchObject({ blobId: f.ids.blob, positionMs: null });

  const write = await handleMediaStateHttp(
    new Request(`https://app.invalid/api/v1/nodes/${f.ids.file}/playback-state`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ blobId: f.ids.blob, positionMs: 9_000 }),
    }),
    app,
    f.principal,
    csrf,
  );
  expect(write.status).toBe(200);
  expect(await write.json()).toMatchObject({ positionMs: 9_000 });

  for (const body of [
    JSON.stringify({ blobId: f.ids.blob }),
    JSON.stringify({ blobId: f.ids.blob, positionMs: 1, extra: true }),
    JSON.stringify({ blobId: f.ids.blob, positionMs: 1 }).padEnd(1_025, " "),
  ])
    expect(
      (
        await handleMediaStateHttp(
          new Request(`https://app.invalid/api/v1/nodes/${f.ids.file}/playback-state`, {
            method: "PUT",
            headers: { "Content-Type": "application/json" },
            body,
          }),
          app,
          f.principal,
          csrf,
        )
      ).status,
    ).toBe(400);

  expect(
    (
      await handleMediaStateHttp(
        new Request(`https://app.invalid/api/v1/nodes/${f.ids.file}/playback-state?share=public`),
        app,
        f.principal,
        csrf,
      )
    ).status,
  ).toBe(404);
  expect(
    (
      await handleMediaStateHttp(
        new Request(`https://app.invalid/api/v1/nodes/${f.ids.file}/playback-state`),
        app,
        {
          kind: "link_share",
          share_id: "share",
          share_version: 1,
          credential_id: "ss:session",
          epoch: 1,
        },
        csrf,
      )
    ).status,
  ).toBe(404);
});
