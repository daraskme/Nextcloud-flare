import { env } from "cloudflare:workers";
import { atomicBatch } from "../../src/db/primary";
import { foundationFixture } from "./foundation";

export async function gcFixture(state: "candidate" | "deleting" = "deleting") {
  const f = foundationFixture(crypto.randomUUID(), Date.now() - 1000);
  await atomicBatch(env.DB, f.statements);
  const key = `u/${f.ids.user}/b/${f.ids.blob}`;
  const object = (await env.BLOBS.put(key, "abc"))!;
  await atomicBatch(env.DB, [
    {
      sql: "INSERT INTO blob_storage(blob_id,bytes,r2_etag,observed_at) VALUES(?,3,?,1)",
      values: [f.ids.blob, object.etag],
    },
    { sql: "UPDATE nodes SET current_blob_id=NULL WHERE id=?", values: [f.ids.file] },
    {
      sql: "UPDATE blobs SET state=? WHERE id=?",
      values: [state === "deleting" ? "deleting" : "gc_candidate", f.ids.blob],
    },
    {
      sql: "INSERT INTO gc_candidates(blob_id,state,not_before,claim_token,claim_expires_at) VALUES(?,?,0,?,?)",
      values: [
        f.ids.blob,
        state,
        state === "deleting" ? crypto.randomUUID() : null,
        state === "deleting" ? 0 : null,
      ],
    },
  ]);
  return { ...f, key };
}
