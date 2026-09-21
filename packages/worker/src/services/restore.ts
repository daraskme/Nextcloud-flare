import type { Env } from "../env.js";

export async function assertBlobRecoverable(env: Env, blobId: string): Promise<void> {
  const blob = await env.DB.prepare("SELECT state FROM blobs WHERE id=?1")
    .bind(blobId)
    .first<{ state: string }>();
  if (blob === null || blob.state === "deleting" || blob.state === "deleted") {
    throw new Error("blob_unrecoverable");
  }
}
