import { type CopyAuthorityContext, copyAuthorityStatements } from "../jobs/copyClaim";
import { assertExists, assertOneChange, primary, type SqlStatement } from "./primary";
import type { R2WriteRequest } from "./r2Write";

export interface R2CopyProof {
  jobId: string;
  sourceBlobId: string;
  attemptId: string;
  claimToken: string;
  expiresAt: number;
}
export function validateCopyWrite(request: R2WriteRequest): void {
  const p = request.copy;
  if (
    !p ||
    request.kind !== "copy.put" ||
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
    p.expiresAt < request.deadline
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
    row.size > 8 * 1024 * 1024
  )
    throw new Error("r2_copy_unavailable");
  return [
    ...(await copyAuthorityStatements(db, plan, row.transfer_node_id)),
    assertExists(
      `SELECT 1 FROM copy_job_blobs cb JOIN bulk_jobs j ON j.id=cb.job_id
      JOIN job_leases l ON l.job_id=j.id JOIN blobs b ON b.id=cb.destination_blob_id
      JOIN copy_job_manifests m ON m.job_id=j.id JOIN control c ON c.singleton=1
      JOIN reservations r ON r.id=cb.reservation_id JOIN blob_pins pin ON pin.pin_id=cb.pin_id
      JOIN outbox o ON o.op_id=j.op_id AND o.payload_ref=j.id AND o.kind='copy.requested'
      WHERE j.id=? AND cb.source_blob_id=? AND cb.transfer_state='claimed' AND cb.transfer_attempt=?
        AND cb.transfer_claim=? AND cb.transfer_node_id=? AND l.claim_token=cb.transfer_claim AND l.epoch=j.epoch AND l.expires_at=?
        AND l.expires_at>=? AND l.expires_at>strftime('%s','now')*1000
        AND j.kind='node.copy' AND j.state='running' AND j.epoch=? AND c.epoch=j.epoch AND c.maintenance=0
        AND m.sha256=? AND m.expires_at>=l.expires_at AND o.state IN ('dispatching','sent') AND o.epoch=j.epoch
        AND b.owner_id=j.owner_id AND b.r2_key=? AND b.size=? AND b.state='staging' AND b.ref_count=0
        AND r.owner_id=b.owner_id AND r.bytes=b.size AND r.epoch=j.epoch AND r.state='reserved'
        AND r.expires_at=m.expires_at AND pin.blob_id=cb.source_blob_id AND pin.purpose='copy' AND pin.expires_at=m.expires_at
        AND NOT EXISTS(SELECT 1 FROM blob_storage WHERE blob_id=b.id)
        AND NOT EXISTS(SELECT 1 FROM gc_candidates WHERE blob_id=b.id)
        AND NOT EXISTS(SELECT 1 FROM orphan_objects WHERE r2_key=b.r2_key)
        AND NOT EXISTS(SELECT 1 FROM r2_write_attempts WHERE r2_key=b.r2_key AND state<>'not_started')`,
      [
        p.jobId,
        p.sourceBlobId,
        p.attemptId,
        p.claimToken,
        row.transfer_node_id,
        p.expiresAt,
        request.deadline,
        request.epoch,
        row.sha256,
        request.key,
        row.size,
      ],
    ),
    {
      sql: "UPDATE job_leases SET r2_calls=r2_calls+1 WHERE job_id=? AND claim_token=? AND r2_calls<2000",
      values: [p.jobId, p.claimToken],
    },
    assertOneChange,
    {
      sql: "UPDATE bulk_jobs SET r2_calls=r2_calls+1 WHERE id=? AND r2_calls<20000",
      values: [p.jobId],
    },
    assertOneChange,
  ];
}
