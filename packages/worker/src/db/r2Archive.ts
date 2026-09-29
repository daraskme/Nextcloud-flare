import {
  archiveDerivativeAuthority,
  archiveDerivativeKey,
  archiveGrantFromRow,
} from "./archiveDerivative";
import { assertExists, primary } from "./primary";
import type { R2WriteRequest } from "./r2Write";

export interface R2ArchiveProof {
  archiveId: string;
  attemptId: string;
  claimToken: string;
  expiresAt: number;
}
export function validateArchiveWrite(r: R2WriteRequest) {
  const p = r.archive,
    uuid = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
  if (
    !p ||
    r.kind !== "archive.put" ||
    ![p.archiveId, p.attemptId, p.claimToken].every((v) => typeof v === "string" && uuid.test(v)) ||
    !Number.isSafeInteger(p.expiresAt) ||
    p.expiresAt < r.deadline ||
    r.image ||
    r.copy ||
    r.upload ||
    r.abort ||
    r.gc ||
    r.prune ||
    r.probe ||
    r.backups ||
    !r.key.startsWith(`u/${r.ownerId}/d/`) ||
    !r.key.endsWith("/" + p.archiveId)
  )
    throw new Error("invalid_r2_write");
}

export async function archiveWriteProof(db: D1Database, r: R2WriteRequest) {
  const p = r.archive!;
  const row = await primary(db)
    .prepare("SELECT * FROM archive_derivative_objects WHERE id=? AND state='prepared'")
    .bind(p.archiveId)
    .first<Record<string, unknown>>();
  if (!row) throw new Error("archive_derivative_unavailable");
  const g = archiveGrantFromRow(row);
  if (g.ownerId !== r.ownerId || g.epoch !== r.epoch || r.key !== archiveDerivativeKey(g))
    throw new Error("archive_derivative_unavailable");
  return {
    grant: g,
    outputJson: row.output_json as string,
    statements: [
      ...(await archiveDerivativeAuthority(db, {
        ...g,
        claimToken: p.claimToken,
        expiresAt: p.expiresAt,
      })),
      assertExists(
        `SELECT 1 FROM archive_derivative_objects x JOIN derivative_results d ON d.id=x.result_id
      JOIN archive_derivative_cleanup clean ON clean.archive_id=x.id
      JOIN blobs b ON b.id=x.output_blob_id JOIN reservations reserve ON reserve.id=x.reservation_id
      JOIN blob_pins pin ON pin.pin_id=x.pin_id
      WHERE x.id=? AND x.write_attempt_id=? AND x.owner_id=? AND x.state='prepared' AND clean.retired_at IS NULL
      AND d.state='running' AND d.epoch=? AND b.r2_key=? AND b.state='staging' AND b.ref_count=1 AND b.size=d.size
      AND reserve.state='reserved' AND reserve.physical_only=1 AND reserve.bytes=b.size AND reserve.epoch=d.epoch
      AND pin.blob_id=b.id AND pin.purpose='job' AND pin.expires_at IS NULL
      AND NOT EXISTS(SELECT 1 FROM blob_storage WHERE blob_id=b.id)
      AND NOT EXISTS(SELECT 1 FROM r2_write_attempts WHERE r2_key=b.r2_key AND state<>'not_started')`,
        [g.id, p.attemptId, g.ownerId, g.epoch, r.key],
      ),
    ],
  };
}
