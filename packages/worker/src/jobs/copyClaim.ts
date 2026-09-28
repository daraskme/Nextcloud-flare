import { authorizationAssertion, authorizeNode } from "../auth/authorize";
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
});
const CLOCK = "strftime('%s','now')*1000";
const INITIAL_CHECKPOINT = '{"v":1,"blob":0,"offset":0}';
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

/** Current authority, using exactly the source/destination selections accepted with the job. */
export async function copyAuthorityStatements(
  db: D1Database,
  plan: PreparedCopy,
  witnessId?: string,
): Promise<SqlStatement[]> {
  const source = await authorizeNode(db, plan.principal, {
    operation: "node.read",
    spaceId: plan.source.spaceId,
    nodeId: plan.source.rootId,
    ownerOnly: !plan.principal.selected_share,
  });
  const destination = destinationPrincipal(plan.principal, plan.destination);
  const target = await authorizeNode(db, destination, {
    operation: "node.create",
    spaceId: plan.destination.spaceId,
    parentId: plan.destinationParentId,
    ownerOnly: plan.destination.share === null,
  });
  const statements = [authorizationAssertion(source), authorizationAssertion(target)];
  if (plan.overwrite)
    statements.push(
      authorizationAssertion(
        await authorizeNode(db, destination, {
          operation: "node.trash",
          spaceId: plan.destination.spaceId,
          nodeId: plan.overwrite.rootId,
          ownerOnly: plan.destination.share === null,
        }),
      ),
    );
  if (witnessId && witnessId !== plan.source.rootId)
    statements.push(
      authorizationAssertion(
        await authorizeNode(db, plan.principal, {
          operation: "node.read",
          spaceId: plan.source.spaceId,
          nodeId: witnessId,
          ownerOnly: !plan.principal.selected_share,
        }),
      ),
    );
  return statements;
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
      INITIAL_CHECKPOINT,
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
    .prepare(`SELECT j.id FROM outbox b JOIN bulk_jobs j ON j.id=b.payload_ref AND j.op_id=b.op_id
      WHERE b.outbox_id=? AND b.kind='copy.requested' AND b.state IN ('dispatching','sent')
      AND j.kind='node.copy' AND j.state IN ('pending','running')`)
    .bind(outboxId)
    .first<{ id: string }>();
  if (!row) throw new Error("copy_job_unavailable");
  const { plan, expiresAt } = await loadCopyJobManifest(env.DB, row.id);
  const claim: CopyJobClaim = Object.freeze({
    id: row.id,
    token: crypto.randomUUID(),
    epoch: plan.principal.epoch,
    expiresAt: Math.min(expiresAt, deadline, started + COPY_EXECUTION_LIMITS.wallMs),
    plan,
  });
  proofs.set(claim, { outboxId, stop: new AbortController(), busy: false });
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
        INITIAL_CHECKPOINT,
        claim.id,
        INITIAL_CHECKPOINT,
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
    assertOneChange,
  ]);
}
