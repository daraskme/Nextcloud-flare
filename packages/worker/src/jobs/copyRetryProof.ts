import { primary } from "../db/primary";

// Preserve the original receipt and exact selections. Closure is proved before
// retry; creating a successor never releases a hold or reuses an old R2 key.
export const COPY_RETRY_PROOF = `previous.kind='node.copy' AND previous.state IN ('failed','cancelled')
  AND previous.stopped_at IS NOT NULL AND previous.stop_epoch>=previous.epoch
  AND previous.publish_op_id IS NULL AND previous.published_root_id IS NULL
  AND original.kind='copy.enqueue' AND original.state='committed'
  AND next.principal_kind='user' AND original.principal_kind=next.principal_kind
  AND original.principal_id=next.principal_id AND original.credential_id=next.credential_id
  AND previous.credential_id=next.credential_id AND original.space_id=next.space_id
  AND original.selected_share_id IS next.selected_share_id
  AND original.selected_share_version IS next.selected_share_version
  AND original.destination_space_id=next.destination_space_id
  AND original.destination_share_id IS next.destination_share_id
  AND original.destination_share_version IS next.destination_share_version
  AND json_extract(original.operands_json,'$.sourceNodeId')=json_extract(next.operands_json,'$.sourceNodeId')
  AND json_extract(original.operands_json,'$.parentId')=json_extract(next.operands_json,'$.parentId')
  AND json_extract(original.operands_json,'$.name')=json_extract(next.operands_json,'$.name')
  AND json_extract(original.operands_json,'$.depth')=json_extract(next.operands_json,'$.depth')
  AND json_extract(original.operands_json,'$.overwriteTargetId') IS json_extract(next.operands_json,'$.overwriteTargetId')
  AND NOT EXISTS(SELECT 1 FROM copy_job_blobs WHERE job_id=previous.id)
  AND NOT EXISTS(SELECT 1 FROM job_leases WHERE job_id=previous.id)
  AND previous.blob_count=(SELECT COUNT(*) FROM copy_cleanup_receipts WHERE job_id=previous.id)
  AND EXISTS(SELECT 1 FROM outbox WHERE op_id=previous.op_id AND payload_ref=previous.id
    AND kind='copy.requested' AND state='failed')`;

/** Restored receipts also need this check: restore bypasses insertion triggers. */
export async function verifyCopyRetry(db: D1Database, operationId: string): Promise<boolean> {
  return !!(await primary(db)
    .prepare(`SELECT 1 FROM operations next
      JOIN bulk_jobs previous ON previous.id=json_extract(next.operands_json,'$.retryOf')
      JOIN operations original ON original.op_id=previous.op_id
      WHERE next.op_id=? AND next.kind='copy.enqueue' AND ${COPY_RETRY_PROOF}`)
    .bind(operationId)
    .first());
}
