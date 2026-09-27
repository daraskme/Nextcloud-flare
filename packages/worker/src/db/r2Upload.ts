import { authorizationAssertion, authorizeNode, type Principal } from "../auth/authorize";
import { storedPrincipal } from "../auth/selectedShare";
import type { UploadRow } from "../services/uploads/access";
import { multipartPartsProof } from "../services/uploads/multipartProof";
import { assertExists, primary, type SqlStatement } from "./primary";
import type { R2WriteRequest } from "./r2Write";

export const UPLOAD_WRITE_KINDS = [
  "upload.put",
  "multipart.create",
  "multipart.part",
  "multipart.complete",
] as const;
export type UploadWriteKind = (typeof UPLOAD_WRITE_KINDS)[number];
export interface R2UploadProof {
  id: string;
  attemptId: string;
  expiresAt: number;
  principal: Principal;
  r2UploadId?: string;
  partNumber?: number;
}
export function isUploadWrite(kind: string): kind is UploadWriteKind {
  return (UPLOAD_WRITE_KINDS as readonly string[]).includes(kind);
}
export function validateUploadWrite(request: R2WriteRequest): void {
  const upload = request.upload;
  if (
    !upload ||
    request.gc !== undefined ||
    !/^(up_[a-f0-9]{64}|dav_op_[a-f0-9]{64})$/.test(upload.id) ||
    !/^[A-Za-z0-9_-]{1,128}$/.test(upload.attemptId) ||
    !Number.isSafeInteger(upload.expiresAt) ||
    upload.expiresAt < request.deadline ||
    !upload.principal ||
    upload.principal.epoch !== request.epoch ||
    !["user", "app_password", "service"].includes(upload.principal.kind) ||
    (upload.r2UploadId !== undefined &&
      (typeof upload.r2UploadId !== "string" ||
        !upload.r2UploadId ||
        upload.r2UploadId.length > 1024)) ||
    ["multipart.part", "multipart.complete"].includes(request.kind) !==
      (upload.r2UploadId !== undefined) ||
    (request.kind === "multipart.part"
      ? !Number.isSafeInteger(upload.partNumber) ||
        upload.partNumber! < 1 ||
        upload.partNumber! > 10000
      : upload.partNumber !== undefined)
  )
    throw new Error("invalid_r2_write");
}

/** Recheck the original transfer, current authority and durable part mirror inside the grant batch. */
export async function uploadWriteProof(
  db: D1Database,
  request: R2WriteRequest,
): Promise<SqlStatement[]> {
  const proof = request.upload!;
  const row = await primary(db)
    .prepare("SELECT * FROM uploads WHERE id=?")
    .bind(proof.id)
    .first<UploadRow & { source: "private" | "dav" }>();
  if (
    !row ||
    row.epoch !== request.epoch ||
    row.owner_id !== request.ownerId ||
    row.credential_id !== proof.principal.credential_id ||
    request.key !== `u/${row.owner_id}/b/${row.blob_id}` ||
    (row.source === "private" && proof.principal.kind !== "user") ||
    (row.source === "dav" && request.kind !== "upload.put")
  )
    throw new Error("r2_upload_unavailable");
  const authorized = await authorizeNode(
    db,
    storedPrincipal(proof.principal, row),
    row.target_id
      ? { operation: "node.content.write", nodeId: row.target_id, spaceId: row.space_id }
      : { operation: "node.create", parentId: row.parent_id, spaceId: row.space_id },
  );
  if (authorized.operation === "node.content.write") {
    if (
      authorized.parentId !== row.parent_id ||
      authorized.node.owner_id !== row.owner_id ||
      authorized.node.revision !== row.target_revision
    )
      throw new Error("r2_upload_unavailable");
  } else if (authorized.operation !== "node.create" || authorized.parent.owner_id !== row.owner_id)
    throw new Error("r2_upload_unavailable");
  const specific =
    request.kind === "upload.put"
      ? "u.mode='single' AND u.state='receiving' AND u.in_flight=1 AND u.write_attempt_id=? AND u.write_lease_expires_at=?"
      : request.kind === "multipart.create"
        ? "u.source='private' AND u.mode='multipart' AND u.state='created' AND u.r2_upload_id IS NULL AND u.write_attempt_id=? AND u.write_lease_expires_at=?"
        : request.kind === "multipart.part"
          ? "u.source='private' AND u.mode='multipart' AND u.state='uploading' AND u.accept_parts=1 AND u.r2_upload_id=? AND EXISTS(SELECT 1 FROM upload_parts p WHERE p.upload_id=u.id AND p.part_number=? AND p.attempt_id=? AND p.state='in_flight' AND p.lease_expires_at=?)"
          : "u.source='private' AND u.mode='multipart' AND u.state='completing' AND u.r2_upload_id=? AND u.multipart_complete_attempt=? AND u.multipart_complete_lease=?";
  return [
    authorizationAssertion(authorized),
    assertExists(
      `SELECT 1 FROM uploads u JOIN blobs b ON b.id=u.blob_id JOIN control c ON c.singleton=1
      JOIN reservations r ON r.id=u.reservation_id
      WHERE u.id=? AND u.owner_id=? AND u.credential_id=? AND u.epoch=? AND u.source=?
      AND u.selected_share_id IS ? AND u.selected_share_version IS ?
      AND b.owner_id=u.owner_id AND b.r2_key=? AND b.state='staging' AND b.ref_count=0
      AND c.epoch=u.epoch AND c.maintenance=0 AND u.cleanup_pending=0
      AND u.expires_at>=? AND u.last_progress_at>strftime('%s','now')*1000-86400000
      AND r.owner_id=u.owner_id AND r.epoch=u.epoch AND r.bytes=u.declared_size
      AND r.state='reserved' AND r.expires_at>=? AND ? >= ?
      AND NOT EXISTS(SELECT 1 FROM gc_candidates WHERE blob_id=b.id)
      AND NOT EXISTS(SELECT 1 FROM orphan_objects WHERE r2_key=b.r2_key)
      AND ${specific}`,
      [
        row.id,
        row.owner_id,
        row.credential_id,
        row.epoch,
        row.source,
        row.selected_share_id,
        row.selected_share_version,
        request.key,
        request.deadline,
        request.deadline,
        proof.expiresAt,
        request.deadline,
        ...(["upload.put", "multipart.create"].includes(request.kind)
          ? [proof.attemptId, proof.expiresAt]
          : request.kind === "multipart.part"
            ? [proof.r2UploadId!, proof.partNumber!, proof.attemptId, proof.expiresAt]
            : [proof.r2UploadId!, proof.attemptId, proof.expiresAt]),
      ],
    ),
    ...(request.kind === "multipart.complete" ? [multipartPartsProof(row)] : []),
  ];
}
