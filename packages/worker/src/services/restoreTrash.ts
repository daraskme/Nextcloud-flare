import { portableName, searchName } from "@next-cloud-flare/shared/names";
import { authorizationAssertion, authorizeNode, type Principal } from "../auth/authorize";
import { assertCreateLocks, lockTokenHashes } from "../auth/locks";
import { assertOpenPermit } from "../db/permits";
import { assertExists, assertOneChange, primary, type SqlStatement } from "../db/primary";
import { assertRestorePause, type RestorePause } from "../db/restorePause";
import { CONTROL_NAME } from "../do/ControlDO";
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
import { commitMutationStatements, type MutationOutcome } from "./fsMutation";

const ID = /^[A-Za-z0-9_-]{1,128}$/;
export const RESTORE_TRASH_BASE_STEPS = 10;
type UserPrincipal = {
  readonly kind: "user";
  readonly user_id: string;
  readonly credential_id: string;
  readonly epoch: number;
};

export interface RestoreTrashRequest {
  readonly principal: Principal;
  readonly requestId: string;
  readonly spaceId: string;
  readonly trashOpId: string;
  readonly destinationParentId: string;
  readonly lockTokens: readonly string[];
}

interface TrashSnapshot {
  rootId: string;
  name: string;
  memberCount: number;
  memberDigest: string;
  levels: readonly { depth: number; count: number }[];
}

async function snapshot(
  db: D1Database,
  principal: UserPrincipal,
  spaceId: string,
  trashOpId: string,
): Promise<TrashSnapshot> {
  const row = await primary(db)
    .prepare(`SELECT t.root_node_id AS rootId,n.name,
      (SELECT COUNT(*) FROM trash_members WHERE trash_op_id=t.op_id) AS memberCount
      FROM trash_ops t JOIN nodes n ON n.id=t.root_node_id AND n.space_id=t.space_id
      WHERE t.op_id=? AND t.space_id=? AND t.actor_id=? AND t.state='trashed'
        AND n.deleted_op_id=t.op_id AND n.deleted_at IS NOT NULL`)
    .bind(trashOpId, spaceId, principal.user_id)
    .first<{ rootId: string; name: string; memberCount: number }>();
  if (!row || row.memberCount < 1 || row.memberCount > 1_000)
    throw new Error("authorization_denied");
  const members = await primary(db)
    .prepare(`WITH RECURSIVE d(id,depth,path) AS (
      SELECT n.id,0,'/'||n.id||'/' FROM nodes n WHERE n.id=? AND n.space_id=?
        AND n.deleted_op_id=? AND n.deleted_at IS NOT NULL
      UNION ALL SELECT n.id,d.depth+1,d.path||n.id||'/' FROM nodes n JOIN d ON n.parent_id=d.id
        JOIN trash_members tm ON tm.node_id=n.id AND tm.trash_op_id=?
        WHERE d.depth<64 AND n.space_id=? AND n.deleted_op_id=? AND n.deleted_at IS NOT NULL
          AND instr(d.path,'/'||n.id||'/')=0
    ) SELECT id,depth FROM d ORDER BY id LIMIT 1001`)
    .bind(row.rootId, spaceId, trashOpId, trashOpId, spaceId, trashOpId)
    .all<{ id: string; depth: number }>();
  if (members.results.length !== row.memberCount) throw new Error("authorization_denied");
  const counts = new Map<number, number>();
  for (const member of members.results)
    if (member.depth > 0) counts.set(member.depth, (counts.get(member.depth) ?? 0) + 1);
  return {
    ...row,
    memberDigest: await digestJson(members.results),
    levels: [...counts]
      .map(([depth, count]) => ({ depth, count }))
      .sort((left, right) => left.depth - right.depth),
  };
}

function restoredCandidate(original: string, suffix: string) {
  const scalars = [...original];
  while (scalars.length) {
    try {
      return portableName(`${scalars.join("")}${suffix}`);
    } catch (error) {
      if (!(error instanceof Error) || error.message !== "name_too_long") throw error;
      scalars.pop();
    }
  }
  return portableName(`restored${suffix}`);
}

async function availableName(db: D1Database, parentId: string, original: string) {
  const candidates = [portableName(original)];
  for (let index = 1; index <= 99; index++)
    candidates.push(restoredCandidate(original, ` (restored ${index})`));
  for (let start = 0; start < candidates.length; start += 49) {
    const group = candidates.slice(start, start + 49);
    const rows = await primary(db)
      .prepare(
        `SELECT name_ci FROM nodes WHERE parent_id=? AND deleted_at IS NULL AND name_ci IN (${group.map(() => "?").join(",")})`,
      )
      .bind(parentId, ...group.map(({ nameCi }) => nameCi))
      .all<{ name_ci: string }>();
    const used = new Set(rows.results.map(({ name_ci }) => name_ci));
    const candidate = group.find(({ nameCi }) => !used.has(nameCi));
    if (candidate) return candidate;
  }
  throw new Error("name_conflict");
}

function restoreGuard(claim: OperationClaim, rootId: string, memberCount: number): SqlStatement {
  if (claim.intent.principal.kind !== "user" || !("user_id" in claim.intent.principal))
    throw new Error("invalid_mutation_plan");
  const operands = JSON.parse(claim.intent.operands) as { trashOpId?: unknown };
  if (typeof operands.trashOpId !== "string") throw new Error("invalid_mutation_plan");
  return assertExists(
    `SELECT 1 FROM trash_ops t JOIN nodes n ON n.id=t.root_node_id AND n.space_id=t.space_id
      WHERE t.op_id=? AND t.space_id=? AND t.root_node_id=? AND t.actor_id=? AND t.state='trashed'
        AND n.deleted_op_id=t.op_id AND n.deleted_at IS NOT NULL
        AND (SELECT COUNT(*) FROM trash_members WHERE trash_op_id=t.op_id)=?
        AND NOT EXISTS(SELECT 1 FROM trash_members tm LEFT JOIN nodes m ON m.id=tm.node_id
          WHERE tm.trash_op_id=t.op_id AND (m.id IS NULL OR m.space_id<>t.space_id OR m.deleted_op_id<>t.op_id OR m.deleted_at IS NULL))
        AND NOT EXISTS(SELECT 1 FROM trash_members tm JOIN nodes m ON m.id=tm.node_id
          JOIN blobs b ON b.id=m.current_blob_id WHERE tm.trash_op_id=t.op_id AND b.state IN ('deleting','deleted'))
        AND NOT EXISTS(SELECT 1 FROM trash_members tm JOIN node_versions v ON v.node_id=tm.node_id
          JOIN blobs b ON b.id=v.blob_id WHERE tm.trash_op_id=t.op_id AND b.state IN ('deleting','deleted'))
        AND EXISTS(SELECT 1 FROM control c WHERE c.singleton=1 AND c.epoch=? AND c.maintenance=0 AND c.gc_paused=1)
        AND NOT EXISTS(SELECT 1 FROM gc_candidates WHERE state='deleting')`,
    [
      operands.trashOpId,
      claim.intent.spaceId,
      rootId,
      claim.intent.principal.user_id,
      memberCount,
      claim.permit.epoch,
    ],
  );
}

function statements(
  claim: OperationClaim,
  destination: Extract<Awaited<ReturnType<typeof authorizeNode>>, { operation: "node.create" }>,
  trashOpId: string,
  rootId: string,
  memberCount: number,
  levels: readonly { depth: number; count: number }[],
  name: ReturnType<typeof portableName>,
  parentRevision: number,
  hashes: readonly string[],
  gcPause: RestorePause,
): SqlStatement[] {
  if (
    claim.intent.kind !== "node.restore" ||
    claim.steps !== RESTORE_TRASH_BASE_STEPS + levels.length ||
    claim.intent.principal.kind !== "user" ||
    !("user_id" in claim.intent.principal)
  )
    throw new Error("invalid_mutation_plan");
  const clock = "strftime('%s','now')*1000";
  const op = claim.intent.id;
  const search = searchName(name.name);
  const steps = [
    {
      kind: "restore_claim",
      id: trashOpId,
      statement: {
        sql: "UPDATE trash_ops SET state='restoring' WHERE op_id=? AND state='trashed'",
        values: [trashOpId],
      },
      assertion: assertOneChange,
    },
    {
      kind: "node",
      id: rootId,
      statement: {
        sql: `UPDATE nodes SET parent_id=?,name=?,name_ci=?,hidden=?,deleted_at=NULL,deleted_op_id=NULL,
          orig_parent_id=NULL,revision=revision+1,last_op_id=?,updated_at=MAX(updated_at,${clock})
          WHERE id=? AND deleted_op_id=? AND deleted_at IS NOT NULL`,
        values: [
          destination.parent.id,
          name.name,
          name.nameCi,
          name.hidden ? 1 : 0,
          op,
          rootId,
          trashOpId,
        ],
      },
      assertion: assertOneChange,
    },
    ...levels.map(({ depth, count }) => ({
      kind: `depth_${depth}`,
      id: rootId,
      statement: {
        sql: `WITH RECURSIVE d(id,depth) AS (
          SELECT id,0 FROM nodes WHERE id=? AND deleted_at IS NULL
          UNION ALL SELECT n.id,d.depth+1 FROM nodes n JOIN d ON n.parent_id=d.id
            JOIN trash_members tm ON tm.node_id=n.id AND tm.trash_op_id=?
            WHERE d.depth<?
        ) UPDATE nodes SET deleted_at=NULL,deleted_op_id=NULL,orig_parent_id=NULL,last_op_id=?,updated_at=MAX(updated_at,${clock})
          WHERE deleted_op_id=? AND deleted_at IS NOT NULL AND id IN (SELECT id FROM d WHERE depth=?)`,
        values: [rootId, trashOpId, depth, op, trashOpId, depth],
      },
      assertion: {
        sql: "INSERT INTO _assert(v) SELECT 1 WHERE changes()<>?",
        values: [count],
      },
    })),
    {
      kind: "parent",
      id: destination.parent.id,
      statement: {
        sql: `UPDATE nodes SET revision=revision+1,last_op_id=?,updated_at=MAX(updated_at,${clock})
          WHERE id=? AND revision=? AND deleted_at IS NULL`,
        values: [op, destination.parent.id, parentRevision],
      },
      assertion: assertOneChange,
    },
    {
      kind: "tree",
      id: claim.intent.spaceId,
      statement: {
        sql: "UPDATE spaces SET tree_generation=tree_generation+1 WHERE id=? AND tree_generation=?",
        values: [claim.intent.spaceId, destination.parent.tree_generation],
      },
      assertion: assertOneChange,
    },
    {
      kind: "search_fts_delete",
      id: rootId,
      statement: {
        sql: `INSERT INTO search_fts(search_fts,rowid,text_norm,tokens)
          SELECT 'delete',rowid,text_norm,tokens FROM search_index WHERE node_id=?`,
        values: [rootId],
      },
      assertion: assertOneChange,
    },
    {
      kind: "search_index",
      id: rootId,
      statement: {
        sql: "UPDATE search_index SET text_norm=?,tokens=?,normalization_version=?,revision=revision+1 WHERE node_id=?",
        values: [search.textNorm, search.tokens, search.version, rootId],
      },
      assertion: assertOneChange,
    },
    {
      kind: "search_fts_insert",
      id: rootId,
      statement: {
        sql: "INSERT INTO search_fts(rowid,text_norm,tokens) SELECT rowid,text_norm,tokens FROM search_index WHERE node_id=?",
        values: [rootId],
      },
      assertion: assertOneChange,
    },
    {
      kind: "activity",
      id: rootId,
      statement: {
        sql: `INSERT INTO activity(id,op_id,actor_id,kind,affected_id,created_at) VALUES(?,?,?,?,?,${clock})`,
        values: [`${op}_activity`, op, claim.intent.principal.user_id, "node.restore", rootId],
      },
      assertion: assertOneChange,
    },
    {
      kind: "outbox",
      id: rootId,
      statement: {
        sql: `INSERT INTO outbox(outbox_id,op_id,kind,payload_ref,state,epoch,created_at,updated_at) VALUES(?,?,'node.restored',?,'pending',?,${clock},${clock})`,
        values: [`${op}_event`, op, rootId, claim.permit.epoch],
      },
      assertion: assertOneChange,
    },
    {
      kind: "publish",
      id: trashOpId,
      statement: {
        sql: "UPDATE trash_ops SET state='restored' WHERE op_id=? AND state='restoring'",
        values: [trashOpId],
      },
      assertion: assertOneChange,
    },
  ];
  const result: SqlStatement[] = [
    assertOpenPermit(claim.permit),
    assertOperationClaim(claim),
    authorizationAssertion(destination),
    assertCreateLocks(destination.parent.id, claim.intent.spaceId, destination.principal, hashes),
    restoreGuard(claim, rootId, memberCount),
    assertRestorePause(gcPause, claim.intent.id),
    assertExists("SELECT 1 WHERE NOT EXISTS(SELECT 1 FROM operation_steps WHERE op_id=?)", [op]),
  ];
  steps.forEach((step, index) =>
    result.push(
      step.statement,
      step.assertion,
      {
        sql: "INSERT INTO operation_steps(op_id,step_no,kind,affected_id) VALUES(?,?,?,?)",
        values: [op, index + 1, step.kind, step.id],
      },
      assertOneChange,
    ),
  );
  result.push(
    {
      sql: `UPDATE operations SET state='committed',result_json=?,updated_at=MAX(updated_at,${clock}) WHERE op_id=? AND state='claimed' AND (SELECT COUNT(*) FROM operation_steps WHERE op_id=?)=expected_steps`,
      values: [JSON.stringify({ status: 200, nodeId: rootId }), op, op],
    },
    assertOneChange,
  );
  return result;
}

export async function restoreTrash(
  env: Pick<Env, "DB" | "LOCKS" | "CONTROL">,
  request: RestoreTrashRequest,
): Promise<MutationOutcome> {
  if (request.principal.kind !== "user" || !ID.test(request.trashOpId))
    throw new Error("authorization_denied");
  const principal = request.principal as UserPrincipal;
  const body = {
    trashOpId: request.trashOpId,
    destinationParentId: request.destinationParentId,
  };
  const slot = await operationIntent(
    principal,
    request.requestId,
    request.spaceId,
    "node.restore",
    body,
    {},
  );
  const terminalSlot = await operationRow(env.DB, slot.id);
  if (terminalSlot && terminalSlot.state !== "claimed") {
    let operands: Record<string, unknown>;
    try {
      operands = JSON.parse(terminalSlot.operands_json) as Record<string, unknown>;
    } catch {
      throw new Error("idempotency_conflict");
    }
    if (
      terminalSlot.principal_kind !== "user" ||
      terminalSlot.credential_id !== principal.credential_id ||
      terminalSlot.space_id !== request.spaceId ||
      terminalSlot.kind !== "node.restore" ||
      terminalSlot.request_digest !== slot.digest ||
      terminalSlot.expected_steps < RESTORE_TRASH_BASE_STEPS ||
      terminalSlot.expected_steps > RESTORE_TRASH_BASE_STEPS + 64 ||
      operands.trashOpId !== request.trashOpId ||
      operands.parentId !== request.destinationParentId
    )
      throw new Error("idempotency_conflict");
    const operation = await lookupOperation(env.DB, principal, terminalSlot.op_id);
    if (!operation) throw new Error("authorization_denied");
    return { kind: "terminal", operation };
  }
  const initial = await snapshot(env.DB, principal, request.spaceId, request.trashOpId);
  const intent = await operationIntent(
    principal,
    request.requestId,
    request.spaceId,
    "node.restore",
    body,
    { trashOpId: request.trashOpId, nodeId: initial.rootId, parentId: request.destinationParentId },
  );
  const steps = RESTORE_TRASH_BASE_STEPS + initial.levels.length;
  const existing = await findOperationIntent(env.DB, intent, steps);
  if (existing && existing.state !== "claimed") {
    const operation = await lookupOperation(env.DB, principal, intent.id);
    if (!operation) throw new Error("authorization_denied");
    return { kind: "terminal", operation };
  }
  await authorizeNode(env.DB, principal, {
    operation: "node.create",
    parentId: request.destinationParentId,
    spaceId: request.spaceId,
  });
  const lost = await primary(env.DB)
    .prepare(`SELECT 1 FROM trash_members tm JOIN nodes n ON n.id=tm.node_id
    JOIN blobs b ON b.id=n.current_blob_id WHERE tm.trash_op_id=? AND b.state IN ('deleting','deleted')
    UNION ALL SELECT 1 FROM trash_members tm JOIN node_versions v ON v.node_id=tm.node_id
    JOIN blobs b ON b.id=v.blob_id WHERE tm.trash_op_id=? AND b.state IN ('deleting','deleted') LIMIT 1`)
    .bind(request.trashOpId, request.trashOpId)
    .first<number>();
  if (lost !== null) throw new Error("blob_unrecoverable");
  const control = env.CONTROL.get(env.CONTROL.idFromName(CONTROL_NAME));
  const gcPause = await control.acquireRestorePause(principal.epoch, intent.id);
  if (!gcPause.ready) throw new Error("gc_quiescing");
  try {
    const lock = env.LOCKS.get(env.LOCKS.idFromName(request.spaceId));
    const permit = await lock.acquireRestore({
      gcPause,
      requestId: intent.id,
      spaceId: request.spaceId,
      parentId: request.destinationParentId,
      trashOpId: request.trashOpId,
      rootNodeId: initial.rootId,
      principal,
      lockTokens: request.lockTokens,
    });
    let terminal = false;
    try {
      const destination = await authorizeNode(env.DB, principal, {
        operation: "node.create",
        parentId: request.destinationParentId,
        spaceId: request.spaceId,
      });
      if (destination.operation !== "node.create") throw new Error("authorization_denied");
      const current = await snapshot(env.DB, principal, request.spaceId, request.trashOpId);
      if (current.rootId !== initial.rootId || current.memberDigest !== initial.memberDigest)
        throw new Error("authorization_denied");
      const claimed = await claimOperation(env.DB, intent, permit, destination, steps);
      if (claimed.kind === "terminal") {
        const operation = await lookupOperation(env.DB, principal, intent.id);
        if (!operation) throw new Error("authorization_denied");
        terminal = true;
        return { kind: "terminal", operation };
      }
      const name = await availableName(env.DB, destination.parent.id, current.name);
      const parentRevision = await primary(env.DB)
        .prepare("SELECT revision FROM nodes WHERE id=? AND deleted_at IS NULL")
        .bind(destination.parent.id)
        .first<number>("revision");
      if (parentRevision === null) throw new Error("authorization_denied");
      const outcome = await commitMutationStatements(
        env.DB,
        claimed.claim,
        statements(
          claimed.claim,
          destination,
          request.trashOpId,
          current.rootId,
          current.memberCount,
          current.levels,
          name,
          parentRevision,
          await lockTokenHashes(request.lockTokens),
          gcPause,
        ),
      );
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
  } finally {
    try {
      await control.releaseRestorePause(principal.epoch, gcPause.token);
    } catch {
      /* The durable alarm reconciles a lost release acknowledgement. */
    }
  }
}
