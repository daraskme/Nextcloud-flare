import { applyD1Migrations } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { searchName } from "@next-cloud-flare/shared/names";
import { base64url } from "jose";
import { beforeAll, beforeEach, expect, it } from "vitest";
import type { AudioMetadataUpdate } from "../../../shared/src/audio";
import { handleAudioMetadataHttp } from "../../src/api/audioMetadata";
import { privateAppRoute } from "../../src/api/privateApp";
import { AudioCursorTokens } from "../../src/auth/audioCursor";
import type { Principal } from "../../src/auth/authorize";
import { contentKeyRing } from "../../src/auth/contentTokens";
import { CsrfTokens } from "../../src/auth/csrf";
import { SearchCursorTokens } from "../../src/auth/searchCursor";
import { atomicBatch } from "../../src/db/primary";
import type { Env } from "../../src/env";
import { lookupOperation } from "../../src/jobs/operations";
import { TRACK_METADATA_GENERATOR as generator } from "../../src/media/tracks/common";
import { AUDIO_SEARCH_CURRENT, audioSearchTags } from "../../src/search/audio";
import { listAudio } from "../../src/services/audio";
import { editAudioMetadata } from "../../src/services/audioMetadata";
import { searchNodes } from "../../src/services/search";
import { foundationFixture } from "../fixtures/foundation";
import { admitted, injectBatch } from "../fixtures/uploadEnv";

beforeAll(() => applyD1Migrations(env.DB, env.TEST_MIGRATIONS));
beforeEach(async () => {
  await env.DB.prepare("UPDATE control SET maintenance=1").run();
  await env.DB.prepare("UPDATE control SET epoch=1,maintenance=0").run();
});
async function fixture() {
  const f = foundationFixture(crypto.randomUUID(), Date.now() - 1000);
  await atomicBatch(env.DB, f.statements);
  const q = searchName("File");
  await atomicBatch(env.DB, [
    {
      sql: `UPDATE blobs SET mime_sniffed='audio/ogg; codecs="opus"' WHERE id=?`,
      values: [f.ids.blob],
    },
    {
      sql: "INSERT INTO node_audio(node_id,blob_id,generator_version,codec,title_extracted,artist_extracted,album_extracted) VALUES(?,?,?,'opus','元の曲','Artist','Album')",
      values: [f.ids.file, f.ids.blob, generator],
    },
    {
      sql: "INSERT INTO search_index(node_id,space_id,text_norm,tokens,normalization_version,revision) VALUES(?,?,?,?,?,1)",
      values: [f.ids.file, f.ids.space, q.textNorm, q.tokens, q.version],
    },
    {
      sql: "INSERT INTO search_fts(rowid,text_norm,tokens) SELECT rowid,text_norm,tokens FROM search_index WHERE node_id=?",
      values: [f.ids.file],
    },
  ]);
  const principal = {
    kind: "user" as const,
    user_id: f.ids.user,
    credential_id: f.ids.credential,
    epoch: 1,
  };
  const input: AudioMetadataUpdate = {
    blobId: f.ids.blob,
    generator,
    revision: 1,
    title: "修正した曲",
    artist: "演奏者",
    album: null,
  };
  const app = { ...admitted(), APP_ORIGIN: "https://app.invalid" },
    key = crypto.randomUUID();
  const ring = await contentKeyRing("test", {
      test: base64url.encode(crypto.getRandomValues(new Uint8Array(32))),
    }),
    tokens = new AudioCursorTokens(ring);
  const list = (p: Principal = principal, root = f.ids.file) => listAudio(env.DB, p, root, tokens);
  const save = (body = input, p: Principal = principal, k: string = key, db = env.DB) =>
    editAudioMetadata({ ...app, DB: db }, p, f.ids.file, k, body);
  const row = () =>
    env.DB.prepare("SELECT * FROM node_audio WHERE node_id=?").bind(f.ids.file).first();
  return { f, principal, input, app, key, ring, list, save, row };
}
it("edits only overrides with a durable audited receipt, replays once and resets to extracted values", async () => {
  const t = await fixture();
  const search = (q: string) =>
    searchNodes(env.DB, t.principal, t.f.ids.folder, q, new SearchCursorTokens(t.ring));
  expect((await search("元の曲")).truncated).toBe(true);
  const before = await t.list();
  expect(before.canEdit).toBe(true);
  expect(before.items[0]?.metadata).toEqual({
    revision: 1,
    extracted: { title: "元の曲", artist: "Artist", album: "Album" },
    overrides: { title: null, artist: null, album: null },
  });
  expect((await t.list(t.principal, t.f.ids.folder)).items[0]?.metadata).toBeUndefined();
  const outcome = await t.save();
  expect(outcome).toMatchObject({
    kind: "terminal",
    operation: { state: "committed", result: { revision: 2, status: 200 } },
  });
  expect(await t.save()).toEqual(outcome);
  expect(await t.row()).toMatchObject({
    title_extracted: "元の曲",
    title_override: "修正した曲",
    artist_override: "演奏者",
    album_override: null,
    search_text_norm: "修正した曲\n演奏者\nalbum",
    search_source: JSON.stringify(["修正した曲", "演奏者", "Album"]),
  });
  expect((await t.list()).items[0]).toMatchObject({
    title: "修正した曲",
    album: "Album",
    metadata: { revision: 2 },
  });
  expect(
    await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM activity WHERE affected_id=? AND kind='audio.metadata.write'",
    )
      .bind(t.f.ids.file)
      .first("n"),
  ).toBe(1);
  expect(
    await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM operation_steps WHERE op_id=(SELECT last_op_id FROM nodes WHERE id=?)",
    )
      .bind(t.f.ids.file)
      .first("n"),
  ).toBe(7);
  expect(
    await env.DB.prepare("SELECT current_blob_id FROM nodes WHERE id=?")
      .bind(t.f.ids.file)
      .first("current_blob_id"),
  ).toBe(t.f.ids.blob);
  expect(
    await env.DB.prepare("SELECT revision FROM search_index WHERE node_id=?")
      .bind(t.f.ids.file)
      .first("revision"),
  ).toBe(2);
  expect((await search("修正した曲")).items.map((n) => n.id)).toEqual([t.f.ids.file]);
  expect((await search("演奏者")).items.map((n) => n.id)).toEqual([t.f.ids.file]);
  expect((await search("ALBUM")).truncated).toBe(false);
  expect((await search("元の曲")).items).toEqual([]);
  await env.DB.prepare("INSERT INTO search_fts(search_fts,rank) VALUES('integrity-check',1)").run();
  await t.save(
    { ...t.input, revision: 2, title: null, artist: null, album: null },
    t.principal,
    crypto.randomUUID(),
  );
  expect((await t.list()).items[0]).toMatchObject({
    title: "元の曲",
    artist: "Artist",
    metadata: { revision: 3 },
  });
  const reset = audioSearchTags({ title: "元の曲", artist: "Artist", album: "Album" });
  expect(await t.row()).toMatchObject({
    search_text_norm: reset.textNorm,
    search_tokens: reset.tokens,
    search_source: reset.source,
    search_version: reset.version,
  });
  expect(
    await env.DB.prepare(
      `SELECT COUNT(*) AS n FROM node_audio a WHERE a.node_id=? AND ${AUDIO_SEARCH_CURRENT}`,
    )
      .bind(t.f.ids.file)
      .first("n"),
  ).toBe(1);
  expect((await search("修正した曲")).items).toEqual([]);
  expect((await search("元の曲")).items.map((n) => n.id)).toEqual([t.f.ids.file]);
  await expect(t.save({ ...t.input, title: "other" })).rejects.toThrow("idempotency_conflict");
});
it("rejects old revisions, stale blobs and unsupported metadata before writing", async () => {
  const t = await fixture();
  for (const input of [
    { ...t.input, revision: 2 },
    { ...t.input, blobId: "other" },
    { ...t.input, generator: "old" },
  ])
    await expect(t.save(input)).rejects.toThrow();
  await env.DB.prepare("UPDATE blobs SET mime_sniffed='text/plain' WHERE id=?")
    .bind(t.f.ids.blob)
    .run();
  await expect(t.save()).rejects.toThrow("audio_metadata_conflict");
  expect(await t.row()).toMatchObject({ title_override: null });
});
it("requires the selected live edit grant and never substitutes another read or edit share", async () => {
  const owner = await fixture(),
    receiver = await fixture(),
    share = crypto.randomUUID();
  await atomicBatch(env.DB, [
    {
      sql: "INSERT INTO shares(id,owner_id,root_node_id,kind,created_at) VALUES(?,?,?,'internal',1)",
      values: [share, owner.f.ids.user, owner.f.ids.folder],
    },
    { sql: "INSERT INTO share_actions(share_id,action) VALUES(?,'read')", values: [share] },
    {
      sql: "INSERT INTO share_grants(share_id,user_id,version) VALUES(?,?,1)",
      values: [share, receiver.f.ids.user],
    },
  ]);
  const p = { ...receiver.principal, selected_share: { id: share, version: 1 } };
  expect((await owner.list(p)).canEdit).toBe(false);
  expect((await owner.list(p)).items[0]?.metadata).toBeUndefined();
  await expect(owner.save(owner.input, p)).rejects.toThrow("authorization_denied");
  await env.DB.prepare("INSERT INTO share_actions(share_id,action) VALUES(?,'edit')")
    .bind(share)
    .run();
  expect((await owner.list(p)).canEdit).toBe(true);
  await expect(owner.save(owner.input, receiver.principal)).rejects.toThrow("authorization_denied");
  const saved = await owner.save(owner.input, p);
  expect(saved).toMatchObject({ kind: "terminal", operation: { state: "committed" } });
  if (saved.kind !== "terminal") throw new Error("missing receipt");
  expect(await lookupOperation(env.DB, receiver.principal, saved.operation.id)).not.toBeNull();
  await env.DB.prepare("DELETE FROM share_actions WHERE share_id=? AND action='edit'")
    .bind(share)
    .run();
  expect(await lookupOperation(env.DB, receiver.principal, saved.operation.id)).toBeNull();
  await expect(owner.save(owner.input, p)).rejects.toThrow("authorization_denied");
});
it.each(["revision", "metadata", "credential", "epoch", "hidden", "lock", "index"])(
  "rechecks %s in the final batch and leaves no partial metadata edit",
  async (kind) => {
    const t = await fixture();
    const db = injectBatch(
      (sql) => sql.includes("UPDATE node_audio SET title_override"),
      async () => {
        if (kind === "revision")
          await env.DB.prepare("UPDATE nodes SET revision=revision+1 WHERE id=?")
            .bind(t.f.ids.file)
            .run();
        if (kind === "index")
          await env.DB.prepare("UPDATE search_index SET revision=revision+1 WHERE node_id=?")
            .bind(t.f.ids.file)
            .run();
        if (kind === "metadata")
          await env.DB.prepare(
            "UPDATE node_audio SET title_extracted='new extraction' WHERE node_id=?",
          )
            .bind(t.f.ids.file)
            .run();
        if (kind === "credential")
          await env.DB.prepare("UPDATE sessions SET revoked_at=? WHERE id=?")
            .bind(Date.now(), t.f.ids.session)
            .run();
        if (kind === "epoch") await env.DB.prepare("UPDATE control SET maintenance=1").run();
        if (kind === "hidden")
          await env.DB.prepare("UPDATE nodes SET hidden=1 WHERE id=?").bind(t.f.ids.folder).run();
        if (kind === "lock")
          await env.DB.prepare(
            "INSERT INTO locks(id,node_id,space_id,creator_credential_id,token_hash,depth,owner_text,epoch,expires_at) VALUES(?,?,?,?,?,'0','',1,?)",
          )
            .bind(
              crypto.randomUUID(),
              t.f.ids.file,
              t.f.ids.space,
              t.f.ids.credential,
              crypto.randomUUID(),
              Date.now() + 60000,
            )
            .run();
      },
      false,
    );
    const result = await t.save(t.input, t.principal, t.key, db);
    expect(result).not.toMatchObject({ kind: "terminal", operation: { state: "committed" } });
    expect(await t.row()).toMatchObject({
      title_override: null,
      artist_override: null,
      search_version: "",
      search_text_norm: "",
      search_tokens: "",
      search_source: "",
    });
    expect(
      await env.DB.prepare("SELECT COUNT(*) AS n FROM activity WHERE affected_id=?")
        .bind(t.f.ids.file)
        .first("n"),
    ).toBe(0);
    expect(
      await env.DB.prepare(
        "SELECT COUNT(*) AS n FROM operation_steps WHERE op_id IN (SELECT op_id FROM operations WHERE space_id=?)",
      )
        .bind(t.f.ids.space)
        .first("n"),
    ).toBe(0);
  },
);
it("reconciles a lost commit ACK without repeating the edit or audit record", async () => {
  const t = await fixture();
  const db = injectBatch(
    (sql) => sql.includes("UPDATE node_audio SET title_override"),
    async () => {
      throw new Error("response lost");
    },
    true,
  );
  const result = await t.save(t.input, t.principal, t.key, db);
  expect(result).toMatchObject({ kind: "terminal", operation: { state: "committed" } });
  expect(await t.save()).toEqual(result);
  expect(
    await env.DB.prepare("SELECT revision FROM nodes WHERE id=?")
      .bind(t.f.ids.file)
      .first("revision"),
  ).toBe(2);
});
it("returns the same receipt when an identical request commits while a duplicate acquires its permit", async () => {
  const t = await fixture();
  let committed: Awaited<ReturnType<typeof editAudioMetadata>> | undefined;
  const app = {
    ...t.app,
    LOCKS: {
      idFromName: t.app.LOCKS.idFromName.bind(t.app.LOCKS),
      get(id: DurableObjectId) {
        const lock = t.app.LOCKS.get(id);
        return {
          acquireNodeWrite: async (request: Parameters<typeof lock.acquireNodeWrite>[0]) => {
            const permit = await lock.acquireNodeWrite(request);
            committed = await t.save();
            return permit;
          },
          release: lock.release.bind(lock),
        };
      },
    } as unknown as Env["LOCKS"],
  };
  expect(await editAudioMetadata(app, t.principal, t.f.ids.file, t.key, t.input)).toEqual(
    committed,
  );
  expect(
    await env.DB.prepare("SELECT revision FROM nodes WHERE id=?")
      .bind(t.f.ids.file)
      .first("revision"),
  ).toBe(2);
});
it("enforces Access, CSRF, bounded body and idempotency on the existing PATCH route", async () => {
  const t = await fixture(),
    csrf = new CsrfTokens(t.ring, t.ring, t.app.APP_ORIGIN),
    { token } = await csrf.issue(
      env.DB,
      new Request(`${t.app.APP_ORIGIN}/api/v1/csrf`, {
        method: "POST",
        headers: { "Sec-Fetch-Site": "same-origin" },
      }),
      {
        kind: "access",
        credentialId: t.principal.credential_id,
        epoch: 1,
      },
    );
  const request = (body: unknown, headers: Record<string, string> = {}) =>
    new Request(`https://app.invalid/api/v1/nodes/${t.f.ids.file}/audio`, {
      method: "PATCH",
      headers: {
        Origin: t.app.APP_ORIGIN,
        "Sec-Fetch-Site": "same-origin",
        "Content-Type": "application/json",
        "X-CSRF-Token": token,
        "Idempotency-Key": t.key,
        ...headers,
      },
      body: JSON.stringify(body),
    });
  expect(privateAppRoute(request(t.input))).toBe(true);
  expect(
    (
      await handleAudioMetadataHttp(
        request(t.input, { "X-CSRF-Token": "" }),
        t.app,
        t.principal,
        csrf,
      )
    ).status,
  ).toBe(403);
  expect(
    (
      await handleAudioMetadataHttp(
        request({ ...t.input, ownerId: "other" }),
        t.app,
        t.principal,
        csrf,
      )
    ).status,
  ).toBe(400);
  expect(
    (
      await handleAudioMetadataHttp(
        request(t.input, { "Idempotency-Key": "" }),
        t.app,
        t.principal,
        csrf,
      )
    ).status,
  ).toBe(400);
  const result = await handleAudioMetadataHttp(request(t.input), t.app, t.principal, csrf);
  expect(result.status).toBe(200);
  expect(result.headers.get("cache-control")).toContain("no-store");
  expect(result.headers.get("operation-id")).toMatch(/^op_/);
  expect(
    (
      await handleAudioMetadataHttp(
        request({ ...t.input, title: "other" }, { "Idempotency-Key": crypto.randomUUID() }),
        t.app,
        t.principal,
        csrf,
      )
    ).status,
  ).toBe(409);
  expect(
    (
      await handleAudioMetadataHttp(
        request(t.input),
        t.app,
        { kind: "link_share", share_id: "s", share_version: 1, credential_id: "c", epoch: 1 },
        csrf,
      )
    ).status,
  ).toBe(400);
});
