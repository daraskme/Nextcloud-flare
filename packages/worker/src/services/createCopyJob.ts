import { portableName } from "@next-cloud-flare/shared/names";
import { authorizeNode } from "../auth/authorize";
import { assertCreateLocks, assertTrashLocks, lockTokenHashes } from "../auth/locks";
import { freezePrincipal, principalSelection } from "../auth/selectedShare";
import { destinationPrincipal, transferDestination } from "../auth/transferScope";
import { assertOpenPermit } from "../db/permits";
import { assertOneChange, type SqlStatement } from "../db/primary";
import type { Env } from "../env";
import {
  COPY_JOB_STEPS,
  copyJobHoldStatements,
  copyJobId,
  copyJobManifestStatements,
} from "../jobs/copyManifest";
import {
  assertOperationClaim,
  claimOperation,
  findOperationIntent,
  lookupOperation,
  operationIntent,
} from "../jobs/operations";
import {
  type CopyPreparationInput,
  prepareCrossOwnerCopy,
  reservePreparedCopyStatements,
} from "./copyPreparation";
import { commitMutationStatements, type MutationOutcome } from "./fsMutation";

export interface CreateCopyJobRequest extends CopyPreparationInput {
  readonly requestId: string;
  readonly lockTokens: readonly string[];
}
/** Internal async acceptance. HTTP is enabled only once transfer/cleanup are connected. */
export async function createCopyJob(
  env: Pick<Env, "DB" | "LOCKS">,
  input: CreateCopyJobRequest,
): Promise<MutationOutcome> {
  input = {
    ...input,
    principal: freezePrincipal(input.principal),
    destination: transferDestination(input.destination)!,
    lockTokens: [...input.lockTokens],
  };
  if (
    input.principal.kind !== "user" ||
    !input.destination ||
    input.destination.spaceId === input.sourceSpaceId
  )
    throw new Error("cross_owner_copy_required");
  const principal = input.principal,
    destination = input.destination,
    name = portableName(input.name);
  const hashes = await lockTokenHashes(input.lockTokens);
  const operands = {
    sourceNodeId: input.sourceNodeId,
    parentId: input.destinationParentId,
    name: name.name,
    depth: input.depth,
    overwriteTargetId: input.overwriteTargetId ?? null,
    lockHashes: hashes,
  };
  const intent = await operationIntent(
    principal,
    input.requestId,
    input.sourceSpaceId,
    "copy.enqueue",
    operands,
    {
      sourceNodeId: input.sourceNodeId,
      parentId: input.destinationParentId,
      name: name.name,
      depth: input.depth,
      ...(input.overwriteTargetId ? { overwriteTargetId: input.overwriteTargetId } : {}),
    },
    destination,
  );
  const existing = await findOperationIntent(env.DB, intent, COPY_JOB_STEPS);
  if (existing && existing.state !== "claimed") {
    const operation = await lookupOperation(env.DB, principal, intent.id);
    if (!operation) throw new Error("authorization_denied");
    return { kind: "terminal", operation };
  }
  const plan = await prepareCrossOwnerCopy(env.DB, input),
    id = copyJobId(intent.id);
  const lock = env.LOCKS.get(env.LOCKS.idFromName(input.sourceSpaceId));
  const permit = await lock.acquireCopy({
    requestId: intent.id,
    principal,
    spaceId: input.sourceSpaceId,
    sourceNodeId: input.sourceNodeId,
    parentId: input.destinationParentId,
    destination,
    ...(input.overwriteTargetId ? { overwriteTargetId: input.overwriteTargetId } : {}),
    lockTokens: input.lockTokens,
    operation: "copy.enqueue",
  });
  let terminal = false;
  try {
    const targetPrincipal = destinationPrincipal(principal, destination);
    const sourceProof = await authorizeNode(env.DB, principal, {
      operation: "node.read",
      nodeId: input.sourceNodeId,
      spaceId: input.sourceSpaceId,
      ownerOnly: !principalSelection(principal),
    });
    const destinationProof = await authorizeNode(env.DB, targetPrincipal, {
      operation: "node.create",
      parentId: input.destinationParentId,
      spaceId: destination.spaceId,
      ownerOnly: !destination.share,
    });
    const claimed = await claimOperation(
      env.DB,
      intent,
      permit,
      sourceProof,
      COPY_JOB_STEPS,
      destinationProof,
    );
    if (claimed.kind === "terminal") {
      const operation = await lookupOperation(env.DB, principal, intent.id);
      if (!operation) throw new Error("authorization_denied");
      terminal = true;
      return { kind: "terminal", operation };
    }
    const expiresAt = Math.floor(Date.now() / 1000) * 1000 + 86400000;
    const statements: SqlStatement[] = [
      assertOpenPermit(permit),
      assertOperationClaim(claimed.claim),
      assertCreateLocks(input.destinationParentId, destination.spaceId, targetPrincipal, hashes),
      ...(input.overwriteTargetId
        ? [assertTrashLocks(input.overwriteTargetId, destination.spaceId, targetPrincipal, hashes)]
        : []),
      ...copyJobManifestStatements(plan, intent.id, expiresAt),
      ...reservePreparedCopyStatements(plan, id, expiresAt),
      ...copyJobHoldStatements(plan, intent.id),
      {
        sql: `INSERT INTO outbox(outbox_id,op_id,kind,payload_ref,state,epoch,created_at,updated_at)
          VALUES(?,?,'copy.requested',?,'pending',?,strftime('%s','now')*1000,strftime('%s','now')*1000)`,
        values: [intent.id + "_copy", intent.id, id, principal.epoch],
      },
    ];
    ["copy_job", "copy_manifest", "copy_holds", "copy_outbox"].forEach((kind, i) =>
      statements.push({
        sql: "INSERT INTO operation_steps(op_id,step_no,kind,affected_id) VALUES(?,?,?,?)",
        values: [intent.id, i + 1, kind, id],
      }),
    );
    statements.push(
      {
        sql: `UPDATE operations SET state='committed',result_json=?,updated_at=MAX(updated_at,strftime('%s','now')*1000)
      WHERE op_id=? AND state='claimed' AND (SELECT COUNT(*) FROM operation_steps WHERE op_id=?)=expected_steps`,
        values: [JSON.stringify({ status: 202, jobId: id }), intent.id, intent.id],
      },
      assertOneChange,
    );
    const outcome = await commitMutationStatements(env.DB, claimed.claim, statements);
    terminal = outcome.kind === "terminal";
    return outcome;
  } finally {
    if (terminal)
      try {
        await lock.release(intent.id, permit);
      } catch {
        /* lease recovery */
      }
  }
}
