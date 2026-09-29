import { applyD1Migrations } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { base64url } from "jose";
import { afterEach, beforeAll, beforeEach, expect, it } from "vitest";
import { AudioCursorTokens } from "../../src/auth/audioCursor";
import { contentKeyRing } from "../../src/auth/contentTokens";
import { SearchCursorTokens } from "../../src/auth/searchCursor";
import { atomicBatch } from "../../src/db/primary";
import { claimCopyJob } from "../../src/jobs/copyClaim";
import { loadCopyJobManifest } from "../../src/jobs/copyManifest";
import { copyNextBlob } from "../../src/jobs/copyMultipart";
import { publishCopyJob } from "../../src/jobs/copyPublication";
import { TRACK_METADATA_GENERATOR as generator } from "../../src/media/tracks/common";
import { AUDIO_SEARCH_VERSION } from "../../src/search/audio";
import { listAudio } from "../../src/services/audio";
import { editAudioMetadata } from "../../src/services/audioMetadata";
import {
  prepareCrossOwnerCopy,
  reservePreparedCopyStatements,
} from "../../src/services/copyPreparation";
import { auditOwnerLedger } from "../../src/services/refs";
import { searchNodes } from "../../src/services/search";
import { copyJobSetup } from "../fixtures/copyJob";
import { clearEndedR2TestWrites, mutationEnv } from "../fixtures/mutationAdmission";
import { trackBytes } from "../fixtures/tracks/encoded";
import { admitted, injectBatch } from "../fixtures/uploadEnv";

beforeAll(() => applyD1Migrations(env.DB, env.TEST_MIGRATIONS));
beforeEach(async () => {
  await env.DB.prepare("UPDATE control SET maintenance=1").run();
  await env.DB.prepare("UPDATE control SET epoch=1,maintenance=0").run();
});
afterEach(clearEndedR2TestWrites);
async function fixture(audio = true) {
  const bytes = trackBytes("opus.ogg"),
    f = await copyJobSetup(false, bytes);
  const seed = async () => {
    await env.DB.prepare(`UPDATE blobs SET mime_sniffed='audio/ogg; codecs="opus"' WHERE id=?`)
      .bind(f.source.ids.blob)
      .run();
    await env.DB.prepare(`INSERT INTO node_audio(node_id,blob_id,generator_version,duration_ms,codec,
      title_extracted,artist_extracted,album_extracted,title_override,track_number,disc_number,
      search_text_norm,search_tokens,search_source,search_version)
      VALUES(?,?,?,2000,'opus','抽出した曲','ＡＲＴＩＳＴ','ｶﾀｶﾅ: / 作品','受付時の曲',3,2,'poison','poison','[]','old')`)
      .bind(f.source.ids.file, f.source.ids.blob, generator)
      .run();
  };
  if (audio) await seed();
  const principal = {
    kind: "user" as const,
    user_id: f.target.ids.user,
    credential_id: f.target.ids.credential,
    epoch: 1,
  };
  const ring = await contentKeyRing("test", {
    test: base64url.encode(crypto.getRandomValues(new Uint8Array(32))),
  });
  const search = (root: string, q: string) =>
    searchNodes(env.DB, principal, root, q, new SearchCursorTokens(ring));
  const list = (root: string) => listAudio(env.DB, principal, root, new AudioCursorTokens(ring));
  return { ...f, bytes, seed, principal, search, list };
}
async function ready(f: Awaited<ReturnType<typeof fixture>>) {
  const job = await f.enqueue(),
    claim = await claimCopyJob(mutationEnv(), job.outboxId);
  for (let i = 0; i < 2; i++) {
    const result = await copyNextBlob(
      { ...admitted(), ...mutationEnv(), BLOBS: env.BLOBS },
      claim,
      8 * 1024 * 1024,
    );
    if (result === "ready") return claim;
    expect(result).toBe("stored");
  }
  throw new Error("fixture_not_ready");
}
async function aliases(f: Awaited<ReturnType<typeof fixture>>, count: number, title = "別名の曲") {
  await env.DB.prepare(`INSERT INTO nodes(id,space_id,owner_id,parent_id,name,name_ci,kind,current_blob_id,created_at,updated_at)
    SELECT ?1||'_'||value,?2,?3,?4,'Alias'||value,'alias'||value,'file',?5,1,1 FROM json_each(?6)`)
    .bind(
      f.source.ids.file,
      f.source.ids.space,
      f.source.ids.user,
      f.source.ids.folder,
      f.source.ids.blob,
      JSON.stringify(Array.from({ length: count }, (_, i) => i)),
    )
    .run();
  await env.DB.prepare(`INSERT INTO node_audio(node_id,blob_id,generator_version,codec,title_extracted,artist_extracted,album_extracted)
    SELECT id,current_blob_id,?1,'opus',?2,?2,?2 FROM nodes WHERE parent_id=?3 AND id<>?4`)
    .bind(generator, title, f.source.ids.folder, f.source.ids.file)
    .run();
}
it("publishes accepted audio and independent COW tags against new blobs, then supports search and reset", async () => {
  const f = await fixture();
  await aliases(f, 1);
  await env.DB.prepare("INSERT INTO user_playback_state VALUES(?,?,?,1000,1)")
    .bind(f.source.ids.user, f.source.ids.file, f.source.ids.blob)
    .run();
  const claim = await ready(f),
    stored = (await loadCopyJobManifest(env.DB, claim.id)).plan;
  expect(stored.version).toBe(2);
  expect(stored.source.audio).toHaveLength(2);
  expect(stored.source.audio![0]!.search.version).toBe(AUDIO_SEARCH_VERSION);
  expect(JSON.stringify(stored.source.audio)).not.toContain("poison");
  // Neither a changed nor a removed source row may substitute for the accepted snapshot.
  await env.DB.prepare(
    "UPDATE node_audio SET title_override='受付後の曲',duration_ms=9999 WHERE node_id=?",
  )
    .bind(f.source.ids.file)
    .run();
  await env.DB.prepare("DELETE FROM node_audio WHERE node_id=?")
    .bind(f.source.ids.file + "_0")
    .run();
  const db = injectBatch(
    (sql) => sql.startsWith("UPDATE bulk_jobs SET publish_op_id="),
    async () => {
      throw new Error("ack_lost");
    },
    true,
  );
  const result = await publishCopyJob(admitted(db), claim);
  expect(result).toMatchObject({ kind: "terminal", operation: { state: "committed" } });
  expect(await publishCopyJob(admitted(), claim)).toEqual(result);
  const root = claim.id + "_n00001",
    node = claim.id + "_n00002",
    blob = claim.id + "_b00001";
  const tracks = (await f.list(root)).items;
  expect(tracks.map((t) => t.title).sort()).toEqual(["別名の曲", "受付時の曲"].sort());
  expect(tracks.find((t) => t.id === node)).toMatchObject({
    currentBlobId: blob,
    durationMs: 2000,
    trackNumber: 3,
    discNumber: 2,
    playback: null,
  });
  for (const q of ["受付時の曲", "artist", "かたかな: / 作品"])
    expect((await f.search(root, q)).items.map((n) => n.id)).toEqual([node]);
  expect((await f.search(root, "受付後の曲")).items).toEqual([]);
  expect((await f.search(root, "poison")).items).toEqual([]);
  expect((await f.search(root, "別名の曲")).items).toHaveLength(1);
  expect(
    new Uint8Array(await (await env.BLOBS.get(`u/${f.target.ids.user}/b/${blob}`))!.arrayBuffer()),
  ).toEqual(f.bytes);
  expect(await auditOwnerLedger(env.DB, f.target.ids.user)).toMatchObject({
    incorrect_refs: 0,
    reserved_bytes: 0,
    physical_bytes: f.bytes.length,
    used_bytes: 3 + f.bytes.length,
  });
  expect(
    await editAudioMetadata(admitted(), f.principal, node, crypto.randomUUID(), {
      blobId: blob,
      generator,
      revision: 1,
      title: null,
      artist: null,
      album: null,
    }),
  ).toMatchObject({ kind: "terminal", operation: { state: "committed" } });
  expect((await f.search(root, "受付時の曲")).items).toEqual([]);
  expect((await f.search(root, "抽出した曲")).items.map((n) => n.id)).toEqual([node]);
  await env.DB.prepare("INSERT INTO search_fts(search_fts,rank) VALUES('integrity-check',1)").run();
});
it("keeps a single renamed audio file searchable without disclosing its former parent", async () => {
  const f = await fixture();
  f.request.sourceNodeId = f.source.ids.file;
  f.request.name = "Renamed.opus";
  const claim = await ready(f);
  expect(JSON.stringify(claim.plan.source)).not.toContain(f.source.ids.folder);
  expect(await publishCopyJob(admitted(), claim)).toMatchObject({
    kind: "terminal",
    operation: { state: "committed" },
  });
  const node = claim.id + "_n00001";
  expect((await f.list(node)).items[0]).toMatchObject({
    name: "Renamed.opus",
    title: "受付時の曲",
  });
  expect((await f.search(f.target.ids.folder, "受付時の曲")).items.map((n) => n.id)).toEqual([
    node,
  ]);
  expect((await f.search(f.target.ids.folder, "renamed.opus")).items.map((n) => n.id)).toEqual([
    node,
  ]);
});
it("does not add audio that appeared only after acceptance", async () => {
  const f = await fixture(false),
    claim = await ready(f);
  await f.seed();
  expect(claim.plan.source.audio).toEqual([]);
  expect(await publishCopyJob(admitted(), claim)).toMatchObject({
    kind: "terminal",
    operation: { state: "committed" },
  });
  expect((await f.list(claim.id + "_n00001")).items).toEqual([]);
});
it.each([
  "insert",
  "delete",
  "extracted",
  "override",
  "duration",
  "track",
  "disc",
  "codec",
  "generator",
])("rejects a changed audio %s before accepting holds", async (change) => {
  const f = await fixture(change !== "insert"),
    plan = await prepareCrossOwnerCopy(env.DB, f.request);
  if (change === "insert") await f.seed();
  else if (change === "delete")
    await env.DB.prepare("DELETE FROM node_audio WHERE node_id=?").bind(f.source.ids.file).run();
  else {
    const clause = {
      extracted: "title_extracted='変更済み'",
      override: "title_override='変更済み'",
      duration: "duration_ms=1",
      track: "track_number=4",
      disc: "disc_number=4",
      codec: "codec='mp3'",
      generator: "generator_version='old'",
    }[change]!;
    await env.DB.prepare(`UPDATE node_audio SET ${clause} WHERE node_id=?`)
      .bind(f.source.ids.file)
      .run();
  }
  await expect(
    atomicBatch(
      env.DB,
      reservePreparedCopyStatements(plan, "copy_" + "a".repeat(64), Date.now() + 60000),
    ),
  ).rejects.toThrow();
  expect(
    await env.DB.prepare("SELECT COUNT(*) AS n FROM blob_pins WHERE blob_id=?")
      .bind(f.source.ids.blob)
      .first("n"),
  ).toBe(0);
});
it("rejects raw audio beyond the manifest budget before fetching it", async () => {
  const f = await fixture();
  await aliases(f, 9, "x".repeat(512 * 1024));
  let fetched = false;
  const db = injectBatch(
    (sql) => sql.includes("SELECT metadata FROM audio ORDER BY"),
    async () => {
      fetched = true;
    },
    false,
  );
  await expect(prepareCrossOwnerCopy(db, f.request)).rejects.toThrow("copy_manifest_too_large");
  expect(fetched).toBe(false);
});
it("rejects Unicode-expanded search data that exceeds the total manifest budget", async () => {
  const f = await fixture();
  await aliases(f, 300, "ﷺ".repeat(341));
  await expect(prepareCrossOwnerCopy(env.DB, f.request)).rejects.toThrow("copy_manifest_too_large");
  expect(
    await env.DB.prepare("SELECT COUNT(*) AS n FROM blob_pins WHERE blob_id=?")
      .bind(f.source.ids.blob)
      .first("n"),
  ).toBe(0);
});
it("round-trips and publishes a bounded multi-chunk audio snapshot without truncating tags", async () => {
  const f = await fixture();
  await aliases(f, 32, "ﷺ".repeat(341));
  const claim = await ready(f);
  expect(claim.plan.source.audio).toHaveLength(33);
  expect(
    await env.DB.prepare("SELECT chunks FROM copy_job_manifests WHERE job_id=?")
      .bind(claim.id)
      .first<number>("chunks"),
  ).toBeGreaterThan(20);
  expect(await publishCopyJob(admitted(), claim)).toMatchObject({
    kind: "terminal",
    operation: { state: "committed" },
  });
  expect((await f.list(claim.id + "_n00001")).items).toHaveLength(33);
  expect((await f.search(claim.id + "_n00001", "ﷺ")).items).toHaveLength(32);
  await env.DB.prepare("INSERT INTO search_fts(search_fts,rank) VALUES('integrity-check',1)").run();
});

/** Test-only import of a historically accepted body, with its own valid digest. */
async function rewriteManifest(
  id: string,
  update: (body: { version: number; source: { audio?: unknown } }) => void,
) {
  const part = await env.DB.prepare("SELECT data FROM copy_job_chunks WHERE job_id=? AND part=0")
    .bind(id)
    .first<number[]>("data");
  const body = JSON.parse(new TextDecoder().decode(new Uint8Array(part!)));
  update(body);
  const bytes = new TextEncoder().encode(JSON.stringify(body));
  expect(bytes.length).toBeLessThan(65536);
  const digest = [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))]
    .map((n) => n.toString(16).padStart(2, "0"))
    .join("");
  const triggers = await env.DB.prepare(
    "SELECT name,sql FROM sqlite_master WHERE name IN ('copy_job_manifest_identity','copy_job_chunk_identity') ORDER BY name",
  ).all<{ name: string; sql: string }>();
  for (const t of triggers.results) await env.DB.prepare(`DROP TRIGGER ${t.name}`).run();
  try {
    await atomicBatch(env.DB, [
      {
        sql: "UPDATE copy_job_manifests SET sha256=?,bytes=? WHERE job_id=?",
        values: [digest, bytes.length, id],
      },
      {
        sql: "UPDATE copy_job_chunks SET data=? WHERE job_id=? AND part=0",
        values: [new Uint8Array(bytes).buffer, id],
      },
    ]);
  } finally {
    for (const t of triggers.results) await env.DB.prepare(t.sql).run();
  }
}
it("resumes a previously accepted v1 manifest without borrowing present-day source audio", async () => {
  const f = await fixture(),
    job = await f.enqueue();
  await rewriteManifest(job.id, (body) => {
    body.version = 1;
    delete body.source.audio;
  });
  expect((await loadCopyJobManifest(env.DB, job.id)).plan.version).toBe(1);
  const claim = await claimCopyJob(mutationEnv(), job.outboxId);
  const app = { ...admitted(), ...mutationEnv(), BLOBS: env.BLOBS };
  expect(await copyNextBlob(app, claim, 8 * 1024 * 1024)).toBe("stored");
  expect(await copyNextBlob(app, claim, 8 * 1024 * 1024)).toBe("ready");
  expect(await publishCopyJob(admitted(), claim)).toMatchObject({
    kind: "terminal",
    operation: { state: "committed" },
  });
  expect((await f.list(claim.id + "_n00001")).items).toEqual([]);
  expect((await f.search(claim.id + "_n00001", "file")).items).toHaveLength(1);
  expect((await loadCopyJobManifest(env.DB, job.id)).plan.version).toBe(1);
});
it.each(["legacy_audio", "missing_audio", "unknown_version"])(
  "rejects a digest-valid manifest with %s",
  async (failure) => {
    const f = await fixture(),
      job = await f.enqueue();
    await rewriteManifest(job.id, (body) => {
      if (failure === "legacy_audio") body.version = 1;
      if (failure === "missing_audio") delete body.source.audio;
      if (failure === "unknown_version") body.version = 3;
    });
    await expect(loadCopyJobManifest(env.DB, job.id)).rejects.toThrow("copy_manifest_unavailable");
  },
);
