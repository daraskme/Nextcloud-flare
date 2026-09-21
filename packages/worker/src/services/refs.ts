import type { Env } from "../env.js";

export async function pinBlob(
  env: Env,
  pinId: string,
  blobId: string,
  purpose: string,
  expiresAt: number | null,
  now = Date.now(),
): Promise<void> {
  await env.DB.batch([
    env.DB.prepare(
      "INSERT INTO _assert(v) SELECT 1 WHERE NOT EXISTS(SELECT 1 FROM blobs WHERE id=?1 AND state NOT IN ('deleting','deleted'))",
    ).bind(blobId),
    env.DB.prepare(
      "INSERT INTO blob_pins(pin_id,blob_id,purpose,expires_at,created_at) VALUES(?1,?2,?3,?4,?5)",
    ).bind(pinId, blobId, purpose, expiresAt, now),
    env.DB.prepare("INSERT INTO _assert(v) SELECT 1 WHERE changes()<>1"),
    env.DB.prepare("UPDATE blobs SET ref_count=ref_count+1 WHERE id=?1").bind(blobId),
    env.DB.prepare("INSERT INTO _assert(v) SELECT 1 WHERE changes()<>1"),
  ]);
}
