import { applyD1Migrations } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { base64url } from "jose";
import { beforeAll, beforeEach, expect, it, vi } from "vitest";
import { handleAudioListHttp, handlePlaybackHttp } from "../../src/api/audio";
import { privateAppRoute } from "../../src/api/privateApp";
import { handlePublicShareHttp, publicShareRoute } from "../../src/api/publicShares";
import { AudioCursorTokens } from "../../src/auth/audioCursor";
import type { Principal } from "../../src/auth/authorize";
import { contentKeyRing } from "../../src/auth/contentTokens";
import { CsrfTokens } from "../../src/auth/csrf";
import { NodeCursorTokens } from "../../src/auth/nodeCursor";
import { atomicBatch } from "../../src/db/primary";
import { TRACK_METADATA_GENERATOR as generator } from "../../src/media/tracks/common";
import { listAudio, PlaybackConflict, savePlayback } from "../../src/services/audio";
import { foundationFixture } from "../fixtures/foundation";
import { mutationEnv } from "../fixtures/mutationAdmission";
import { publicShareFixture } from "../fixtures/publicShare";
import { injectBatch } from "../fixtures/uploadEnv";

beforeAll(() => applyD1Migrations(env.DB, env.TEST_MIGRATIONS));
beforeEach(async () => {
  await env.DB.prepare("UPDATE control SET maintenance=1").run();
  await env.DB.prepare("UPDATE control SET epoch=1,maintenance=0").run();
});
async function metadata(node: string, blob: string) {
  await env.DB.prepare("UPDATE blobs SET mime_sniffed='audio/ogg; codecs=\"opus\"' WHERE id=?")
    .bind(blob)
    .run();
  await env.DB.prepare(`INSERT INTO node_audio(node_id,blob_id,generator_version,duration_ms,codec,title_extracted,artist_extracted,album_extracted,track_number)
    VALUES(?,?,?,90000,'opus','<script>title</script>','Artist','Album',2)`)
    .bind(node, blob, generator)
    .run();
}
async function fixture() {
  const f = foundationFixture(crypto.randomUUID(), Date.now() - 1000);
  await atomicBatch(env.DB, f.statements);
  await metadata(f.ids.file, f.ids.blob);
  const principal = {
    kind: "user" as const,
    user_id: f.ids.user,
    credential_id: f.ids.credential,
    epoch: 1,
  };
  const ring = await contentKeyRing("test", {
    test: base64url.encode(crypto.getRandomValues(new Uint8Array(32))),
  });
  const tokens = new AudioCursorTokens(ring),
    cursors = new NodeCursorTokens(ring);
  const app = { ...mutationEnv(), APP_ORIGIN: "https://app.invalid" };
  const input = {
    blobId: f.ids.blob,
    generator,
    positionMs: 1234,
    previousUpdatedAt: null as number | null,
  };
  const list = (p: Principal = principal, cursor?: string, root = f.ids.folder) =>
    listAudio(env.DB, p, root, tokens, cursor);
  const state = () =>
    env.DB.prepare(
      "SELECT user_id,node_id,blob_id,position_ms,updated_at FROM user_playback_state WHERE node_id=? ORDER BY user_id",
    )
      .bind(f.ids.file)
      .all();
  const add = async (count: number) => {
    const prefix = crypto.randomUUID();
    await env.DB.prepare(`WITH RECURSIVE seq(i) AS (SELECT 0 UNION ALL SELECT i+1 FROM seq WHERE i<?)
      INSERT INTO blobs(id,owner_id,r2_key,size,content_etag,mime_sniffed,state,created_at)
      SELECT ?||i,?,'u/'||?||'/b/'||?||i,3,'etag','audio/webm; codecs="opus"','committed',1 FROM seq`)
      .bind(count - 1, prefix + "b", f.ids.user, f.ids.user, prefix + "b")
      .run();
    await env.DB.prepare(`WITH RECURSIVE seq(i) AS (SELECT 0 UNION ALL SELECT i+1 FROM seq WHERE i<?)
      INSERT INTO nodes(id,space_id,owner_id,parent_id,name,name_ci,kind,current_blob_id,created_at,updated_at)
      SELECT ?||printf('%06d',i),?,?,?,printf('%06d.opus',i),printf('%06d.opus',i),'file',?||i,1,1 FROM seq`)
      .bind(count - 1, prefix, f.ids.space, f.ids.user, f.ids.folder, prefix + "b")
      .run();
    await env.DB.prepare(`INSERT INTO node_audio(node_id,blob_id,generator_version,codec,duration_ms)
      SELECT id,current_blob_id,?,'opus',90000 FROM nodes WHERE id LIKE ?`)
      .bind(generator, prefix + "%")
      .run();
  };
  return { f, principal, tokens, cursors, ring, app, input, list, state, add };
}
async function share(
  owner: Awaited<ReturnType<typeof fixture>>,
  recipient: Awaited<ReturnType<typeof fixture>>,
) {
  const id = crypto.randomUUID();
  await env.DB.prepare(
    "INSERT INTO shares(id,owner_id,root_node_id,kind,created_at) VALUES(?,?,?,'internal',1)",
  )
    .bind(id, owner.f.ids.user, owner.f.ids.folder)
    .run();
  await env.DB.prepare("INSERT INTO share_actions(share_id,action) VALUES(?,'read')")
    .bind(id)
    .run();
  await env.DB.prepare("INSERT INTO share_grants(share_id,user_id,version) VALUES(?,?,1)")
    .bind(id, recipient.f.ids.user)
    .run();
  return { ...recipient.principal, selected_share: { id, version: 1 } };
}
it("returns current tags, prefers overrides, and separates each user's position on a read share", async () => {
  const t = await fixture(),
    r = await fixture(),
    p = await share(t, r);
  await env.DB.prepare("UPDATE node_audio SET title_override='My title' WHERE node_id=?")
    .bind(t.f.ids.file)
    .run();
  expect((await t.list()).items[0]).toMatchObject({
    title: "My title",
    artist: "Artist",
    trackNumber: 2,
    playback: null,
  });
  const owner = await savePlayback(t.app, t.principal, t.f.ids.file, t.input);
  expect((await t.list()).items[0]?.playback).toEqual(owner);
  expect((await t.list(p)).items[0]?.playback).toBeNull();
  const other = await savePlayback(t.app, p, t.f.ids.file, { ...t.input, positionMs: 2000 });
  expect((await t.list(p)).items[0]?.playback).toEqual(other);
  expect((await t.list()).items[0]?.playback).toEqual(owner);
  await expect(t.list(r.principal)).rejects.toThrow("authorization_denied");
  await expect(savePlayback(t.app, r.principal, t.f.ids.file, t.input)).rejects.toThrow(
    "authorization_denied",
  );
  const receipts = await env.DB.prepare(
    "SELECT space_id,state FROM mutation_admissions WHERE permit_id LIKE 'playback.write:%' AND space_id=?",
  )
    .bind(t.f.ids.space)
    .all();
  expect(receipts.results).toHaveLength(2);
  expect(receipts.results.every((r) => r.space_id === t.f.ids.space && r.state === "closed")).toBe(
    true,
  );
});
it.each([
  ["mp3", "audio/mpeg"],
  ["flac", "audio/flac"],
  ["pcm", "audio/wav"],
  ["aac", 'audio/mp4; codecs="mp4a.40.2"'],
  ["aac", 'audio/mp4; codecs="mp4a.40.5"'],
  ["aac", 'audio/mp4; codecs="mp4a.40.29"'],
  ["vorbis", 'audio/ogg; codecs="vorbis"'],
])(
  "binds the %s codec to its exact parsed MIME for listing and position writes",
  async (codec, mime) => {
    const t = await fixture();
    await env.DB.prepare("UPDATE node_audio SET codec=? WHERE node_id=?")
      .bind(codec, t.f.ids.file)
      .run();
    await env.DB.prepare("UPDATE blobs SET mime_sniffed=? WHERE id=?")
      .bind(mime, t.f.ids.blob)
      .run();
    expect((await t.list()).items[0]?.mime).toBe(mime);
    await savePlayback(t.app, t.principal, t.f.ids.file, t.input);
    await env.DB.prepare("UPDATE blobs SET mime_sniffed='audio/webm; codecs=\"opus\"' WHERE id=?")
      .bind(t.f.ids.blob)
      .run();
    expect((await t.list()).items).toEqual([]);
    await expect(
      savePlayback(t.app, t.principal, t.f.ids.file, { ...t.input, positionMs: 0 }),
    ).rejects.toThrow();
  },
);
it("pages by name/id with scoped cursors and stops at 2,000 tracks", async () => {
  const t = await fixture();
  await t.add(2002);
  let page = await t.list(),
    cursor = page.nextCursor!;
  expect(page.items).toHaveLength(200);
  expect(page.items[0]?.name).toBe("000000.opus");
  await expect(t.cursors.verify(cursor)).rejects.toThrow("invalid_node_cursor");
  await expect(t.list(t.principal, cursor + "x")).rejects.toThrow("invalid_audio_cursor");
  await expect(t.list(t.principal, cursor, t.f.ids.root)).rejects.toThrow("invalid_audio_cursor");
  await expect(
    t.tokens.verify(await t.cursors.issue(await t.tokens.verify(cursor))),
  ).rejects.toThrow("invalid_audio_cursor");
  let count = page.items.length;
  while (page.nextCursor) {
    page = await t.list(t.principal, page.nextCursor);
    count += page.items.length;
  }
  expect(count).toBe(2000);
  expect(page.limitReached).toBe(true);
  await env.DB.prepare("UPDATE spaces SET tree_generation=tree_generation+1 WHERE id=?")
    .bind(t.f.ids.space)
    .run();
  await expect(t.list(t.principal, cursor)).rejects.toThrow("invalid_audio_cursor");
});
it("does not descend into subfolders and supports an exact shared file root", async () => {
  const t = await fixture();
  expect((await t.list(t.principal, undefined, t.f.ids.root)).items).toEqual([]);
  expect((await t.list(t.principal, undefined, t.f.ids.file)).items.map((x) => x.id)).toEqual([
    t.f.ids.file,
  ]);
});
it.each(["generator", "mime", "blob", "hidden"])("excludes stale or hidden %s", async (kind) => {
  const t = await fixture();
  if (kind === "generator")
    await env.DB.prepare("UPDATE node_audio SET generator_version='old' WHERE node_id=?")
      .bind(t.f.ids.file)
      .run();
  if (kind === "mime")
    await env.DB.prepare("UPDATE blobs SET mime_sniffed='text/html' WHERE id=?")
      .bind(t.f.ids.blob)
      .run();
  if (kind === "blob")
    await env.DB.prepare("UPDATE nodes SET current_blob_id=NULL WHERE id=?")
      .bind(t.f.ids.file)
      .run();
  if (kind === "hidden")
    await env.DB.prepare("UPDATE nodes SET hidden=1 WHERE id=?").bind(t.f.ids.file).run();
  expect((await t.list()).items).toEqual([]);
  await expect(savePlayback(t.app, t.principal, t.f.ids.file, t.input)).rejects.toThrow();
});
it("invalidates old-blob positions and does not overwrite a competing tab", async () => {
  const t = await fixture();
  const writes = await Promise.allSettled([
    savePlayback(t.app, t.principal, t.f.ids.file, t.input),
    savePlayback(t.app, t.principal, t.f.ids.file, { ...t.input, positionMs: 2000 }),
  ]);
  expect(writes.filter((x) => x.status === "fulfilled")).toHaveLength(1);
  const failed = writes.find((x) => x.status === "rejected") as PromiseRejectedResult;
  expect(failed.reason).toBeInstanceOf(PlaybackConflict);
  const prior = (await t.list()).items[0]!.playback!;
  const next = await savePlayback(t.app, t.principal, t.f.ids.file, {
    ...t.input,
    positionMs: 2500,
    previousUpdatedAt: prior.updatedAt,
  });
  expect(next.updatedAt).toBeGreaterThan(prior.updatedAt);
  const blob = t.f.ids.blob + "new";
  await env.DB.prepare(
    "INSERT INTO blobs(id,owner_id,r2_key,size,content_etag,state,created_at) VALUES(?,?,?,3,'new','committed',1)",
  )
    .bind(blob, t.f.ids.user, `u/${t.f.ids.user}/b/${blob}`)
    .run();
  await env.DB.prepare("UPDATE nodes SET current_blob_id=? WHERE id=?")
    .bind(blob, t.f.ids.file)
    .run();
  await env.DB.prepare("DELETE FROM node_audio WHERE node_id=?").bind(t.f.ids.file).run();
  await metadata(t.f.ids.file, blob);
  expect((await t.list()).items[0]?.playback).toBeNull();
  await expect(savePlayback(t.app, t.principal, t.f.ids.file, t.input)).rejects.toThrow();
  await savePlayback(t.app, t.principal, t.f.ids.file, { ...t.input, blobId: blob });
  expect((await t.state()).results).toHaveLength(1);
  expect((await t.state()).results[0]?.blob_id).toBe(blob);
});
it.each(["credential", "hidden", "parent", "blob", "generator", "epoch", "share"])(
  "rechecks %s at the final state transaction",
  async (kind) => {
    const t = await fixture(),
      r = await fixture(),
      p: Principal = kind === "share" ? await share(t, r) : t.principal;
    const db = injectBatch(
      (sql) => sql.includes("INSERT INTO user_playback_state"),
      async () => {
        if (kind === "credential")
          await env.DB.prepare("UPDATE sessions SET revoked_at=1 WHERE id=?")
            .bind(t.f.ids.session)
            .run();
        if (kind === "hidden")
          await env.DB.prepare("UPDATE nodes SET hidden=1 WHERE id=?").bind(t.f.ids.root).run();
        if (kind === "parent")
          await env.DB.prepare("UPDATE nodes SET parent_id=? WHERE id=?")
            .bind(t.f.ids.root, t.f.ids.file)
            .run();
        if (kind === "blob")
          await env.DB.prepare("UPDATE nodes SET current_blob_id=NULL WHERE id=?")
            .bind(t.f.ids.file)
            .run();
        if (kind === "generator")
          await env.DB.prepare("UPDATE node_audio SET generator_version='old' WHERE node_id=?")
            .bind(t.f.ids.file)
            .run();
        if (kind === "epoch")
          await env.DB.prepare("UPDATE control SET maintenance=1,epoch=2").run();
        if (kind === "share")
          await env.DB.prepare("UPDATE shares SET disabled_at=1 WHERE id=?")
            .bind("selected_share" in p ? p.selected_share!.id : "")
            .run();
      },
      false,
    );
    await expect(savePlayback({ ...t.app, DB: db }, p, t.f.ids.file, t.input)).rejects.toThrow();
    expect((await t.state()).results).toEqual([]);
  },
);
it("recovers a lost commit ACK without writing another position", async () => {
  const t = await fixture();
  const db = injectBatch(
    (sql) => sql.includes("INSERT INTO user_playback_state"),
    async () => {
      throw new Error("lost_ack");
    },
    true,
  );
  const result = await savePlayback({ ...t.app, DB: db }, t.principal, t.f.ids.file, t.input);
  expect((await t.list()).items[0]?.playback).toEqual(result);
  expect((await t.state()).results).toHaveLength(1);
});
it.each([-1, 1.1, 90001, Number.MAX_SAFE_INTEGER + 1, NaN])(
  "rejects invalid or out-of-duration position %s",
  async (positionMs) => {
    const t = await fixture();
    await expect(
      savePlayback(t.app, t.principal, t.f.ids.file, { ...t.input, positionMs }),
    ).rejects.toThrow("invalid_playback_update");
    expect((await t.state()).results).toEqual([]);
  },
);
it("requires CSRF, exact body fields and current CAS for the private HTTP state endpoint", async () => {
  const t = await fixture(),
    csrf = new CsrfTokens(t.ring, t.ring, t.app.APP_ORIGIN);
  const request = (body: unknown = t.input, token?: string) =>
    new Request(`${t.app.APP_ORIGIN}/api/v1/nodes/${t.f.ids.file}/playback-state`, {
      method: "PUT",
      headers: {
        Origin: t.app.APP_ORIGIN,
        "Sec-Fetch-Site": "same-origin",
        "Content-Type": "application/json",
        ...(token ? { "X-CSRF-Token": token } : {}),
      },
      body: JSON.stringify(body),
    });
  const issued = await csrf.issue(env.DB, new Request(request(), { method: "POST" }), {
    kind: "access",
    credentialId: t.principal.credential_id,
    epoch: 1,
  });
  expect(privateAppRoute(request())).toBe(true);
  expect((await handlePlaybackHttp(request(), t.app, t.principal, csrf)).status).toBe(403);
  expect(
    (
      await handlePlaybackHttp(
        request({ ...t.input, userId: "other" }, issued.token),
        t.app,
        t.principal,
        csrf,
      )
    ).status,
  ).toBe(400);
  expect(
    (await handlePlaybackHttp(request(t.input, issued.token), t.app, t.principal, csrf)).status,
  ).toBe(200);
  expect(
    (await handlePlaybackHttp(request(t.input, issued.token), t.app, t.principal, csrf)).status,
  ).toBe(409);
  const get = new Request(`${t.app.APP_ORIGIN}/api/v1/nodes/${t.f.ids.folder}/tracks`);
  expect(privateAppRoute(get)).toBe(true);
  const response = await handleAudioListHttp(get, t.app, t.principal, t.cursors);
  expect(response.status).toBe(200);
  expect(response.headers.get("Cache-Control")).toBe("private, no-store");
  for (const query of ["?cursor=", "?cursor=a&cursor=b", "?recursive=1", "?shareId=x"])
    expect(
      (await handleAudioListHttp(new Request(get.url + query), t.app, t.principal, t.cursors))
        .status,
    ).toBe(400);
});
it("binds anonymous tracks to the selected unlock session and never exposes user positions", async () => {
  const t = await fixture(),
    f = await publicShareFixture("read");
  await metadata(f.f.ids.file, f.f.ids.blob);
  await env.DB.prepare("INSERT INTO user_playback_state VALUES(?,?,?,999,1)")
    .bind(f.f.ids.user, f.f.ids.file, f.f.ids.blob)
    .run();
  const http = (r: Request) =>
    handlePublicShareHttp(r, f.app, 1, { ...f.deps, cursors: t.cursors });
  const request = f.request("/tracks");
  expect(publicShareRoute(request)).toBe(true);
  const result = await http(request);
  expect(result.status).toBe(200);
  expect((await result.json<any>()).items[0]).toMatchObject({ id: f.f.ids.file, playback: null });
  expect((await http(f.request(`/tracks?nodeId=${f.f.ids.root}`))).status).toBe(404);
  const missing = new Request(request);
  missing.headers.delete("Share-Session");
  expect((await http(missing)).status).toBe(412);
  await env.DB.prepare("UPDATE shares SET disabled_at=1 WHERE id=?").bind(f.share.id).run();
  expect([401, 404]).toContain((await http(new Request(request))).status);
});
it("returns 503 with a retry hint when state admission is unavailable", async () => {
  const t = await fixture();
  const app = {
    ...t.app,
    CONTROL: {
      ...t.app.CONTROL,
      idFromName: t.app.CONTROL.idFromName.bind(t.app.CONTROL),
      get: () => ({ acquireMutation: vi.fn().mockRejectedValue(new Error("busy")) }),
    } as unknown as typeof t.app.CONTROL,
  };
  const request = new Request(`${t.app.APP_ORIGIN}/api/v1/nodes/${t.f.ids.file}/playback-state`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(t.input),
  });
  const response = await handlePlaybackHttp(request, app, t.principal, { verify: async () => {} });
  expect(response.status).toBe(503);
  expect(response.headers.get("Retry-After")).toBe("1");
  expect((await t.state()).results).toEqual([]);
});
