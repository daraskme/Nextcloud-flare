import { env } from "cloudflare:workers";
import { atomicBatch } from "../../src/db/primary";
import { foundationFixture } from "./foundation";

export async function multipartInventoryFixture(
  options: { idle?: boolean; initLease?: number; known?: boolean } = {},
) {
  const f = foundationFixture(crypto.randomUUID(), Date.now() - 1000);
  await atomicBatch(env.DB, f.statements);
  const id = `up_${crypto.randomUUID().replaceAll("-", "").repeat(2)}`;
  const blob = `${id}_blob`;
  const reservation = `${id}_reservation`;
  const key = `u/${f.ids.user}/b/${blob}`;
  const attempt = crypto.randomUUID();
  const metadata = { upload_id: id, blob_id: blob, epoch: "1", attempt_id: attempt };
  const handle = await env.BLOBS.createMultipartUpload(key, { customMetadata: metadata });
  await handle.uploadPart(1, new TextEncoder().encode("abc"));
  const created = Date.now() - (options.idle === false ? 1000 : 25 * 3600000);
  await atomicBatch(env.DB, [
    {
      sql: "INSERT INTO reservations(id,owner_id,bytes,state,expires_at,epoch) VALUES(?,?,3,'reserved',?,1)",
      values: [reservation, f.ids.user, created + 6 * 86400000],
    },
    {
      sql: "INSERT INTO blobs(id,owner_id,r2_key,size,content_etag,state,created_at) VALUES(?,?,?,3,?,'staging',?)",
      values: [blob, f.ids.user, key, `"b-${blob}"`, created],
    },
    {
      sql: `INSERT INTO uploads(id,owner_id,space_id,parent_id,blob_id,credential_id,reservation_id,mode,state,declared_size,
      capability_hash,epoch,created_at,expires_at,last_progress_at,upload_name,request_digest,capability_kid,
      write_attempt_id,write_lease_expires_at,r2_upload_id,part_bytes,part_count)
      VALUES(?,?,?,?,?,?,?,'multipart','uploading',3,'fixture',1,?,?,?,'inventory.bin','fixture','fixture',?,?,?,67108864,1)`,
      values: [
        id,
        f.ids.user,
        f.ids.space,
        f.ids.folder,
        blob,
        f.ids.credential,
        reservation,
        created,
        created + 6 * 86400000,
        created,
        attempt,
        options.initLease ?? 0,
        options.known ? handle.uploadId : null,
      ],
    },
  ]);
  return { ...f, id, blob, reservation, key, handle, metadata };
}
