import { assertExists, primary, type SqlStatement } from "../db/primary";

export interface BlobPin {
  readonly id: string;
  readonly blobId: string;
  readonly purpose: "copy" | "zip" | "backup" | "job" | "reader";
  readonly expiresAt: number | null;
}

/** Pin rows are authoritative even after expiry until a fenced cleanup removes them. */
export function addPinStatements(pin: BlobPin, epoch: number): SqlStatement[] {
  if (
    !pin.id ||
    pin.id.length > 128 ||
    !pin.blobId ||
    pin.blobId.length > 128 ||
    !["copy", "zip", "backup", "job", "reader"].includes(pin.purpose) ||
    (pin.expiresAt !== null && !Number.isSafeInteger(pin.expiresAt))
  )
    throw new Error("invalid_pin");
  return [
    assertExists("SELECT 1 FROM control WHERE singleton=1 AND epoch=?", [epoch]),
    assertExists("SELECT 1 FROM blobs WHERE id=? AND state NOT IN ('deleting','deleted')", [
      pin.blobId,
    ]),
    {
      sql: `INSERT INTO blob_pins(pin_id,blob_id,purpose,expires_at,created_at) VALUES(?,?,?,?,strftime('%s','now')*1000)
        ON CONFLICT(pin_id) DO NOTHING`,
      values: [pin.id, pin.blobId, pin.purpose, pin.expiresAt],
    },
    assertExists(
      "SELECT 1 FROM blob_pins WHERE pin_id=? AND blob_id=? AND purpose=? AND expires_at IS ?",
      [pin.id, pin.blobId, pin.purpose, pin.expiresAt],
    ),
  ];
}

export function removePinStatements(id: string, blobId: string, epoch: number): SqlStatement[] {
  return [
    assertExists("SELECT 1 FROM control WHERE singleton=1 AND epoch=?", [epoch]),
    assertExists(
      "SELECT 1 WHERE NOT EXISTS(SELECT 1 FROM blob_pins WHERE pin_id=? AND blob_id<>?)",
      [id, blobId],
    ),
    { sql: "DELETE FROM blob_pins WHERE pin_id=? AND blob_id=?", values: [id, blobId] },
    assertExists("SELECT 1 WHERE NOT EXISTS(SELECT 1 FROM blob_pins WHERE pin_id=?)", [id]),
  ];
}

export interface LedgerAudit {
  used_bytes: number;
  actual_used_bytes: number;
  reserved_bytes: number;
  actual_reserved_bytes: number;
  physical_bytes: number;
  observed_physical_bytes: number;
  incorrect_refs: number;
}

/** Diagnostic read; R2 existence reconciliation is a separate maintenance operation. */
export async function auditOwnerLedger(
  db: D1Database,
  ownerId: string,
): Promise<LedgerAudit | null> {
  return primary(db)
    .prepare(`SELECT u.used_bytes,u.reserved_bytes,u.physical_bytes,
    COALESCE((SELECT SUM(b.size) FROM blobs b WHERE b.owner_id=u.id AND
      (EXISTS(SELECT 1 FROM nodes WHERE current_blob_id=b.id) OR EXISTS(SELECT 1 FROM node_versions WHERE blob_id=b.id))),0) AS actual_used_bytes,
    COALESCE((SELECT SUM(bytes) FROM reservations WHERE owner_id=u.id AND state='reserved'),0) AS actual_reserved_bytes,
    COALESCE((SELECT SUM(s.bytes) FROM blobs b JOIN blob_storage s ON s.blob_id=b.id WHERE b.owner_id=u.id AND s.removed_at IS NULL),0)
      +COALESCE((SELECT SUM(o.bytes) FROM orphan_objects o WHERE o.owner_id=u.id AND o.state<>'deleted'),0)
      +COALESCE((SELECT SUM(h.held_bytes) FROM multipart_bucket_handles h WHERE h.owner_id=u.id),0) AS observed_physical_bytes,
    (SELECT COUNT(*) FROM blobs b WHERE b.owner_id=u.id AND b.ref_count<>
      (SELECT COUNT(*) FROM nodes WHERE current_blob_id=b.id)+(SELECT COUNT(*) FROM node_versions WHERE blob_id=b.id)+(SELECT COUNT(*) FROM blob_pins WHERE blob_id=b.id)) AS incorrect_refs
    FROM users u WHERE u.id=?`)
    .bind(ownerId)
    .first<LedgerAudit>();
}
