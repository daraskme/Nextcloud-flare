import { env } from "cloudflare:workers";
import { searchName } from "../../../shared/src/names";
import { atomicBatch } from "../../src/db/primary";
import { TRACK_METADATA_GENERATOR } from "../../src/media/tracks/common";
import { foundationFixture } from "./foundation";

export async function audioReindexBackupFence() {
  const token = crypto.randomUUID();
  await env.DB.prepare(
    "INSERT INTO backup_runs(id,epoch,state,created_at,barrier_token) VALUES(?,1,'pending',1,?)",
  )
    .bind(token, token)
    .run();
  await env.DB.prepare("UPDATE control SET backup_token=?").bind(token).run();
}

export async function audioReindexFixture(count = 1, indexed = true) {
  const f = foundationFixture(crypto.randomUUID(), Date.now() - 1000),
    ids: string[] = [];
  await atomicBatch(env.DB, f.statements);
  await env.DB.prepare(`UPDATE blobs SET mime_sniffed='audio/ogg; codecs="opus"' WHERE id=?`)
    .bind(f.ids.blob)
    .run();
  for (let i = 0; i < count; i++) {
    const id = i === 0 ? f.ids.file : `${f.ids.file}-${String(i).padStart(4, "0")}`;
    const name = i === 0 ? "File" : `Track${i}`,
      q = searchName(name);
    ids.push(id);
    if (i)
      await env.DB.prepare(`INSERT INTO nodes(id,space_id,owner_id,parent_id,name,name_ci,kind,current_blob_id,created_at,updated_at)
      VALUES(?,?,?,?,?,?,'file',?,1,1)`)
        .bind(id, f.ids.space, f.ids.user, f.ids.folder, name, name.toLowerCase(), f.ids.blob)
        .run();
    await env.DB.prepare(`INSERT INTO node_audio(node_id,blob_id,generator_version,codec,
      title_extracted,title_override,artist_extracted,album_extracted,duration_ms,track_number,disc_number)
      VALUES(?,?,?,'opus','Original','ｶﾀｶﾅ / Straße','O''Brien','Album',123000,2,1)`)
      .bind(id, f.ids.blob, TRACK_METADATA_GENERATOR)
      .run();
    if (indexed)
      await atomicBatch(env.DB, [
        {
          sql: "INSERT INTO search_index(node_id,space_id,text_norm,tokens,normalization_version,revision) VALUES(?,?,?,?,?,1)",
          values: [id, f.ids.space, q.textNorm, q.tokens, q.version],
        },
        {
          sql: "INSERT INTO search_fts(rowid,text_norm,tokens) SELECT rowid,text_norm,tokens FROM search_index WHERE node_id=?",
          values: [id],
        },
      ]);
  }
  return { ...f, nodes: ids };
}
