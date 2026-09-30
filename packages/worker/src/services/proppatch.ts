import {
  type AuthorizedNode,
  authorizationAssertion,
  authorizeNode,
  type Principal,
} from "../auth/authorize";
import { assertCreateLocks, lockTokenHashes } from "../auth/locks";
import type { ProppatchChange } from "../dav/xml";
import { assertOpenPermit } from "../db/permits";
import { assertExists, assertOneChange, type SqlStatement } from "../db/primary";
import type { Env } from "../env";
import {
  assertOperationClaim,
  claimOperation,
  findOperationIntent,
  lookupOperation,
  type OperationClaim,
  operationIntent,
} from "../jobs/operations";
import { commitMutationStatements, type MutationOutcome } from "./fsMutation";

type PropsAuthority = Extract<AuthorizedNode, { operation: "node.props.write" }>;

export interface ProppatchRequest {
  readonly principal: Principal;
  readonly idempotencyKey: string;
  readonly spaceId: string;
  readonly nodeId: string;
  readonly changes: readonly ProppatchChange[];
  readonly lockTokens: readonly string[];
}

function statements(
  claim: OperationClaim,
  authorized: PropsAuthority,
  changes: readonly ProppatchChange[],
  lockHashes: readonly string[],
): SqlStatement[] {
  const expected = changes.length + 2;
  if (
    claim.intent.kind !== "dav.proppatch" ||
    claim.steps !== expected ||
    changes.length < 1 ||
    changes.length > 100 ||
    lockHashes.length > 16 ||
    lockHashes.some((hash) => !/^[a-f0-9]{64}$/.test(hash))
  )
    throw new Error("invalid_mutation_plan");
  const result: SqlStatement[] = [
    assertOpenPermit(claim.permit),
    assertOperationClaim(claim),
    authorizationAssertion(authorized),
    assertCreateLocks(
      authorized.node.id,
      authorized.node.space_id,
      authorized.principal,
      lockHashes,
    ),
    assertExists("SELECT 1 WHERE NOT EXISTS(SELECT 1 FROM operation_steps WHERE op_id=?)", [
      claim.intent.id,
    ]),
  ];
  changes.forEach((change, index) => {
    result.push(
      change.action === "set"
        ? {
            sql: `INSERT INTO node_props(node_id,namespace,name,value_xml) VALUES(?,?,?,?)
              ON CONFLICT(node_id,namespace,name) DO UPDATE SET value_xml=excluded.value_xml`,
            values: [authorized.node.id, change.namespace, change.name, change.valueXml],
          }
        : {
            sql: "DELETE FROM node_props WHERE node_id=? AND namespace=? AND name=?",
            values: [authorized.node.id, change.namespace, change.name],
          },
      {
        sql: "INSERT INTO operation_steps(op_id,step_no,kind,affected_id) VALUES(?,?,?,?)",
        values: [claim.intent.id, index + 1, `property_${change.action}`, authorized.node.id],
      },
      assertOneChange,
    );
  });
  const clock = "strftime('%s','now')*1000";
  result.push(
    {
      sql: `UPDATE nodes SET revision=revision+1,last_op_id=?,updated_at=MAX(updated_at,${clock})
        WHERE id=? AND space_id=? AND revision=? AND deleted_at IS NULL`,
      values: [
        claim.intent.id,
        authorized.node.id,
        authorized.node.space_id,
        authorized.node.revision,
      ],
    },
    assertOneChange,
    {
      sql: "INSERT INTO operation_steps(op_id,step_no,kind,affected_id) VALUES(?,?,?,?)",
      values: [claim.intent.id, changes.length + 1, "node", authorized.node.id],
    },
    assertOneChange,
    {
      sql: `INSERT INTO activity(id,op_id,actor_id,kind,affected_id,created_at)
        VALUES(?,?,?,'dav.proppatch',?,${clock})`,
      values: [
        `${claim.intent.id}_activity`,
        claim.intent.id,
        authorized.principal.kind === "link_share" ? null : authorized.principal.user_id,
        authorized.node.id,
      ],
    },
    assertOneChange,
    {
      sql: "INSERT INTO operation_steps(op_id,step_no,kind,affected_id) VALUES(?,?,?,?)",
      values: [claim.intent.id, changes.length + 2, "activity", authorized.node.id],
    },
    assertOneChange,
    {
      sql: `UPDATE operations SET state='committed',result_json=?,updated_at=MAX(updated_at,${clock})
        WHERE op_id=? AND state='claimed' AND (SELECT COUNT(*) FROM operation_steps WHERE op_id=?)=expected_steps`,
      values: [
        JSON.stringify({ status: 207, nodeId: authorized.node.id }),
        claim.intent.id,
        claim.intent.id,
      ],
    },
    assertOneChange,
  );
  return result;
}

export async function proppatch(
  env: Pick<Env, "DB" | "LOCKS">,
  request: ProppatchRequest,
): Promise<MutationOutcome> {
  const hashes = await lockTokenHashes(request.lockTokens);
  const authorized = await authorizeNode(env.DB, request.principal, {
    operation: "node.props.write",
    nodeId: request.nodeId,
    spaceId: request.spaceId,
  });
  if (authorized.operation !== "node.props.write") throw new Error("authorization_denied");
  const intent = await operationIntent(
    request.principal,
    request.idempotencyKey,
    request.spaceId,
    "dav.proppatch",
    request.changes,
    { nodeId: request.nodeId },
  );
  const stepCount = request.changes.length + 2;
  const existing = await findOperationIntent(env.DB, intent, stepCount);
  if (existing && existing.state !== "claimed") {
    const operation = await lookupOperation(env.DB, request.principal, intent.id);
    if (!operation) throw new Error("authorization_denied");
    return { kind: "terminal", operation };
  }
  const lock = env.LOCKS.get(env.LOCKS.idFromName(request.spaceId));
  const permit = await lock.acquireNodeWrite({
    requestId: intent.id,
    spaceId: request.spaceId,
    nodeId: request.nodeId,
    principal: request.principal,
    lockTokens: request.lockTokens,
  });
  const current = await authorizeNode(env.DB, request.principal, {
    operation: "node.props.write",
    nodeId: request.nodeId,
    spaceId: request.spaceId,
  });
  if (current.operation !== "node.props.write") throw new Error("authorization_denied");
  const claimed = await claimOperation(env.DB, intent, permit, current, stepCount);
  const outcome =
    claimed.kind === "claimed"
      ? await commitMutationStatements(
          env.DB,
          claimed.claim,
          statements(claimed.claim, current, request.changes, hashes),
        )
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
