import { applyD1Migrations } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { base64url } from "jose";
import { beforeAll, beforeEach, expect, it } from "vitest";
import { contentKeyRing } from "../../src/auth/contentTokens";
import { SEARCH_CURSOR_VERSION, SearchCursorTokens } from "../../src/auth/searchCursor";
import { reindexAudioNode } from "../../src/jobs/audioSearchReindex";
import { AUDIO_SEARCH_VERSION, audioSearchTags } from "../../src/search/audio";
import { searchNodes } from "../../src/services/search";
import { audioReindexBackupFence, audioReindexFixture } from "../fixtures/audioReindex";
import { measureD1 } from "../fixtures/d1Calls";
import { mutationEnv } from "../fixtures/mutationAdmission";
import { injectBatch } from "../fixtures/uploadEnv";

beforeAll(() => applyD1Migrations(env.DB, env.TEST_MIGRATIONS));
beforeEach(async () => {
  await env.DB.prepare(
    "UPDATE control SET backup_token=NULL,backup_frozen=0,restore_freeze_token=NULL",
  ).run();
  await env.DB.prepare("UPDATE control SET maintenance=1").run();
  await env.DB.prepare("UPDATE control SET epoch=1,maintenance=0").run();
  await env.DB.prepare("UPDATE mutation_admissions SET state='closed' WHERE state='active'").run();
});
async function fixture(indexed = true) {
  const f = await audioReindexFixture(1, indexed),
    app = mutationEnv();
  const row = () =>
    env.DB.prepare("SELECT * FROM node_audio WHERE node_id=?")
      .bind(f.ids.file)
      .first<Record<string, unknown>>();
  const index = () =>
    env.DB.prepare("SELECT * FROM search_index WHERE node_id=?").bind(f.ids.file).first();
  const generation = () =>
    env.DB.prepare("SELECT tree_generation FROM spaces WHERE id=?")
      .bind(f.ids.space)
      .first<number>("tree_generation");
  const run = (db = env.DB, epoch = 1) => reindexAudioNode({ ...app, DB: db }, epoch, f.ids.file);
  return { f, row, index, generation, run };
}
it.each([true, false])(
  "repairs legacy tags and base/FTS atomically (existing index: %s) without changing user data",
  async (indexed) => {
    const t = await fixture(indexed),
      id = t.f.ids.file;
    await env.DB.prepare("INSERT INTO user_playback_state VALUES(?,?,?,42000,1)")
      .bind(t.f.ids.user, id, t.f.ids.blob)
      .run();
    const before = await t.row(),
      generation = (await t.generation())!;
    const node = await env.DB.prepare("SELECT * FROM nodes WHERE id=?").bind(id).first();
    const blob = await env.DB.prepare("SELECT * FROM blobs WHERE id=?").bind(t.f.ids.blob).first();
    const measured = measureD1(env.DB);
    expect(await t.run(measured.db)).toBe("repaired");
    expect(measured.counts.calls).toBeLessThanOrEqual(3);
    expect(measured.counts.statements).toBeLessThanOrEqual(20);
    const expected = audioSearchTags({ title: "ｶﾀｶﾅ / Straße", artist: "O'Brien", album: "Album" });
    expect(await t.row()).toEqual({
      ...before,
      search_text_norm: expected.textNorm,
      search_tokens: expected.tokens,
      search_source: expected.source,
      search_version: expected.version,
    });
    expect(await t.index()).toMatchObject({ text_norm: `file\n${expected.textNorm}`, revision: 1 });
    expect(await t.generation()).toBe(generation + 1);
    expect(await t.run()).toBe("current");
    expect(await t.generation()).toBe(generation + 1);
    expect(await env.DB.prepare("SELECT * FROM nodes WHERE id=?").bind(id).first()).toEqual(node);
    expect(
      await env.DB.prepare("SELECT * FROM blobs WHERE id=?").bind(t.f.ids.blob).first(),
    ).toEqual(blob);
    expect(
      await env.DB.prepare("SELECT position_ms FROM user_playback_state WHERE node_id=?")
        .bind(id)
        .first("position_ms"),
    ).toBe(42000);
    await env.DB.prepare(
      "INSERT INTO search_fts(search_fts,rank) VALUES('integrity-check',1)",
    ).run();
  },
);
it("makes existing songs searchable and invalidates a pre-repair search cursor", async () => {
  const t = await fixture(),
    f = t.f;
  const ring = await contentKeyRing("test", {
      test: base64url.encode(crypto.getRandomValues(new Uint8Array(32))),
    }),
    tokens = new SearchCursorTokens(ring);
  const principal = {
    kind: "user" as const,
    user_id: f.ids.user,
    credential_id: f.ids.credential,
    epoch: 1,
  };
  const search = (q: string, cursor?: string) =>
    searchNodes(env.DB, principal, f.ids.folder, q, tokens, cursor);
  expect(await search("かたかな")).toMatchObject({ items: [], truncated: true });
  const cursor = await tokens.issue({
    scopeId: f.ids.folder,
    spaceId: f.ids.space,
    ownerId: f.ids.user,
    userId: f.ids.user,
    credentialId: f.ids.credential,
    epoch: 1,
    generation: (await t.generation())!,
    query: "かたかな",
    version: SEARCH_CURSOR_VERSION,
    lastNameCi: "file",
    lastId: f.ids.file,
  });
  await t.run();
  for (const q of ["かたかな", "STRASSE", "O'Brien", "album", "File"])
    expect(await search(q)).toMatchObject({ items: [{ id: f.ids.file }], truncated: false });
  expect((await search("Original")).items).toEqual([]);
  await expect(search("かたかな", cursor)).rejects.toThrow("invalid_search_cursor");
});
it.each(["v1", "name", "source", "missing"])("repairs %s cache/index drift", async (kind) => {
  const t = await fixture();
  await t.run();
  if (kind === "v1")
    await env.DB.prepare("UPDATE node_audio SET search_version='audio-tags-1' WHERE node_id=?")
      .bind(t.f.ids.file)
      .run();
  if (kind === "name")
    await env.DB.prepare("UPDATE search_index SET normalization_version='legacy' WHERE node_id=?")
      .bind(t.f.ids.file)
      .run();
  if (kind === "source")
    await env.DB.prepare("UPDATE node_audio SET title_override='New title' WHERE node_id=?")
      .bind(t.f.ids.file)
      .run();
  if (kind === "missing") {
    await env.DB.prepare(
      "INSERT INTO search_fts(search_fts,rowid,text_norm,tokens) SELECT 'delete',rowid,text_norm,tokens FROM search_index WHERE node_id=?",
    )
      .bind(t.f.ids.file)
      .run();
    await env.DB.prepare("DELETE FROM search_index WHERE node_id=?").bind(t.f.ids.file).run();
  }
  const generation = (await t.generation())!;
  expect(await t.run()).toBe("repaired");
  expect(await t.row()).toMatchObject({ search_version: AUDIO_SEARCH_VERSION });
  expect(await t.generation()).toBe(generation + 1);
  await env.DB.prepare("INSERT INTO search_fts(search_fts,rank) VALUES('integrity-check',1)").run();
});
it.each(["generator", "codec", "mime", "blob", "oversize"])(
  "preserves unavailable %s data",
  async (kind) => {
    const t = await fixture(),
      id = t.f.ids.file;
    if (kind === "generator")
      await env.DB.prepare("UPDATE node_audio SET generator_version='old' WHERE node_id=?")
        .bind(id)
        .run();
    if (kind === "codec")
      await env.DB.prepare("UPDATE node_audio SET codec='aac' WHERE node_id=?").bind(id).run();
    if (kind === "mime")
      await env.DB.prepare("UPDATE blobs SET mime_sniffed='image/png' WHERE id=?")
        .bind(t.f.ids.blob)
        .run();
    if (kind === "blob")
      await env.DB.prepare("UPDATE nodes SET current_blob_id=NULL WHERE id=?").bind(id).run();
    if (kind === "oversize")
      await env.DB.prepare("UPDATE node_audio SET title_override=? WHERE node_id=?")
        .bind("a".repeat(200000), id)
        .run();
    const before = await t.row(),
      index = await t.index(),
      generation = await t.generation();
    expect(await t.run()).toBe("unavailable");
    expect(await t.row()).toEqual(before);
    expect(await t.index()).toEqual(index);
    expect(await t.generation()).toBe(generation);
  },
);
it("handles maximal Unicode expansion and all-null tags without truncating", async () => {
  const t = await fixture(),
    value = "ﷺ".repeat(341);
  for (const tags of [
    { title: value, artist: value, album: value },
    { title: null, artist: null, album: null },
  ]) {
    await env.DB.prepare(
      "UPDATE node_audio SET title_override=?,title_extracted=NULL,artist_extracted=?,album_extracted=? WHERE node_id=?",
    )
      .bind(tags.title, tags.artist, tags.album, t.f.ids.file)
      .run();
    expect(await t.run()).toBe("repaired");
    expect(await t.row()).toMatchObject({
      search_text_norm: audioSearchTags(tags).textNorm,
      search_source: JSON.stringify(Object.values(tags)),
    });
  }
});
it.each(["future", "foreign"])("refuses a %s index rather than adopting it", async (kind) => {
  const t = await fixture();
  if (kind === "future")
    await env.DB.prepare("UPDATE search_index SET revision=99 WHERE node_id=?")
      .bind(t.f.ids.file)
      .run();
  else {
    const other = await audioReindexFixture();
    await env.DB.prepare("UPDATE search_index SET space_id=? WHERE node_id=?")
      .bind(other.ids.space, t.f.ids.file)
      .run();
  }
  const before = await t.row();
  await expect(t.run()).rejects.toThrow("audio_reindex_index_conflict");
  expect(await t.row()).toEqual(before);
});
it.each(["name", "revision", "blob", "tags", "delete", "stop", "epoch", "backup"])(
  "rolls back all derived writes after a %s race",
  async (kind) => {
    const t = await fixture(),
      id = t.f.ids.file,
      before = await t.index(),
      generation = await t.generation();
    let raced: Record<string, unknown> | null = null;
    const db = injectBatch(
      (sql) => sql.startsWith("UPDATE node_audio SET search_text_norm"),
      async () => {
        if (kind === "name")
          await env.DB.prepare("UPDATE nodes SET name='Renamed',name_ci='renamed' WHERE id=?")
            .bind(id)
            .run();
        if (kind === "revision")
          await env.DB.prepare("UPDATE nodes SET revision=2 WHERE id=?").bind(id).run();
        if (kind === "blob")
          await env.DB.prepare("UPDATE nodes SET current_blob_id=NULL WHERE id=?").bind(id).run();
        if (kind === "tags")
          await env.DB.prepare("UPDATE node_audio SET title_override='Foreground' WHERE node_id=?")
            .bind(id)
            .run();
        if (kind === "delete")
          await env.DB.prepare("DELETE FROM node_audio WHERE node_id=?").bind(id).run();
        if (kind === "stop" || kind === "epoch")
          await env.DB.prepare("UPDATE control SET maintenance=1").run();
        if (kind === "epoch")
          await env.DB.prepare("UPDATE control SET epoch=2,maintenance=0").run();
        if (kind === "backup") await audioReindexBackupFence();
        raced = await t.row();
      },
      false,
    );
    await expect(t.run(db)).rejects.toThrow();
    expect(await t.row()).toEqual(raced);
    expect(await t.index()).toEqual(before);
    expect(await t.generation()).toBe(generation);
  },
);
it("recovers a lost commit acknowledgement without applying twice", async () => {
  const t = await fixture(),
    generation = (await t.generation())!;
  const db = injectBatch(
    (sql) => sql.startsWith("UPDATE node_audio SET search_text_norm"),
    async () => {
      throw new Error("lost_ack");
    },
    true,
  );
  expect(await t.run(db)).toBe("repaired");
  expect(await t.run()).toBe("current");
  expect(await t.generation()).toBe(generation + 1);
});
it("rolls back cache, base and FTS when the final generation update fails", async () => {
  const t = await fixture(),
    before = await t.row(),
    index = await t.index();
  await env.DB.prepare("UPDATE spaces SET tree_generation=9007199254740991 WHERE id=?")
    .bind(t.f.ids.space)
    .run();
  await expect(t.run()).rejects.toThrow();
  expect(await t.row()).toEqual(before);
  expect(await t.index()).toEqual(index);
  expect(await t.generation()).toBe(9007199254740991);
  await env.DB.prepare("INSERT INTO search_fts(search_fts,rank) VALUES('integrity-check',1)").run();
});
it.each(["stop", "epoch", "backup", "restore"])(
  "does no work behind an existing %s fence",
  async (kind) => {
    const t = await fixture(),
      before = await t.row();
    if (kind === "stop" || kind === "restore" || kind === "epoch")
      await env.DB.prepare("UPDATE control SET maintenance=1").run();
    if (kind === "epoch") await env.DB.prepare("UPDATE control SET epoch=2,maintenance=0").run();
    if (kind === "backup") await audioReindexBackupFence();
    if (kind === "restore")
      await env.DB.prepare("UPDATE control SET gc_paused=1,restore_freeze_token=?")
        .bind(crypto.randomUUID())
        .run();
    expect(await t.run()).toBe("unavailable");
    expect(await t.row()).toEqual(before);
  },
);
