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

export const DAV_COPY_MAX_NODES = 1_000;
export const DAV_COPY_MAX_BYTES = 10 * 1024 * 1024 * 1024;
export const COPY_NODE_STEPS = 18;
type ReadAuthority = Extract<
  AuthorizedNode,
  { operation: "node.read" | "automation.list" | "automation.metadata.read" }
> & { operation: "node.read" };
type CreateAuthority = Extract<AuthorizedNode, { operation: "node.create" }>;
type TrashAuthority = Extract<AuthorizedNode, { operation: "node.trash" }>;

export interface CopyNodeRequest {
  readonly principal: Principal;
  readonly requestId: string;
  readonly spaceId: string;
  readonly sourceNodeId: string;
  readonly destinationParentId: string;
  readonly name: string;
  readonly depth: "0" | "infinity";
  readonly overwriteTargetId?: string;
  readonly lockTokens: readonly string[];
  readonly operation?: "node.copy" | "dav.copy";
}

interface ManifestRow {
  id: string;
  bytes: number;
}
function assertChanges(count: number): SqlStatement {
  return { sql: "INSERT INTO _assert(v) SELECT 1 WHERE changes()<>?", values: [count] };
}

async function copyManifest(
  db: D1Database,
  nodeId: string,
  spaceId: string,
  depth: "0" | "infinity",
) {
  const rows = await primary(db)
    .prepare(`WITH RECURSIVE d(id,depth,path,current_blob_id) AS (
    SELECT id,0,'/'||id||'/',current_blob_id FROM nodes WHERE id=? AND space_id=? AND deleted_at IS NULL
    UNION ALL SELECT n.id,d.depth+1,d.path||n.id||'/',n.current_blob_id FROM nodes n JOIN d ON n.parent_id=d.id
      WHERE ?='infinity' AND d.depth<64 AND n.space_id=? AND n.deleted_at IS NULL
        AND instr(d.path,'/'||n.id||'/')=0
  ) SELECT d.id,COALESCE(b.size,0) AS bytes FROM d LEFT JOIN blobs b ON b.id=d.current_blob_id
    ORDER BY d.depth,d.id LIMIT ?`)
    .bind(nodeId, spaceId, depth, spaceId, DAV_COPY_MAX_NODES + 1)
    .all<ManifestRow>();
  const bytes = rows.results.reduce((sum, row) => sum + row.bytes, 0);
  if (!rows.results.length) throw new Error("authorization_denied");
  if (rows.results.length > DAV_COPY_MAX_NODES || bytes > DAV_COPY_MAX_BYTES)
    throw new Error("dav_transfer_too_large");
  const props = await primary(db)
    .prepare(`WITH RECURSIVE d(id,depth,path) AS (
    SELECT id,0,'/'||id||'/' FROM nodes WHERE id=? AND space_id=? AND deleted_at IS NULL
    UNION ALL SELECT n.id,d.depth+1,d.path||n.id||'/' FROM nodes n JOIN d ON n.parent_id=d.id
      WHERE ?='infinity' AND d.depth<64 AND n.space_id=? AND n.deleted_at IS NULL
  ) SELECT COUNT(*) AS count FROM node_props WHERE node_id IN (SELECT id FROM d)`)
    .bind(nodeId, spaceId, depth, spaceId)
    .first<number>("count");
  if (props === null) throw new Error("copy_manifest_unavailable");
  return Object.freeze({ ids: rows.results.map((row) => row.id), bytes, props });
}

function copyStatements(
  claim: OperationClaim,
  source: ReadAuthority,
  destination: CreateAuthority,
  overwrite: TrashAuthority | null,
  overwriteCount: number,
  parentRevision: number,
  inputName: string,
  depth: "0" | "infinity",
  memberCount: number,
  propCount: number,
  hashes: readonly string[],
): readonly SqlStatement[] {
  if (!["node.copy", "dav.copy"].includes(claim.intent.kind) || claim.steps !== COPY_NODE_STEPS)
    throw new Error("invalid_mutation_plan");
  const name = portableName(inputName);
  const search = searchName(name.name);
  const op = claim.intent.id;
  const rootCopy = `${op}_c0001`;
  const clock = "strftime('%s','now')*1000";
  const overwriteId = overwrite?.node.id ?? null;
  const membership = "SELECT node_id FROM trash_members WHERE trash_op_id=?";
  const steps: Array<MutationStep & { assertion: SqlStatement }> = [
    {
      kind: "trash_op",
      affectedId: overwriteId ?? rootCopy,
      statement: {
        sql: `INSERT INTO trash_ops(op_id,actor_id,space_id,root_node_id,state,reason,created_at,purge_after,epoch) SELECT ?,?,?,?,'pending',?,${clock},${clock}+3024000000,? WHERE ? IS NOT NULL`,
        values: [
          op,
          source.principal.kind === "link_share" ? null : source.principal.user_id,
          source.node.space_id,
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
      affectedId: overwriteId ?? rootCopy,
      statement: {
        sql: `WITH RECURSIVE d(id,depth,path) AS (SELECT id,0,'/'||id||'/' FROM nodes WHERE id=? AND space_id=? AND deleted_at IS NULL UNION ALL SELECT n.id,d.depth+1,d.path||n.id||'/' FROM nodes n JOIN d ON n.parent_id=d.id WHERE d.depth<64 AND n.space_id=? AND n.deleted_at IS NULL AND instr(d.path,'/'||n.id||'/')=0) INSERT INTO trash_members(trash_op_id,node_id) SELECT ?,id FROM d`,
        values: [overwriteId, source.node.space_id, source.node.space_id, op],
      },
      assertion: assertChanges(overwriteCount),
    },
    {
      kind: "trash_nodes",
      affectedId: overwriteId ?? rootCopy,
      statement: {
        sql: `UPDATE nodes SET deleted_at=${clock},deleted_op_id=?,orig_parent_id=parent_id,last_op_id=?,updated_at=MAX(updated_at,${clock}) WHERE id IN (${membership}) AND deleted_at IS NULL`,
        values: [op, op, op],
      },
      assertion: assertChanges(overwriteCount),
    },
    {
      kind: "trash_locks",
      affectedId: overwriteId ?? rootCopy,
      statement: { sql: `DELETE FROM locks WHERE node_id IN (${membership})`, values: [op] },
      assertion: assertExists(
        `SELECT 1 WHERE NOT EXISTS(SELECT 1 FROM locks WHERE node_id IN (${membership}))`,
        [op],
      ),
    },
    {
      kind: "trash_shares",
      affectedId: overwriteId ?? rootCopy,
      statement: {
        sql: `UPDATE shares SET disabled_at=${clock},version=version+1 WHERE root_node_id IN (${membership}) AND disabled_at IS NULL`,
        values: [op],
      },
      assertion: assertExists(
        `SELECT 1 WHERE NOT EXISTS(SELECT 1 FROM shares WHERE root_node_id IN (${membership}) AND disabled_at IS NULL)`,
        [op],
      ),
    },
    {
      kind: "trash_share_sessions",
      affectedId: overwriteId ?? rootCopy,
      statement: {
        sql: `UPDATE share_sessions SET revoked_at=${clock} WHERE revoked_at IS NULL AND share_id IN (SELECT id FROM shares WHERE root_node_id IN (${membership}))`,
        values: [op],
      },
      assertion: assertExists(
        `SELECT 1 WHERE NOT EXISTS(SELECT 1 FROM share_sessions WHERE revoked_at IS NULL AND share_id IN (SELECT id FROM shares WHERE root_node_id IN (${membership})))`,
        [op],
      ),
    },
    {
      kind: "trash_tickets",
      affectedId: source.node.owner_id,
      statement: {
        sql: `UPDATE tickets SET cancelled_at=${clock} WHERE ? IS NOT NULL AND cancelled_at IS NULL AND target_set_id IN (SELECT id FROM target_sets WHERE owner_id=?)`,
        values: [overwriteId, source.node.owner_id],
      },
      assertion: assertExists(
        `SELECT 1 WHERE ? IS NULL OR NOT EXISTS(SELECT 1 FROM tickets WHERE cancelled_at IS NULL AND target_set_id IN (SELECT id FROM target_sets WHERE owner_id=?))`,
        [overwriteId, source.node.owner_id],
      ),
    },
    {
      kind: "trash_content_sessions",
      affectedId: source.node.owner_id,
      statement: {
        sql: `UPDATE content_sessions SET revoked_at=${clock} WHERE ? IS NOT NULL AND revoked_at IS NULL AND target_set_id IN (SELECT id FROM target_sets WHERE owner_id=?)`,
        values: [overwriteId, source.node.owner_id],
      },
      assertion: assertExists(
        `SELECT 1 WHERE ? IS NULL OR NOT EXISTS(SELECT 1 FROM content_sessions WHERE revoked_at IS NULL AND target_set_id IN (SELECT id FROM target_sets WHERE owner_id=?))`,
        [overwriteId, source.node.owner_id],
      ),
    },
    {
      kind: "manifest",
      affectedId: rootCopy,
      statement: {
        sql: `WITH RECURSIVE d(id,depth,path) AS (
      SELECT id,0,'/'||id||'/' FROM nodes WHERE id=? AND space_id=? AND deleted_at IS NULL
      UNION ALL SELECT n.id,d.depth+1,d.path||n.id||'/' FROM nodes n JOIN d ON n.parent_id=d.id
        WHERE ?='infinity' AND d.depth<64 AND n.space_id=? AND n.deleted_at IS NULL
          AND instr(d.path,'/'||n.id||'/')=0
    ), numbered AS (SELECT id,depth,row_number() OVER(ORDER BY depth,id) AS ordinal FROM d)
    INSERT INTO copy_members(copy_op_id,source_node_id,copied_node_id,depth)
      SELECT ?,id,printf('%s_c%04d',?,ordinal),depth FROM numbered`,
        values: [source.node.id, source.node.space_id, depth, source.node.space_id, op, op],
      },
      assertion: assertExists(
        "SELECT 1 FROM copy_members WHERE copy_op_id=? GROUP BY copy_op_id HAVING COUNT(*)=?",
        [op, memberCount],
      ),
    },
    {
      kind: "node",
      affectedId: rootCopy,
      statement: {
        sql: `INSERT INTO nodes(id,space_id,owner_id,parent_id,name,name_ci,kind,current_blob_id,revision,client_mtime,created_at,updated_at,hidden,last_op_id)
      SELECT cm.copied_node_id,n.space_id,n.owner_id,CASE WHEN cm.depth=0 THEN ? ELSE pm.copied_node_id END,
        CASE WHEN cm.depth=0 THEN ? ELSE n.name END,CASE WHEN cm.depth=0 THEN ? ELSE n.name_ci END,n.kind,n.current_blob_id,1,n.client_mtime,${clock},${clock},CASE WHEN cm.depth=0 THEN ? ELSE n.hidden END,?
      FROM copy_members cm JOIN nodes n ON n.id=cm.source_node_id LEFT JOIN copy_members pm ON pm.copy_op_id=cm.copy_op_id AND pm.source_node_id=n.parent_id
      WHERE cm.copy_op_id=? AND n.deleted_at IS NULL AND NOT EXISTS(
        SELECT 1 FROM copy_members x JOIN nodes xn ON xn.id=x.source_node_id JOIN blobs b ON b.id=xn.current_blob_id
          WHERE x.copy_op_id=cm.copy_op_id AND (b.state IN ('deleting','deleted') OR b.ref_count+(SELECT COUNT(*) FROM copy_members y JOIN nodes yn ON yn.id=y.source_node_id WHERE y.copy_op_id=cm.copy_op_id AND yn.current_blob_id=b.id)>1000))
      ORDER BY cm.depth,cm.source_node_id`,
        values: [destination.parent.id, name.name, name.nameCi, name.hidden ? 1 : 0, op, op],
      },
      assertion: assertExists(
        "SELECT COUNT(*) FROM nodes WHERE id IN (SELECT copied_node_id FROM copy_members WHERE copy_op_id=?) HAVING COUNT(*)=?",
        [op, memberCount],
      ),
    },
    {
      kind: "props",
      affectedId: rootCopy,
      statement: {
        sql: `INSERT INTO node_props(node_id,namespace,name,value_xml)
      SELECT cm.copied_node_id,p.namespace,p.name,p.value_xml FROM copy_members cm JOIN node_props p ON p.node_id=cm.source_node_id WHERE cm.copy_op_id=?`,
        values: [op],
      },
      assertion: assertExists(
        "SELECT COUNT(*) FROM node_props WHERE node_id IN (SELECT copied_node_id FROM copy_members WHERE copy_op_id=?) HAVING COUNT(*)=?",
        [op, propCount],
      ),
    },
    {
      kind: "parent",
      affectedId: destination.parent.id,
      statement: {
        sql: `UPDATE nodes SET revision=revision+1,last_op_id=?,updated_at=MAX(updated_at,${clock}) WHERE id=? AND revision=? AND deleted_at IS NULL AND kind IN ('root','folder')`,
        values: [op, destination.parent.id, parentRevision],
      },
      assertion: assertOneChange,
    },
    {
      kind: "tree",
      affectedId: source.node.space_id,
      statement: {
        sql: "UPDATE spaces SET tree_generation=tree_generation+1 WHERE id=? AND tree_generation=?",
        values: [source.node.space_id, source.node.tree_generation],
      },
      assertion: assertOneChange,
    },
    {
      kind: "search_index",
      affectedId: rootCopy,
      statement: {
        sql: `INSERT INTO search_index(node_id,space_id,text_norm,tokens,normalization_version,revision)
      SELECT cm.copied_node_id,si.space_id,CASE WHEN cm.depth=0 THEN ? ELSE si.text_norm END,CASE WHEN cm.depth=0 THEN ? ELSE si.tokens END,CASE WHEN cm.depth=0 THEN ? ELSE si.normalization_version END,1
      FROM copy_members cm JOIN search_index si ON si.node_id=cm.source_node_id WHERE cm.copy_op_id=? ORDER BY cm.depth,cm.source_node_id`,
        values: [search.textNorm, search.tokens, search.version, op],
      },
      assertion: assertExists(
        "SELECT COUNT(*) FROM search_index WHERE node_id IN (SELECT copied_node_id FROM copy_members WHERE copy_op_id=?) HAVING COUNT(*)=?",
        [op, memberCount],
      ),
    },
    {
      kind: "search_fts",
      affectedId: rootCopy,
      statement: {
        sql: "INSERT INTO search_fts(rowid,text_norm,tokens) SELECT si.rowid,si.text_norm,si.tokens FROM search_index si JOIN copy_members cm ON cm.copied_node_id=si.node_id WHERE cm.copy_op_id=?",
        values: [op],
      },
      assertion: assertExists(
        "SELECT COUNT(*) FROM search_fts WHERE rowid IN (SELECT si.rowid FROM search_index si JOIN copy_members cm ON cm.copied_node_id=si.node_id WHERE cm.copy_op_id=?) HAVING COUNT(*)=?",
        [op, memberCount],
      ),
    },
    {
      kind: "activity",
      affectedId: rootCopy,
      statement: {
        sql: `INSERT INTO activity(id,op_id,actor_id,kind,affected_id,created_at) VALUES(?,?,?,?,?,${clock})`,
        values: [
          `${op}_activity`,
          op,
          source.principal.kind === "link_share" ? null : source.principal.user_id,
          claim.intent.kind,
          rootCopy,
        ],
      },
      assertion: assertOneChange,
    },
    {
      kind: "outbox",
      affectedId: rootCopy,
      statement: {
        sql: `INSERT INTO outbox(outbox_id,op_id,kind,payload_ref,state,epoch,created_at,updated_at) VALUES(?,?,'node.created',?,'pending',?,${clock},${clock})`,
        values: [`${op}_event`, op, rootCopy, claim.permit.epoch],
      },
      assertion: assertOneChange,
    },
    {
      kind: "trash_publish",
      affectedId: overwriteId ?? rootCopy,
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
    assertCreateLocks(destination.parent.id, source.node.space_id, source.principal, hashes),
    ...(overwrite
      ? [assertTrashLocks(overwrite.node.id, source.node.space_id, source.principal, hashes)]
      : []),
    assertExists(
      "SELECT 1 WHERE NOT EXISTS(SELECT 1 FROM nodes WHERE parent_id=? AND name_ci=? AND deleted_at IS NULL AND id<>COALESCE(?,''))",
      [destination.parent.id, name.nameCi, overwriteId],
    ),
    assertExists("SELECT 1 WHERE NOT EXISTS(SELECT 1 FROM operation_steps WHERE op_id=?)", [op]),
  ];
  for (const [index, step] of steps.entries())
    statements.push(
      step.statement,
      step.assertion,
      {
        sql: "INSERT INTO operation_steps(op_id,step_no,kind,affected_id) VALUES(?,?,?,?)",
        values: [op, index + 1, step.kind, step.affectedId],
      },
      assertOneChange,
    );
  statements.push(
    {
      sql: `UPDATE operations SET state='committed',result_json=?,updated_at=MAX(updated_at,${clock}) WHERE op_id=? AND state='claimed' AND (SELECT COUNT(*) FROM operation_steps WHERE op_id=?)=expected_steps`,
      values: [JSON.stringify({ status: overwrite ? 204 : 201, nodeId: rootCopy }), op, op],
    },
    assertOneChange,
  );
  return statements;
}

export async function copyNode(
  env: Pick<Env, "DB" | "LOCKS">,
  request: CopyNodeRequest,
): Promise<MutationOutcome> {
  if (request.principal.kind !== "user" && request.principal.kind !== "app_password")
    throw new Error("authorization_denied");
  const name = portableName(request.name);
  const operationKind = request.operation ?? "dav.copy";
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
      terminalSlot.expected_steps !== COPY_NODE_STEPS ||
      operands.sourceNodeId !== request.sourceNodeId ||
      operands.parentId !== request.destinationParentId ||
      operands.name !== name.name ||
      operands.depth !== request.depth ||
      (operands.overwriteTargetId ?? undefined) !== request.overwriteTargetId
    )
      throw new Error("idempotency_conflict");
    const operation = await lookupOperation(env.DB, request.principal, terminalSlot.op_id);
    if (!operation) throw new Error("authorization_denied");
    return { kind: "terminal", operation };
  }
  const source = await authorizeNode(env.DB, request.principal, {
    operation: "node.read",
    nodeId: request.sourceNodeId,
    spaceId: request.spaceId,
  });
  const destination = await authorizeNode(env.DB, request.principal, {
    operation: "node.create",
    parentId: request.destinationParentId,
    spaceId: request.spaceId,
  });
  if (
    source.operation !== "node.read" ||
    destination.operation !== "node.create" ||
    source.node.owner_id !== destination.parent.owner_id
  )
    throw new Error("dav_cross_space_copy");
  const manifest = await copyManifest(env.DB, request.sourceNodeId, request.spaceId, request.depth);
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
    throw new Error("invalid_copy_authorization");
  const overwriteManifest = overwrite
    ? await copyManifest(env.DB, overwrite.node.id, request.spaceId, "infinity")
    : Object.freeze({ ids: [] as string[], bytes: 0, props: 0 });
  if (
    overwriteManifest.ids.includes(source.node.id) ||
    manifest.ids.length + overwriteManifest.ids.length > DAV_COPY_MAX_NODES
  )
    throw new Error("dav_transfer_too_large");
  const intent = await operationIntent(
    request.principal,
    request.requestId,
    request.spaceId,
    operationKind,
    {
      sourceNodeId: request.sourceNodeId,
      destinationParentId: request.destinationParentId,
      name: name.name,
      depth: request.depth,
      manifestCount: manifest.ids.length,
      manifestBytes: manifest.bytes,
      manifestDigest: await digestJson(manifest.ids),
      overwriteTargetId: overwrite?.node.id ?? null,
      overwriteCount: overwriteManifest.ids.length,
      overwriteDigest: await digestJson(overwriteManifest.ids),
    },
    {
      sourceNodeId: request.sourceNodeId,
      parentId: request.destinationParentId,
      name: name.name,
      depth: request.depth,
      ...(overwrite ? { overwriteTargetId: overwrite.node.id } : {}),
    },
  );
  const existing = await findOperationIntent(env.DB, intent, COPY_NODE_STEPS);
  if (existing && existing.state !== "claimed") {
    const operation = await lookupOperation(env.DB, request.principal, intent.id);
    if (!operation) throw new Error("authorization_denied");
    return { kind: "terminal", operation };
  }
  const lock = env.LOCKS.get(env.LOCKS.idFromName(request.spaceId));
  const permit = await lock.acquireCopy({
    requestId: intent.id,
    spaceId: request.spaceId,
    sourceNodeId: request.sourceNodeId,
    parentId: request.destinationParentId,
    ...(overwrite ? { overwriteTargetId: overwrite.node.id } : {}),
    principal: request.principal,
    lockTokens: request.lockTokens,
    operation: operationKind,
  });
  let terminal = false;
  try {
    const currentSource = await authorizeNode(env.DB, request.principal, {
      operation: "node.read",
      nodeId: request.sourceNodeId,
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
      currentSource.operation !== "node.read" ||
      currentDestination.operation !== "node.create" ||
      (currentOverwrite &&
        (currentOverwrite.operation !== "node.trash" ||
          currentOverwrite.parentId !== currentDestination.parent.id))
    )
      throw new Error("authorization_denied");
    const current = await copyManifest(
      env.DB,
      request.sourceNodeId,
      request.spaceId,
      request.depth,
    );
    if (
      current.props !== manifest.props ||
      current.bytes !== manifest.bytes ||
      (await digestJson(current.ids)) !== (await digestJson(manifest.ids))
    )
      throw new Error("authorization_denied");
    const currentOverwriteManifest = currentOverwrite
      ? await copyManifest(env.DB, currentOverwrite.node.id, request.spaceId, "infinity")
      : Object.freeze({ ids: [] as string[], bytes: 0, props: 0 });
    if (
      currentOverwriteManifest.bytes !== overwriteManifest.bytes ||
      (await digestJson(currentOverwriteManifest.ids)) !== (await digestJson(overwriteManifest.ids))
    )
      throw new Error("authorization_denied");
    const claimed = await claimOperation(env.DB, intent, permit, currentSource, COPY_NODE_STEPS);
    if (claimed.kind === "terminal") {
      const operation = await lookupOperation(env.DB, request.principal, intent.id);
      if (!operation) throw new Error("authorization_denied");
      terminal = true;
      return { kind: "terminal", operation };
    }
    const revision = await primary(env.DB)
      .prepare("SELECT revision FROM nodes WHERE id=? AND space_id=? AND deleted_at IS NULL")
      .bind(currentDestination.parent.id, request.spaceId)
      .first<number>("revision");
    if (revision === null) throw new Error("authorization_denied");
    const outcome = await commitMutationStatements(
      env.DB,
      claimed.claim,
      copyStatements(
        claimed.claim,
        currentSource as ReadAuthority,
        currentDestination,
        currentOverwrite,
        currentOverwriteManifest.ids.length,
        revision,
        name.name,
        request.depth,
        current.ids.length,
        current.props,
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
        /* lease recovery */
      }
  }
}
