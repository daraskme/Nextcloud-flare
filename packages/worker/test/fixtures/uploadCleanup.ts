import { env } from "cloudflare:workers";
import { atomicBatch } from "../../src/db/primary";
import { foundationFixture } from "./foundation";

// Seed persisted history at real past timestamps; never weaken the immutable expiry trigger.
export async function singleCleanupFixture(state = "receiving", expired = true) {
  const f = foundationFixture(crypto.randomUUID(), Date.now() - 1000);
  await atomicBatch(env.DB, f.statements);
  const id = `up_${crypto.randomUUID().replaceAll("-", "").repeat(2)}`;
  const blob = `${id}_blob`;
  const reservation = `${id}_reservation`;
  const createdAt = Date.now() - (expired ? 25 : 1) * 3600000;
  const expiresAt = createdAt + 86400000;
  const attempt = state === "created" ? null : crypto.randomUUID();
  const key = `u/${f.ids.user}/b/${blob}`;
  await atomicBatch(env.DB, [
    {
      sql: "INSERT INTO reservations(id,owner_id,bytes,state,expires_at,epoch) VALUES(?,?,3,'reserved',?,1)",
      values: [reservation, f.ids.user, expiresAt],
    },
    {
      sql: "INSERT INTO blobs(id,owner_id,r2_key,size,content_etag,state,created_at) VALUES(?,?,?,3,?,'staging',?)",
      values: [blob, f.ids.user, key, `"b-${blob}"`, createdAt],
    },
    {
      sql: `INSERT INTO uploads(id,owner_id,space_id,parent_id,blob_id,credential_id,reservation_id,mode,state,declared_size,
      capability_hash,epoch,created_at,expires_at,last_progress_at,upload_name,request_digest,capability_kid,
      write_attempt_id,write_lease_expires_at,in_flight,cleanup_pending)
      VALUES(?,?,?,?,?,?,?,'single',?,3,'fixture',1,?,?,?,'cleanup.txt','fixture','fixture',?,?,?,?)`,
      values: [
        id,
        f.ids.user,
        f.ids.space,
        f.ids.folder,
        blob,
        f.ids.credential,
        reservation,
        state,
        createdAt,
        expiresAt,
        createdAt,
        attempt,
        attempt ? createdAt + 900000 : null,
        state === "receiving" ? 1 : 0,
        ["aborted", "failed", "expired"].includes(state) ? 1 : 0,
      ],
    },
  ]);
  const metadata = {
    upload_id: id,
    blob_id: blob,
    epoch: "1",
    attempt_id: attempt ?? "not_started",
  };
  return { ...f, id, blob, reservation, key, metadata };
}

export async function multipartCleanupFixture(
  options: {
    state?: string;
    idle?: boolean;
    known?: boolean;
    completeLease?: number;
    initLease?: number;
  } = {},
) {
  const f = foundationFixture(crypto.randomUUID(), Date.now() - 1000);
  await atomicBatch(env.DB, f.statements);
  const id = `up_${crypto.randomUUID().replaceAll("-", "").repeat(2)}`;
  const blob = `${id}_blob`;
  const reservation = `${id}_reservation`;
  const key = `u/${f.ids.user}/b/${blob}`;
  const attempt = crypto.randomUUID();
  const metadata = { upload_id: id, blob_id: blob, epoch: "1", attempt_id: attempt };
  const multipart =
    options.known === false
      ? null
      : await env.BLOBS.createMultipartUpload(key, { customMetadata: metadata });
  const state = options.state ?? "uploading";
  const created = Date.now() - (options.idle === false ? 1000 : 25 * 3600000);
  const expires = created + 6 * 86400000;
  await atomicBatch(env.DB, [
    {
      sql: "INSERT INTO reservations(id,owner_id,bytes,state,expires_at,epoch) VALUES(?,?,3,'reserved',?,1)",
      values: [reservation, f.ids.user, expires],
    },
    {
      sql: "INSERT INTO blobs(id,owner_id,r2_key,size,content_etag,state,created_at) VALUES(?,?,?,3,?,'staging',?)",
      values: [blob, f.ids.user, key, `"b-${blob}"`, created],
    },
    {
      sql: `INSERT INTO uploads(id,owner_id,space_id,parent_id,blob_id,credential_id,reservation_id,
        mode,state,declared_size,capability_hash,epoch,created_at,expires_at,last_progress_at,
        upload_name,request_digest,capability_kid,write_attempt_id,write_lease_expires_at,
        r2_upload_id,part_bytes,part_count,cleanup_pending,multipart_complete_attempt,multipart_complete_lease)
        VALUES(?,?,?,?,?,?,?,'multipart',?,3,'fixture',1,?,?,?,'cleanup.bin','fixture','fixture',?,?,?,67108864,1,?,?,?)`,
      values: [
        id,
        f.ids.user,
        f.ids.space,
        f.ids.folder,
        blob,
        f.ids.credential,
        reservation,
        state,
        created,
        expires,
        created,
        attempt,
        options.initLease ?? 0,
        multipart?.uploadId ?? null,
        ["aborting", "failed", "expired", "aborted"].includes(state) ? 1 : 0,
        state === "completing" ? crypto.randomUUID() : null,
        state === "completing" ? (options.completeLease ?? 0) : null,
      ],
    },
  ]);
  return { ...f, id, blob, reservation, key, metadata, multipart };
}
