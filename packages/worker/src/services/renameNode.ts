import { portableName, searchName } from "@next-cloud-flare/shared/names";
import {
  type AuthorizedNode,
  authorizationAssertion,
  authorizeNode,
  type Principal,
} from "../auth/authorize";
import { assertCreateLocks, lockTokenHashes } from "../auth/locks";
import { assertOpenPermit } from "../db/permits";
import { assertExists, assertOneChange, primary, type SqlStatement } from "../db/primary";
import type { Env } from "../env";
import {
  assertOperationClaim,
  claimOperation,
  findOperationIntent,
  lookupOperation,
  type OperationClaim,
  operationIntent,
} from "../jobs/operations";
import { commitMutationStatements, type MutationOutcome, type MutationStep } from "./fsMutation";

export const RENAME_NODE_STEPS = 8;
type RenameAuthority = Extract<AuthorizedNode, { operation: "node.rename" }>;

export interface RenameNodeRequest {
  readonly principal: Principal;
  readonly idempotencyKey: string;
  readonly spaceId: string;
  readonly nodeId: string;
  readonly name: string;
  readonly lockTokens: readonly string[];
}

export interface RenamePlan {
  readonly claim: OperationClaim;
  readonly authorized: RenameAuthority;
  readonly parentRevision: number;
  readonly lockHashes: readonly string[];
  readonly steps: readonly MutationStep[];
  readonly result: { readonly status: 200; readonly nodeId: string };
}

export function renameMutationPlan(
  claim: OperationClaim,
  authorized: RenameAuthority,
  parentRevision: number,
  inputName: string,
  lockHashes: readonly string[],
): RenamePlan {
  const name = portableName(inputName);
  const search = searchName(name.name);
  const op = claim.intent.id;
  const node = authorized.node;
  const parentId = authorized.parentId;
  const clock = "strftime('%s','now')*1000";
  const steps: MutationStep[] = [
    {
      kind: "node",
      affectedId: node.id,
      statement: {
        sql: `UPDATE nodes SET name=?,name_ci=?,hidden=?,revision=revision+1,
          last_op_id=?,updated_at=MAX(updated_at,${clock})
          WHERE id=? AND parent_id=? AND revision=? AND deleted_at IS NULL AND kind<>'root'`,
        values: [name.name, name.nameCi, name.hidden ? 1 : 0, op, node.id, parentId, node.revision],
      },
    },
    {
      kind: "parent",
      affectedId: parentId,
      statement: {
        sql: `UPDATE nodes SET revision=revision+1,last_op_id=?,updated_at=MAX(updated_at,${clock})
          WHERE id=? AND revision=? AND deleted_at IS NULL AND kind IN ('root','folder')`,
        values: [op, parentId, parentRevision],
      },
    },
    {
      kind: "tree",
      affectedId: node.space_id,
      statement: {
        sql: "UPDATE spaces SET tree_generation=tree_generation+1 WHERE id=? AND tree_generation=?",
        values: [node.space_id, node.tree_generation],
      },
    },
    {
      kind: "search_fts_delete",
      affectedId: node.id,
      statement: {
        sql: `INSERT INTO search_fts(search_fts,rowid,text_norm,tokens)
          SELECT 'delete',rowid,text_norm,tokens FROM search_index WHERE node_id=?`,
        values: [node.id],
      },
    },
    {
      kind: "search_index",
      affectedId: node.id,
      statement: {
        sql: `UPDATE search_index SET text_norm=?,tokens=?,normalization_version=?,revision=?
          WHERE node_id=? AND revision=? AND space_id=?`,
        values: [
          search.textNorm,
          search.tokens,
          search.version,
          node.revision + 1,
          node.id,
          node.revision,
          node.space_id,
        ],
      },
    },
    {
      kind: "search_fts_insert",
      affectedId: node.id,
      statement: {
        sql: "INSERT INTO search_fts(rowid,text_norm,tokens) SELECT rowid,text_norm,tokens FROM search_index WHERE node_id=?",
        values: [node.id],
      },
    },
    {
      kind: "activity",
      affectedId: node.id,
      statement: {
        sql: `INSERT INTO activity(id,op_id,actor_id,kind,affected_id,created_at)
          VALUES(?,?,?,'node.rename',?,${clock})`,
        values: [
          `${op}_activity`,
          op,
          authorized.principal.kind === "link_share" ? null : authorized.principal.user_id,
          node.id,
        ],
      },
    },
    {
      kind: "outbox",
      affectedId: node.id,
      statement: {
        sql: `INSERT INTO outbox(outbox_id,op_id,kind,payload_ref,state,epoch,created_at,updated_at)
          VALUES(?,?,'node.renamed',?,'pending',?,${clock},${clock})`,
        values: [`${op}_event`, op, node.id, claim.permit.epoch],
      },
    },
  ];
  return {
    claim,
    authorized,
    parentRevision,
    lockHashes,
    steps,
    result: { status: 200, nodeId: node.id },
  };
}

export function renameMutationStatements(plan: RenamePlan): SqlStatement[] {
  const { claim, authorized } = plan;
  const authority = authorizationAssertion(authorized);
  if (
    claim.intent.kind !== "node.rename" ||
    plan.steps.length !== RENAME_NODE_STEPS ||
    claim.steps !== RENAME_NODE_STEPS ||
    new Set(plan.steps.map((step) => step.kind)).size !== RENAME_NODE_STEPS ||
    !Number.isSafeInteger(plan.parentRevision) ||
    plan.parentRevision < 1 ||
    plan.result.status !== 200 ||
    plan.result.nodeId !== authorized.node.id ||
    plan.lockHashes.length > 16 ||
    plan.lockHashes.some((hash) => !/^[a-f0-9]{64}$/.test(hash))
  )
    throw new Error("invalid_mutation_plan");
  const statements: SqlStatement[] = [
    assertOpenPermit(claim.permit),
    assertOperationClaim(claim),
    authority,
    assertCreateLocks(
      authorized.node.id,
      authorized.node.space_id,
      authorized.principal,
      plan.lockHashes,
    ),
    assertCreateLocks(
      authorized.parentId,
      authorized.node.space_id,
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

export async function renameNode(
  env: Pick<Env, "DB" | "LOCKS">,
  request: RenameNodeRequest,
): Promise<MutationOutcome> {
  const name = portableName(request.name);
  const hashes = await lockTokenHashes(request.lockTokens);
  const authorized = await authorizeNode(env.DB, request.principal, {
    operation: "node.rename",
    nodeId: request.nodeId,
    spaceId: request.spaceId,
  });
  if (authorized.operation !== "node.rename") throw new Error("invalid_rename_authorization");
  const intent = await operationIntent(
    request.principal,
    request.idempotencyKey,
    request.spaceId,
    "node.rename",
    { nodeId: request.nodeId, name: name.name },
    { nodeId: request.nodeId, parentId: authorized.parentId },
  );
  const existing = await findOperationIntent(env.DB, intent, RENAME_NODE_STEPS);
  if (existing && existing.state !== "claimed") {
    const operation = await lookupOperation(env.DB, request.principal, intent.id);
    if (!operation) throw new Error("authorization_denied");
    return { kind: "terminal", operation };
  }
  const lock = env.LOCKS.get(env.LOCKS.idFromName(request.spaceId));
  const permit = await lock.acquireRename({
    requestId: intent.id,
    spaceId: request.spaceId,
    nodeId: request.nodeId,
    principal: request.principal,
    lockTokens: request.lockTokens,
  });
  const current = await authorizeNode(env.DB, request.principal, {
    operation: "node.rename",
    nodeId: request.nodeId,
    spaceId: request.spaceId,
  });
  if (current.operation !== "node.rename" || current.parentId !== authorized.parentId)
    throw new Error("authorization_denied");
  const claimed = await claimOperation(env.DB, intent, permit, current, RENAME_NODE_STEPS);
  const outcome =
    claimed.kind === "claimed"
      ? await (async () => {
          const parent = await primary(env.DB)
            .prepare("SELECT revision FROM nodes WHERE id=? AND space_id=? AND deleted_at IS NULL")
            .bind(current.parentId, request.spaceId)
            .first<number>("revision");
          if (parent === null) throw new Error("authorization_denied");
          const plan = renameMutationPlan(claimed.claim, current, parent, name.name, hashes);
          return commitMutationStatements(env.DB, claimed.claim, renameMutationStatements(plan));
        })()
      : await (async (): Promise<MutationOutcome> => {
          const operation = await lookupOperation(env.DB, request.principal, intent.id);
          if (!operation) throw new Error("authorization_denied");
          return { kind: "terminal", operation };
        })();
  if (outcome.kind === "terminal") {
    try {
      await lock.release(intent.id, permit);
    } catch {
      /* Lease recovery releases a permit when the release response is lost. */
    }
  }
  return outcome;
}
