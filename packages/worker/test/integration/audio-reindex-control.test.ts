import { applyD1Migrations, evictDurableObject, runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeAll, beforeEach, expect, it } from "vitest";
import { AUDIO_REINDEX_PAGE_SQL, ControlAudioSearch } from "../../src/do/controlAudioSearch";
import { CONTROL_NAME } from "../../src/do/controlName";
import { AUDIO_SEARCH_VERSION } from "../../src/search/audio";
import { audioReindexFixture } from "../fixtures/audioReindex";
import { measureD1 } from "../fixtures/d1Calls";
import { mutationEnv } from "../fixtures/mutationAdmission";
import { injectBatch } from "../fixtures/uploadEnv";

beforeAll(() => applyD1Migrations(env.DB, env.TEST_MIGRATIONS));
beforeEach(async () => {
  await env.DB.prepare("UPDATE control SET maintenance=1").run();
  await env.DB.prepare("UPDATE control SET epoch=1,maintenance=0").run();
  await env.DB.prepare("UPDATE mutation_admissions SET state='closed' WHERE state='active'").run();
  await env.DB.prepare("DELETE FROM node_audio").run();
});
function fixture() {
  const stub = env.CONTROL.get(env.CONTROL.idFromName(`audio-walk-${crypto.randomUUID()}`));
  const run = (db = env.DB, epoch = 1) =>
    runInDurableObject(stub, (_, state) =>
      new ControlAudioSearch(state.storage, mutationEnv(db), () => {}).run(epoch),
    );
  const row = () =>
    runInDurableObject(stub, (_, state) =>
      state.storage.sql.exec("SELECT * FROM audio_search_walk").one(),
    );
  return { stub, run, row };
}
it("resumes a bounded eight-repair walk after eviction and makes a second pass without writes", async () => {
  const data = await audioReindexFixture(10),
    t = fixture();
  expect(await t.run()).toMatchObject({ checked: 8, repaired: 8, wrapped: false, failed: 0 });
  expect(await t.row()).toMatchObject({ after_id: data.nodes[7], token: null });
  await evictDurableObject(t.stub);
  expect(await t.run()).toMatchObject({ checked: 2, repaired: 2, wrapped: true, failed: 0 });
  expect(await t.row()).toMatchObject({ after_id: "", token: null });
  const generation = await env.DB.prepare("SELECT tree_generation FROM spaces WHERE id=?")
    .bind(data.ids.space)
    .first("tree_generation");
  expect(await t.run()).toMatchObject({ checked: 10, current: 10, repaired: 0, wrapped: true });
  expect(
    await env.DB.prepare("SELECT tree_generation FROM spaces WHERE id=?")
      .bind(data.ids.space)
      .first("tree_generation"),
  ).toBe(generation);
});
it("bounds current-row scans at 32 and seeks directly to later keys", async () => {
  const data = await audioReindexFixture(45),
    t = fixture();
  for (let i = 0; i < 6; i++) await t.run();
  const measured = measureD1(env.DB);
  expect(await t.run(measured.db)).toMatchObject({ checked: 32, current: 32, wrapped: false });
  expect(measured.counts).toEqual({ calls: 33, statements: 33 });
  expect(await t.row()).toMatchObject({ after_id: data.nodes[31] });
  expect(await t.run()).toMatchObject({ checked: 13, current: 13, wrapped: true });
  const page = await env.DB.prepare(AUDIO_REINDEX_PAGE_SQL).bind(data.nodes[40], 1, 33).all();
  expect(page.results).toHaveLength(4);
  expect(page.meta.rows_read).toBeLessThanOrEqual(8);
});
it("advances past invalid metadata and index conflicts, then retries them on the next walk", async () => {
  const data = await audioReindexFixture(3),
    t = fixture();
  await env.DB.prepare("UPDATE node_audio SET title_override=? WHERE node_id=?")
    .bind("x".repeat(1025), data.nodes[0])
    .run();
  await env.DB.prepare("UPDATE search_index SET revision=99 WHERE node_id=?")
    .bind(data.nodes[1])
    .run();
  expect(await t.run()).toMatchObject({
    checked: 3,
    unavailable: 1,
    failed: 1,
    repaired: 1,
    wrapped: true,
  });
  await env.DB.prepare("UPDATE node_audio SET title_override='Fixed' WHERE node_id=?")
    .bind(data.nodes[0])
    .run();
  await env.DB.prepare("UPDATE search_index SET revision=1 WHERE node_id=?")
    .bind(data.nodes[1])
    .run();
  expect(await t.run()).toMatchObject({ checked: 3, repaired: 2, current: 1, wrapped: true });
});
it("keeps one live lease and prevents a late request from clearing or rewinding its replacement", async () => {
  const data = await audioReindexFixture(2),
    t = fixture();
  await runInDurableObject(t.stub, async (_, state) => {
    let entered!: () => void, release!: () => void;
    const started = new Promise<void>((r) => {
        entered = r;
      }),
      pending = new Promise<void>((r) => {
        release = r;
      });
    const db = injectBatch(
      (sql) => sql.startsWith("UPDATE node_audio SET search_text_norm"),
      async () => {
        entered();
        await pending;
      },
      false,
    );
    const job = new ControlAudioSearch(state.storage, mutationEnv(db), () => {});
    const first = job.run(1);
    await started;
    expect(await job.run(1)).toMatchObject({ busy: true, checked: 0 });
    state.storage.sql.exec(
      "UPDATE audio_search_walk SET token='replacement',after_id=?,expires_at=?",
      data.nodes[1],
      Date.now() + 5000,
    );
    release();
    expect(await first).toMatchObject({ checked: 1, repaired: 1, wrapped: false });
    expect(state.storage.sql.exec("SELECT * FROM audio_search_walk").one()).toMatchObject({
      token: "replacement",
      after_id: data.nodes[1],
    });
  });
});
it.each(["expiry", "version", "epoch"])("recovers the cursor after %s changes", async (kind) => {
  const data = await audioReindexFixture(10),
    t = fixture();
  await t.run();
  await runInDurableObject(t.stub, (_, state) => {
    state.storage.sql.exec(
      "UPDATE audio_search_walk SET token='abandoned',expires_at=?",
      kind === "expiry" ? 0 : Date.now() + 5000,
    );
    if (kind === "version") state.storage.sql.exec("UPDATE audio_search_walk SET version='old'");
    if (kind === "epoch") state.storage.sql.exec("UPDATE audio_search_walk SET epoch=2");
  });
  expect(await t.run()).toMatchObject({
    checked: kind === "expiry" ? 2 : 10,
    repaired: 2,
    wrapped: true,
  });
  expect(await t.row()).toMatchObject({
    epoch: 1,
    version: AUDIO_SEARCH_VERSION,
    after_id: "",
    token: null,
  });
  expect(
    await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM node_audio WHERE node_id>=? AND search_version=?",
    )
      .bind(data.nodes[0], AUDIO_SEARCH_VERSION)
      .first("n"),
  ).toBe(10);
});
it("stops after a policy change while a repair is in flight and rejects expired deadlines", async () => {
  await audioReindexFixture(2);
  const t = fixture();
  await runInDurableObject(t.stub, async (_, state) => {
    let open = true;
    const db = injectBatch(
      (sql) => sql.startsWith("UPDATE node_audio SET search_text_norm"),
      async () => {
        open = false;
        await env.DB.prepare("UPDATE control SET maintenance=1").run();
      },
      false,
    );
    const job = new ControlAudioSearch(state.storage, mutationEnv(db), () => {
      if (!open) throw new Error("closed");
    });
    await expect(job.run(1)).rejects.toThrow("closed");
    expect(state.storage.sql.exec("SELECT token FROM audio_search_walk").one()).toEqual({
      token: null,
    });
    await expect(job.run(1, Date.now() - 1)).rejects.toThrow("invalid_audio_reindex");
  });
});
it("runs through the real singleton RPC and rejects stale epochs and closed admission", async () => {
  await audioReindexFixture();
  const stub = env.CONTROL.get(env.CONTROL.idFromName(CONTROL_NAME));
  await runInDurableObject(stub, (_, state) => {
    const sql = state.storage.sql;
    sql.exec("UPDATE control_state SET phase='ready',epoch=1 WHERE singleton=1");
    sql.exec(
      "UPDATE control_admission SET epoch=1,revision=0,token=NULL,phase='open',gc_paused=1 WHERE singleton=1",
    );
    sql.exec(
      "UPDATE control_gc_policy SET epoch=1,operator_paused=1,hold_token=NULL,hold_operation=NULL,hold_expires_at=NULL,prior_gc_paused=1 WHERE singleton=1",
    );
  });
  expect(await stub.reindexAudioSearch(1)).toMatchObject({ repaired: 1, wrapped: true });
  await evictDurableObject(stub);
  expect(await stub.reindexAudioSearch(1)).toMatchObject({ current: 1, wrapped: true });
  await runInDurableObject(stub, async (instance) => {
    await expect(instance.reindexAudioSearch(2)).rejects.toThrow("audio_reindex_unavailable");
  });
  await stub.quiesce(1);
  await runInDurableObject(stub, async (instance) => {
    await expect(instance.reindexAudioSearch(1)).rejects.toThrow("audio_reindex_unavailable");
  });
});
