import { authorizationAssertion, authorizeNode, type Principal } from "../auth/authorize";
import { GC_NOT_BEFORE_SQL } from "../db/gcGrace";
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
import { commitMutationStatements, type MutationOutcome } from "./fsMutation";

const ID = /^[A-Za-z0-9_-]{1,128}$/;
const BASE_STEPS = 35;
type UserPrincipal = {
  readonly kind: "user";
  readonly user_id: string;
  readonly credential_id: string;
  readonly epoch: number;
};
type ReadAuthority = Exclude<
  Awaited<ReturnType<typeof authorizeNode>>,
  { readonly operation: "node.create" }
> & { readonly operation: "node.read" };

export interface PurgeTrashRequest {
  readonly principal: Principal;
  readonly requestId: string;
  readonly spaceId: string;
  readonly trashOpId: string;
}

interface Snapshot {
  rootId: string;
  spaceRootId: string;
  memberCount: number;
  memberDigest: string;
  searchCount: number;
  levels: readonly { depth: number; count: number }[];
}

async function snapshot(
  db: D1Database,
  principal: UserPrincipal,
  spaceId: string,
  trashOpId: string,
): Promise<Snapshot> {
  const row = await primary(db)
    .prepare(`SELECT t.root_node_id AS rootId,s.root_node_id AS spaceRootId,
      (SELECT COUNT(*) FROM trash_members WHERE trash_op_id=t.op_id) AS memberCount,
      (SELECT COUNT(*) FROM search_index si JOIN trash_members tm ON tm.node_id=si.node_id
        WHERE tm.trash_op_id=t.op_id) AS searchCount
      FROM trash_ops t JOIN spaces s ON s.id=t.space_id AND s.owner_id=t.actor_id
      JOIN nodes n ON n.id=t.root_node_id AND n.space_id=t.space_id
      WHERE t.op_id=? AND t.space_id=? AND t.actor_id=? AND t.state='trashed'
        AND n.deleted_op_id=t.op_id AND n.deleted_at IS NOT NULL`)
    .bind(trashOpId, spaceId, principal.user_id)
    .first<{ rootId: string; spaceRootId: string; memberCount: number; searchCount: number }>();
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
  for (const { depth } of members.results) counts.set(depth, (counts.get(depth) ?? 0) + 1);
  return {
    ...row,
    memberDigest: await digestJson(members.results),
    levels: [...counts]
      .map(([depth, count]) => ({ depth, count }))
      .sort((left, right) => right.depth - left.depth),
  };
}

interface Step {
  kind: string;
  id: string;
  statement: SqlStatement;
  assertion: SqlStatement;
}

function absent(sql: string, values: readonly (string | number | null)[]): SqlStatement {
  return assertExists(`SELECT 1 WHERE NOT EXISTS(${sql})`, values);
}

function purgeGuard(claim: OperationClaim, rootId: string, memberCount: number) {
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
          WHERE tm.trash_op_id=t.op_id AND (m.id IS NULL OR m.space_id<>t.space_id OR m.deleted_op_id<>t.op_id OR m.deleted_at IS NULL))`,
    [operands.trashOpId, claim.intent.spaceId, rootId, claim.intent.principal.user_id, memberCount],
  );
}

function statements(
  claim: OperationClaim,
  authority: ReadAuthority,
  current: Snapshot,
  trashOpId: string,
): SqlStatement[] {
  if (
    claim.intent.kind !== "node.purge" ||
    claim.steps !== BASE_STEPS + current.levels.length ||
    claim.intent.principal.kind !== "user" ||
    !("user_id" in claim.intent.principal)
  )
    throw new Error("invalid_mutation_plan");
  const op = claim.intent.id;
  const clock = "strftime('%s','now')*1000";
  const members = "SELECT node_id FROM purge_members WHERE purge_op_id=?";
  const sourceMembers = "SELECT node_id FROM trash_members WHERE trash_op_id=?";
  const steps: Step[] = [];
  const add = (kind: string, id: string, statement: SqlStatement, assertion: SqlStatement) =>
    steps.push({ kind, id, statement, assertion });
  add(
    "purge_claim",
    trashOpId,
    {
      sql: "UPDATE trash_ops SET state='purging' WHERE op_id=? AND state='trashed'",
      values: [trashOpId],
    },
    assertOneChange,
  );
  add(
    "member_manifest",
    current.rootId,
    {
      sql: `WITH RECURSIVE d(id,depth,path) AS (
        SELECT n.id,0,'/'||n.id||'/' FROM nodes n WHERE n.id=? AND n.deleted_op_id=?
        UNION ALL SELECT n.id,d.depth+1,d.path||n.id||'/' FROM nodes n JOIN d ON n.parent_id=d.id
          JOIN trash_members tm ON tm.node_id=n.id AND tm.trash_op_id=?
          WHERE d.depth<64 AND n.deleted_op_id=? AND instr(d.path,'/'||n.id||'/')=0)
        INSERT INTO purge_members(purge_op_id,node_id,depth) SELECT ?,id,depth FROM d`,
      values: [current.rootId, trashOpId, trashOpId, trashOpId, op],
    },
    assertExists(
      "SELECT 1 FROM purge_members WHERE purge_op_id=? GROUP BY purge_op_id HAVING COUNT(*)=?",
      [op, current.memberCount],
    ),
  );
  add(
    "blob_manifest",
    current.rootId,
    {
      sql: `INSERT OR IGNORE INTO purge_blobs(purge_op_id,blob_id)
        SELECT ?,current_blob_id FROM nodes WHERE id IN (${sourceMembers}) AND current_blob_id IS NOT NULL
        UNION SELECT ?,blob_id FROM node_versions WHERE node_id IN (${sourceMembers})
        UNION SELECT ?,blob_id FROM uploads WHERE parent_id IN (${sourceMembers}) OR target_id IN (${sourceMembers})`,
      values: [op, trashOpId, op, trashOpId, op, trashOpId, trashOpId],
    },
    assertExists("SELECT 1 FROM purge_members WHERE purge_op_id=?", [op]),
  );
  add(
    "foreign_children",
    current.rootId,
    {
      sql: `UPDATE nodes SET parent_id=NULL WHERE deleted_at IS NOT NULL AND deleted_op_id<>?
        AND parent_id IN (${members})`,
      values: [trashOpId, op],
    },
    absent(
      `SELECT 1 FROM nodes WHERE deleted_at IS NOT NULL AND deleted_op_id<>? AND parent_id IN (${members})`,
      [trashOpId, op],
    ),
  );
  add(
    "credential_scopes",
    current.rootId,
    {
      sql: `DELETE FROM credential_scopes WHERE credential_id IN (
        SELECT c.id FROM credentials c LEFT JOIN app_passwords ap ON ap.id=c.app_password_id
        LEFT JOIN service_principals sp ON sp.id=c.service_principal_id
        WHERE ap.root_node_id IN (${members}) OR sp.root_node_id IN (${members}))`,
      values: [op, op],
    },
    absent(
      `SELECT 1 FROM credential_scopes cs JOIN credentials c ON c.id=cs.credential_id
      LEFT JOIN app_passwords ap ON ap.id=c.app_password_id LEFT JOIN service_principals sp ON sp.id=c.service_principal_id
      WHERE ap.root_node_id IN (${members}) OR sp.root_node_id IN (${members})`,
      [op, op],
    ),
  );
  add(
    "credential_roots",
    current.rootId,
    {
      sql: `UPDATE app_passwords SET root_node_id=NULL,revoked_at=COALESCE(revoked_at,${clock}) WHERE root_node_id IN (${members});`,
      values: [op],
    },
    absent(`SELECT 1 FROM app_passwords WHERE root_node_id IN (${members})`, [op]),
  );
  add(
    "service_roots",
    current.rootId,
    {
      sql: `UPDATE service_principals SET root_node_id=NULL,disabled_at=COALESCE(disabled_at,${clock}) WHERE root_node_id IN (${members})`,
      values: [op],
    },
    absent(`SELECT 1 FROM service_principals WHERE root_node_id IN (${members})`, [op]),
  );
  add(
    "share_dependents",
    current.rootId,
    {
      sql: `DELETE FROM share_grants WHERE share_id IN (SELECT id FROM shares WHERE root_node_id IN (${members}))`,
      values: [op],
    },
    absent(
      `SELECT 1 FROM share_grants WHERE share_id IN (SELECT id FROM shares WHERE root_node_id IN (${members}))`,
      [op],
    ),
  );
  add(
    "share_actions",
    current.rootId,
    {
      sql: `DELETE FROM share_actions WHERE share_id IN (SELECT id FROM shares WHERE root_node_id IN (${members}))`,
      values: [op],
    },
    absent(
      `SELECT 1 FROM share_actions WHERE share_id IN (SELECT id FROM shares WHERE root_node_id IN (${members}))`,
      [op],
    ),
  );
  add(
    "shares",
    current.rootId,
    {
      sql: `UPDATE shares SET root_node_id=NULL,disabled_at=COALESCE(disabled_at,${clock}),version=version+1 WHERE root_node_id IN (${members})`,
      values: [op],
    },
    absent(`SELECT 1 FROM shares WHERE root_node_id IN (${members})`, [op]),
  );
  add(
    "upload_parts",
    current.rootId,
    {
      sql: `DELETE FROM upload_parts WHERE upload_id IN (SELECT id FROM uploads WHERE parent_id IN (${members}) OR target_id IN (${members}))`,
      values: [op, op],
    },
    absent(
      `SELECT 1 FROM upload_parts WHERE upload_id IN (SELECT id FROM uploads WHERE parent_id IN (${members}) OR target_id IN (${members}))`,
      [op, op],
    ),
  );
  add(
    "reservations",
    current.rootId,
    {
      sql: `UPDATE reservations SET state='released' WHERE state='reserved' AND id IN (SELECT reservation_id FROM uploads WHERE parent_id IN (${members}) OR target_id IN (${members}))`,
      values: [op, op],
    },
    absent(
      `SELECT 1 FROM reservations r JOIN uploads u ON u.reservation_id=r.id
        WHERE r.state='reserved' AND (u.parent_id IN (${members}) OR u.target_id IN (${members}))`,
      [op, op],
    ),
  );
  add(
    "uploads",
    current.rootId,
    {
      sql: `DELETE FROM uploads WHERE parent_id IN (${members}) OR target_id IN (${members})`,
      values: [op, op],
    },
    absent(`SELECT 1 FROM uploads WHERE parent_id IN (${members}) OR target_id IN (${members})`, [
      op,
      op,
    ]),
  );
  const deletes: readonly [string, string, string][] = [
    ["copy_members", "copy_members", `source_node_id IN (${members})`],
    ["node_props", "node_props", `node_id IN (${members})`],
    ["stars", "stars", `node_id IN (${members})`],
    ["node_tags", "node_tags", `node_id IN (${members})`],
    ["node_media", "node_media", `node_id IN (${members})`],
    ["library_items", "library_items", `node_id IN (${members})`],
    ["archive_index", "archive_index", `node_id IN (${members})`],
    ["library_roots", "library_roots", `node_id IN (${members})`],
    ["node_audio", "node_audio", `node_id IN (${members})`],
    ["reading_state", "user_reading_state", `node_id IN (${members})`],
    ["playback_state", "user_playback_state", `node_id IN (${members})`],
    ["locks", "locks", `node_id IN (${members})`],
    ["node_versions", "node_versions", `node_id IN (${members})`],
  ];
  for (const [kind, table, predicate] of deletes)
    add(
      kind,
      current.rootId,
      { sql: `DELETE FROM ${table} WHERE ${predicate}`, values: [op] },
      absent(`SELECT 1 FROM ${table} WHERE ${predicate}`, [op]),
    );
  add(
    "search_fts",
    current.rootId,
    {
      sql: `INSERT INTO search_fts(search_fts,rowid,text_norm,tokens)
      SELECT 'delete',rowid,text_norm,tokens FROM search_index WHERE node_id IN (${members})`,
      values: [op],
    },
    { sql: "INSERT INTO _assert(v) SELECT 1 WHERE changes()<>?", values: [current.searchCount] },
  );
  add(
    "search_index",
    current.rootId,
    {
      sql: `DELETE FROM search_index WHERE node_id IN (${members})`,
      values: [op],
    },
    absent(`SELECT 1 FROM search_index WHERE node_id IN (${members})`, [op]),
  );
  add(
    "trash_members",
    trashOpId,
    {
      sql: `DELETE FROM trash_members WHERE node_id IN (${members})`,
      values: [op],
    },
    absent(`SELECT 1 FROM trash_members WHERE node_id IN (${members})`, [op]),
  );
  for (const { depth, count } of current.levels)
    add(
      depth === 0 ? "node" : `nodes_depth_${depth}`,
      current.rootId,
      {
        sql: "DELETE FROM nodes WHERE id IN (SELECT node_id FROM purge_members WHERE purge_op_id=? AND depth=?)",
        values: [op, depth],
      },
      { sql: "INSERT INTO _assert(v) SELECT 1 WHERE changes()<>?", values: [count] },
    );
  add(
    "blob_state",
    current.rootId,
    {
      sql: `UPDATE blobs SET state='gc_candidate',last_op_id=? WHERE ref_count=0
      AND state NOT IN ('deleting','deleted') AND id IN (SELECT blob_id FROM purge_blobs WHERE purge_op_id=?)`,
      values: [op, op],
    },
    absent(
      `SELECT 1 FROM blobs WHERE ref_count=0 AND state NOT IN ('gc_candidate','deleting','deleted')
    AND id IN (SELECT blob_id FROM purge_blobs WHERE purge_op_id=?)`,
      [op],
    ),
  );
  add(
    "gc_candidates",
    trashOpId,
    {
      sql: `INSERT OR IGNORE INTO gc_candidates(blob_id,trash_op_id,state,not_before)
      SELECT b.id,?,'candidate',${GC_NOT_BEFORE_SQL} FROM blobs b JOIN purge_blobs p ON p.blob_id=b.id
      WHERE p.purge_op_id=? AND b.state NOT IN ('deleting','deleted')`,
      values: [trashOpId, op],
    },
    absent(
      `SELECT 1 FROM blobs b JOIN purge_blobs p ON p.blob_id=b.id WHERE p.purge_op_id=?
    AND b.state NOT IN ('deleting','deleted') AND NOT EXISTS(SELECT 1 FROM gc_candidates g WHERE g.blob_id=b.id)`,
      [op],
    ),
  );
  add(
    "tree",
    claim.intent.spaceId,
    {
      sql: "UPDATE spaces SET tree_generation=tree_generation+1 WHERE id=? AND tree_generation=?",
      values: [claim.intent.spaceId, authority.node.tree_generation],
    },
    assertOneChange,
  );
  add(
    "activity",
    current.rootId,
    {
      sql: `INSERT INTO activity(id,op_id,actor_id,kind,affected_id,created_at) VALUES(?,?,?,?,?,${clock})`,
      values: [`${op}_activity`, op, claim.intent.principal.user_id, "node.purge", current.rootId],
    },
    assertOneChange,
  );
  add(
    "outbox",
    current.rootId,
    {
      sql: `INSERT INTO outbox(outbox_id,op_id,kind,payload_ref,state,epoch,created_at,updated_at)
      VALUES(?,?,'node.purged',?,'pending',?,${clock},${clock})`,
      values: [`${op}_event`, op, current.rootId, claim.permit.epoch],
    },
    assertOneChange,
  );
  add(
    "publish",
    trashOpId,
    {
      sql: "UPDATE trash_ops SET state='purged' WHERE op_id=? AND state='purging'",
      values: [trashOpId],
    },
    assertOneChange,
  );
  if (steps.length !== claim.steps) throw new Error(`invalid_mutation_plan`);
  const result: SqlStatement[] = [
    assertOpenPermit(claim.permit),
    assertOperationClaim(claim),
    authorizationAssertion(authority),
    purgeGuard(claim, current.rootId, current.memberCount),
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
      sql: `UPDATE operations SET state='committed',result_json=?,updated_at=MAX(updated_at,${clock})
      WHERE op_id=? AND state='claimed' AND (SELECT COUNT(*) FROM operation_steps WHERE op_id=?)=expected_steps`,
      values: [JSON.stringify({ status: 200, nodeId: current.rootId }), op, op],
    },
    assertOneChange,
  );
  return result;
}

export async function purgeTrash(
  env: Pick<Env, "DB" | "LOCKS">,
  request: PurgeTrashRequest,
): Promise<MutationOutcome> {
  if (request.principal.kind !== "user" || !ID.test(request.trashOpId))
    throw new Error("authorization_denied");
  const principal = request.principal as UserPrincipal;
  const body = { trashOpId: request.trashOpId };
  const slot = await operationIntent(
    principal,
    request.requestId,
    request.spaceId,
    "node.purge",
    body,
    {},
  );
  const terminal = await operationRow(env.DB, slot.id);
  if (terminal && terminal.state !== "claimed") {
    const operation = await lookupOperation(env.DB, principal, terminal.op_id);
    if (!operation || terminal.request_digest !== slot.digest)
      throw new Error("idempotency_conflict");
    return { kind: "terminal", operation };
  }
  const initial = await snapshot(env.DB, principal, request.spaceId, request.trashOpId);
  const intent = await operationIntent(
    principal,
    request.requestId,
    request.spaceId,
    "node.purge",
    body,
    {
      trashOpId: request.trashOpId,
      nodeId: initial.rootId,
      parentId: initial.spaceRootId,
    },
  );
  const stepCount = BASE_STEPS + initial.levels.length;
  const existing = await findOperationIntent(env.DB, intent, stepCount);
  if (existing && existing.state !== "claimed") {
    const operation = await lookupOperation(env.DB, principal, intent.id);
    if (!operation) throw new Error("authorization_denied");
    return { kind: "terminal", operation };
  }
  const lock = env.LOCKS.get(env.LOCKS.idFromName(request.spaceId));
  const permit = await lock.acquirePurge({
    requestId: intent.id,
    spaceId: request.spaceId,
    trashOpId: request.trashOpId,
    rootNodeId: initial.rootId,
    principal,
  });
  let done = false;
  try {
    const authority = await authorizeNode(env.DB, principal, {
      operation: "node.read",
      nodeId: initial.spaceRootId,
      spaceId: request.spaceId,
    });
    if (authority.operation !== "node.read") throw new Error("authorization_denied");
    const current = await snapshot(env.DB, principal, request.spaceId, request.trashOpId);
    if (current.memberDigest !== initial.memberDigest) throw new Error("authorization_denied");
    const claimed = await claimOperation(env.DB, intent, permit, authority, stepCount);
    if (claimed.kind === "terminal") {
      const operation = await lookupOperation(env.DB, principal, intent.id);
      if (!operation) throw new Error("authorization_denied");
      done = true;
      return { kind: "terminal", operation };
    }
    const outcome = await commitMutationStatements(
      env.DB,
      claimed.claim,
      statements(claimed.claim, authority as ReadAuthority, current, request.trashOpId),
    );
    done = outcome.kind === "terminal";
    return outcome;
  } finally {
    if (done)
      try {
        await lock.release(intent.id, permit);
      } catch {
        /* lease recovery */
      }
  }
}
