import { authorizationAssertion, type Principal } from "../../auth/authorize";
import type { UploadCapabilities } from "../../auth/uploadCapability";
import { atomicBatch } from "../../db/primary";
import { accessUpload, type UploadRow, uploadReceiptFence, uploadStatus } from "./access";

export interface UploadPartReceipt {
  partNumber: number;
  attempts: number;
  attemptId: string | null;
  state: "pending" | "in_flight" | "completed" | "unknown";
  expectedBytes: number;
  leaseExpiresAt: number | null;
  etag: string | null;
  sha256: string | null;
}

/** Return a D1 snapshot; reading progress never initializes a DO or grants another dispatch. */
export async function readUpload(
  db: D1Database,
  principal: Principal,
  id: string,
  capability: string,
  capabilities: UploadCapabilities,
  page?: { after: number; limit: number },
) {
  if (
    page &&
    (!Number.isInteger(page.after) ||
      page.after < 0 ||
      page.after > 10000 ||
      !Number.isInteger(page.limit) ||
      page.limit < 1 ||
      page.limit > 200)
  )
    throw new Error("invalid_upload_page");
  const { row, authorized } = await accessUpload(
    db,
    principal,
    id,
    capability,
    capabilities,
    false,
    "receipt",
  );
  if (page && row.mode !== "multipart") throw new Error("invalid_upload_page");
  const after = page?.after ?? 0;
  const limit = page?.limit ?? 200;
  const result = await atomicBatch(db, [
    authorizationAssertion(authorized),
    uploadReceiptFence(row),
    { sql: "SELECT * FROM uploads WHERE id=?", values: [id] },
    ...(row.mode === "multipart"
      ? [
          {
            sql: `SELECT part_number AS partNumber,attempts,attempt_id AS attemptId,state,
        expected_size AS expectedBytes,lease_expires_at AS leaseExpiresAt,etag,sha256
        FROM upload_parts WHERE upload_id=? AND part_number>? ORDER BY part_number LIMIT ?`,
            values: [id, after, limit + 1],
          },
        ]
      : []),
  ]);
  const current = result[2]?.results[0] as unknown as UploadRow;
  if (!current) throw new Error("upload_not_found");
  const parts = (result[3]?.results ?? []) as unknown as UploadPartReceipt[];
  const more = parts.length > limit;
  if (more) parts.pop();
  return {
    ...uploadStatus(current),
    ...(current.mode === "multipart"
      ? {
          revision: current.multipart_revision,
          parts,
          nextAfter: more ? parts.at(-1)!.partNumber : null,
        }
      : {}),
  };
}
