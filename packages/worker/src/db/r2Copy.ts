import {
  COPY_EXECUTION_LIMITS,
  type CopyAuthorityContext,
  copyAuthorityStatements,
} from "../jobs/copyClaim";
import { assertExists, assertOneChange, primary, type SqlStatement } from "./primary";
import type { R2WriteRequest } from "./r2Write";

export const COPY_WRITE_KINDS = [
  "copy.put",
  "copy.multipart.create",
  "copy.multipart.part",
  "copy.multipart.complete",
] as const;
export type CopyWriteKind = (typeof COPY_WRITE_KINDS)[number];
export function isCopyWrite(kind: string): kind is CopyWriteKind {
  return (COPY_WRITE_KINDS as readonly string[]).includes(kind);
}

export interface R2CopyProof {
  jobId: string;
  sourceBlobId: string;
  attemptId: string;
  claimToken: string;
  expiresAt: number;
  r2UploadId?: string;
  partNumber?: number;
}
export function validateCopyWrite(request: R2WriteRequest): void {
  const p = request.copy;
  if (
    !p ||
    !isCopyWrite(request.kind) ||
    request.gc !== undefined ||
    request.upload !== undefined ||
    request.abort !== undefined ||
    request.probe !== undefined ||
    request.backups !== undefined ||
    request.prune !== undefined ||
    !/^copy_[a-f0-9]{64}$/.test(p.jobId) ||
    !/^[A-Za-z0-9_-]{1,128}$/.test(p.sourceBlobId) ||
    !/^[a-f0-9-]{36}$/.test(p.attemptId) ||
    !/^[a-f0-9-]{36}$/.test(p.claimToken) ||
    !Number.isSafeInteger(p.expiresAt) ||
    p.expiresAt < request.deadline ||
    (["copy.multipart.part", "copy.multipart.complete"].includes(request.kind)
      ? typeof p.r2UploadId !== "string" || p.r2UploadId.length < 1 || p.r2UploadId.length > 1024
      : p.r2UploadId !== undefined) ||
    (request.kind === "copy.multipart.part"
      ? !Number.isInteger(p.partNumber) || p.partNumber! < 1 || p.partNumber! > 10000
      : p.partNumber !== undefined)
  )
    throw new Error("invalid_r2_write");
}

/** Reauthorize from bounded durable identity rows; never load an 8 MiB manifest per native grant. */
export async function copyWriteProof(
  db: D1Database,
  request: R2WriteRequest,
): Promise<SqlStatement[]> {
  const p = request.copy!;
  const row = await primary(db)
    .prepare(`SELECT j.grant_snapshot,j.epoch,j.owner_id,j.credential_id,
      o.space_id,o.operands_json,o.principal_id,m.sha256,b.size,cb.transfer_node_id
    FROM copy_job_blobs cb JOIN bulk_jobs j ON j.id=cb.job_id JOIN copy_job_manifests m ON m.job_id=j.id
      JOIN operations o ON o.op_id=j.op_id JOIN blobs b ON b.id=cb.source_blob_id
    WHERE cb.job_id=? AND cb.source_blob_id=? AND o.state='committed' AND o.kind='copy.enqueue'
      AND o.principal_kind='user' AND o.epoch=j.epoch AND o.credential_id=j.credential_id`)
    .bind(p.jobId, p.sourceBlobId)
    .first<{
      grant_snapshot: string;
      epoch: number;
      owner_id: string;
      credential_id: string;
      space_id: string;
      operands_json: string;
      principal_id: string;
      sha256: string;
      size: number;
      transfer_node_id: string | null;
    }>();
  if (
    !row ||
    row.epoch !== request.epoch ||
    row.owner_id !== request.ownerId ||
    !row.transfer_node_id
  )
    throw new Error("r2_copy_unavailable");
  const identity = JSON.parse(row.grant_snapshot) as Pick<
    CopyAuthorityContext,
    "principal" | "destination"
  >;
  const operands = JSON.parse(row.operands_json);
  const plan: CopyAuthorityContext = {
    ...identity,
    source: { spaceId: row.space_id, rootId: operands.sourceNodeId },
    destinationParentId: operands.parentId,
    overwrite: operands.overwriteTargetId ? { rootId: operands.overwriteTargetId } : null,
  };
  if (
    plan.principal.kind !== "user" ||
    plan.principal.user_id !== row.principal_id ||
    plan.principal.credential_id !== row.credential_id ||
    plan.principal.epoch !== request.epoch ||
    (request.kind === "copy.put" && row.size > 8 * 1024 * 1024)
  )
    throw new Error("r2_copy_unavailable");
  const specific =
    request.kind === "copy.put"
      ? "cb.transfer_mode='single' AND cb.transfer_attempt=? AND cb.transfer_claim=?"
      : request.kind === "copy.multipart.create"
        ? "cb.transfer_mode='multipart' AND EXISTS(SELECT 1 FROM copy_multipart_uploads m WHERE m.destination_blob_id=b.id AND m.state='creating' AND m.init_attempt=? AND m.init_claim=?)"
        : request.kind === "copy.multipart.part"
          ? "cb.transfer_mode='multipart' AND EXISTS(SELECT 1 FROM copy_multipart_uploads m JOIN copy_multipart_parts p ON p.destination_blob_id=m.destination_blob_id WHERE m.destination_blob_id=b.id AND m.state='uploading' AND m.r2_upload_id=? AND p.part_number=? AND p.attempt_id=? AND p.claim_token=? AND p.state='claimed')"
          : "cb.transfer_mode='multipart' AND EXISTS(SELECT 1 FROM copy_multipart_uploads m WHERE m.destination_blob_id=b.id AND m.state='completing' AND m.r2_upload_id=? AND m.complete_attempt=? AND m.complete_claim=?)";
  return [
    ...(await copyAuthorityStatements(db, plan, row.transfer_node_id)),
    assertExists(
      `SELECT 1 FROM copy_job_blobs cb JOIN bulk_jobs j ON j.id=cb.job_id
      JOIN job_leases l ON l.job_id=j.id JOIN blobs b ON b.id=cb.destination_blob_id
      JOIN copy_job_manifests m ON m.job_id=j.id JOIN control c ON c.singleton=1
      JOIN reservations r ON r.id=cb.reservation_id JOIN blob_pins pin ON pin.pin_id=cb.pin_id
      JOIN outbox o ON o.op_id=j.op_id AND o.payload_ref=j.id AND o.kind='copy.requested'
      WHERE j.id=? AND cb.source_blob_id=? AND cb.transfer_state='claimed'
        AND l.claim_token=? AND cb.transfer_node_id=? AND l.epoch=j.epoch AND l.expires_at=?
        AND l.expires_at>=? AND l.expires_at>strftime('%s','now')*1000
        AND j.kind='node.copy' AND j.state='running' AND j.epoch=? AND c.epoch=j.epoch AND c.maintenance=0
        AND m.sha256=? AND m.expires_at>=l.expires_at AND o.state IN ('dispatching','sent') AND o.epoch=j.epoch
        AND b.owner_id=j.owner_id AND b.r2_key=? AND b.size=? AND b.state='staging' AND b.ref_count=0
        AND r.owner_id=b.owner_id AND r.bytes=b.size AND r.epoch=j.epoch AND r.state='reserved'
        AND r.expires_at=m.expires_at AND pin.blob_id=cb.source_blob_id AND pin.purpose='copy' AND pin.expires_at=m.expires_at
        AND NOT EXISTS(SELECT 1 FROM blob_storage WHERE blob_id=b.id)
        AND NOT EXISTS(SELECT 1 FROM gc_candidates WHERE blob_id=b.id)
        AND NOT EXISTS(SELECT 1 FROM orphan_objects WHERE r2_key=b.r2_key)
        AND NOT EXISTS(SELECT 1 FROM r2_write_attempts WHERE r2_key=b.r2_key AND ${request.kind === "copy.put" || request.kind === "copy.multipart.create" ? "state<>'not_started'" : "state='pending'"})
        AND ${specific}`,
      [
        p.jobId,
        p.sourceBlobId,
        p.claimToken,
        row.transfer_node_id,
        p.expiresAt,
        request.deadline,
        request.epoch,
        row.sha256,
        request.key,
        row.size,
        ...(["copy.put", "copy.multipart.create"].includes(request.kind)
          ? [p.attemptId, p.claimToken]
          : request.kind === "copy.multipart.part"
            ? [p.r2UploadId!, p.partNumber!, p.attemptId, p.claimToken]
            : [p.r2UploadId!, p.attemptId, p.claimToken]),
      ],
    ),
    ...(request.kind === "copy.multipart.complete" ? [copyMultipartPartsProof(request.key)] : []),
    {
      sql: "UPDATE job_leases SET r2_calls=r2_calls+1 WHERE job_id=? AND claim_token=? AND r2_calls<?",
      values: [p.jobId, p.claimToken, COPY_EXECUTION_LIMITS.invocationR2Calls],
    },
    assertOneChange,
    {
      sql: "UPDATE bulk_jobs SET r2_calls=r2_calls+1 WHERE id=? AND r2_calls<20000",
      values: [p.jobId],
    },
    assertOneChange,
  ];
}

// The explicit non-not_started predicate enables the partial unique index. A key-history
// scan per part would make completion quadratic in the number of uploaded parts.
export function copyMultipartPartsProof(key: string): SqlStatement {
  return assertExists(
    `SELECT 1 FROM blobs b JOIN copy_multipart_uploads m ON m.destination_blob_id=b.id
    JOIN copy_job_blobs cb ON cb.destination_blob_id=b.id
    WHERE b.r2_key=? AND (SELECT COUNT(*) FROM copy_multipart_parts WHERE destination_blob_id=b.id)=m.part_count
      AND (SELECT SUM(expected_size) FROM copy_multipart_parts WHERE destination_blob_id=b.id)=b.size
      AND NOT EXISTS(SELECT 1 FROM copy_multipart_parts p WHERE p.destination_blob_id=b.id AND (
        p.state<>'stored' OR p.part_number>m.part_count OR p.expected_size<>MIN(m.part_bytes,b.size-(p.part_number-1)*m.part_bytes)
        OR NOT EXISTS(SELECT 1 FROM r2_write_attempts w INDEXED BY r2_write_source
          WHERE w.kind='copy.multipart.part' AND w.r2_key=b.r2_key
          AND w.source_ref=json_array(cb.job_id,cb.source_blob_id,p.attempt_id)
          AND w.state='succeeded' AND w.state<>'not_started')))`,
    [key],
  );
}
