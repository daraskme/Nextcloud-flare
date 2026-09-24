import { authorizationAssertion, authorizeNode, type Principal } from "../../auth/authorize";
import type { UploadCapabilities } from "../../auth/uploadCapability";
import { assertExists, atomicBatch, primary, type SqlStatement } from "../../db/primary";
import { digestJson } from "../../jobs/operations";

export interface UploadRow {
  id: string;
  owner_id: string;
  space_id: string;
  parent_id: string;
  target_id: string | null;
  blob_id: string;
  credential_id: string;
  reservation_id: string;
  mode: "single" | "multipart";
  state: string;
  declared_size: number;
  r2_upload_id: string | null;
  capability_hash: string;
  epoch: number;
  accept_parts: number;
  in_flight: number;
  data_calls: number;
  data_bytes: number;
  control_calls: number;
  cleanup_calls: number;
  cleanup_pending: number;
  created_at: number;
  expires_at: number;
  last_progress_at: number;
  error_code: string | null;
  upload_name: string;
  target_revision: number | null;
  request_digest: string;
  capability_kid: string;
  write_attempt_id: string | null;
  write_lease_expires_at: number | null;
  completion_op_id: string | null;
  part_bytes: number | null;
  part_count: number | null;
  multipart_ledger_id: string | null;
  multipart_revision: number;
  multipart_complete_attempt: string | null;
  multipart_complete_lease: number | null;
  multipart_object_etag: string | null;
  multipart_cleanup_started_at: number | null;
  multipart_cleanup_closed: "aborted" | "completed" | null;
}

export async function uploadRow(db: D1Database, id: string): Promise<UploadRow | null> {
  if (!/^up_[a-f0-9]{64}$/.test(id)) throw new Error("invalid_upload_id");
  return primary(db)
    .prepare(
      "SELECT * FROM uploads WHERE id=? AND source='private' AND upload_name IS NOT NULL AND capability_kid IS NOT NULL",
    )
    .bind(id)
    .first<UploadRow>();
}

export function uploadFence(
  row: UploadRow,
  states: readonly string[],
  reservation = true,
): SqlStatement {
  return assertExists(
    `SELECT 1 FROM uploads u JOIN control c ON c.singleton=1
      WHERE u.id=? AND u.source='private' AND u.credential_id=? AND u.epoch=? AND c.epoch=u.epoch AND c.maintenance=0
        AND u.state IN (SELECT value FROM json_each(?))
        AND u.expires_at>strftime('%s','now')*1000
        AND u.last_progress_at>strftime('%s','now')*1000-86400000
        ${
          reservation
            ? `AND EXISTS(SELECT 1 FROM reservations r WHERE r.id=u.reservation_id
          AND r.owner_id=u.owner_id AND r.epoch=u.epoch AND r.bytes=u.declared_size
          AND r.state='reserved' AND r.expires_at>strftime('%s','now')*1000)`
            : ""
        }`,
    [row.id, row.credential_id, row.epoch, JSON.stringify(states)],
  );
}

/** Private Access uploads first. Public upload-only policy is connected separately. */
export async function uploadAuthority(
  db: D1Database,
  principal: Principal,
  row: UploadRow,
  checkTargetRevision = true,
) {
  if (
    principal.kind !== "user" ||
    principal.credential_id !== row.credential_id ||
    principal.epoch !== row.epoch
  )
    throw new Error("upload_authorization_denied");
  const authorized = await authorizeNode(
    db,
    principal,
    row.target_id
      ? {
          operation: "node.content.write",
          nodeId: row.target_id,
          spaceId: row.space_id,
        }
      : { operation: "node.create", parentId: row.parent_id, spaceId: row.space_id },
  );
  if (authorized.operation === "node.content.write") {
    if (
      authorized.parentId !== row.parent_id ||
      authorized.node.owner_id !== row.owner_id ||
      (checkTargetRevision && authorized.node.revision !== row.target_revision)
    )
      throw new Error("upload_target_changed");
  } else if (authorized.operation !== "node.create" || authorized.parent.owner_id !== row.owner_id)
    throw new Error("upload_authorization_denied");
  return authorized;
}

export async function accessUpload(
  db: D1Database,
  principal: Principal,
  id: string,
  token: string,
  capabilities: UploadCapabilities,
  checkTargetRevision = true,
  profile: "transfer" | "receipt" = "transfer",
) {
  const row = await uploadRow(db, id);
  if (!row) throw new Error("upload_not_found");
  await capabilities.verify(row, token);
  if ((await digestJson(token)) !== row.capability_hash)
    throw new Error("invalid_upload_capability");
  const authorized = await uploadAuthority(db, principal, row, checkTargetRevision);
  if (
    profile === "transfer" &&
    (row.expires_at <= Date.now() || row.last_progress_at <= Date.now() - 86400000)
  )
    throw new Error("upload_expired");
  await atomicBatch(db, [
    authorizationAssertion(authorized),
    profile === "receipt" ? uploadReceiptFence(row) : uploadFence(row, [row.state], false),
  ]);
  return { row, authorized };
}

/** Current credential/capability and node authority are still required after transfer expiry. */
export function uploadReceiptFence(row: UploadRow): SqlStatement {
  return assertExists(
    `SELECT 1 FROM uploads u JOIN control c ON c.singleton=1
      WHERE u.id=? AND u.source='private' AND u.credential_id=? AND u.epoch=? AND c.epoch=u.epoch AND c.maintenance=0`,
    [row.id, row.credential_id, row.epoch],
  );
}

export function uploadStatus(row: UploadRow) {
  return {
    id: row.id,
    mode: row.mode,
    state: row.state,
    declaredSize: row.declared_size,
    expiresAt: row.expires_at,
    inFlight: row.in_flight,
    cleanupPending: row.cleanup_pending === 1,
    operationId: row.completion_op_id,
    errorCode: row.error_code,
    ...(row.mode === "multipart" ? { partBytes: row.part_bytes, partCount: row.part_count } : {}),
  };
}
