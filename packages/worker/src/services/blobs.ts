import type { Env } from "../env.js";
import { putKnownLength } from "./streaming.js";

export interface StagedBlob {
  id: string;
  ownerId: string;
  key: string;
  size: number;
  contentEtag: string;
  r2Etag: string;
  mime: string;
}

export function immutableBlobKey(ownerId: string, blobId: string): string {
  if (!/^[A-Za-z0-9_-]+$/u.test(ownerId) || !/^[A-Za-z0-9_-]+$/u.test(blobId)) {
    throw new RangeError("Blob identity is invalid");
  }
  return `u/${ownerId}/b/${blobId}`;
}

export async function transferImmutableBlob(
  env: Env,
  input: {
    ownerId: string;
    blobId: string;
    source: ReadableStream<Uint8Array>;
    size: number;
    mime?: string;
    operationId?: string;
  },
): Promise<StagedBlob> {
  if (!Number.isSafeInteger(input.size) || input.size < 0) {
    throw new RangeError("Blob size is invalid");
  }
  const key = immutableBlobKey(input.ownerId, input.blobId);
  const existing = await env.BLOBS.head(key);
  if (existing !== null) {
    throw new Error("immutable_blob_exists");
  }
  const object = await putKnownLength(env.BLOBS, key, input.source, input.size);
  const blob = {
    id: input.blobId,
    ownerId: input.ownerId,
    key,
    size: input.size,
    contentEtag: `"b-${input.blobId}"`,
    r2Etag: object.httpEtag,
    mime: input.mime ?? "application/octet-stream",
  };
  await env.DB.batch([
    env.DB.prepare(
      "INSERT INTO blobs(id,owner_id,r2_key,size,sha256_verified,client_sha256,content_etag,r2_etag,mime_sniffed,ref_count,state,created_at,last_op_id) VALUES(?1,?2,?3,?4,NULL,NULL,?5,?6,?7,0,'staging',?8,?9)",
    ).bind(
      blob.id,
      blob.ownerId,
      blob.key,
      blob.size,
      blob.contentEtag,
      blob.r2Etag,
      blob.mime,
      Date.now(),
      input.operationId ?? null,
    ),
    env.DB.prepare("INSERT INTO _assert(v) SELECT 1 WHERE changes()<>1"),
    env.DB.prepare(
      "UPDATE users SET physical_bytes=physical_bytes+?1 WHERE id=?2 AND disabled_at IS NULL AND reserved_bytes>=?1",
    ).bind(blob.size, blob.ownerId),
    env.DB.prepare("INSERT INTO _assert(v) SELECT 1 WHERE changes()<>1"),
  ]);
  return blob;
}

export async function markStagedBlobOrphan(
  env: Env,
  blobId: string,
  ownerId: string,
): Promise<void> {
  await env.DB.batch([
    env.DB.prepare(
      "UPDATE blobs SET state='orphan' WHERE id=?1 AND owner_id=?2 AND state='staging' AND ref_count=0",
    ).bind(blobId, ownerId),
    env.DB.prepare("INSERT INTO _assert(v) SELECT 1 WHERE changes()<>1"),
  ]);
}
