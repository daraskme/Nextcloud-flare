import { assertExists, assertOneChange, type SqlStatement } from "../../db/primary";
import type { UploadRow } from "./access";

/** Rechecked in the publishing batch: exact geometry and every completed part, never a whole hash. */
export function multipartPartsProof(row: UploadRow): SqlStatement {
  return assertExists(
    `SELECT 1 FROM uploads u WHERE u.id=? AND u.mode='multipart' AND u.r2_upload_id IS NOT NULL
      AND u.multipart_ledger_id IS NOT NULL AND u.part_count IS NOT NULL AND u.part_bytes IS NOT NULL
      AND u.accept_parts=0 AND u.in_flight=0
      AND (SELECT COUNT(*) FROM upload_parts p WHERE p.upload_id=u.id)=u.part_count
      AND (SELECT SUM(expected_size) FROM upload_parts p WHERE p.upload_id=u.id)=u.declared_size
      AND NOT EXISTS(SELECT 1 FROM upload_parts p WHERE p.upload_id=u.id AND (
        p.state<>'completed' OR p.part_number>u.part_count OR p.attempt_id IS NULL
        OR p.expected_size<>MIN(u.part_bytes,u.declared_size-(p.part_number-1)*u.part_bytes)
        OR p.etag IS NULL OR length(p.etag) NOT BETWEEN 1 AND 1024
        OR p.sha256 IS NULL OR length(p.sha256)<>64 OR p.sha256 GLOB '*[^0-9a-f]*'))`,
    [row.id],
  );
}

/** This proof is also required before compensating a known failed namespace operation. */
export function multipartObjectProof(row: UploadRow): SqlStatement {
  return assertExists(
    `SELECT 1 FROM uploads u JOIN blobs b ON b.id=u.blob_id JOIN blob_storage s ON s.blob_id=b.id
      WHERE u.id=? AND u.mode='multipart' AND u.multipart_complete_attempt IS NOT NULL
        AND u.multipart_object_etag IS NOT NULL AND b.r2_etag=u.multipart_object_etag
        AND b.owner_id=u.owner_id AND b.size=u.declared_size AND b.sha256_verified IS NULL
        AND b.r2_key='u/'||u.owner_id||'/b/'||u.blob_id
        AND s.bytes=b.size AND s.r2_etag=b.r2_etag AND s.removed_at IS NULL`,
    [row.id],
  );
}

/** Reconciliation cannot consume the cleanup budget or cause an unbounded HEAD loop. */
export function multipartHeadCharge(row: UploadRow): SqlStatement[] {
  return [
    {
      sql: "UPDATE uploads SET control_calls=control_calls+1 WHERE id=? AND control_calls<64",
      values: [row.id],
    },
    assertOneChange,
  ];
}
