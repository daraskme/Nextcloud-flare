import { authorizationAssertion, authorizeNodes } from "../auth/authorize";
import { destinationPrincipal } from "../auth/transferScope";
import { assertExists, assertOneChange, primary, type SqlStatement } from "../db/primary";
import type { PreparedCopy } from "../services/copyPreparation";
import {
  acquireSystemMutation,
  commitSystemMutation,
  type SystemMutationSource,
} from "../services/systemMutation";
import { loadCopyJobManifest } from "./copyManifest";

export const COPY_EXECUTION_LIMITS = Object.freeze({
  wallMs: 25_000,
  ownerClaims: 2,
  invocations: 200,
  attempts: 10,
  r2Calls: 20_000,
  // Leave D1 query and memory headroom for authorization and subsequent writes.
  rangeReads: 16,
  rangeBytes: 8 * 1024 * 1024,
  streamRangeBytes: 90 * 1024 * 1024,
});
const CLOCK = "strftime('%s','now')*1000";
const checkpoint = (position: number, offset = 0) =>
  JSON.stringify({ v: 1, blob: position, offset });
export interface CopyJobClaim {
  readonly id: string;
  readonly token: string;
  readonly epoch: number;
  readonly expiresAt: number;
  readonly plan: PreparedCopy;
}
interface ClaimProof {
  readonly outboxId: string;
  readonly stop: AbortController;
  busy: boolean;
  position: number;
  offset: number;
}
const proofs = new WeakMap<CopyJobClaim, ClaimProof>();
function proof(claim: CopyJobClaim): ClaimProof {
  const value = proofs.get(claim);
  if (!value) throw new Error("invalid_copy_claim");
  return value;
}
export function checkCopyClaim(claim: CopyJobClaim): void {
  proof(claim).stop.signal.throwIfAborted();
  if (Date.now() >= claim.expiresAt) throw new Error("copy_claim_expired");
}
export function copyClaimPosition(claim: CopyJobClaim): number {
  return proof(claim).position;
}
export function copyClaimOffset(claim: CopyJobClaim): number {
  return proof(claim).offset;
}
export function advancedCopyPart(claim: CopyJobClaim, offset: number): void {
  const p = proof(claim),
    blob = claim.plan.source.blobs[p.position];
  if (!blob || !Number.isSafeInteger(offset) || offset <= p.offset || offset > blob.size)
    throw new Error("invalid_copy_checkpoint");
  p.offset = offset;
}
/** Called only after the matching, receipt-backed checkpoint batch commits. */
export function advancedCopyClaim(claim: CopyJobClaim, position: number): void {
  const p = proof(claim);
  if (position !== p.position + 1 || position > claim.plan.source.blobs.length)
    throw new Error("invalid_copy_checkpoint");
  p.position = position;
  p.offset = 0;
}

/** Current authority, using exactly the source/destination selections accepted with the job. */
export type CopyAuthorityContext = Pick<
  PreparedCopy,
  "principal" | "destination" | "destinationParentId"
> & {
  source: Pick<PreparedCopy["source"], "spaceId" | "rootId">;
  overwrite: { rootId: string } | null;
};
export async function copyAuthorityStatements(
  db: D1Database,
  plan: CopyAuthorityContext,
  witnessId?: string,
): Promise<SqlStatement[]> {
  const destination = destinationPrincipal(plan.principal, plan.destination);
  const requests: Parameters<typeof authorizeNodes>[1][number][] = [
    {
      principal: plan.principal,
      request: {
        operation: "node.read",
        spaceId: plan.source.spaceId,
        nodeId: plan.source.rootId,
        ownerOnly: !plan.principal.selected_share,
      },
    },
    {
      principal: destination,
      request: {
        operation: "node.create",
        spaceId: plan.destination.spaceId,
        parentId: plan.destinationParentId,
        ownerOnly: plan.destination.share === null,
      },
    },
  ];
  if (plan.overwrite)
    requests.push({
      principal: destination,
      request: {
        operation: "node.trash",
        spaceId: plan.destination.spaceId,
        nodeId: plan.overwrite.rootId,
        ownerOnly: plan.destination.share === null,
      },
    });
  if (witnessId && witnessId !== plan.source.rootId)
    requests.push({
      principal: plan.principal,
      request: {
        operation: "node.read",
        spaceId: plan.source.spaceId,
        nodeId: witnessId,
        ownerOnly: !plan.principal.selected_share,
      },
    });
  return (await authorizeNodes(db, requests)).map(authorizationAssertion);
}

/** Exact token, epoch, manifest and checkpoint; a JSON-reloaded claim is never a proof. */
export function copyClaimFence(claim: CopyJobClaim): SqlStatement {
  const { outboxId } = proof(claim);
  return assertExists(
    `SELECT 1 FROM job_leases l JOIN bulk_jobs j ON j.id=l.job_id
      JOIN copy_job_manifests m ON m.job_id=j.id JOIN control c ON c.singleton=1
      JOIN outbox b ON b.op_id=j.op_id AND b.payload_ref=j.id
      JOIN operations o ON o.op_id=j.op_id
    WHERE l.job_id=? AND l.claim_token=? AND l.epoch=? AND l.expires_at=? AND l.expires_at>${CLOCK}
      AND j.state='running' AND j.kind='node.copy' AND j.epoch=l.epoch AND j.owner_id=?
      AND j.checkpoint=? AND m.sha256=? AND m.expires_at>${CLOCK}
      AND j.manifest_ref='d1:copy/'||j.id AND c.epoch=j.epoch AND c.maintenance=0
      AND b.outbox_id=? AND b.kind='copy.requested' AND b.state IN ('dispatching','sent')
      AND b.epoch=j.epoch AND o.state='committed' AND o.kind='copy.enqueue' AND o.epoch=j.epoch`,
    [
      claim.id,
      claim.token,
      claim.epoch,
      claim.expiresAt,
      claim.plan.destinationOwnerId,
      checkpoint(proof(claim).position, proof(claim).offset),
      claim.plan.digest,
      outboxId,
    ],
  );
}

/** Internal executor entry. Queue delivery is connected only after transfer and cleanup exist. */
export async function claimCopyJob(
  env: SystemMutationSource,
  outboxId: string,
  deadline = Date.now() + COPY_EXECUTION_LIMITS.wallMs,
): Promise<CopyJobClaim> {
  const started = Date.now();
  if (
    !/^[A-Za-z0-9_-]{1,128}$/.test(outboxId) ||
    !Number.isSafeInteger(deadline) ||
    deadline <= started
  )
    throw new Error("invalid_copy_claim");
  const row = await primary(env.DB)
    .prepare(`SELECT j.id,j.checkpoint FROM outbox b JOIN bulk_jobs j ON j.id=b.payload_ref AND j.op_id=b.op_id
      WHERE b.outbox_id=? AND b.kind='copy.requested' AND b.state IN ('dispatching','sent')
      AND j.kind='node.copy' AND j.state IN ('pending','running')`)
    .bind(outboxId)
    .first<{ id: string; checkpoint: string | null }>();
  if (!row) throw new Error("copy_job_unavailable");
  const { plan, expiresAt } = await loadCopyJobManifest(env.DB, row.id);
  const position: number = row.checkpoint === null ? 0 : JSON.parse(row.checkpoint).blob;
  const offset: number = row.checkpoint === null ? 0 : JSON.parse(row.checkpoint).offset;
  if (
    !Number.isSafeInteger(position) ||
    position < 0 ||
    position > plan.source.blobs.length ||
    !Number.isSafeInteger(offset) ||
    offset < 0 ||
    offset > (plan.source.blobs[position]?.size ?? 0) ||
    (row.checkpoint !== null && row.checkpoint !== checkpoint(position, offset))
  )
    throw new Error("invalid_copy_checkpoint");
  const claim: CopyJobClaim = Object.freeze({
    id: row.id,
    token: crypto.randomUUID(),
    epoch: plan.principal.epoch,
    expiresAt: Math.min(expiresAt, deadline, started + COPY_EXECUTION_LIMITS.wallMs),
    plan,
  });
  proofs.set(claim, { outboxId, stop: new AbortController(), busy: false, position, offset });
  const authority = await copyAuthorityStatements(env.DB, plan);
  const admission = await acquireSystemMutation(
    env,
    plan.destinationOwnerId,
    "copy.claim",
    claim.expiresAt,
  );
  checkCopyClaim(claim);
  await commitSystemMutation(env.DB, admission, plan.destinationOwnerId, [
    ...authority,
    assertExists(
      `SELECT 1 WHERE ?1=0 OR EXISTS(SELECT 1 FROM copy_job_blobs cb JOIN copy_multipart_uploads m
      ON m.destination_blob_id=cb.destination_blob_id WHERE cb.job_id=?2 AND cb.source_blob_id=?3
        AND cb.transfer_mode='multipart' AND m.state<>'creating'
        AND ?1=(SELECT SUM(expected_size) FROM copy_multipart_parts p WHERE p.destination_blob_id=m.destination_blob_id
          AND p.part_number<=(?1+m.part_bytes-1)/m.part_bytes AND p.state='stored'))`,
      [offset, claim.id, plan.source.blobs[position]?.id ?? null],
    ),
    assertExists(
      `SELECT 1 WHERE ?=(SELECT COUNT(*) FROM
      (SELECT * FROM copy_job_blobs WHERE job_id=? ORDER BY source_blob_id LIMIT ?) cb
      JOIN blobs b ON b.id=cb.destination_blob_id JOIN blob_storage s ON s.blob_id=b.id
      LEFT JOIN copy_multipart_uploads m ON m.destination_blob_id=b.id
      WHERE cb.transfer_state='stored' AND b.state='staging' AND
        ((cb.transfer_mode='single' AND b.sha256_verified=cb.transfer_sha256)
          OR (cb.transfer_mode='multipart' AND b.sha256_verified IS NULL AND cb.transfer_sha256 IS NULL AND m.state='stored' AND m.object_etag=s.r2_etag))
        AND s.bytes=b.size AND s.removed_at IS NULL)`,
      [position, claim.id, position],
    ),
    assertExists(
      `SELECT 1 WHERE (SELECT COUNT(*) FROM bulk_jobs j JOIN job_leases l ON l.job_id=j.id
      WHERE j.owner_id=? AND j.kind='node.copy' AND j.state='running' AND l.expires_at>${CLOCK})<?`,
      [plan.destinationOwnerId, COPY_EXECUTION_LIMITS.ownerClaims],
    ),
    // An expired lease never proves an external write has ended.
    assertExists(
      `SELECT 1 WHERE NOT EXISTS(SELECT 1 FROM copy_job_blobs cb JOIN r2_write_attempts w
      ON w.r2_key='u/'||?||'/b/'||cb.destination_blob_id AND w.state='pending' WHERE cb.job_id=?)`,
      [plan.destinationOwnerId, claim.id],
    ),
    {
      sql: `INSERT INTO job_leases(job_id,claim_token,epoch,expires_at,attempt,r2_calls) VALUES(?,?,?,?,1,0)
        ON CONFLICT(job_id) DO UPDATE SET claim_token=excluded.claim_token,epoch=excluded.epoch,
          expires_at=excluded.expires_at,attempt=job_leases.attempt+1,r2_calls=0
        WHERE job_leases.expires_at<=${CLOCK} AND job_leases.epoch=excluded.epoch AND job_leases.attempt<?`,
      values: [claim.id, claim.token, claim.epoch, claim.expiresAt, COPY_EXECUTION_LIMITS.attempts],
    },
    assertOneChange,
    {
      sql: `UPDATE bulk_jobs SET state='running',checkpoint=COALESCE(checkpoint,?),
        invocation_count=invocation_count+1,updated_at=MAX(updated_at,${CLOCK})
        WHERE id=? AND state IN ('pending','running') AND (checkpoint IS NULL OR checkpoint=?)
          AND invocation_count<? AND r2_calls<?`,
      values: [
        checkpoint(position, offset),
        claim.id,
        checkpoint(position, offset),
        COPY_EXECUTION_LIMITS.invocations,
        COPY_EXECUTION_LIMITS.r2Calls,
      ],
    },
    assertOneChange,
    copyClaimFence(claim),
  ]);
  checkCopyClaim(claim);
  return claim;
}

/** Serialize reads within one claim and stop local delivery when the claim is released. */
export function beginCopyClaimRead(claim: CopyJobClaim): { signal: AbortSignal; finish(): void } {
  checkCopyClaim(claim);
  const value = proof(claim);
  if (value.busy) throw new Error("copy_claim_busy");
  value.busy = true;
  return {
    signal: value.stop.signal,
    finish: () => {
      value.busy = false;
    },
  };
}

/** Release only the execution lease, including after revocation. Pins and quota remain held. */
export async function releaseCopyJobClaim(
  env: SystemMutationSource,
  claim: CopyJobClaim,
): Promise<void> {
  proof(claim).stop.abort(new Error("copy_claim_released"));
  const admission = await acquireSystemMutation(env, claim.plan.destinationOwnerId, "copy.release");
  await commitSystemMutation(env.DB, admission, claim.plan.destinationOwnerId, [
    {
      sql: `UPDATE job_leases SET expires_at=0 WHERE job_id=? AND claim_token=? AND epoch=?
        AND EXISTS(SELECT 1 FROM control WHERE singleton=1 AND epoch=?)`,
      values: [claim.id, claim.token, claim.epoch, claim.epoch],
    },
    assertExists(
      `SELECT 1 WHERE changes()=1 OR EXISTS(SELECT 1 FROM bulk_jobs j JOIN operations o ON o.op_id=j.publish_op_id
      WHERE j.id=? AND j.epoch=? AND j.state='completed' AND o.kind='copy.publish' AND o.state='committed'
        AND json_extract(o.operands_json,'$.claimToken')=?)
      OR EXISTS(SELECT 1 FROM bulk_jobs j JOIN copy_job_manifests m ON m.job_id=j.id
        WHERE j.id=? AND j.epoch=? AND m.sha256=? AND j.state IN ('cancelled','failed') AND j.stopped_at IS NOT NULL
          AND NOT EXISTS(SELECT 1 FROM job_leases WHERE job_id=j.id))`,
      [claim.id, claim.epoch, claim.token, claim.id, claim.epoch, claim.plan.digest],
    ),
  ]);
}
