import { assertExists, primary } from "../db/primary";

import {
  acquireSystemMutation,
  commitSystemMutation,
  type SystemMutationEnv,
} from "./systemMutation";

/** Repeating this after response loss is safe. Never infer R2 presence from a client report. */
export async function observePhysicalObject(
  env: SystemMutationEnv,
  bucket: R2Bucket,
  blobId: string,
  epoch: number,
): Promise<void> {
  const { DB: db } = env;
  const blob = await primary(db)
    .prepare(
      "SELECT owner_id,r2_key,size FROM blobs WHERE id=? AND state NOT IN ('deleting','deleted')",
    )
    .bind(blobId)
    .first<{ owner_id: string; r2_key: string; size: number }>();
  if (!blob) throw new Error("blob_not_observable");
  const object = await bucket.head(blob.r2_key);
  if (!object || !Number.isSafeInteger(object.size) || object.size < 0)
    throw new Error("physical_object_mismatch");
  const admission = await acquireSystemMutation(env, blob.owner_id, "upload.observe");
  await commitSystemMutation(db, admission, blob.owner_id, [
    assertExists("SELECT 1 FROM control WHERE singleton=1 AND epoch=?", [epoch]),
    assertExists(
      "SELECT 1 FROM blobs WHERE id=? AND r2_key=? AND size=? AND state NOT IN ('deleting','deleted')",
      [blobId, blob.r2_key, blob.size],
    ),
    {
      sql: `INSERT INTO blob_storage(blob_id,bytes,r2_etag,observed_at) VALUES(?,?,?,strftime('%s','now')*1000)
      ON CONFLICT(blob_id) DO NOTHING`,
      values: [blobId, object.size, object.etag],
    },
    assertExists(
      "SELECT 1 FROM blob_storage WHERE blob_id=? AND bytes=? AND r2_etag=? AND removed_at IS NULL",
      [blobId, object.size, object.etag],
    ),
  ]);
  // Validation failure does not make already-existing R2 bytes free. The caller must
  // fail publication and clean up the object; the observed charge survives until deletion.
  if (object.size !== blob.size) throw new Error("physical_object_mismatch");
}
