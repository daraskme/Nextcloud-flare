import { imageGrantFromRow, imageTransformAuthority } from "./imageTransform";
import { assertExists, primary } from "./primary";
import type { R2WriteRequest } from "./r2Write";

export interface R2ImageProof {
  imageId: string;
  attemptId: string;
  claimToken: string;
  expiresAt: number;
}
const uuid = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
export function validateImageWrite(r: R2WriteRequest) {
  const p = r.image;
  if (
    !p ||
    r.kind !== "image.put" ||
    !uuid.test(p.imageId) ||
    !uuid.test(p.attemptId) ||
    !uuid.test(p.claimToken) ||
    !Number.isSafeInteger(p.expiresAt) ||
    p.expiresAt < r.deadline ||
    r.copy ||
    r.upload ||
    r.abort ||
    r.gc ||
    r.prune ||
    r.probe ||
    r.backups ||
    !r.key.startsWith(`u/${r.ownerId}/d/`) ||
    !r.key.endsWith("/" + p.imageId)
  )
    throw new Error("invalid_r2_write");
}

/** The native PUT needs the original saved authority and this exact prepared output. */
export async function imageWriteProof(db: D1Database, r: R2WriteRequest) {
  const p = r.image!;
  const row = await primary(db)
    .prepare("SELECT * FROM image_transform_attempts WHERE id=? AND state='succeeded'")
    .bind(p.imageId)
    .first<Record<string, unknown>>();
  if (!row) throw new Error("image_derivative_unavailable");
  const g = imageGrantFromRow(row);
  if (
    g.ownerId !== r.ownerId ||
    g.epoch !== r.epoch ||
    g.claimToken !== p.claimToken ||
    g.expiresAt !== p.expiresAt
  )
    throw new Error("image_derivative_unavailable");
  return [
    ...(await imageTransformAuthority(db, g)),
    assertExists(
      `SELECT 1 FROM image_derivative_objects x JOIN derivative_results d ON d.id=x.result_id
      JOIN blobs b ON b.id=x.output_blob_id JOIN reservations reserve ON reserve.id=x.reservation_id
      JOIN blob_pins pin ON pin.pin_id=x.pin_id
      WHERE x.id=? AND x.write_attempt_id=? AND x.owner_id=? AND x.state='prepared'
      AND d.state='running' AND d.claim_token=? AND d.claim_expires_at=? AND d.epoch=?
      AND b.r2_key=? AND b.state='staging' AND b.ref_count=1 AND b.size=d.size
      AND reserve.state='reserved' AND reserve.physical_only=1 AND reserve.bytes=b.size AND reserve.epoch=d.epoch AND reserve.expires_at=d.claim_expires_at
      AND pin.blob_id=b.id AND pin.purpose='job' AND pin.expires_at IS NULL
      AND d.claim_expires_at>=? AND d.claim_expires_at>strftime('%s','now')*1000+1000
      AND NOT EXISTS(SELECT 1 FROM blob_storage WHERE blob_id=b.id)
      AND NOT EXISTS(SELECT 1 FROM r2_write_attempts WHERE r2_key=b.r2_key AND state<>'not_started')`,
      [g.id, p.attemptId, g.ownerId, g.claimToken, g.expiresAt, g.epoch, r.key, r.deadline],
    ),
  ];
}
