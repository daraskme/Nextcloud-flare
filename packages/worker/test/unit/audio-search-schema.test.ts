import { readdirSync, readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { URL } from "node:url";
import { afterEach, beforeEach, expect, it } from "vitest";
import { AUDIO_SEARCH_CURRENT, AUDIO_SEARCH_LIMITS, audioSearchTags } from "../../src/search/audio";
import { foundationFixture } from "../fixtures/foundation";

let db: DatabaseSync;
const dir = new URL("../../migrations/", import.meta.url);
const migration = readFileSync(new URL("0074_audio_search_projection.sql", dir), "utf8");
beforeEach(() => {
  db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys=ON");
  for (const file of readdirSync(dir)
    .filter((f) => f.endsWith(".sql") && f < "0074_")
    .sort())
    db.exec(readFileSync(new URL(file, dir), "utf8"));
  for (const s of foundationFixture().statements)
    db.prepare(s.sql).run(...((s.values as (string | number | null)[]) ?? []));
  db.exec(
    "INSERT INTO node_audio(node_id,blob_id,generator_version,title_extracted,artist_extracted,title_override) VALUES('f-f','f-b','track-metadata-v1','Extracted','Artist','My title')",
  );
});
afterEach(() => db.close());
const row = () => db.prepare("SELECT * FROM node_audio").get();
const current = () => db.prepare(`SELECT 1 FROM node_audio a WHERE ${AUDIO_SEARCH_CURRENT}`).all();
it("retains raw tags, leaves legacy caches unready, and binds each cache to the effective values", () => {
  const before = row();
  db.exec(migration);
  expect(row()).toMatchObject({ ...before, search_version: "", search_text_norm: "" });
  expect(current()).toEqual([]);
  const q = audioSearchTags({ title: "My title", artist: "Artist", album: null });
  db.prepare(
    "UPDATE node_audio SET search_text_norm=?,search_tokens=?,search_source=?,search_version=?",
  ).run(q.textNorm, q.tokens, q.source, q.version);
  expect(current()).toHaveLength(1);
  db.exec("UPDATE node_audio SET title_extracted='new extracted'");
  expect(current()).toHaveLength(1);
  db.exec("UPDATE node_audio SET title_override=NULL");
  expect(current()).toEqual([]);
  db.exec("UPDATE node_audio SET title_override='My title',search_version='old'");
  expect(current()).toEqual([]);
  expect(db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
});
it("refuses migration while admission is open", () => {
  db.exec("UPDATE control SET maintenance=0");
  const before = row();
  expect(() => db.exec(migration)).toThrow();
  expect(row()).toEqual(before);
});
it("enforces UTF-8 byte bounds in SQL and accepts expanded normalized text", () => {
  db.exec(migration);
  const tag = "ﷺ".repeat(341),
    q = audioSearchTags({ title: tag, artist: tag, album: tag });
  db.prepare(
    "UPDATE node_audio SET search_text_norm=?,search_tokens=?,search_source=?,search_version=?",
  ).run(q.textNorm, q.tokens, q.source, q.version);
  const before = row();
  for (const [column, size] of [
    ["search_text_norm", AUDIO_SEARCH_LIMITS.textBytes],
    ["search_tokens", AUDIO_SEARCH_LIMITS.tokenBytes],
    ["search_source", AUDIO_SEARCH_LIMITS.sourceBytes],
    ["search_version", 128],
  ] as const) {
    expect(() =>
      db.prepare(`UPDATE node_audio SET ${column}=?`).run("あ".repeat(Math.floor(size / 3) + 1)),
    ).toThrow();
    expect(row()).toEqual(before);
  }
});
it("compares the source tuple identically in SQLite and JavaScript for extracted punctuation", () => {
  db.exec(migration);
  const title = 'a\\b/"c"\n\t曲😀\u2028',
    q = audioSearchTags({ title, artist: "Artist", album: null });
  db.prepare(
    "UPDATE node_audio SET title_override=?,search_text_norm=?,search_tokens=?,search_source=?,search_version=?",
  ).run(title, q.textNorm, q.tokens, q.source, q.version);
  expect(current()).toHaveLength(1);
});
