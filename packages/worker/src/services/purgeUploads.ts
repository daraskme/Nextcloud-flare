import { assertExists, type SqlStatement } from "../db/primary";

/** Removing an upload must not erase an outstanding R2 write or its cleanup proof. */
export function assertPurgeUploadsSettled(trashOpId: string): SqlStatement {
  const members = "SELECT node_id FROM trash_members WHERE trash_op_id=?";
  return assertExists(
    `SELECT 1 WHERE NOT EXISTS(
      SELECT 1 FROM uploads u JOIN reservations r ON r.id=u.reservation_id
      JOIN blobs b ON b.id=u.blob_id
      WHERE (u.parent_id IN (${members}) OR u.target_id IN (${members}))
        AND (u.in_flight=0 AND u.cleanup_token IS NULL AND (
          (u.write_attempt_id IS NULL AND u.r2_upload_id IS NULL
            AND u.state IN ('created','aborted','aborting'))
          OR (u.state='completed' AND r.state='consumed')
          OR (u.state IN ('expired','aborted','failed') AND r.state='released'
            AND (u.mode='single' OR u.multipart_cleanup_closed IS NOT NULL
              OR EXISTS(SELECT 1 FROM multipart_upload_settlements x
                WHERE x.upload_id=u.id AND x.state='settled'))
            AND (
              (b.state='deleted' AND u.cleanup_pending=0
                AND EXISTS(SELECT 1 FROM gc_candidates g WHERE g.blob_id=b.id AND g.state='deleted')
                AND NOT EXISTS(SELECT 1 FROM blob_storage s WHERE s.blob_id=b.id AND s.removed_at IS NULL))
              OR (b.state IN ('orphan','gc_candidate','deleting') AND u.cleanup_pending=1
                AND EXISTS(SELECT 1 FROM gc_candidates g WHERE g.blob_id=b.id AND g.state IN ('candidate','deleting'))
                AND EXISTS(SELECT 1 FROM blob_storage s WHERE s.blob_id=b.id AND s.removed_at IS NULL))
            ))
        )) IS NOT 1
    )`,
    [trashOpId, trashOpId],
  );
}
