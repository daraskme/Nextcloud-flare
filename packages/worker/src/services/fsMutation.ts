import type { AuthorizedNode } from "../auth/authorize";
import { assertCreateLocks } from "../auth/locks";
import { classifyBatchFailure, reconcileCommit } from "../db/outcome";
import { assertOpenPermit } from "../db/permits";
import { assertExists, assertOneChange, atomicBatch, type SqlStatement } from "../db/primary";
import {
  assertOperationClaim,
  lookupOperation,
  type OperationClaim,
  type VisibleOperation,
  validateClaimAuthorization,
} from "../jobs/operations";

export interface MutationStep {
  readonly kind: string;
  readonly affectedId: string;
  readonly statement: SqlStatement;
}
export interface MutationPlan {
  readonly claim: OperationClaim;
  readonly authorized: Extract<AuthorizedNode, { operation: "node.create" }>;
  readonly lockHashes: readonly string[];
  readonly steps: readonly MutationStep[];
  readonly result: { readonly status: 201; readonly nodeId: string };
}
export type MutationOutcome =
  | { kind: "terminal"; operation: VisibleOperation }
  | { kind: "commit_unknown"; operationId: string };

/** Trusted server-generated steps only; every mandatory write and its marker are asserted in SQL. */
export function mutationStatements(plan: MutationPlan): SqlStatement[] {
  const { claim, authorized } = plan;
  const authority = validateClaimAuthorization(claim.intent, claim.permit, authorized, claim.steps);
  if (
    plan.steps.length !== claim.steps ||
    new Set(plan.steps.map((step) => step.kind)).size !== claim.steps ||
    plan.steps.some((step) => !/^[a-z_]{1,64}$/.test(step.kind)) ||
    plan.result.status !== 201 ||
    !plan.result.nodeId ||
    plan.result.nodeId.length > 128 ||
    plan.lockHashes.length > 16 ||
    plan.lockHashes.some((hash) => !/^[a-f0-9]{64}$/.test(hash))
  )
    throw new Error("invalid_mutation_plan");
  const statements: SqlStatement[] = [
    assertOpenPermit(claim.permit),
    assertOperationClaim(claim),
    authority,
    assertCreateLocks(
      authorized.parent.id,
      authorized.spaceId,
      authorized.principal,
      plan.lockHashes,
    ),
    assertExists("SELECT 1 WHERE NOT EXISTS(SELECT 1 FROM operation_steps WHERE op_id=?)", [
      claim.intent.id,
    ]),
  ];
  plan.steps.forEach((step, index) => {
    statements.push(
      step.statement,
      assertOneChange,
      {
        sql: "INSERT INTO operation_steps(op_id,step_no,kind,affected_id) VALUES(?,?,?,?)",
        values: [claim.intent.id, index + 1, step.kind, step.affectedId],
      },
      assertOneChange,
    );
  });
  statements.push(
    {
      sql: `UPDATE operations SET state='committed',result_json=?,updated_at=MAX(updated_at,strftime('%s','now')*1000)
      WHERE op_id=? AND state='claimed' AND (SELECT COUNT(*) FROM operation_steps WHERE op_id=?)=expected_steps`,
      values: [JSON.stringify(plan.result), claim.intent.id, claim.intent.id],
    },
    assertOneChange,
  );
  return statements;
}

/** Bounded primary reconciliation always rechecks the initiating credential and current operands. */
export async function reconcileMutation(
  db: D1Database,
  claim: OperationClaim,
): Promise<MutationOutcome> {
  const reconciled = await reconcileCommit(async () => {
    const visible = await lookupOperation(db, claim.intent.principal, claim.intent.id);
    return visible
      ? { state: visible.state, error_code: visible.errorCode, result_json: null, visible }
      : null;
  });
  return reconciled.kind === "terminal"
    ? { kind: "terminal", operation: reconciled.operation.visible }
    : { kind: "commit_unknown", operationId: claim.intent.id };
}

export async function fsMutation(db: D1Database, plan: MutationPlan): Promise<MutationOutcome> {
  // Compile before dispatch. Invalid server plans cannot leave a partially executed batch.
  const statements = mutationStatements(plan);
  return commitMutationStatements(db, plan.claim, statements);
}

/** Shared terminal reconciliation for namespace mutation plans. */
export async function commitMutationStatements(
  db: D1Database,
  claim: OperationClaim,
  statements: readonly SqlStatement[],
): Promise<MutationOutcome> {
  try {
    await atomicBatch(db, statements);
  } catch (error) {
    if (classifyBatchFailure(error) === "rolled_back") {
      const code =
        error instanceof Error &&
        error.message.includes("UNIQUE constraint failed: nodes.parent_id, nodes.name_ci")
          ? "name_conflict"
          : "mutation_rejected";
      try {
        await atomicBatch(db, [
          assertOpenPermit(claim.permit),
          assertOperationClaim(claim),
          {
            sql: "UPDATE operations SET state='failed',error_code=?,updated_at=MAX(updated_at,strftime('%s','now')*1000) WHERE op_id=? AND state='claimed'",
            values: [code, claim.intent.id],
          },
          assertOneChange,
        ]);
      } catch {
        /* Another commit/revoke may have won. Reconcile without compensating namespace writes. */
      }
    }
    // Transport failure is never sufficient evidence for a failed-state write.
  }
  return reconcileMutation(db, claim);
}
