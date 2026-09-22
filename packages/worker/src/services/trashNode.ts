import {
  type AuthorizedNode,
  authorizationAssertion,
  authorizeNode,
  type Principal,
} from "../auth/authorize";
import { assertTrashLocks, lockTokenHashes } from "../auth/locks";
import { assertOpenPermit } from "../db/permits";
import { assertExists, assertOneChange, primary, type SqlStatement } from "../db/primary";
import type { Env } from "../env";
import {
  assertOperationClaim,
  claimOperation,
  digestJson,
  findOperationIntent,
  lookupOperation,
  type OperationClaim,
  operationIntent,
  operationRow,
} from "../jobs/operations";
import { commitMutationStatements, type MutationOutcome, type MutationStep } from "./fsMutation";

export const DAV_DELETE_MAX_NODES = 1_000;
export const TRASH_NODE_STEPS = 13;
type TrashAuthority = Extract<AuthorizedNode, { operation: "node.trash" }>;

export interface TrashNodeRequest {
  readonly principal: Principal;
  readonly requestId: string;
  readonly spaceId: string;
  readonly nodeId: string;
  readonly lockTokens: readonly string[];
  readonly operation?: "node.trash" | "dav.delete";
}

interface MemberRow {
  id: string;
}

function assertChanges(count: number): SqlStatement {
  return { sql: "INSERT INTO _assert(v) SELECT 1 WHERE changes()<>?", values: [count] };
}

async function liveMembers(db: D1Database, nodeId: string, spaceId: string): Promise<string[]> {
  const rows = await primary(db)
    .prepare(`WITH RECURSIVE d(id,depth,path) AS (
      SELECT id,0,'/'||id||'/' FROM nodes WHERE id=? AND space_id=? AND deleted_at IS NULL
      UNION ALL SELECT n.id,d.depth+1,d.path||n.id||'/' FROM nodes n JOIN d ON n.parent_id=d.id
        WHERE d.depth<64 AND n.space_id=? AND n.deleted_at IS NULL AND instr(d.path,'/'||n.id||'/')=0
    ) SELECT id FROM d ORDER BY id LIMIT ?`)
    .bind(nodeId, spaceId, spaceId, DAV_DELETE_MAX_NODES + 1)
    .all<MemberRow>();
  if (rows.results.length === 0) throw new Error("authorization_denied");
  if (rows.results.length > DAV_DELETE_MAX_NODES) throw new Error("dav_delete_too_large");
  return rows.results.map(({ id }) => id);
}

function trashStatements(
  claim: OperationClaim,
  authorized: TrashAuthority,
  memberCount: number,
  parentRevision: number,
  hashes: readonly string[],
): readonly SqlStatement[] {
  if (claim.intent.kind !== "dav.delete" && claim.intent.kind !== "node.trash")
    throw new Error("invalid_mutation_plan");
  if (
    claim.steps !== TRASH_NODE_STEPS ||
    memberCount < 1 ||
    memberCount > DAV_DELETE_MAX_NODES ||
    !Number.isSafeInteger(parentRevision) ||
    parentRevision < 1
  )
    throw new Error("invalid_mutation_plan");
  const op = claim.intent.id;
  const node = authorized.node;
  if (authorized.principal.kind !== "user" && authorized.principal.kind !== "app_password")
    throw new Error("invalid_mutation_plan");
  const actorId = authorized.principal.user_id;
  const clock = "strftime('%s','now')*1000";
  const membership = "SELECT node_id FROM trash_members WHERE trash_op_id=?";
  const steps: Array<MutationStep & { assertion: SqlStatement }> = [
    {
      kind: "trash_op",
      affectedId: op,
      statement: {
        sql: `INSERT INTO trash_ops(op_id,actor_id,space_id,root_node_id,state,reason,created_at,purge_after,epoch)
          VALUES(?,?,?,?,'pending',?,${clock},${clock}+3024000000,?)`,
        values: [op, actorId, node.space_id, node.id, claim.intent.kind, claim.permit.epoch],
      },
      assertion: assertOneChange,
    },
    {
      kind: "members",
      affectedId: node.id,
      statement: {
        sql: `WITH RECURSIVE d(id,depth,path) AS (
          SELECT id,0,'/'||id||'/' FROM nodes WHERE id=? AND space_id=? AND deleted_at IS NULL
          UNION ALL SELECT n.id,d.depth+1,d.path||n.id||'/' FROM nodes n JOIN d ON n.parent_id=d.id
            WHERE d.depth<64 AND n.space_id=? AND n.deleted_at IS NULL AND instr(d.path,'/'||n.id||'/')=0
        ) INSERT INTO trash_members(trash_op_id,node_id) SELECT ?,id FROM d`,
        values: [node.id, node.space_id, node.space_id, op],
      },
      assertion: assertChanges(memberCount),
    },
    {
      kind: "node",
      affectedId: node.id,
      statement: {
        sql: `UPDATE nodes SET deleted_at=${clock},deleted_op_id=?,orig_parent_id=parent_id,last_op_id=?,updated_at=MAX(updated_at,${clock})
          WHERE id IN (${membership}) AND deleted_at IS NULL`,
        values: [op, op, op],
      },
      assertion: assertChanges(memberCount),
    },
    {
      kind: "parent",
      affectedId: authorized.parentId,
      statement: {
        sql: `UPDATE nodes SET revision=revision+1,last_op_id=?,updated_at=MAX(updated_at,${clock})
          WHERE id=? AND revision=? AND deleted_at IS NULL AND kind IN ('root','folder')`,
        values: [op, authorized.parentId, parentRevision],
      },
      assertion: assertOneChange,
    },
    {
      kind: "tree",
      affectedId: node.space_id,
      statement: {
        sql: "UPDATE spaces SET tree_generation=tree_generation+1 WHERE id=? AND tree_generation=?",
        values: [node.space_id, node.tree_generation],
      },
      assertion: assertOneChange,
    },
    {
      kind: "locks",
      affectedId: node.id,
      statement: { sql: `DELETE FROM locks WHERE node_id IN (${membership})`, values: [op] },
      assertion: assertExists(
        `SELECT 1 WHERE NOT EXISTS(SELECT 1 FROM locks WHERE node_id IN (${membership}))`,
        [op],
      ),
    },
    {
      kind: "shares",
      affectedId: node.id,
      statement: {
        sql: `UPDATE shares SET disabled_at=${clock},version=version+1
          WHERE root_node_id IN (${membership}) AND disabled_at IS NULL`,
        values: [op],
      },
      assertion: assertExists(
        `SELECT 1 WHERE NOT EXISTS(SELECT 1 FROM shares WHERE root_node_id IN (${membership}) AND disabled_at IS NULL)`,
        [op],
      ),
    },
    {
      kind: "share_sessions",
      affectedId: node.id,
      statement: {
        sql: `UPDATE share_sessions SET revoked_at=${clock} WHERE revoked_at IS NULL
          AND share_id IN (SELECT id FROM shares WHERE root_node_id IN (${membership}))`,
        values: [op],
      },
      assertion: assertExists(
        `SELECT 1 WHERE NOT EXISTS(SELECT 1 FROM share_sessions WHERE revoked_at IS NULL
        AND share_id IN (SELECT id FROM shares WHERE root_node_id IN (${membership})))`,
        [op],
      ),
    },
    {
      kind: "tickets",
      affectedId: node.owner_id,
      statement: {
        sql: `UPDATE tickets SET cancelled_at=${clock} WHERE cancelled_at IS NULL
          AND target_set_id IN (SELECT id FROM target_sets WHERE owner_id=?)`,
        values: [node.owner_id],
      },
      assertion: assertExists(
        `SELECT 1 WHERE NOT EXISTS(SELECT 1 FROM tickets WHERE cancelled_at IS NULL
          AND target_set_id IN (SELECT id FROM target_sets WHERE owner_id=?))`,
        [node.owner_id],
      ),
    },
    {
      kind: "content_sessions",
      affectedId: node.owner_id,
      statement: {
        sql: `UPDATE content_sessions SET revoked_at=${clock} WHERE revoked_at IS NULL
          AND target_set_id IN (SELECT id FROM target_sets WHERE owner_id=?)`,
        values: [node.owner_id],
      },
      assertion: assertExists(
        `SELECT 1 WHERE NOT EXISTS(SELECT 1 FROM content_sessions WHERE revoked_at IS NULL
          AND target_set_id IN (SELECT id FROM target_sets WHERE owner_id=?))`,
        [node.owner_id],
      ),
    },
    {
      kind: "activity",
      affectedId: node.id,
      statement: {
        sql: `INSERT INTO activity(id,op_id,actor_id,kind,affected_id,created_at)
          VALUES(?,?,?,?,?,${clock})`,
        values: [`${op}_activity`, op, actorId, claim.intent.kind, node.id],
      },
      assertion: assertOneChange,
    },
    {
      kind: "outbox",
      affectedId: node.id,
      statement: {
        sql: `INSERT INTO outbox(outbox_id,op_id,kind,payload_ref,state,epoch,created_at,updated_at)
          VALUES(?,?,'node.trashed',?,'pending',?,${clock},${clock})`,
        values: [`${op}_event`, op, node.id, claim.permit.epoch],
      },
      assertion: assertOneChange,
    },
    {
      kind: "publish",
      affectedId: op,
      statement: {
        sql: "UPDATE trash_ops SET state='trashed' WHERE op_id=? AND state='pending'",
        values: [op],
      },
      assertion: assertOneChange,
    },
  ];
  const statements: SqlStatement[] = [
    assertOpenPermit(claim.permit),
    assertOperationClaim(claim),
    authorizationAssertion(authorized),
    assertTrashLocks(node.id, node.space_id, authorized.principal, hashes),
    assertExists("SELECT 1 WHERE NOT EXISTS(SELECT 1 FROM operation_steps WHERE op_id=?)", [op]),
  ];
  steps.forEach((step, index) => {
    statements.push(
      step.statement,
      step.assertion,
      {
        sql: "INSERT INTO operation_steps(op_id,step_no,kind,affected_id) VALUES(?,?,?,?)",
        values: [op, index + 1, step.kind, step.affectedId],
      },
      assertOneChange,
    );
  });
  statements.push(
    {
      sql: `UPDATE operations SET state='committed',result_json=?,updated_at=MAX(updated_at,${clock})
        WHERE op_id=? AND state='claimed' AND (SELECT COUNT(*) FROM operation_steps WHERE op_id=?)=expected_steps`,
      values: [JSON.stringify({ status: 204, nodeId: node.id }), op, op],
    },
    assertOneChange,
  );
  return statements;
}

export async function trashNode(
  env: Pick<Env, "DB" | "LOCKS">,
  request: TrashNodeRequest,
): Promise<MutationOutcome> {
  if (request.principal.kind !== "user" && request.principal.kind !== "app_password")
    throw new Error("authorization_denied");
  const operationKind = request.operation ?? "node.trash";
  const slotIntent = await operationIntent(
    request.principal,
    request.requestId,
    request.spaceId,
    operationKind,
    {},
    {},
  );
  const terminalSlot = await operationRow(env.DB, slotIntent.id);
  if (terminalSlot && terminalSlot.state !== "claimed") {
    let operands: Record<string, unknown>;
    try {
      operands = JSON.parse(terminalSlot.operands_json) as Record<string, unknown>;
    } catch {
      throw new Error("idempotency_conflict");
    }
    if (
      terminalSlot.principal_kind !== request.principal.kind ||
      terminalSlot.credential_id !== request.principal.credential_id ||
      terminalSlot.space_id !== request.spaceId ||
      terminalSlot.kind !== operationKind ||
      terminalSlot.expected_steps !== TRASH_NODE_STEPS ||
      operands.nodeId !== request.nodeId
    )
      throw new Error("idempotency_conflict");
    const operation = await lookupOperation(env.DB, request.principal, terminalSlot.op_id);
    if (!operation) throw new Error("authorization_denied");
    return { kind: "terminal", operation };
  }
  const initial = await authorizeNode(env.DB, request.principal, {
    operation: "node.trash",
    nodeId: request.nodeId,
    spaceId: request.spaceId,
  });
  if (initial.operation !== "node.trash") throw new Error("invalid_trash_authorization");
  const members = await liveMembers(env.DB, request.nodeId, request.spaceId);
  const intent = await operationIntent(
    request.principal,
    request.requestId,
    request.spaceId,
    operationKind,
    {
      nodeId: request.nodeId,
      memberCount: members.length,
      memberDigest: await digestJson(members),
    },
    { nodeId: request.nodeId, parentId: initial.parentId },
  );
  const existing = await findOperationIntent(env.DB, intent, TRASH_NODE_STEPS);
  if (existing && existing.state !== "claimed") {
    const operation = await lookupOperation(env.DB, request.principal, intent.id);
    if (!operation) throw new Error("authorization_denied");
    return { kind: "terminal", operation };
  }
  const lock = env.LOCKS.get(env.LOCKS.idFromName(request.spaceId));
  const permit = await lock.acquireTrash({
    requestId: intent.id,
    spaceId: request.spaceId,
    nodeId: request.nodeId,
    principal: request.principal,
    lockTokens: request.lockTokens,
  });
  let terminal = false;
  try {
    const authorized = await authorizeNode(env.DB, request.principal, {
      operation: "node.trash",
      nodeId: request.nodeId,
      spaceId: request.spaceId,
    });
    if (authorized.operation !== "node.trash" || authorized.parentId !== initial.parentId)
      throw new Error("authorization_denied");
    const currentMembers = await liveMembers(env.DB, request.nodeId, request.spaceId);
    if ((await digestJson(currentMembers)) !== (await digestJson(members)))
      throw new Error("authorization_denied");
    const claimed = await claimOperation(env.DB, intent, permit, authorized, TRASH_NODE_STEPS);
    if (claimed.kind === "terminal") {
      const operation = await lookupOperation(env.DB, request.principal, intent.id);
      if (!operation) throw new Error("authorization_denied");
      terminal = true;
      return { kind: "terminal", operation };
    }
    const parentRevision = await primary(env.DB)
      .prepare("SELECT revision FROM nodes WHERE id=? AND space_id=? AND deleted_at IS NULL")
      .bind(authorized.parentId, request.spaceId)
      .first<number>("revision");
    if (parentRevision === null) throw new Error("authorization_denied");
    const outcome = await commitMutationStatements(
      env.DB,
      claimed.claim,
      trashStatements(
        claimed.claim,
        authorized,
        currentMembers.length,
        parentRevision,
        await lockTokenHashes(request.lockTokens),
      ),
    );
    terminal = outcome.kind === "terminal";
    return outcome;
  } finally {
    if (terminal)
      try {
        await lock.release(intent.id, permit);
      } catch {
        /* Lease recovery releases it. */
      }
  }
}
