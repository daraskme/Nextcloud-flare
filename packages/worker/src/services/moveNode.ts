import { portableName, searchName } from "@next-cloud-flare/shared/names";
import {
  type AuthorizedNode,
  authorizationAssertion,
  authorizeNode,
  type Principal,
} from "../auth/authorize";
import { assertCreateLocks, assertTrashLocks, lockTokenHashes } from "../auth/locks";
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

export const DAV_MOVE_MAX_NODES = 1_000;
export const DAV_MOVE_MAX_BYTES = 10 * 1024 * 1024 * 1024;
export const MOVE_NODE_STEPS = 19;
type RenameAuthority = Extract<AuthorizedNode, { operation: "node.rename" }>;
type CreateAuthority = Extract<AuthorizedNode, { operation: "node.create" }>;
type TrashAuthority = Extract<AuthorizedNode, { operation: "node.trash" }>;

export interface MoveNodeRequest {
  readonly principal: Principal;
  readonly requestId: string;
  readonly spaceId: string;
  readonly nodeId: string;
  readonly destinationParentId: string;
  readonly overwriteTargetId?: string;
  readonly name: string;
  readonly lockTokens: readonly string[];
  readonly operation?: "node.move" | "dav.move";
}

interface ManifestRow {
  id: string;
  bytes: number;
}

function assertChanges(count: number): SqlStatement {
  return { sql: "INSERT INTO _assert(v) SELECT 1 WHERE changes()<>?", values: [count] };
}

async function moveManifest(db: D1Database, nodeId: string, spaceId: string) {
  const rows = await primary(db)
    .prepare(`WITH RECURSIVE d(id,depth,path,current_blob_id) AS (
      SELECT id,0,'/'||id||'/',current_blob_id FROM nodes
        WHERE id=? AND space_id=? AND deleted_at IS NULL
      UNION ALL SELECT n.id,d.depth+1,d.path||n.id||'/',n.current_blob_id
        FROM nodes n JOIN d ON n.parent_id=d.id
        WHERE d.depth<64 AND n.space_id=? AND n.deleted_at IS NULL
          AND instr(d.path,'/'||n.id||'/')=0
    ) SELECT d.id,COALESCE(b.size,0) AS bytes FROM d LEFT JOIN blobs b ON b.id=d.current_blob_id
      ORDER BY d.id LIMIT ?`)
    .bind(nodeId, spaceId, spaceId, DAV_MOVE_MAX_NODES + 1)
    .all<ManifestRow>();
  if (rows.results.length === 0) throw new Error("authorization_denied");
  const bytes = rows.results.reduce((total, row) => total + row.bytes, 0);
  if (rows.results.length > DAV_MOVE_MAX_NODES || bytes > DAV_MOVE_MAX_BYTES)
    throw new Error("dav_transfer_too_large");
  return Object.freeze({ ids: rows.results.map(({ id }) => id), bytes });
}

function moveStatements(
  claim: OperationClaim,
  source: RenameAuthority,
  destination: CreateAuthority,
  overwrite: TrashAuthority | null,
  overwriteMemberCount: number,
  sourceParentRevision: number,
  destinationParentRevision: number,
  inputName: string,
  hashes: readonly string[],
): readonly SqlStatement[] {
  if (!["node.move", "dav.move"].includes(claim.intent.kind) || claim.steps !== MOVE_NODE_STEPS)
    throw new Error("invalid_mutation_plan");
  const name = portableName(inputName);
  const search = searchName(name.name);
  const node = source.node;
  const sourceParentId = source.parentId;
  const destinationParentId = destination.parent.id;
  const sameParent = sourceParentId === destinationParentId;
  if (
    node.space_id !== destination.spaceId ||
    node.owner_id !== destination.parent.owner_id ||
    (source.principal.kind !== "user" && source.principal.kind !== "app_password") ||
    !Number.isSafeInteger(sourceParentRevision) ||
    !Number.isSafeInteger(destinationParentRevision) ||
    sourceParentRevision < 1 ||
    destinationParentRevision < 1
  )
    throw new Error("invalid_mutation_plan");
  const actorId = source.principal.user_id;
  const op = claim.intent.id;
  const clock = "strftime('%s','now')*1000";
  const overwriteId = overwrite?.node.id ?? null;
  const membership = "SELECT node_id FROM trash_members WHERE trash_op_id=?";
  const steps: Array<MutationStep & { assertion: SqlStatement }> = [
    {
      kind: "trash_op",
      affectedId: overwriteId ?? node.id,
      statement: {
        sql: `INSERT INTO trash_ops(op_id,actor_id,space_id,root_node_id,state,reason,created_at,purge_after,epoch)
          SELECT ?,?,?,?,'pending',?,${clock},${clock}+3024000000,? WHERE ? IS NOT NULL`,
        values: [
          op,
          actorId,
          node.space_id,
          overwriteId,
          claim.intent.kind,
          claim.permit.epoch,
          overwriteId,
        ],
      },
      assertion: assertChanges(overwrite ? 1 : 0),
    },
    {
      kind: "trash_members",
      affectedId: overwriteId ?? node.id,
      statement: {
        sql: `WITH RECURSIVE d(id,depth,path) AS (
          SELECT id,0,'/'||id||'/' FROM nodes WHERE id=? AND space_id=? AND deleted_at IS NULL
          UNION ALL SELECT n.id,d.depth+1,d.path||n.id||'/' FROM nodes n JOIN d ON n.parent_id=d.id
            WHERE d.depth<64 AND n.space_id=? AND n.deleted_at IS NULL
              AND instr(d.path,'/'||n.id||'/')=0
        ) INSERT INTO trash_members(trash_op_id,node_id) SELECT ?,id FROM d`,
        values: [overwriteId, node.space_id, node.space_id, op],
      },
      assertion: assertChanges(overwriteMemberCount),
    },
    {
      kind: "trash_nodes",
      affectedId: overwriteId ?? node.id,
      statement: {
        sql: `UPDATE nodes SET deleted_at=${clock},deleted_op_id=?,orig_parent_id=parent_id,
          last_op_id=?,updated_at=MAX(updated_at,${clock})
          WHERE id IN (${membership}) AND deleted_at IS NULL`,
        values: [op, op, op],
      },
      assertion: assertChanges(overwriteMemberCount),
    },
    {
      kind: "trash_locks",
      affectedId: overwriteId ?? node.id,
      statement: { sql: `DELETE FROM locks WHERE node_id IN (${membership})`, values: [op] },
      assertion: assertExists(
        `SELECT 1 WHERE NOT EXISTS(SELECT 1 FROM locks WHERE node_id IN (${membership}))`,
        [op],
      ),
    },
    {
      kind: "trash_shares",
      affectedId: overwriteId ?? node.id,
      statement: {
        sql: `UPDATE shares SET disabled_at=${clock},version=version+1
          WHERE root_node_id IN (${membership}) AND disabled_at IS NULL`,
        values: [op],
      },
      assertion: assertExists(
        `SELECT 1 WHERE NOT EXISTS(SELECT 1 FROM shares
          WHERE root_node_id IN (${membership}) AND disabled_at IS NULL)`,
        [op],
      ),
    },
    {
      kind: "trash_share_sessions",
      affectedId: overwriteId ?? node.id,
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
      kind: "trash_tickets",
      affectedId: node.owner_id,
      statement: {
        sql: `UPDATE tickets SET cancelled_at=${clock} WHERE ? IS NOT NULL AND cancelled_at IS NULL
          AND target_set_id IN (SELECT id FROM target_sets WHERE owner_id=?)`,
        values: [overwriteId, node.owner_id],
      },
      assertion: assertExists(
        `SELECT 1 WHERE ? IS NULL OR NOT EXISTS(SELECT 1 FROM tickets WHERE cancelled_at IS NULL
          AND target_set_id IN (SELECT id FROM target_sets WHERE owner_id=?))`,
        [overwriteId, node.owner_id],
      ),
    },
    {
      kind: "trash_content_sessions",
      affectedId: node.owner_id,
      statement: {
        sql: `UPDATE content_sessions SET revoked_at=${clock} WHERE ? IS NOT NULL AND revoked_at IS NULL
          AND target_set_id IN (SELECT id FROM target_sets WHERE owner_id=?)`,
        values: [overwriteId, node.owner_id],
      },
      assertion: assertExists(
        `SELECT 1 WHERE ? IS NULL OR NOT EXISTS(SELECT 1 FROM content_sessions WHERE revoked_at IS NULL
          AND target_set_id IN (SELECT id FROM target_sets WHERE owner_id=?))`,
        [overwriteId, node.owner_id],
      ),
    },
    {
      kind: "node",
      affectedId: node.id,
      statement: {
        sql: `UPDATE nodes SET parent_id=?,name=?,name_ci=?,hidden=?,revision=revision+1,
          last_op_id=?,updated_at=MAX(updated_at,${clock})
          WHERE id=? AND parent_id=? AND revision=? AND deleted_at IS NULL AND kind<>'root'`,
        values: [
          destinationParentId,
          name.name,
          name.nameCi,
          name.hidden ? 1 : 0,
          op,
          node.id,
          sourceParentId,
          node.revision,
        ],
      },
      assertion: assertOneChange,
    },
    {
      kind: "source_parent",
      affectedId: sourceParentId,
      statement: {
        sql: `UPDATE nodes SET revision=revision+1,last_op_id=?,updated_at=MAX(updated_at,${clock})
          WHERE id=? AND revision=? AND deleted_at IS NULL AND kind IN ('root','folder')`,
        values: [op, sourceParentId, sourceParentRevision],
      },
      assertion: assertOneChange,
    },
    {
      kind: "destination_parent",
      affectedId: destinationParentId,
      statement: {
        sql: `UPDATE nodes SET revision=revision+1,last_op_id=?,updated_at=MAX(updated_at,${clock})
          WHERE id=? AND id<>? AND revision=? AND deleted_at IS NULL AND kind IN ('root','folder')`,
        values: [op, destinationParentId, sourceParentId, destinationParentRevision],
      },
      assertion: assertChanges(sameParent ? 0 : 1),
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
      statement: {
        sql: `WITH RECURSIVE d(id,depth) AS (
          SELECT id,0 FROM nodes WHERE id=? AND space_id=? AND deleted_at IS NULL
          UNION ALL SELECT n.id,d.depth+1 FROM nodes n JOIN d ON n.parent_id=d.id
            WHERE d.depth<64 AND n.space_id=? AND n.deleted_at IS NULL
        ) DELETE FROM locks WHERE node_id IN (SELECT id FROM d)`,
        values: [node.id, node.space_id, node.space_id],
      },
      assertion: assertExists(
        `WITH RECURSIVE d(id,depth) AS (
          SELECT id,0 FROM nodes WHERE id=? AND space_id=? AND deleted_at IS NULL
          UNION ALL SELECT n.id,d.depth+1 FROM nodes n JOIN d ON n.parent_id=d.id
            WHERE d.depth<64 AND n.space_id=? AND n.deleted_at IS NULL
        ) SELECT 1 WHERE NOT EXISTS(SELECT 1 FROM locks WHERE node_id IN (SELECT id FROM d))`,
        [node.id, node.space_id, node.space_id],
      ),
    },
    {
      kind: "search_fts_delete",
      affectedId: node.id,
      statement: {
        sql: `INSERT INTO search_fts(search_fts,rowid,text_norm,tokens)
          SELECT 'delete',rowid,text_norm,tokens FROM search_index WHERE node_id=?`,
        values: [node.id],
      },
      assertion: assertOneChange,
    },
    {
      kind: "search_index",
      affectedId: node.id,
      statement: {
        sql: `UPDATE search_index SET text_norm=?,tokens=?,normalization_version=?,revision=?
          WHERE node_id=? AND revision<=? AND space_id=?`,
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
      assertion: assertOneChange,
    },
    {
      kind: "search_fts_insert",
      affectedId: node.id,
      statement: {
        sql: "INSERT INTO search_fts(rowid,text_norm,tokens) SELECT rowid,text_norm,tokens FROM search_index WHERE node_id=?",
        values: [node.id],
      },
      assertion: assertOneChange,
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
          VALUES(?,?,'node.renamed',?,'pending',?,${clock},${clock})`,
        values: [`${op}_event`, op, node.id, claim.permit.epoch],
      },
      assertion: assertOneChange,
    },
    {
      kind: "trash_publish",
      affectedId: overwriteId ?? node.id,
      statement: {
        sql: "UPDATE trash_ops SET state='trashed' WHERE op_id=? AND state='pending'",
        values: [op],
      },
      assertion: assertChanges(overwrite ? 1 : 0),
    },
  ];
  const statements: SqlStatement[] = [
    assertOpenPermit(claim.permit),
    assertOperationClaim(claim),
    authorizationAssertion(source),
    authorizationAssertion(destination),
    ...(overwrite ? [authorizationAssertion(overwrite)] : []),
    assertTrashLocks(node.id, node.space_id, source.principal, hashes),
    assertCreateLocks(destinationParentId, node.space_id, source.principal, hashes),
    ...(overwrite
      ? [assertTrashLocks(overwrite.node.id, node.space_id, source.principal, hashes)]
      : []),
    assertExists(
      `WITH RECURSIVE d(id,depth,path) AS (
        SELECT id,0,'/'||id||'/' FROM nodes WHERE id=? AND space_id=? AND deleted_at IS NULL
        UNION ALL SELECT n.id,d.depth+1,d.path||n.id||'/' FROM nodes n JOIN d ON n.parent_id=d.id
          WHERE d.depth<64 AND n.space_id=? AND n.deleted_at IS NULL
            AND instr(d.path,'/'||n.id||'/')=0
      ) SELECT 1 WHERE NOT EXISTS(SELECT 1 FROM d WHERE id=?)`,
      [node.id, node.space_id, node.space_id, destinationParentId],
    ),
    assertExists(
      "SELECT 1 WHERE NOT EXISTS(SELECT 1 FROM nodes WHERE parent_id=? AND name_ci=? AND deleted_at IS NULL AND id NOT IN (?,COALESCE(?,'')))",
      [destinationParentId, name.nameCi, node.id, overwriteId],
    ),
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
      values: [JSON.stringify({ status: overwrite ? 204 : 201, nodeId: node.id }), op, op],
    },
    assertOneChange,
  );
  return statements;
}

export async function moveNode(
  env: Pick<Env, "DB" | "LOCKS">,
  request: MoveNodeRequest,
): Promise<MutationOutcome> {
  if (request.principal.kind !== "user" && request.principal.kind !== "app_password")
    throw new Error("authorization_denied");
  const name = portableName(request.name);
  const operationKind = request.operation ?? "dav.move";
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
      terminalSlot.expected_steps !== MOVE_NODE_STEPS ||
      operands.nodeId !== request.nodeId ||
      operands.parentId !== request.destinationParentId ||
      operands.name !== name.name ||
      (operands.overwriteTargetId ?? undefined) !== request.overwriteTargetId
    )
      throw new Error("idempotency_conflict");
    const operation = await lookupOperation(env.DB, request.principal, terminalSlot.op_id);
    if (!operation) throw new Error("authorization_denied");
    return { kind: "terminal", operation };
  }
  const source = await authorizeNode(env.DB, request.principal, {
    operation: "node.rename",
    nodeId: request.nodeId,
    spaceId: request.spaceId,
  });
  const destination = await authorizeNode(env.DB, request.principal, {
    operation: "node.create",
    parentId: request.destinationParentId,
    spaceId: request.spaceId,
  });
  if (source.operation !== "node.rename" || destination.operation !== "node.create")
    throw new Error("invalid_move_authorization");
  if (
    source.node.owner_id !== destination.parent.owner_id ||
    source.node.space_id !== destination.spaceId
  )
    throw new Error("dav_cross_space_move");
  const manifest = await moveManifest(env.DB, request.nodeId, request.spaceId);
  const overwrite = request.overwriteTargetId
    ? await authorizeNode(env.DB, request.principal, {
        operation: "node.trash",
        nodeId: request.overwriteTargetId,
        spaceId: request.spaceId,
      })
    : null;
  if (
    overwrite &&
    (overwrite.operation !== "node.trash" ||
      overwrite.parentId !== request.destinationParentId ||
      overwrite.node.id === source.node.id)
  )
    throw new Error("invalid_move_authorization");
  const overwriteManifest = overwrite
    ? await moveManifest(env.DB, overwrite.node.id, request.spaceId)
    : Object.freeze({ ids: [] as string[], bytes: 0 });
  if (
    overwriteManifest.ids.includes(source.node.id) ||
    manifest.ids.length + overwriteManifest.ids.length > DAV_MOVE_MAX_NODES
  )
    throw new Error("dav_transfer_too_large");
  const intent = await operationIntent(
    request.principal,
    request.requestId,
    request.spaceId,
    operationKind,
    {
      nodeId: request.nodeId,
      destinationParentId: request.destinationParentId,
      name: name.name,
      manifestCount: manifest.ids.length,
      manifestBytes: manifest.bytes,
      manifestDigest: await digestJson(manifest.ids),
      overwriteTargetId: overwrite?.node.id ?? null,
      overwriteCount: overwriteManifest.ids.length,
      overwriteDigest: await digestJson(overwriteManifest.ids),
    },
    {
      nodeId: request.nodeId,
      sourceParentId: source.parentId,
      parentId: request.destinationParentId,
      name: name.name,
      ...(overwrite ? { overwriteTargetId: overwrite.node.id } : {}),
    },
  );
  const existing = await findOperationIntent(env.DB, intent, MOVE_NODE_STEPS);
  if (existing && existing.state !== "claimed") {
    const operation = await lookupOperation(env.DB, request.principal, intent.id);
    if (!operation) throw new Error("authorization_denied");
    return { kind: "terminal", operation };
  }
  const lock = env.LOCKS.get(env.LOCKS.idFromName(request.spaceId));
  const permit = await lock.acquireMove({
    requestId: intent.id,
    spaceId: request.spaceId,
    nodeId: request.nodeId,
    destinationParentId: request.destinationParentId,
    ...(overwrite ? { overwriteTargetId: overwrite.node.id } : {}),
    principal: request.principal,
    lockTokens: request.lockTokens,
    operation: operationKind,
  });
  let terminal = false;
  try {
    const currentSource = await authorizeNode(env.DB, request.principal, {
      operation: "node.rename",
      nodeId: request.nodeId,
      spaceId: request.spaceId,
    });
    const currentDestination = await authorizeNode(env.DB, request.principal, {
      operation: "node.create",
      parentId: request.destinationParentId,
      spaceId: request.spaceId,
    });
    const currentOverwrite = overwrite
      ? await authorizeNode(env.DB, request.principal, {
          operation: "node.trash",
          nodeId: overwrite.node.id,
          spaceId: request.spaceId,
        })
      : null;
    if (
      currentSource.operation !== "node.rename" ||
      currentSource.parentId !== source.parentId ||
      currentDestination.operation !== "node.create" ||
      (currentOverwrite &&
        (currentOverwrite.operation !== "node.trash" ||
          currentOverwrite.parentId !== currentDestination.parent.id))
    )
      throw new Error("authorization_denied");
    const currentManifest = await moveManifest(env.DB, request.nodeId, request.spaceId);
    if (
      currentManifest.bytes !== manifest.bytes ||
      (await digestJson(currentManifest.ids)) !== (await digestJson(manifest.ids))
    )
      throw new Error("authorization_denied");
    const currentOverwriteManifest = currentOverwrite
      ? await moveManifest(env.DB, currentOverwrite.node.id, request.spaceId)
      : Object.freeze({ ids: [] as string[], bytes: 0 });
    if (
      currentOverwriteManifest.bytes !== overwriteManifest.bytes ||
      (await digestJson(currentOverwriteManifest.ids)) !== (await digestJson(overwriteManifest.ids))
    )
      throw new Error("authorization_denied");
    const claimed = await claimOperation(env.DB, intent, permit, currentSource, MOVE_NODE_STEPS);
    if (claimed.kind === "terminal") {
      const operation = await lookupOperation(env.DB, request.principal, intent.id);
      if (!operation) throw new Error("authorization_denied");
      terminal = true;
      return { kind: "terminal", operation };
    }
    const revisions = await primary(env.DB)
      .prepare(
        "SELECT id,revision FROM nodes WHERE id IN (?,?) AND space_id=? AND deleted_at IS NULL",
      )
      .bind(currentSource.parentId, currentDestination.parent.id, request.spaceId)
      .all<{ id: string; revision: number }>();
    const byId = new Map(revisions.results.map((row) => [row.id, row.revision]));
    const sourceRevision = byId.get(currentSource.parentId);
    const destinationRevision = byId.get(currentDestination.parent.id);
    if (sourceRevision === undefined || destinationRevision === undefined)
      throw new Error("authorization_denied");
    const outcome = await commitMutationStatements(
      env.DB,
      claimed.claim,
      moveStatements(
        claimed.claim,
        currentSource,
        currentDestination,
        currentOverwrite,
        currentOverwriteManifest.ids.length,
        sourceRevision,
        destinationRevision,
        name.name,
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
