import { readdirSync, readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { URL } from "node:url";
import { afterEach, beforeEach, expect, it } from "vitest";
import { foundationFixture } from "../fixtures/foundation";

const migrations = new URL("../../migrations/", import.meta.url);
const backfill = readFileSync(new URL("0053_media_mime_backfill.sql", migrations), "utf8");
let db: DatabaseSync;
beforeEach(() => {
  db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys=ON");
  for (const name of readdirSync(migrations)
    .filter((n) => n.endsWith(".sql") && n < "0053_")
    .sort())
    db.exec(readFileSync(new URL(name, migrations), "utf8"));
  const fixture = foundationFixture();
  for (const { sql, values } of fixture.statements)
    db.prepare(sql).run(...((values ?? []) as (string | number | null)[]));
  db.exec("UPDATE blobs SET mime_sniffed='application/octet-stream'");
});
afterEach(() => db.close());

const mime = () => db.prepare("SELECT mime_sniffed FROM blobs WHERE id='f-b'").get()?.mime_sniffed;
const audio = () =>
  db.exec(`INSERT INTO node_audio(node_id,blob_id,generator_version,codec)
  VALUES('f-f','f-b','ncf-id3-1','mp3')`);

it("backfills current parsed MP3 uploads without altering their accounting or identity", () => {
  audio();
  const before = db.prepare("SELECT * FROM blobs WHERE id='f-b'").get();
  db.exec(backfill);
  expect(db.prepare("SELECT * FROM blobs WHERE id='f-b'").get()).toEqual({
    ...before,
    mime_sniffed: "audio/mpeg",
  });
  expect(db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
});

it.each(["mp4", "webm"])(
  "prioritizes the current AV1 %s projection over audio metadata",
  (container) => {
    audio();
    db.prepare(`INSERT INTO node_media(node_id,blob_id,generator_version,width,height,
    container,video_codec,audio_codec,codec_profile,codec_level,codec_tier,bit_depth)
    VALUES('f-f','f-b','video-av1-metadata-v1',32,24,?,'av1','opus',0,0,'M',8)`).run(container);
    db.exec(backfill);
    expect(mime()).toBe(`video/${container}`);
  },
);

it.each([
  "UPDATE node_audio SET generator_version='old-parser'",
  "UPDATE nodes SET current_blob_id=NULL WHERE id='f-f'",
  `INSERT INTO trash_ops(op_id,actor_id,space_id,root_node_id,state,created_at,epoch)
    VALUES('trash','f-u','f-s','f-f','trashed',2000,1);
   UPDATE nodes SET deleted_at=2000,deleted_op_id='trash' WHERE id='f-f'`,
  "DELETE FROM node_audio",
])("does not infer a MIME from missing, stale or deleted projections: %s", (invalidate) => {
  audio();
  db.exec(invalidate);
  db.exec(backfill);
  expect(mime()).toBe("application/octet-stream");
});

it("preserves an already identified MIME", () => {
  audio();
  db.exec("UPDATE blobs SET mime_sniffed='audio/ogg'");
  db.exec(backfill);
  expect(mime()).toBe("audio/ogg");
});
