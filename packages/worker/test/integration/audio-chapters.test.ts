import { applyD1Migrations } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeAll, beforeEach, expect, it } from "vitest";
import { handleAudioChaptersHttp } from "../../src/api/audioChapters";
import { atomicBatch } from "../../src/db/primary";
import { AUDIO_GENERATOR_VERSION } from "../../src/media/audio";
import { readAudioChapters, writeAudioChapters } from "../../src/services/audioChapters";
import { foundationFixture } from "../fixtures/foundation";

beforeAll(async () => applyD1Migrations(env.DB, env.TEST_MIGRATIONS));

beforeEach(async () => {
  await env.DB.prepare("UPDATE control SET epoch=1,maintenance=0,backup_frozen=0").run();
});

async function audioFixture() {
  const now = Date.now() - 1_000;
  const fixture = foundationFixture(crypto.randomUUID(), now);
  await atomicBatch(env.DB, [
    ...fixture.statements,
    {
      sql: "INSERT INTO blob_storage(blob_id,bytes,r2_etag,observed_at) VALUES(?,3,'etag',?)",
      values: [fixture.ids.blob, now],
    },
    {
      sql: `INSERT INTO node_audio(node_id,blob_id,generator_version,duration_ms,codec)
        VALUES(?,?,?,?,?)`,
      values: [fixture.ids.file, fixture.ids.blob, AUDIO_GENERATOR_VERSION, 185_000, "mp3"],
    },
  ]);
  return {
    ...fixture,
    principal: {
      kind: "user" as const,
      user_id: fixture.ids.user,
      credential_id: fixture.ids.credential,
      epoch: 1,
    },
  };
}

const chapter = (id: string, positionMs: number, title = id) => ({ id, positionMs, title });

it("refuses chapters for an encrypted blob even if an old audio projection remains", async () => {
  const fixture = await audioFixture();
  await writeAudioChapters(env.DB, fixture.principal, fixture.ids.file, fixture.ids.blob, 0, [
    chapter("existing", 1000),
  ]);
  await env.DB.prepare(`INSERT INTO blob_encryption(
    blob_id,owner_id,header_sha256,signer_rsa_fingerprint,signer_signing_fingerprint,
    required_admin_fingerprint,crypto_id,format_version,admin_receipt_state,verified_at)
    VALUES(?,?,'${"a".repeat(64)}','${"A".repeat(43)}','${"B".repeat(43)}',
      '${"C".repeat(43)}','fixture-crypto',2,'pending',?)`)
    .bind(fixture.ids.blob, fixture.ids.user, Date.now())
    .run();
  await expect(readAudioChapters(env.DB, fixture.principal, fixture.ids.file)).rejects.toThrow(
    "audio_chapters_unavailable",
  );
  await expect(
    writeAudioChapters(env.DB, fixture.principal, fixture.ids.file, fixture.ids.blob, 1, [
      chapter("replacement", 2000),
    ]),
  ).rejects.toThrow("audio_chapters_unavailable");
  expect(
    await env.DB.prepare("SELECT revision FROM user_audio_chapter_sets WHERE node_id=?")
      .bind(fixture.ids.file)
      .first<number>("revision"),
  ).toBe(1);
});

it("atomically creates, reorders, replaces, and revision-fences an owner's complete list", async () => {
  const fixture = await audioFixture();
  expect(await readAudioChapters(env.DB, fixture.principal, fixture.ids.file)).toMatchObject({
    blobId: fixture.ids.blob,
    durationMs: 185_000,
    revision: 0,
    chapters: [],
  });
  const created = await writeAudioChapters(
    env.DB,
    fixture.principal,
    fixture.ids.file,
    fixture.ids.blob,
    0,
    [chapter("one", 1_001), chapter("two", 2_002)],
    10_000,
  );
  expect(created).toMatchObject({ revision: 1 });
  const reordered = await writeAudioChapters(
    env.DB,
    fixture.principal,
    fixture.ids.file,
    fixture.ids.blob,
    1,
    [chapter("two", 2_002, "Second"), chapter("one", 1_001, "First")],
    11_000,
  );
  expect(reordered).toMatchObject({
    revision: 2,
    chapters: [
      { id: "two", title: "Second" },
      { id: "one", title: "First" },
    ],
  });
  await expect(
    writeAudioChapters(env.DB, fixture.principal, fixture.ids.file, fixture.ids.blob, 1, []),
  ).rejects.toThrow("audio_chapters_conflict");
  expect(
    (await readAudioChapters(env.DB, fixture.principal, fixture.ids.file)).chapters,
  ).toHaveLength(2);
  const chapterSet = await env.DB.prepare(
    "SELECT id FROM user_audio_chapter_sets WHERE user_id=? AND node_id=? AND blob_id=?",
  )
    .bind(fixture.ids.user, fixture.ids.file, fixture.ids.blob)
    .first<{ id: string }>();
  expect(chapterSet).not.toBeNull();
  if (!chapterSet) throw new Error("missing audio chapter set");
  const backupId = crypto.randomUUID();
  const backupToken = crypto.randomUUID();
  const watermark = crypto.randomUUID();
  await env.DB.prepare(
    `INSERT INTO backup_runs(id,epoch,state,created_at,barrier_token,watermark)
      VALUES(?,1,'exporting',?,?,?)`,
  )
    .bind(backupId, Date.now(), backupToken, watermark)
    .run();
  await env.DB.prepare(
    `UPDATE control SET backup_last_op=?,backup_barrier_op=?,
      backup_token=?,maintenance=1,gc_paused=1,backup_frozen=1`,
  )
    .bind(watermark, watermark, backupToken)
    .run();
  await expect(
    env.DB.prepare(
      `INSERT INTO user_audio_chapters(set_id,chapter_id,sort_order,position_ms,title)
        VALUES(?,'frozen',2,3000,'Frozen')`,
    )
      .bind(chapterSet.id)
      .run(),
  ).rejects.toThrow("backup_frozen");
  await expect(
    env.DB.prepare(
      "UPDATE user_audio_chapters SET title='Frozen' WHERE set_id=? AND chapter_id='one'",
    )
      .bind(chapterSet.id)
      .run(),
  ).rejects.toThrow("backup_frozen");
  await expect(
    env.DB.prepare("DELETE FROM user_audio_chapters WHERE set_id=? AND chapter_id='one'")
      .bind(chapterSet.id)
      .run(),
  ).rejects.toThrow("backup_frozen");
  await env.DB.prepare("UPDATE control SET backup_frozen=0 WHERE backup_token=?")
    .bind(backupToken)
    .run();
  await env.DB.prepare("UPDATE control SET backup_token=NULL WHERE backup_token=?")
    .bind(backupToken)
    .run();
  await env.DB.prepare("UPDATE control SET maintenance=0,gc_paused=0").run();
  expect((await readAudioChapters(env.DB, fixture.principal, fixture.ids.file)).revision).toBe(2);
});

it("keeps owner and current internal reader chapter sets isolated and fences revocation", async () => {
  const owner = await audioFixture();
  const guest = foundationFixture(crypto.randomUUID(), Date.now() - 1_000);
  const share = crypto.randomUUID();
  await atomicBatch(env.DB, [
    ...guest.statements,
    {
      sql: "INSERT INTO shares(id,owner_id,root_node_id,kind,created_at) VALUES(?,?,?,'internal',?)",
      values: [share, owner.ids.user, owner.ids.folder, Date.now() - 1_000],
    },
    { sql: "INSERT INTO share_actions(share_id,action) VALUES(?,'read')", values: [share] },
    {
      sql: "INSERT INTO share_grants(share_id,user_id,version) VALUES(?,?,1)",
      values: [share, guest.ids.user],
    },
  ]);
  const guestPrincipal = {
    kind: "user" as const,
    user_id: guest.ids.user,
    credential_id: guest.ids.credential,
    epoch: 1,
  };
  await writeAudioChapters(env.DB, owner.principal, owner.ids.file, owner.ids.blob, 0, [
    chapter("owner", 1_000),
  ]);
  await writeAudioChapters(env.DB, guestPrincipal, owner.ids.file, owner.ids.blob, 0, [
    chapter("guest", 2_000),
  ]);
  expect((await readAudioChapters(env.DB, owner.principal, owner.ids.file)).chapters[0]?.id).toBe(
    "owner",
  );
  expect((await readAudioChapters(env.DB, guestPrincipal, owner.ids.file)).chapters[0]?.id).toBe(
    "guest",
  );
  await env.DB.prepare("UPDATE share_grants SET disabled_at=? WHERE share_id=?")
    .bind(Date.now(), share)
    .run();
  await expect(readAudioChapters(env.DB, guestPrincipal, owner.ids.file)).rejects.toThrow();
  expect((await readAudioChapters(env.DB, owner.principal, owner.ids.file)).chapters).toHaveLength(
    1,
  );
});

it("returns only the authoritative current blob and cleans old rows only after current proof", async () => {
  const fixture = await audioFixture();
  await writeAudioChapters(env.DB, fixture.principal, fixture.ids.file, fixture.ids.blob, 0, [
    chapter("old", 1_000),
  ]);
  const replacement = `${fixture.ids.blob}-replacement`;
  await atomicBatch(env.DB, [
    {
      sql: `INSERT INTO blobs(id,owner_id,r2_key,size,content_etag,state,created_at)
        VALUES(?,?,?,4,'replacement','committed',?)`,
      values: [replacement, fixture.ids.user, `u/${fixture.ids.user}/b/${replacement}`, Date.now()],
    },
    {
      sql: "INSERT INTO blob_storage(blob_id,bytes,r2_etag,observed_at) VALUES(?,4,'replacement',?)",
      values: [replacement, Date.now()],
    },
    {
      sql: "UPDATE nodes SET current_blob_id=?,revision=revision+1 WHERE id=?",
      values: [replacement, fixture.ids.file],
    },
    {
      sql: `UPDATE node_audio SET blob_id=?,duration_ms=90000,generator_version=? WHERE node_id=?`,
      values: [replacement, AUDIO_GENERATOR_VERSION, fixture.ids.file],
    },
  ]);
  expect(await readAudioChapters(env.DB, fixture.principal, fixture.ids.file)).toMatchObject({
    blobId: replacement,
    revision: 0,
    chapters: [],
  });
  await expect(
    writeAudioChapters(env.DB, fixture.principal, fixture.ids.file, fixture.ids.blob, 1, []),
  ).rejects.toThrow("audio_chapters_unavailable");
  expect(
    await env.DB.prepare("SELECT COUNT(*) AS n FROM user_audio_chapter_sets WHERE blob_id=?")
      .bind(fixture.ids.blob)
      .first("n"),
  ).toBe(1);
  await writeAudioChapters(env.DB, fixture.principal, fixture.ids.file, replacement, 0, []);
  expect(
    await env.DB.prepare("SELECT COUNT(*) AS n FROM user_audio_chapter_sets WHERE blob_id=?")
      .bind(fixture.ids.blob)
      .first("n"),
  ).toBe(0);
});

it("rejects invalid complete lists, duration changes, maintenance, epoch, and trash without mutation", async () => {
  const fixture = await audioFixture();
  const write = (chapters: Parameters<typeof writeAudioChapters>[5]) =>
    writeAudioChapters(env.DB, fixture.principal, fixture.ids.file, fixture.ids.blob, 0, chapters);
  await expect(write([chapter("duplicate", 1), chapter("duplicate", 2)])).rejects.toThrow(
    "invalid_audio_chapters",
  );
  await expect(write([chapter("late", 185_001)])).rejects.toThrow("invalid_audio_chapters");
  await expect(write([chapter("title", 1, "あ".repeat(86))])).rejects.toThrow(
    "invalid_audio_chapters",
  );
  await expect(
    write(Array.from({ length: 201 }, (_, index) => chapter(`c${index}`, index))),
  ).rejects.toThrow("invalid_audio_chapters");
  await env.DB.prepare("UPDATE node_audio SET duration_ms=184999 WHERE node_id=?")
    .bind(fixture.ids.file)
    .run();
  await writeAudioChapters(env.DB, fixture.principal, fixture.ids.file, fixture.ids.blob, 0, [
    chapter("current", 1),
  ]);
  await env.DB.prepare("UPDATE node_audio SET duration_ms=180000 WHERE node_id=?")
    .bind(fixture.ids.file)
    .run();
  await expect(
    writeAudioChapters(env.DB, fixture.principal, fixture.ids.file, fixture.ids.blob, 1, []),
  ).rejects.toThrow();
  expect(
    await env.DB.prepare("SELECT COUNT(*) AS n FROM user_audio_chapters").first("n"),
  ).toBeGreaterThan(0);
  await env.DB.prepare("UPDATE control SET maintenance=1").run();
  await expect(readAudioChapters(env.DB, fixture.principal, fixture.ids.file)).rejects.toThrow();
  await env.DB.prepare("UPDATE control SET maintenance=0,epoch=2").run();
  await expect(readAudioChapters(env.DB, fixture.principal, fixture.ids.file)).rejects.toThrow();
  await env.DB.prepare("UPDATE control SET epoch=1").run();
  const op = crypto.randomUUID();
  await env.DB.prepare(
    `INSERT INTO trash_ops(op_id,actor_id,space_id,root_node_id,state,created_at,epoch)
      VALUES(?,?,?,?,'trashed',?,1)`,
  )
    .bind(op, fixture.ids.user, fixture.ids.space, fixture.ids.file, Date.now())
    .run();
  await env.DB.prepare("UPDATE nodes SET deleted_at=?,deleted_op_id=? WHERE id=?")
    .bind(Date.now(), op, fixture.ids.file)
    .run();
  await expect(readAudioChapters(env.DB, fixture.principal, fixture.ids.file)).rejects.toThrow();
});

it("enforces private no-store HTTP contracts, CSRF, strict bodies, and user principals", async () => {
  const fixture = await audioFixture();
  const app = { ...env, APP_ORIGIN: "https://app.invalid" };
  const url = `https://app.invalid/api/v1/nodes/${fixture.ids.file}/audio-chapters`;
  const csrf = { verify: async () => undefined };
  const read = await handleAudioChaptersHttp(new Request(url), app, fixture.principal, csrf);
  expect(read.status).toBe(200);
  expect(read.headers.get("Cache-Control")).toBe("private, no-store");
  const write = await handleAudioChaptersHttp(
    new Request(url, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        blobId: fixture.ids.blob,
        expectedRevision: 0,
        chapters: [chapter("http", 3_000)],
      }),
    }),
    app,
    fixture.principal,
    csrf,
  );
  expect(write.status).toBe(200);
  for (const body of [
    { blobId: fixture.ids.blob, expectedRevision: 1 },
    { blobId: fixture.ids.blob, expectedRevision: 1, chapters: [], extra: true },
    {
      blobId: fixture.ids.blob,
      expectedRevision: 1,
      chapters: [{ id: "bad", positionMs: 1.5, title: "bad" }],
    },
  ])
    expect(
      (
        await handleAudioChaptersHttp(
          new Request(url, {
            method: "PUT",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(body),
          }),
          app,
          fixture.principal,
          csrf,
        )
      ).status,
    ).toBe(400);
  expect(
    (
      await handleAudioChaptersHttp(
        new Request(url, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: "{",
        }),
        app,
        fixture.principal,
        csrf,
      )
    ).status,
  ).toBe(400);
  expect(
    (
      await handleAudioChaptersHttp(
        new Request(`${url}?share=public`),
        app,
        fixture.principal,
        csrf,
      )
    ).status,
  ).toBe(404);
  expect(
    (
      await handleAudioChaptersHttp(
        new Request(url),
        app,
        { ...fixture.principal, kind: "app_password" },
        csrf,
      )
    ).status,
  ).toBe(404);
  expect(
    (
      await handleAudioChaptersHttp(
        new Request(url),
        app,
        {
          kind: "link_share",
          share_id: "share",
          share_version: 1,
          credential_id: "ss:share",
          epoch: 1,
        },
        csrf,
      )
    ).status,
  ).toBe(404);
  expect(
    (
      await handleAudioChaptersHttp(
        new Request(url),
        app,
        {
          kind: "service",
          service_principal_id: "service",
          user_id: fixture.ids.user,
          credential_id: "service",
          epoch: 1,
          token_expires_at: Date.now() + 60_000,
          access_iss: "https://access.invalid",
          common_name: "service",
        },
        csrf,
      )
    ).status,
  ).toBe(404);
  expect(
    (
      await handleAudioChaptersHttp(
        new Request(url, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ blobId: fixture.ids.blob, expectedRevision: 1, chapters: [] }),
        }),
        app,
        fixture.principal,
        { verify: async () => Promise.reject(new Error("csrf")) },
      )
    ).status,
  ).toBe(403);
});
