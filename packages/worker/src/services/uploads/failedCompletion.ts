import {
  assertExists,
  assertOneChange,
  prepare,
  primary,
  type SqlStatement,
} from "../../db/primary";
import {
  acquireSystemMutation,
  commitSystemMutation,
  type SystemMutationSource,
} from "../systemMutation";
import type { UploadRow } from "./access";
import { multipartObjectProof } from "./multipartProof";

/** Bind the original upload and the failed publication, including the pre-publication row snapshot. */
function source(row: UploadRow, operationId: string): SqlStatement {
  return {
    sql: `SELECT 1 FROM uploads u JOIN reservations r ON r.id=u.reservation_id
      JOIN blobs b ON b.id=u.blob_id JOIN operations o ON o.op_id=u.completion_op_id
      JOIN spaces space ON space.id=u.space_id AND space.owner_id=u.owner_id
      JOIN control c ON c.singleton=1
      WHERE (u.id=? AND u.source='private' AND u.owner_id=? AND u.space_id=? AND u.parent_id=? AND u.target_id IS ?
        AND u.blob_id=? AND u.reservation_id=? AND u.credential_id=? AND u.epoch=? AND u.mode=?
        AND u.declared_size=? AND u.request_digest=? AND u.write_attempt_id IS ?
        AND u.expires_at=? AND u.target_revision IS ? AND u.completion_op_id=?)
        AND (u.r2_upload_id IS ? AND u.multipart_complete_attempt IS ? AND u.multipart_object_etag IS ?)
        AND (c.epoch=u.epoch AND u.in_flight=0 AND u.accept_parts=0)
        AND (r.owner_id=u.owner_id AND r.bytes=u.declared_size AND r.epoch=u.epoch
        AND r.expires_at=u.expires_at AND r.share_id IS NULL AND r.op_id IS NULL)
        AND (b.owner_id=u.owner_id AND b.size=u.declared_size AND b.ref_count=0
        AND b.r2_key='u/'||u.owner_id||'/b/'||u.blob_id)
        AND (o.kind='upload.complete' AND o.state='failed' AND o.principal_kind='user'
        AND o.credential_id=u.credential_id AND o.epoch=u.epoch AND o.space_id=u.space_id
        AND json_extract(o.operands_json,'$.uploadId')=u.id
        AND json_extract(o.operands_json,'$.parentId')=u.parent_id
        AND json_extract(o.operands_json,'$.nodeId') IS u.target_id)
        AND NOT EXISTS(SELECT 1 FROM operation_steps WHERE op_id=o.op_id)`,
    values: [
      row.id,
      row.owner_id,
      row.space_id,
      row.parent_id,
      row.target_id,
      row.blob_id,
      row.reservation_id,
      row.credential_id,
      row.epoch,
      row.mode,
      row.declared_size,
      row.request_digest,
      row.write_attempt_id,
      row.expires_at,
      row.target_revision,
      operationId,
      row.r2_upload_id,
      row.multipart_complete_attempt,
      row.multipart_object_etag,
    ],
  };
}

async function settled(db: D1Database, proof: SqlStatement): Promise<boolean> {
  return (
    (await prepare(primary(db), {
      ...proof,
      sql:
        proof.sql +
        " AND u.state='failed' AND r.state='released' AND b.state IN ('orphan','deleted')",
    }).first()) !== null
  );
}

/** DB-only compensation for a proven failed publication; never delete R2 or refund physical bytes. */
export async function settleFailedCompletion(
  env: SystemMutationSource,
  row: UploadRow,
  operationId: string,
): Promise<void> {
  const proof = source(row, operationId);
  // A later GC may remove the object. Replaying an already released reservation is read-only.
  if (await settled(env.DB, proof)) return;
  const admission = await acquireSystemMutation(env, row.owner_id, "upload.complete-failed");
  try {
    await commitSystemMutation(env.DB, admission, row.owner_id, [
      assertExists(
        proof.sql +
          ` AND u.state IN ('completing','failed') AND r.state='reserved'
          AND b.state IN ('staging','orphan') AND u.write_attempt_id IS NOT NULL
          AND b.sha256_verified ${row.mode === "single" ? "IS NOT NULL" : "IS NULL"}
          AND EXISTS(SELECT 1 FROM blob_storage s WHERE s.blob_id=b.id
            AND s.bytes=b.size AND s.r2_etag=b.r2_etag AND s.removed_at IS NULL)`,
        proof.values,
      ),
      ...(row.mode === "multipart" ? [multipartObjectProof(row)] : []),
      {
        sql: "UPDATE uploads SET state='failed',cleanup_pending=1,error_code='complete_failed' WHERE id=? AND state IN ('completing','failed') AND completion_op_id=?",
        values: [row.id, operationId],
      },
      assertOneChange,
      {
        sql: "UPDATE blobs SET state='orphan' WHERE id=? AND state IN ('staging','orphan') AND ref_count=0",
        values: [row.blob_id],
      },
      assertOneChange,
      {
        sql: "UPDATE reservations SET state='released' WHERE id=? AND state='reserved'",
        values: [row.reservation_id],
      },
      assertOneChange,
    ]);
  } catch (error) {
    // Another cleanup may establish this domain result, but cannot close our unknown receipt.
    if (!(await settled(env.DB, proof))) throw error;
  }
}
