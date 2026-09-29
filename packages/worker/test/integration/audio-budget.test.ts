import { applyD1Migrations } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { base64url } from "jose";
import { beforeAll, expect, it } from "vitest";
import { AudioCursorTokens } from "../../src/auth/audioCursor";
import { contentKeyRing } from "../../src/auth/contentTokens";
import { atomicBatch } from "../../src/db/primary";
import {
  AUDIO_CANDIDATE_LIMIT,
  type AudioScan,
  audioStatement,
  listAudio,
} from "../../src/services/audio";
import { foundationFixture } from "../fixtures/foundation";
import { injectBatch } from "../fixtures/uploadEnv";

beforeAll(() => applyD1Migrations(env.DB, env.TEST_MIGRATIONS));
const generator = "track-metadata-v1";
async function fixture(count: number, hidden = 0) {
  await env.DB.prepare("UPDATE control SET maintenance=0").run();
  const f = foundationFixture(crypto.randomUUID(), Date.now() - 1000);
  await atomicBatch(env.DB, f.statements);
  for (const [total, prefix, hide] of [
    [count, "a", 0],
    [hidden, "0-secret", 1],
  ] as const) {
    if (!total) continue;
    await env.DB.prepare(`WITH RECURSIVE seq(i) AS (SELECT 0 UNION ALL SELECT i+1 FROM seq WHERE i<?)
      INSERT INTO nodes(id,space_id,owner_id,parent_id,name,name_ci,kind,hidden,created_at,updated_at)
      SELECT ?||i,?,?,?,?||printf('%06d.txt',i),?||printf('%06d.txt',i),'file',?,1,1 FROM seq`)
      .bind(
        total - 1,
        f.ids.file + prefix,
        f.ids.space,
        f.ids.user,
        f.ids.folder,
        prefix,
        prefix,
        hide,
      )
      .run();
  }
  const tokens = new AudioCursorTokens(
    await contentKeyRing("test", {
      test: base64url.encode(crypto.getRandomValues(new Uint8Array(32))),
    }),
  );
  const principal = {
    kind: "user" as const,
    user_id: f.ids.user,
    credential_id: f.ids.credential,
    epoch: 1,
  };
  const list = (cursor?: string) => listAudio(env.DB, principal, f.ids.folder, tokens, cursor);
  const measure = async (name: string | null, id: string | null) =>
    env.DB.prepare(audioStatement(false, 201, name !== null))
      .bind(f.ids.folder, f.ids.space, f.ids.user, generator, f.ids.user, name, id)
      .all<AudioScan>();
  const audio = async (id: string) => {
    await env.DB.prepare("UPDATE nodes SET current_blob_id=? WHERE id=?")
      .bind(f.ids.blob, id)
      .run();
    await env.DB.prepare("UPDATE blobs SET mime_sniffed='audio/ogg; codecs=\"opus\"' WHERE id=?")
      .bind(f.ids.blob)
      .run();
    await env.DB.prepare(
      "INSERT INTO node_audio(node_id,blob_id,generator_version,codec,duration_ms) VALUES(?,?,?,'opus',90000)",
    )
      .bind(id, f.ids.blob, generator)
      .run();
  };
  return { f, tokens, principal, list, measure, audio };
}

it("bounds first and late pages independently of 50k ordinary and 50k hidden siblings", {
  timeout: 120000,
}, async () => {
  const t = await fixture(50050, 50000);
  await t.audio(t.f.ids.file);
  const first = await t.measure(null, null);
  const record = first.results[0]!;
  expect(record.scanned).toBe(AUDIO_CANDIDATE_LIMIT);
  expect(JSON.parse(record.items)).toEqual([]);
  expect(record.moreCandidates).toBe(1);
  expect(record.lastNameCi).toBe("a000999.txt");
  const late = await t.measure("a049999.txt", t.f.ids.file + "a49999");
  expect(late.results[0]?.scanned).toBe(51);
  expect(JSON.parse(late.results[0]!.items).map((x: { id: string }) => x.id)).toEqual([
    t.f.ids.file,
  ]);
  expect(late.results[0]?.moreCandidates).toBe(0);
  const measurements = [first, late].map((r) => ({ rows: r.meta.rows_read, ms: r.meta.duration }));
  console.info("audio candidate budgets", JSON.stringify(measurements));
  for (const result of [first, late])
    expect(result.meta.rows_read, JSON.stringify(measurements)).toBeLessThanOrEqual(10000);
  expect(late.meta.rows_read, JSON.stringify(measurements)).toBeLessThan(1000);
  const plan = await env.DB.prepare("EXPLAIN QUERY PLAN " + audioStatement(false, 201, true))
    .bind(
      t.f.ids.folder,
      t.f.ids.space,
      t.f.ids.user,
      generator,
      t.f.ids.user,
      "a049999.txt",
      t.f.ids.file + "a49999",
    )
    .all<{ detail: string }>();
  expect(
    plan.results.some(
      (r) => r.detail.includes("nodes_audio_candidates") && r.detail.includes("(name_ci,id)>(?,?)"),
    ),
    JSON.stringify(plan.results),
  ).toBe(true);
  const page = await t.list();
  expect(page.items).toEqual([]);
  expect(page.limitReached).toBe(false);
  expect(page.nextCursor).not.toBeNull();
  const cursor = await t.tokens.verify(page.nextCursor!);
  expect(cursor).toMatchObject({ lastNameCi: "a000999.txt", emitted: 0 });
  expect(JSON.stringify(cursor)).not.toContain("secret");
  const last = await t.list(
    await t.tokens.issue({ ...cursor, lastNameCi: "a049999.txt", lastId: t.f.ids.file + "a49999" }),
  );
  expect(last.items.map((x) => x.id)).toEqual([t.f.ids.file]);
  expect(last.nextCursor).toBeNull();
});
it("continues after empty candidate windows and includes boundary tracks exactly once", async () => {
  const t = await fixture(3100, 2100);
  for (const index of [1000, 1999, 2000, 3099]) await t.audio(t.f.ids.file + "a" + index);
  let page = await t.list();
  expect(page.items).toEqual([]);
  expect(page.nextCursor).not.toBeNull();
  const ids: string[] = [];
  let pages = 1;
  while (page.nextCursor) {
    page = await t.list(page.nextCursor);
    ids.push(...page.items.map((x) => x.id));
    pages++;
    expect(pages).toBeLessThan(6);
  }
  expect(ids).toEqual([1000, 1999, 2000, 3099].map((i) => t.f.ids.file + "a" + i));
  expect(pages).toBe(4);
  expect(page.limitReached).toBe(false);
});
it("does not add a phantom continuation at an exact candidate boundary", async () => {
  const t = await fixture(AUDIO_CANDIDATE_LIMIT - 1, 2000);
  const page = await t.list();
  expect(page.items).toEqual([]);
  expect(page.nextCursor).toBeNull();
  expect(page.limitReached).toBe(false);
});
it("does not scan stale or unsupported metadata beyond its candidate window", async () => {
  const t = await fixture(2500);
  await env.DB.prepare(
    `INSERT INTO node_audio(node_id,blob_id,generator_version,codec) SELECT id,?,'old','opus' FROM nodes WHERE parent_id=?`,
  )
    .bind(t.f.ids.blob, t.f.ids.folder)
    .run();
  const result = await t.measure(null, null);
  expect(JSON.parse(result.results[0]!.items)).toEqual([]);
  expect(result.meta.rows_read, JSON.stringify(result.meta)).toBeLessThanOrEqual(10000);
  expect((await t.list()).nextCursor).not.toBeNull();
});
it("bounds a dense page with current playback states and does not skip the 201st track", async () => {
  const t = await fixture(2100);
  await env.DB.prepare(`INSERT INTO blobs(id,owner_id,r2_key,size,content_etag,mime_sniffed,state,created_at)
    SELECT id||'-audio',owner_id,'u/'||owner_id||'/b/'||id||'-audio',3,'etag','audio/webm; codecs="opus"','committed',1
    FROM nodes WHERE parent_id=? AND id<>?`)
    .bind(t.f.ids.folder, t.f.ids.file)
    .run();
  await env.DB.prepare("UPDATE nodes SET current_blob_id=id||'-audio' WHERE parent_id=? AND id<>?")
    .bind(t.f.ids.folder, t.f.ids.file)
    .run();
  await env.DB.prepare(`INSERT INTO node_audio(node_id,blob_id,generator_version,codec,duration_ms)
    SELECT id,current_blob_id,?,'opus',90000 FROM nodes WHERE parent_id=? AND id<>?`)
    .bind(generator, t.f.ids.folder, t.f.ids.file)
    .run();
  await env.DB.prepare(`INSERT INTO user_playback_state(user_id,node_id,blob_id,position_ms,updated_at)
    SELECT ?,id,current_blob_id,12000,1 FROM nodes WHERE parent_id=? AND id<>?`)
    .bind(t.f.ids.user, t.f.ids.folder, t.f.ids.file)
    .run();
  const result = await t.measure(null, null);
  console.info("audio dense budget", JSON.stringify(result.meta));
  expect(JSON.parse(result.results[0]!.items)).toHaveLength(201);
  expect(result.meta.rows_read, JSON.stringify(result.meta)).toBeLessThanOrEqual(10000);
  const first = await t.list(),
    second = await t.list(first.nextCursor!);
  expect(first.items).toHaveLength(200);
  expect(second.items).toHaveLength(200);
  expect(second.items[0]?.name).toBe("a000200.txt");
  expect(second.items.every((x) => x.playback?.positionMs === 12000)).toBe(true);
  // Current metadata with an ineligible MIME still reaches every blob lookup in the window.
  await env.DB.prepare("UPDATE blobs SET mime_sniffed='text/plain' WHERE owner_id=?")
    .bind(t.f.ids.user)
    .run();
  const unsupported = await t.measure(null, null);
  expect(JSON.parse(unsupported.results[0]!.items)).toEqual([]);
  expect(unsupported.meta.rows_read, JSON.stringify(unsupported.meta)).toBeLessThanOrEqual(10000);
  await env.DB.prepare(`UPDATE blobs SET mime_sniffed='audio/webm; codecs="opus"'
    WHERE id IN (SELECT current_blob_id FROM nodes WHERE parent_id=? AND name_ci>='a000900.txt')`)
    .bind(t.f.ids.folder)
    .run();
  const mixed = await t.measure(null, null);
  expect(JSON.parse(mixed.results[0]!.items)).toHaveLength(100);
  expect(mixed.meta.rows_read, JSON.stringify(mixed.meta)).toBeLessThanOrEqual(10000);
  console.info(
    "audio ineligible/mixed budgets",
    JSON.stringify([unsupported, mixed].map((r) => r.meta)),
  );
});
it.each(["credential", "generation"])(
  "keeps the %s assertion in the same batch as bounded candidates",
  async (kind) => {
    const t = await fixture(5);
    await t.audio(t.f.ids.file);
    const db = injectBatch(
      (sql) => sql.includes("WITH candidates AS MATERIALIZED"),
      async () => {
        if (kind === "credential")
          await env.DB.prepare("UPDATE sessions SET revoked_at=1 WHERE id=?")
            .bind(t.f.ids.session)
            .run();
        else
          await env.DB.prepare("UPDATE spaces SET tree_generation=tree_generation+1 WHERE id=?")
            .bind(t.f.ids.space)
            .run();
      },
      false,
    );
    await expect(listAudio(db, t.principal, t.f.ids.folder, t.tokens)).rejects.toThrow();
  },
);
