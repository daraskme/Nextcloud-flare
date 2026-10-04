import { portableName, searchName } from "@next-cloud-flare/shared/names";
import { authorizationAssertion, authorizeNode, type Principal } from "../auth/authorize";
import { assertCreateLocks, assertTrashLocks } from "../auth/locks";
import { GC_NOT_BEFORE_SQL } from "../db/gcGrace";
import { assertExists, assertOneChange, primary, type SqlStatement } from "../db/primary";
import { assertRestorePause, type RestorePause } from "../db/restorePause";
import { CONTROL_NAME } from "../do/ControlDO";
import { repairFence } from "../do/recoveryAudit";
import type { Env } from "../env";
import {
  assertPrivateEncryptedRestore,
  privateEncryptedRestoreAssertion,
} from "../services/encryptionGuards";
import {
  acquireSystemMutation,
  commitSystemMutation,
  type SystemMutationSource,
} from "../services/systemMutation";
import {
  ASYNC_TREE_CHUNK_NODES,
  ASYNC_TREE_MAX_NODES,
  assertExactTreeJob,
  parseTreeJobCheckpoint,
  parseTreeJobGrant,
  TREE_JOB_CLAIM_LEASE_MS,
  type TreeJobGrant,
  type TreeJobRow,
  treeJobRow,
} from "./treeJobStore";

export type TreeJobResult = "completed" | "failed" | "progressed" | "busy" | "retry";
type TreeWorkerEnv = SystemMutationSource & Partial<Pick<Env, "CONTROL">>;

const clock = "strftime('%s','now')*1000";
const ID = /^[A-Za-z0-9_-]{1,128}$/;

interface Member {
  id: string;
  depth: number;
}

function savedPrincipal(row: TreeJobRow): Principal | null {
  if (
    row.principal_kind !== "user" ||
    row.principal_id !== row.owner_id ||
    row.credential_id.length < 1
  )
    return null;
  return {
    kind: "user",
    user_id: row.owner_id,
    credential_id: row.credential_id,
    epoch: row.epoch,
  };
}

function leaseAssertion(row: TreeJobRow, token: string): SqlStatement {
  return assertExists(
    `SELECT 1 FROM job_leases l JOIN bulk_jobs j ON j.id=l.job_id
    JOIN operations o ON o.op_id=j.op_id JOIN control c ON c.singleton=1
    WHERE l.job_id=? AND l.claim_token=? AND l.epoch=? AND l.expires_at>${clock}
      AND j.owner_id=? AND j.credential_id=? AND j.op_id=? AND j.kind=?
      AND j.epoch=l.epoch AND j.state='running' AND j.dispatch_state='sent'
      AND o.state='claimed' AND o.epoch=j.epoch AND o.space_id=?
      AND c.epoch=j.epoch AND c.maintenance=0`,
    [row.id, token, row.epoch, row.owner_id, row.credential_id, row.op_id, row.kind, row.space_id],
  );
}

async function claimTreeJob(
  env: SystemMutationSource,
  row: TreeJobRow,
  deadline: number,
): Promise<{ row: TreeJobRow; token: string } | null> {
  if (
    row.operation_state !== "claimed" ||
    !["pending", "running"].includes(row.state) ||
    !["dispatching", "sent"].includes(row.dispatch_state)
  )
    return null;
  const token = crypto.randomUUID();
  try {
    const admission = await acquireSystemMutation(env, row.owner_id, "tree-job.claim", deadline);
    await commitSystemMutation(env.DB, admission, row.owner_id, [
      assertExactTreeJob(row),
      {
        sql: `INSERT INTO job_leases(job_id,claim_token,epoch,expires_at,attempt)
          VALUES(?,?,?,${clock}+?,1)
          ON CONFLICT(job_id) DO UPDATE SET
            claim_token=excluded.claim_token,epoch=excluded.epoch,expires_at=excluded.expires_at,
            attempt=job_leases.attempt+1
          WHERE job_leases.expires_at<=${clock} AND job_leases.attempt<10`,
        values: [row.id, token, row.epoch, TREE_JOB_CLAIM_LEASE_MS],
      },
      {
        sql: `UPDATE bulk_jobs SET state='running',invocation_count=invocation_count+1,
          dispatch_state='sent',updated_at=MAX(updated_at,${clock})
        WHERE id=? AND state IN ('pending','running') AND invocation_count<200
          AND EXISTS(SELECT 1 FROM job_leases WHERE job_id=? AND claim_token=? AND epoch=?)`,
        values: [row.id, row.id, token, row.epoch],
      },
      assertOneChange,
      leaseAssertion({ ...row, state: "running", dispatch_state: "sent" }, token),
    ]);
  } catch {
    const current = await treeJobRow(env.DB, row.id);
    const lease = await primary(env.DB)
      .prepare(
        `SELECT claim_token FROM job_leases WHERE job_id=? AND epoch=? AND expires_at>${clock}`,
      )
      .bind(row.id, row.epoch)
      .first<string>("claim_token");
    if (!current || lease !== token) return null;
  }
  const current = await treeJobRow(env.DB, row.id);
  return current ? { row: current, token } : null;
}

async function trashMembers(db: D1Database, row: TreeJobRow, cursor: string | null) {
  return primary(db)
    .prepare(`WITH RECURSIVE d(id,depth,path) AS (
      SELECT n.id,0,'/'||n.id||'/' FROM nodes n
        WHERE n.id=? AND n.space_id=? AND n.deleted_at IS NULL
      UNION ALL
      SELECT n.id,d.depth+1,d.path||n.id||'/' FROM nodes n JOIN d ON n.parent_id=d.id
        WHERE d.depth<64 AND n.space_id=? AND n.deleted_at IS NULL
          AND instr(d.path,'/'||n.id||'/')=0
    ) SELECT id,depth FROM d WHERE (? IS NULL OR id>?) ORDER BY id LIMIT ?`)
    .bind(
      parseTreeJobGrant(row.grant_snapshot).rootNodeId,
      row.space_id,
      row.space_id,
      cursor,
      cursor,
      ASYNC_TREE_CHUNK_NODES + 1,
    )
    .all<Member>();
}

async function trashedMembers(
  db: D1Database,
  row: TreeJobRow,
  grant: TreeJobGrant,
  cursor: string | null,
) {
  return primary(db)
    .prepare(`WITH RECURSIVE d(id,depth,path) AS (
      SELECT n.id,0,'/'||n.id||'/' FROM nodes n
        WHERE n.id=? AND n.space_id=? AND n.deleted_op_id=? AND n.deleted_at IS NOT NULL
      UNION ALL
      SELECT n.id,d.depth+1,d.path||n.id||'/' FROM nodes n JOIN d ON n.parent_id=d.id
        JOIN trash_members tm ON tm.node_id=n.id AND tm.trash_op_id=?
        WHERE d.depth<64 AND n.space_id=? AND n.deleted_op_id=? AND n.deleted_at IS NOT NULL
          AND instr(d.path,'/'||n.id||'/')=0
    ) SELECT id,depth FROM d WHERE (? IS NULL OR id>?) ORDER BY id LIMIT ?`)
    .bind(
      grant.rootNodeId,
      row.space_id,
      grant.trashOpId,
      grant.trashOpId,
      row.space_id,
      grant.trashOpId,
      cursor,
      cursor,
      ASYNC_TREE_CHUNK_NODES + 1,
    )
    .all<Member>();
}

function valueGroups(rows: readonly Member[], size: number): readonly (readonly Member[])[] {
  const groups: Member[][] = [];
  for (let start = 0; start < rows.length; start += size)
    groups.push(rows.slice(start, start + size));
  return groups;
}

function trashManifestStatements(row: TreeJobRow, members: readonly Member[]): SqlStatement[] {
  const statements: SqlStatement[] = [];
  for (const group of valueGroups(members, 45)) {
    statements.push({
      sql: `INSERT INTO trash_members(trash_op_id,node_id) VALUES ${group
        .map(() => "(?,?)")
        .join(",")}`,
      values: group.flatMap(({ id }) => [row.op_id, id]),
    });
  }
  return statements;
}

function purgeManifestStatements(row: TreeJobRow, members: readonly Member[]): SqlStatement[] {
  const statements: SqlStatement[] = [];
  for (const group of valueGroups(members, 30)) {
    statements.push({
      sql: `INSERT INTO purge_members(purge_op_id,node_id,depth) VALUES ${group
        .map(() => "(?,?,?)")
        .join(",")}`,
      values: group.flatMap(({ id, depth }) => [row.op_id, id, depth]),
    });
  }
  for (const group of valueGroups(members, 20)) {
    const placeholders = group.map(() => "?").join(",");
    const ids = group.map(({ id }) => id);
    statements.push({
      sql: `INSERT OR IGNORE INTO purge_blobs(purge_op_id,blob_id)
        SELECT ?,current_blob_id FROM nodes WHERE id IN (${placeholders}) AND current_blob_id IS NOT NULL
        UNION SELECT ?,blob_id FROM node_versions WHERE node_id IN (${placeholders})
        UNION SELECT ?,blob_id FROM uploads WHERE parent_id IN (${placeholders}) OR target_id IN (${placeholders})`,
      values: [row.op_id, ...ids, row.op_id, ...ids, row.op_id, ...ids, ...ids],
    });
  }
  return statements;
}

async function currentAuthorization(
  db: D1Database,
  row: TreeJobRow,
  grant: TreeJobGrant,
  principal: Principal,
) {
  if (row.kind === "node.trash") {
    const authorized = await authorizeNode(db, principal, {
      operation: "node.trash",
      nodeId: grant.rootNodeId,
      spaceId: row.space_id,
    });
    if (
      authorized.operation !== "node.trash" ||
      authorized.parentId !== grant.parentId ||
      authorized.node.tree_generation !== grant.sourceTreeGeneration ||
      authorized.node.revision !== grant.sourceRevision
    )
      throw new Error("authorization_denied");
    return authorized;
  }
  if (row.kind === "node.restore") {
    const authorized = await authorizeNode(db, principal, {
      operation: "node.create",
      parentId: grant.parentId,
      spaceId: row.space_id,
    });
    if (
      authorized.operation !== "node.create" ||
      authorized.parent.tree_generation !== grant.sourceTreeGeneration ||
      authorized.parent.revision !== grant.parentRevision
    )
      throw new Error("authorization_denied");
    await assertPrivateEncryptedRestore(db, grant.trashOpId, grant.parentId, row.space_id);
    return authorized;
  }
  const authorized = await authorizeNode(db, principal, {
    operation: "node.read",
    nodeId: grant.parentId,
    spaceId: row.space_id,
  });
  if (
    authorized.operation !== "node.read" ||
    authorized.node.tree_generation !== grant.sourceTreeGeneration ||
    authorized.node.revision !== grant.parentRevision
  )
    throw new Error("authorization_denied");
  return authorized;
}

function sourceGuard(row: TreeJobRow, grant: TreeJobGrant): SqlStatement {
  if (row.kind === "node.trash")
    return assertExists(
      `SELECT 1 FROM nodes n JOIN spaces s ON s.id=n.space_id
      WHERE n.id=? AND n.space_id=? AND n.parent_id=? AND n.revision=?
        AND n.deleted_at IS NULL AND s.tree_generation=?`,
      [
        grant.rootNodeId,
        row.space_id,
        grant.parentId,
        grant.sourceRevision,
        grant.sourceTreeGeneration,
      ],
    );
  return assertExists(
    `SELECT 1 FROM trash_ops t JOIN nodes n ON n.id=t.root_node_id AND n.space_id=t.space_id
    JOIN spaces s ON s.id=t.space_id
    WHERE t.op_id=? AND t.space_id=? AND t.actor_id=? AND t.root_node_id=?
      AND t.state='trashed' AND n.deleted_op_id=t.op_id AND n.deleted_at IS NOT NULL
      AND n.revision=? AND s.tree_generation=?`,
    [
      grant.trashOpId,
      row.space_id,
      row.owner_id,
      grant.rootNodeId,
      grant.sourceRevision,
      grant.sourceTreeGeneration,
    ],
  );
}

async function processManifest(
  env: SystemMutationSource,
  row: TreeJobRow,
  token: string,
  deadline: number,
): Promise<TreeJobResult> {
  const grant = parseTreeJobGrant(row.grant_snapshot);
  const checkpoint = parseTreeJobCheckpoint(row.checkpoint);
  if (checkpoint.phase !== "manifest") return "retry";
  const principal = savedPrincipal(row);
  if (!principal)
    return failTreeJobInternal(env, row, "mutation_rejected", deadline, undefined, token);
  let authorized;
  try {
    authorized = await currentAuthorization(env.DB, row, grant, principal);
  } catch {
    return failTreeJobInternal(env, row, "mutation_rejected", deadline, undefined, token);
  }
  const result =
    row.kind === "node.trash"
      ? await trashMembers(env.DB, row, checkpoint.cursor)
      : await trashedMembers(env.DB, row, grant, checkpoint.cursor);
  const members = result.results.slice(0, ASYNC_TREE_CHUNK_NODES);
  const hasMore = result.results.length > ASYNC_TREE_CHUNK_NODES;
  if (
    row.node_count + members.length > ASYNC_TREE_MAX_NODES ||
    (row.node_count + members.length === ASYNC_TREE_MAX_NODES && hasMore)
  )
    return failTreeJobInternal(env, row, "tree_too_large", deadline, undefined, token);
  if (members.length === 0 && row.node_count < 1)
    return failTreeJobInternal(env, row, "mutation_rejected", deadline, undefined, token);
  const nextCursor = members.at(-1)?.id ?? checkpoint.cursor;
  const nextPhase = hasMore ? "manifest" : "finalize";
  const manifest =
    row.kind === "node.trash"
      ? trashManifestStatements(row, members)
      : row.kind === "node.purge"
        ? purgeManifestStatements(row, members)
        : [];
  try {
    const admission = await acquireSystemMutation(env, row.owner_id, "tree-job.chunk", deadline);
    await commitSystemMutation(env.DB, admission, row.owner_id, [
      assertExactTreeJob(row),
      leaseAssertion(row, token),
      authorizationAssertion(authorized),
      sourceGuard(row, grant),
      ...manifest,
      {
        sql: `UPDATE bulk_jobs SET checkpoint=?,node_count=node_count+?,
          blob_count=CASE WHEN kind='node.purge'
            THEN (SELECT COUNT(*) FROM purge_blobs WHERE purge_op_id=bulk_jobs.op_id)
            ELSE blob_count END,
          dispatch_state='pending',dispatch_token=NULL,dispatch_expires_at=NULL,
          updated_at=MAX(updated_at,${clock})
        WHERE id=? AND checkpoint=? AND node_count=? AND state='running'
          AND dispatch_state='sent'`,
        values: [
          JSON.stringify({ phase: nextPhase, cursor: nextCursor }),
          members.length,
          row.id,
          row.checkpoint,
          row.node_count,
        ],
      },
      assertOneChange,
      { sql: "DELETE FROM job_leases WHERE job_id=? AND claim_token=?", values: [row.id, token] },
      assertOneChange,
    ]);
  } catch {
    return "retry";
  }
  return "progressed";
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
        `SELECT name_ci FROM nodes WHERE parent_id=? AND deleted_at IS NULL AND name_ci IN (${group
          .map(() => "?")
          .join(",")})`,
      )
      .bind(parentId, ...group.map(({ nameCi }) => nameCi))
      .all<{ name_ci: string }>();
    const used = new Set(rows.results.map(({ name_ci }) => name_ci));
    const candidate = group.find(({ nameCi }) => !used.has(nameCi));
    if (candidate) return candidate;
  }
  throw new Error("name_conflict");
}

function finishJobStatements(
  row: TreeJobRow,
  token: string,
  result: { status: number; nodeId: string },
): SqlStatement[] {
  return [
    {
      sql: `UPDATE operations SET state='committed',result_json=?,updated_at=MAX(updated_at,${clock})
      WHERE op_id=? AND state='claimed' AND expected_steps=1
        AND (SELECT COUNT(*) FROM operation_steps WHERE op_id=?)=1`,
      values: [JSON.stringify(result), row.op_id, row.op_id],
    },
    assertOneChange,
    {
      sql: `UPDATE bulk_jobs SET state='completed',checkpoint=?,dispatch_state='completed',
        dispatch_token=NULL,dispatch_expires_at=NULL,updated_at=MAX(updated_at,${clock})
      WHERE id=? AND state='running' AND checkpoint=? AND dispatch_state='sent'`,
      values: [
        JSON.stringify({
          phase: "completed",
          cursor: parseTreeJobCheckpoint(row.checkpoint).cursor,
        }),
        row.id,
        row.checkpoint,
      ],
    },
    assertOneChange,
    { sql: "DELETE FROM job_leases WHERE job_id=? AND claim_token=?", values: [row.id, token] },
    assertOneChange,
  ];
}

function trashFinalStatements(
  row: TreeJobRow,
  grant: TreeJobGrant,
  token: string,
  authorized: Extract<Awaited<ReturnType<typeof authorizeNode>>, { operation: "node.trash" }>,
): SqlStatement[] {
  const members = "SELECT node_id FROM trash_members WHERE trash_op_id=?";
  return [
    assertExactTreeJob(row),
    leaseAssertion(row, token),
    authorizationAssertion(authorized),
    assertTrashLocks(grant.rootNodeId, row.space_id, authorized.principal, grant.lockTokenHashes),
    assertExists(
      `SELECT 1 FROM trash_ops t JOIN nodes n ON n.id=t.root_node_id AND n.space_id=t.space_id
      WHERE t.op_id=? AND t.state='pending' AND t.actor_id=? AND t.space_id=?
        AND t.root_node_id=? AND t.epoch=? AND n.parent_id=? AND n.revision=?
        AND n.deleted_at IS NULL
        AND (SELECT COUNT(*) FROM trash_members WHERE trash_op_id=t.op_id)=?
        AND EXISTS(SELECT 1 FROM spaces s WHERE s.id=t.space_id AND s.tree_generation=?)`,
      [
        row.op_id,
        row.owner_id,
        row.space_id,
        grant.rootNodeId,
        row.epoch,
        grant.parentId,
        grant.sourceRevision,
        row.node_count,
        grant.sourceTreeGeneration,
      ],
    ),
    {
      sql: `UPDATE nodes SET deleted_at=${clock},deleted_op_id=?,orig_parent_id=parent_id,
        last_op_id=?,updated_at=MAX(updated_at,${clock})
      WHERE id IN (${members}) AND deleted_at IS NULL`,
      values: [row.op_id, row.op_id, row.op_id],
    },
    {
      sql: "INSERT INTO _assert(v) SELECT 1 WHERE changes()<>?",
      values: [row.node_count],
    },
    {
      sql: `UPDATE nodes SET revision=revision+1,last_op_id=?,updated_at=MAX(updated_at,${clock})
      WHERE id=? AND revision=? AND deleted_at IS NULL AND kind IN ('root','folder')`,
      values: [row.op_id, grant.parentId, grant.parentRevision],
    },
    assertOneChange,
    {
      sql: "UPDATE spaces SET tree_generation=tree_generation+1 WHERE id=? AND tree_generation=?",
      values: [row.space_id, grant.sourceTreeGeneration],
    },
    assertOneChange,
    { sql: `DELETE FROM locks WHERE node_id IN (${members})`, values: [row.op_id] },
    {
      sql: `UPDATE shares SET disabled_at=${clock},version=version+1
        WHERE root_node_id IN (${members}) AND disabled_at IS NULL`,
      values: [row.op_id],
    },
    {
      sql: `UPDATE share_sessions SET revoked_at=${clock} WHERE revoked_at IS NULL
        AND share_id IN (SELECT id FROM shares WHERE root_node_id IN (${members}))`,
      values: [row.op_id],
    },
    {
      sql: `UPDATE tickets SET cancelled_at=${clock} WHERE cancelled_at IS NULL
        AND target_set_id IN (SELECT id FROM target_sets WHERE owner_id=?)`,
      values: [row.owner_id],
    },
    {
      sql: `UPDATE content_sessions SET revoked_at=${clock} WHERE revoked_at IS NULL
        AND target_set_id IN (SELECT id FROM target_sets WHERE owner_id=?)`,
      values: [row.owner_id],
    },
    {
      sql: `INSERT INTO activity(id,op_id,actor_id,kind,affected_id,created_at)
        VALUES(?,?,?,?,?,${clock})`,
      values: [`${row.op_id}_activity`, row.op_id, row.owner_id, row.kind, grant.rootNodeId],
    },
    {
      sql: `INSERT INTO outbox(outbox_id,op_id,kind,payload_ref,state,epoch,created_at,updated_at)
        VALUES(?,?,'node.trashed',?,'pending',?,${clock},${clock})`,
      values: [`${row.op_id}_event`, row.op_id, grant.rootNodeId, row.epoch],
    },
    {
      sql: "UPDATE trash_ops SET state='trashed' WHERE op_id=? AND state='pending'",
      values: [row.op_id],
    },
    assertOneChange,
    ...finishJobStatements(row, token, { status: 204, nodeId: grant.rootNodeId }),
  ];
}

async function restoreFinalStatements(
  db: D1Database,
  row: TreeJobRow,
  grant: TreeJobGrant,
  token: string,
  authorized: Extract<Awaited<ReturnType<typeof authorizeNode>>, { operation: "node.create" }>,
  pause: RestorePause,
): Promise<SqlStatement[]> {
  const root = await primary(db)
    .prepare("SELECT name FROM nodes WHERE id=? AND space_id=? AND deleted_op_id=?")
    .bind(grant.rootNodeId, row.space_id, grant.trashOpId)
    .first<string>("name");
  if (!root) throw new Error("authorization_denied");
  const name = await availableName(db, grant.parentId, root);
  const search = searchName(name.name);
  const levels = await primary(db)
    .prepare(
      `WITH RECURSIVE d(id,depth) AS (
        SELECT id,0 FROM nodes WHERE id=? AND space_id=? AND deleted_op_id=?
        UNION ALL SELECT n.id,d.depth+1 FROM nodes n JOIN d ON n.parent_id=d.id
          JOIN trash_members tm ON tm.node_id=n.id AND tm.trash_op_id=?
          WHERE d.depth<64 AND n.space_id=? AND n.deleted_op_id=?
      ) SELECT depth,COUNT(*) AS count FROM d WHERE depth>0 GROUP BY depth ORDER BY depth`,
    )
    .bind(
      grant.rootNodeId,
      row.space_id,
      grant.trashOpId,
      grant.trashOpId,
      row.space_id,
      grant.trashOpId,
    )
    .all<{ depth: number; count: number }>();
  if (levels.results.reduce((total, level) => total + level.count, 1) !== row.node_count)
    throw new Error("authorization_denied");
  const statements: SqlStatement[] = [
    assertExactTreeJob(row),
    leaseAssertion(row, token),
    authorizationAssertion(authorized),
    sourceGuard(row, grant),
    assertCreateLocks(grant.parentId, row.space_id, authorized.principal, grant.lockTokenHashes),
    assertRestorePause(pause, row.op_id),
    privateEncryptedRestoreAssertion(grant.trashOpId, grant.parentId, row.space_id),
    assertExists(
      `SELECT 1 FROM trash_ops t JOIN nodes n ON n.id=t.root_node_id AND n.space_id=t.space_id
      WHERE t.op_id=? AND t.state='trashed' AND t.actor_id=? AND t.space_id=?
        AND t.root_node_id=? AND n.deleted_op_id=t.op_id AND n.deleted_at IS NOT NULL
        AND (SELECT COUNT(*) FROM trash_members WHERE trash_op_id=t.op_id)=?
        AND NOT EXISTS(SELECT 1 FROM trash_members tm LEFT JOIN nodes m ON m.id=tm.node_id
          WHERE tm.trash_op_id=t.op_id AND
            (m.id IS NULL OR m.space_id<>t.space_id OR m.deleted_op_id<>t.op_id OR m.deleted_at IS NULL))
        AND NOT EXISTS(SELECT 1 FROM trash_members tm JOIN nodes m ON m.id=tm.node_id
          JOIN blobs b ON b.id=m.current_blob_id
          WHERE tm.trash_op_id=t.op_id AND b.state IN ('deleting','deleted'))
        AND NOT EXISTS(SELECT 1 FROM trash_members tm JOIN node_versions v ON v.node_id=tm.node_id
          JOIN blobs b ON b.id=v.blob_id
          WHERE tm.trash_op_id=t.op_id AND b.state IN ('deleting','deleted'))`,
      [grant.trashOpId, row.owner_id, row.space_id, grant.rootNodeId, row.node_count],
    ),
    {
      sql: "UPDATE trash_ops SET state='restoring' WHERE op_id=? AND state='trashed'",
      values: [grant.trashOpId],
    },
    assertOneChange,
    {
      sql: `UPDATE nodes SET parent_id=?,name=?,name_ci=?,hidden=?,deleted_at=NULL,
        deleted_op_id=NULL,orig_parent_id=NULL,revision=revision+1,last_op_id=?,
        updated_at=MAX(updated_at,${clock})
      WHERE id=? AND deleted_op_id=? AND deleted_at IS NOT NULL`,
      values: [
        grant.parentId,
        name.name,
        name.nameCi,
        name.hidden ? 1 : 0,
        row.op_id,
        grant.rootNodeId,
        grant.trashOpId,
      ],
    },
    assertOneChange,
    ...levels.results.flatMap(({ depth, count }) => [
      {
        sql: `WITH RECURSIVE d(id,depth) AS (
          SELECT id,0 FROM nodes WHERE id=? AND deleted_at IS NULL
          UNION ALL SELECT n.id,d.depth+1 FROM nodes n JOIN d ON n.parent_id=d.id
            JOIN trash_members tm ON tm.node_id=n.id AND tm.trash_op_id=?
            WHERE d.depth<?
        ) UPDATE nodes SET deleted_at=NULL,deleted_op_id=NULL,orig_parent_id=NULL,
          last_op_id=?,updated_at=MAX(updated_at,${clock})
          WHERE deleted_op_id=? AND deleted_at IS NOT NULL
            AND id IN (SELECT id FROM d WHERE depth=?)`,
        values: [grant.rootNodeId, grant.trashOpId, depth, row.op_id, grant.trashOpId, depth],
      },
      { sql: "INSERT INTO _assert(v) SELECT 1 WHERE changes()<>?", values: [count] },
    ]),
    {
      sql: `UPDATE nodes SET revision=revision+1,last_op_id=?,updated_at=MAX(updated_at,${clock})
      WHERE id=? AND revision=? AND deleted_at IS NULL`,
      values: [row.op_id, grant.parentId, grant.parentRevision],
    },
    assertOneChange,
    {
      sql: "UPDATE spaces SET tree_generation=tree_generation+1 WHERE id=? AND tree_generation=?",
      values: [row.space_id, authorized.parent.tree_generation],
    },
    assertOneChange,
    {
      sql: `INSERT INTO search_fts(search_fts,rowid,text_norm,tokens)
        SELECT 'delete',rowid,text_norm,tokens FROM search_index WHERE node_id=?`,
      values: [grant.rootNodeId],
    },
    assertOneChange,
    {
      sql: `UPDATE search_index SET text_norm=?,tokens=?,normalization_version=?,
        revision=revision+1 WHERE node_id=?`,
      values: [search.textNorm, search.tokens, search.version, grant.rootNodeId],
    },
    assertOneChange,
    {
      sql: `INSERT INTO search_fts(rowid,text_norm,tokens)
        SELECT rowid,text_norm,tokens FROM search_index WHERE node_id=?`,
      values: [grant.rootNodeId],
    },
    assertOneChange,
    {
      sql: `INSERT INTO activity(id,op_id,actor_id,kind,affected_id,created_at)
        VALUES(?,?,?,?,?,${clock})`,
      values: [`${row.op_id}_activity`, row.op_id, row.owner_id, "node.restore", grant.rootNodeId],
    },
    {
      sql: `INSERT INTO outbox(outbox_id,op_id,kind,payload_ref,state,epoch,created_at,updated_at)
        VALUES(?,?,'node.restored',?,'pending',?,${clock},${clock})`,
      values: [`${row.op_id}_event`, row.op_id, grant.rootNodeId, row.epoch],
    },
    {
      sql: "UPDATE trash_ops SET state='restored' WHERE op_id=? AND state='restoring'",
      values: [grant.trashOpId],
    },
    assertOneChange,
    ...finishJobStatements(row, token, { status: 200, nodeId: grant.rootNodeId }),
  ];
  return statements;
}

function absent(sql: string, values: readonly (string | number | null)[]): SqlStatement {
  return assertExists(`SELECT 1 WHERE NOT EXISTS(${sql})`, values);
}

async function purgeFinalStatements(
  db: D1Database,
  row: TreeJobRow,
  grant: TreeJobGrant,
  token: string,
  authorized: Exclude<
    Awaited<ReturnType<typeof authorizeNode>>,
    { readonly operation: "node.create" }
  >,
): Promise<SqlStatement[]> {
  const members = "SELECT node_id FROM purge_members WHERE purge_op_id=?";
  const levels = await primary(db)
    .prepare(
      "SELECT depth,COUNT(*) AS count FROM purge_members WHERE purge_op_id=? GROUP BY depth ORDER BY depth DESC",
    )
    .bind(row.op_id)
    .all<{ depth: number; count: number }>();
  const currentMembers = await primary(db)
    .prepare(
      `SELECT COUNT(*) AS count FROM purge_members pm
      JOIN trash_members tm ON tm.node_id=pm.node_id AND tm.trash_op_id=?
      JOIN nodes n ON n.id=pm.node_id
      WHERE pm.purge_op_id=? AND n.space_id=? AND n.deleted_op_id=? AND n.deleted_at IS NOT NULL`,
    )
    .bind(grant.trashOpId, row.op_id, row.space_id, grant.trashOpId)
    .first<number>("count");
  if (
    currentMembers !== row.node_count ||
    levels.results.reduce((total, level) => total + level.count, 0) !== row.node_count
  )
    throw new Error("authorization_denied");
  const searchCount = await primary(db)
    .prepare(
      `SELECT COUNT(*) AS count FROM search_index
      WHERE node_id IN (SELECT node_id FROM purge_members WHERE purge_op_id=?)`,
    )
    .bind(row.op_id)
    .first<number>("count");
  if (searchCount === null) throw new Error("authorization_denied");
  const statements: SqlStatement[] = [
    assertExactTreeJob(row),
    leaseAssertion(row, token),
    authorizationAssertion(authorized),
    sourceGuard(row, grant),
    assertExists(
      `SELECT 1 FROM trash_ops t JOIN nodes n ON n.id=t.root_node_id AND n.space_id=t.space_id
      WHERE t.op_id=? AND t.state='trashed' AND t.actor_id=? AND t.space_id=?
        AND t.root_node_id=? AND n.deleted_op_id=t.op_id AND n.deleted_at IS NOT NULL
        AND (SELECT COUNT(*) FROM trash_members WHERE trash_op_id=t.op_id)=?
        AND (SELECT COUNT(*) FROM purge_members WHERE purge_op_id=?)=?`,
      [
        grant.trashOpId,
        row.owner_id,
        row.space_id,
        grant.rootNodeId,
        row.node_count,
        row.op_id,
        row.node_count,
      ],
    ),
    {
      sql: "UPDATE trash_ops SET state='purging' WHERE op_id=? AND state='trashed'",
      values: [grant.trashOpId],
    },
    assertOneChange,
    {
      sql: `UPDATE nodes SET parent_id=NULL WHERE deleted_at IS NOT NULL AND deleted_op_id<>?
        AND parent_id IN (${members})`,
      values: [grant.trashOpId, row.op_id],
    },
    absent(
      `SELECT 1 FROM nodes WHERE deleted_at IS NOT NULL AND deleted_op_id<>?
        AND parent_id IN (${members})`,
      [grant.trashOpId, row.op_id],
    ),
    {
      sql: `DELETE FROM credential_scopes WHERE credential_id IN (
        SELECT c.id FROM credentials c LEFT JOIN app_passwords ap ON ap.id=c.app_password_id
        LEFT JOIN service_principals sp ON sp.id=c.service_principal_id
        WHERE ap.root_node_id IN (${members}) OR sp.root_node_id IN (${members}))`,
      values: [row.op_id, row.op_id],
    },
    absent(
      `SELECT 1 FROM credential_scopes cs JOIN credentials c ON c.id=cs.credential_id
        LEFT JOIN app_passwords ap ON ap.id=c.app_password_id
        LEFT JOIN service_principals sp ON sp.id=c.service_principal_id
        WHERE ap.root_node_id IN (${members}) OR sp.root_node_id IN (${members})`,
      [row.op_id, row.op_id],
    ),
    {
      sql: `UPDATE app_passwords SET root_node_id=NULL,
        revoked_at=COALESCE(revoked_at,${clock}) WHERE root_node_id IN (${members})`,
      values: [row.op_id],
    },
    absent(`SELECT 1 FROM app_passwords WHERE root_node_id IN (${members})`, [row.op_id]),
    {
      sql: `UPDATE service_principals SET root_node_id=NULL,
        disabled_at=COALESCE(disabled_at,${clock}) WHERE root_node_id IN (${members})`,
      values: [row.op_id],
    },
    absent(`SELECT 1 FROM service_principals WHERE root_node_id IN (${members})`, [row.op_id]),
    {
      sql: `DELETE FROM share_grants
        WHERE share_id IN (SELECT id FROM shares WHERE root_node_id IN (${members}))`,
      values: [row.op_id],
    },
    absent(
      `SELECT 1 FROM share_grants
        WHERE share_id IN (SELECT id FROM shares WHERE root_node_id IN (${members}))`,
      [row.op_id],
    ),
    {
      sql: `DELETE FROM share_group_grants
        WHERE share_id IN (SELECT id FROM shares WHERE root_node_id IN (${members}))`,
      values: [row.op_id],
    },
    absent(
      `SELECT 1 FROM share_group_grants
        WHERE share_id IN (SELECT id FROM shares WHERE root_node_id IN (${members}))`,
      [row.op_id],
    ),
    {
      sql: `DELETE FROM share_actions
        WHERE share_id IN (SELECT id FROM shares WHERE root_node_id IN (${members}))`,
      values: [row.op_id],
    },
    absent(
      `SELECT 1 FROM share_actions
        WHERE share_id IN (SELECT id FROM shares WHERE root_node_id IN (${members}))`,
      [row.op_id],
    ),
    {
      sql: `UPDATE shares SET root_node_id=NULL,disabled_at=COALESCE(disabled_at,${clock}),
        version=version+1 WHERE root_node_id IN (${members})`,
      values: [row.op_id],
    },
    absent(`SELECT 1 FROM shares WHERE root_node_id IN (${members})`, [row.op_id]),
    {
      sql: `DELETE FROM upload_parts WHERE upload_id IN (
        SELECT id FROM uploads WHERE parent_id IN (${members}) OR target_id IN (${members}))`,
      values: [row.op_id, row.op_id],
    },
    absent(
      `SELECT 1 FROM upload_parts WHERE upload_id IN (
        SELECT id FROM uploads WHERE parent_id IN (${members}) OR target_id IN (${members}))`,
      [row.op_id, row.op_id],
    ),
    {
      sql: `UPDATE reservations SET state='released' WHERE state='reserved' AND id IN (
        SELECT reservation_id FROM uploads
        WHERE parent_id IN (${members}) OR target_id IN (${members}))`,
      values: [row.op_id, row.op_id],
    },
    absent(
      `SELECT 1 FROM reservations r JOIN uploads u ON u.reservation_id=r.id
        WHERE r.state='reserved'
          AND (u.parent_id IN (${members}) OR u.target_id IN (${members}))`,
      [row.op_id, row.op_id],
    ),
    {
      sql: `DELETE FROM uploads WHERE parent_id IN (${members}) OR target_id IN (${members})`,
      values: [row.op_id, row.op_id],
    },
    absent(`SELECT 1 FROM uploads WHERE parent_id IN (${members}) OR target_id IN (${members})`, [
      row.op_id,
      row.op_id,
    ]),
  ];
  const deletes: readonly [string, string][] = [
    ["copy_members", `source_node_id IN (${members})`],
    ["node_props", `node_id IN (${members})`],
    ["user_node_state", `node_id IN (${members})`],
    ["node_tags", `node_id IN (${members})`],
    ["node_media", `node_id IN (${members})`],
    ["library_items", `node_id IN (${members})`],
    ["archive_index", `node_id IN (${members})`],
    ["library_roots", `node_id IN (${members})`],
    ["node_audio", `node_id IN (${members})`],
    ["user_reading_state", `node_id IN (${members})`],
    ["user_playback_state", `node_id IN (${members})`],
    ["locks", `node_id IN (${members})`],
    ["node_versions", `node_id IN (${members})`],
  ];
  for (const [table, predicate] of deletes) {
    statements.push(
      { sql: `DELETE FROM ${table} WHERE ${predicate}`, values: [row.op_id] },
      absent(`SELECT 1 FROM ${table} WHERE ${predicate}`, [row.op_id]),
    );
  }
  statements.push(
    {
      sql: `INSERT INTO search_fts(search_fts,rowid,text_norm,tokens)
        SELECT 'delete',rowid,text_norm,tokens FROM search_index
        WHERE node_id IN (${members})`,
      values: [row.op_id],
    },
    { sql: "INSERT INTO _assert(v) SELECT 1 WHERE changes()<>?", values: [searchCount] },
    {
      sql: `DELETE FROM search_index WHERE node_id IN (${members})`,
      values: [row.op_id],
    },
    absent(`SELECT 1 FROM search_index WHERE node_id IN (${members})`, [row.op_id]),
    {
      sql: `DELETE FROM trash_members WHERE node_id IN (${members})`,
      values: [row.op_id],
    },
    absent(`SELECT 1 FROM trash_members WHERE node_id IN (${members})`, [row.op_id]),
  );
  for (const { depth, count } of levels.results)
    statements.push(
      {
        sql: `DELETE FROM nodes
          WHERE id IN (SELECT node_id FROM purge_members WHERE purge_op_id=? AND depth=?)`,
        values: [row.op_id, depth],
      },
      { sql: "INSERT INTO _assert(v) SELECT 1 WHERE changes()<>?", values: [count] },
    );
  statements.push(
    {
      sql: `UPDATE blobs SET state='gc_candidate',last_op_id=? WHERE ref_count=0
        AND state NOT IN ('deleting','deleted')
        AND id IN (SELECT blob_id FROM purge_blobs WHERE purge_op_id=?)`,
      values: [row.op_id, row.op_id],
    },
    absent(
      `SELECT 1 FROM blobs WHERE ref_count=0 AND state NOT IN ('gc_candidate','deleting','deleted')
        AND id IN (SELECT blob_id FROM purge_blobs WHERE purge_op_id=?)`,
      [row.op_id],
    ),
    {
      sql: `INSERT OR IGNORE INTO gc_candidates(blob_id,trash_op_id,state,not_before)
        SELECT b.id,?,'candidate',${GC_NOT_BEFORE_SQL}
        FROM blobs b JOIN purge_blobs p ON p.blob_id=b.id
      WHERE p.purge_op_id=? AND b.state NOT IN ('deleting','deleted')`,
      values: [grant.trashOpId, row.op_id],
    },
    absent(
      `SELECT 1 FROM blobs b JOIN purge_blobs p ON p.blob_id=b.id
        WHERE p.purge_op_id=? AND b.state NOT IN ('deleting','deleted')
          AND NOT EXISTS(SELECT 1 FROM gc_candidates g WHERE g.blob_id=b.id)`,
      [row.op_id],
    ),
    {
      sql: "UPDATE spaces SET tree_generation=tree_generation+1 WHERE id=? AND tree_generation=?",
      values: [row.space_id, authorized.node.tree_generation],
    },
    assertOneChange,
    {
      sql: `INSERT INTO activity(id,op_id,actor_id,kind,affected_id,created_at)
        VALUES(?,?,?,?,?,${clock})`,
      values: [`${row.op_id}_activity`, row.op_id, row.owner_id, "node.purge", grant.rootNodeId],
    },
    {
      sql: `INSERT INTO outbox(outbox_id,op_id,kind,payload_ref,state,epoch,created_at,updated_at)
        VALUES(?,?,'node.purged',?,'pending',?,${clock},${clock})`,
      values: [`${row.op_id}_event`, row.op_id, grant.rootNodeId, row.epoch],
    },
    {
      sql: "UPDATE trash_ops SET state='purged' WHERE op_id=? AND state='purging'",
      values: [grant.trashOpId],
    },
    assertOneChange,
    ...finishJobStatements(row, token, { status: 200, nodeId: grant.rootNodeId }),
  );
  return statements;
}

async function processFinalize(
  env: TreeWorkerEnv,
  row: TreeJobRow,
  token: string,
  deadline: number,
): Promise<TreeJobResult> {
  const grant = parseTreeJobGrant(row.grant_snapshot);
  if (
    parseTreeJobCheckpoint(row.checkpoint).phase !== "finalize" ||
    row.node_count <= 1_000 ||
    row.node_count > ASYNC_TREE_MAX_NODES
  )
    return failTreeJobInternal(env, row, "mutation_rejected", deadline, undefined, token);
  const principal = savedPrincipal(row);
  if (!principal)
    return failTreeJobInternal(env, row, "mutation_rejected", deadline, undefined, token);
  let authorized;
  try {
    authorized = await currentAuthorization(env.DB, row, grant, principal);
  } catch {
    return failTreeJobInternal(env, row, "mutation_rejected", deadline, undefined, token);
  }
  let pause: (RestorePause & { ready: boolean }) | null = null;
  try {
    let statements: SqlStatement[];
    if (row.kind === "node.trash") {
      if (authorized.operation !== "node.trash") throw new Error("authorization_denied");
      statements = trashFinalStatements(row, grant, token, authorized);
    } else if (row.kind === "node.restore") {
      if (authorized.operation !== "node.create" || !("CONTROL" in env) || !env.CONTROL)
        throw new Error("mutation_unavailable");
      const control = env.CONTROL.get(env.CONTROL.idFromName(CONTROL_NAME));
      pause = await control.acquireRestorePause(row.epoch, row.op_id);
      if (!pause.ready) return "retry";
      statements = await restoreFinalStatements(env.DB, row, grant, token, authorized, pause);
    } else {
      if (authorized.operation !== "node.read") throw new Error("authorization_denied");
      statements = await purgeFinalStatements(env.DB, row, grant, token, authorized);
    }
    const admission = await acquireSystemMutation(env, row.owner_id, "tree-job.finalize", deadline);
    await commitSystemMutation(env.DB, admission, row.owner_id, statements);
    return "completed";
  } catch (error) {
    if (
      error instanceof Error &&
      ["authorization_denied", "name_conflict", "blob_unrecoverable"].includes(error.message)
    )
      return failTreeJobInternal(
        env,
        row,
        error.message === "authorization_denied" ? "mutation_rejected" : error.message,
        deadline,
        undefined,
        token,
      );
    return "retry";
  } finally {
    if (pause && "CONTROL" in env && env.CONTROL)
      try {
        await env.CONTROL.get(env.CONTROL.idFromName(CONTROL_NAME)).releaseRestorePause(
          row.epoch,
          pause.token,
        );
      } catch {
        /* Alarm recovery reconciles a lost release acknowledgement. */
      }
  }
}

async function failTreeJobInternal(
  env: SystemMutationSource,
  row: TreeJobRow,
  errorCode: string,
  deadline = Date.now() + 25_000,
  terminalGuard?: SqlStatement,
  claimToken?: string,
): Promise<"failed" | "retry"> {
  if (!/^[a-z_]{1,64}$/.test(errorCode)) errorCode = "operation_failed";
  try {
    const admission = await acquireSystemMutation(env, row.owner_id, "tree-job.fail", deadline);
    const statements: SqlStatement[] = [assertExactTreeJob(row)];
    statements.push(
      claimToken
        ? leaseAssertion(row, claimToken)
        : absent(`SELECT 1 FROM job_leases WHERE job_id=? AND expires_at>${clock}`, [row.id]),
    );
    if (terminalGuard) statements.push(terminalGuard, assertOneChange);
    if (row.kind === "node.trash") {
      statements.push(
        {
          sql: "DELETE FROM trash_members WHERE trash_op_id=?",
          values: [row.op_id],
        },
        {
          sql: "DELETE FROM trash_ops WHERE op_id=? AND state='pending'",
          values: [row.op_id],
        },
        assertOneChange,
      );
    } else if (row.kind === "node.purge") {
      statements.push(
        { sql: "DELETE FROM purge_blobs WHERE purge_op_id=?", values: [row.op_id] },
        { sql: "DELETE FROM purge_members WHERE purge_op_id=?", values: [row.op_id] },
      );
    }
    statements.push(
      { sql: "DELETE FROM job_leases WHERE job_id=?", values: [row.id] },
      {
        sql: `UPDATE operations SET state='failed',error_code=?,updated_at=MAX(updated_at,${clock})
        WHERE op_id=? AND state='claimed'`,
        values: [errorCode, row.op_id],
      },
      assertOneChange,
      {
        sql: `UPDATE bulk_jobs SET state='failed',error_code=?,checkpoint=?,
          dispatch_state='failed',dispatch_token=NULL,dispatch_expires_at=NULL,
          updated_at=MAX(updated_at,${clock})
        WHERE id=? AND state IN ('pending','running')`,
        values: [
          errorCode,
          JSON.stringify({
            phase: "failed",
            cursor: parseTreeJobCheckpoint(row.checkpoint).cursor,
          }),
          row.id,
        ],
      },
      assertOneChange,
    );
    await commitSystemMutation(env.DB, admission, row.owner_id, statements);
    return "failed";
  } catch {
    const current = await treeJobRow(env.DB, row.id);
    return current?.state === "failed" && current.operation_state === "failed" ? "failed" : "retry";
  }
}

export async function failTreeJob(
  env: SystemMutationSource,
  row: TreeJobRow,
  errorCode: string,
  deadline = Date.now() + 25_000,
): Promise<"failed" | "retry"> {
  return failTreeJobInternal(env, row, errorCode, deadline);
}

interface TreeJobExhaustionState {
  invocation_count: number;
  attempt: number | null;
  lease_expired: number | null;
}

async function failExhaustedTreeJob(
  env: SystemMutationSource,
  row: TreeJobRow,
  deadline: number,
): Promise<"failed" | "retry"> {
  const state = await primary(env.DB)
    .prepare(`SELECT j.invocation_count,l.attempt,
      CASE WHEN l.expires_at<=${clock} THEN 1 ELSE 0 END AS lease_expired
      FROM bulk_jobs j LEFT JOIN job_leases l ON l.job_id=j.id WHERE j.id=?`)
    .bind(row.id)
    .first<TreeJobExhaustionState>();
  if (!state) return "retry";

  const exhaustedInvocations = state.invocation_count >= 200;
  const exhaustedClaims =
    !exhaustedInvocations &&
    state.attempt !== null &&
    state.attempt >= 10 &&
    state.lease_expired === 1;
  if (!exhaustedInvocations && !exhaustedClaims) return "retry";

  const exhaustionPredicate = exhaustedInvocations
    ? "j.invocation_count>=200"
    : `EXISTS(SELECT 1 FROM job_leases old_lease WHERE old_lease.job_id=j.id
        AND old_lease.attempt>=10 AND old_lease.expires_at<=${clock})`;
  const guard: SqlStatement = {
    sql: `UPDATE bulk_jobs SET updated_at=MAX(updated_at,${clock})
      WHERE id=? AND epoch=? AND state IN ('pending','running')
        AND EXISTS(SELECT 1 FROM operations o WHERE o.op_id=bulk_jobs.op_id
          AND o.state='claimed' AND o.epoch=bulk_jobs.epoch)
        AND ${exhaustionPredicate.replaceAll("j.", "bulk_jobs.")}
        AND NOT EXISTS(SELECT 1 FROM job_leases active_lease
          WHERE active_lease.job_id=bulk_jobs.id AND active_lease.expires_at>${clock})`,
    values: [row.id, row.epoch],
  };
  return failTreeJobInternal(
    env,
    row,
    exhaustedInvocations ? "invocation_limit_exhausted" : "claim_attempts_exhausted",
    deadline,
    guard,
  );
}

export async function processTreeJob(
  env: TreeWorkerEnv,
  id: string,
  deadline = Date.now() + 25_000,
): Promise<TreeJobResult> {
  if (!/^job_[a-f0-9]{64}$/.test(id) || Date.now() >= deadline) return "retry";
  const initial = await treeJobRow(env.DB, id);
  if (initial?.state === "completed" && initial.operation_state === "committed") return "completed";
  if (initial?.state === "failed" && initial.operation_state === "failed") return "failed";
  if (!initial || initial.operation_state !== "claimed") return "retry";
  const claimed = await claimTreeJob(env, initial, deadline);
  if (!claimed) {
    const current = await treeJobRow(env.DB, id);
    if (current && (await failExhaustedTreeJob(env, current, deadline)) === "failed")
      return "failed";
    return "busy";
  }
  const phase = parseTreeJobCheckpoint(claimed.row.checkpoint).phase;
  return phase === "manifest"
    ? processManifest(env, claimed.row, claimed.token, deadline)
    : phase === "finalize"
      ? processFinalize(env, claimed.row, claimed.token, deadline)
      : "retry";
}

export async function failStaleTreeJobs(
  env: SystemMutationSource,
  epoch: number,
  limit = 25,
): Promise<number> {
  const rows = await primary(env.DB)
    .prepare(`SELECT j.id FROM bulk_jobs j JOIN operations o ON o.op_id=j.op_id
      WHERE j.kind IN ('node.trash','node.restore','node.purge')
        AND j.state IN ('pending','running') AND o.state='claimed' AND j.epoch<>?
      ORDER BY j.updated_at,j.id LIMIT ?`)
    .bind(epoch, limit)
    .all<{ id: string }>();
  let failed = 0;
  for (const candidate of rows.results) {
    const row = await treeJobRow(env.DB, candidate.id);
    if (row && (await failTreeJob(env, row, "stale_epoch")) === "failed") failed++;
  }
  return failed;
}

/** Stopped jobs retain their source tree; only uncommitted setup is discarded. */
export async function reconcileStoppedTreeJobs(
  env: SystemMutationSource,
  epoch: number,
  limit = 20,
): Promise<number> {
  if (
    !Number.isSafeInteger(epoch) ||
    epoch < 1 ||
    !Number.isInteger(limit) ||
    limit < 1 ||
    limit > 20
  )
    throw new Error("invalid_tree_job_repair");
  const deadline = Date.now() + 25_000;
  const rows = await primary(env.DB)
    .prepare(`SELECT id FROM bulk_jobs WHERE kind IN ('node.trash','node.restore','node.purge')
      AND state IN ('pending','running') ORDER BY id LIMIT ?`)
    .bind(limit)
    .all<{ id: string }>();
  let reconciled = 0;
  for (const { id } of rows.results) {
    if (Date.now() >= deadline) break;
    const row = await treeJobRow(env.DB, id);
    if (!row || row.operation_state !== "failed") throw new Error("recovery_tree_job_provenance");
    const grant = parseTreeJobGrant(row.grant_snapshot);
    const checkpoint = parseTreeJobCheckpoint(row.checkpoint);
    if (!["manifest", "finalize"].includes(checkpoint.phase))
      throw new Error("recovery_tree_job_provenance");
    const admission = await acquireSystemMutation(env, row.owner_id, "tree-job.fail", deadline);
    if (admission.epoch !== epoch || admission.maintenance !== 1)
      throw new Error("recovery_tree_job_not_stopped");
    if (Date.now() >= deadline) throw new Error("recovery_repair_budget");
    const statements: SqlStatement[] = [
      repairFence(epoch, admission),
      assertExactTreeJob(row),
      assertExists(
        `SELECT 1 FROM control WHERE singleton=1 AND epoch=?
        AND maintenance=1 AND gc_paused=1 AND backup_token IS NULL AND backup_frozen=0 AND gc_hold_token IS NULL
        AND gc_hold_operation IS NULL AND gc_hold_expires_at IS NULL`,
        [epoch],
      ),
      assertExists(
        `SELECT 1 FROM bulk_jobs j JOIN operations o ON o.op_id=j.op_id
        JOIN spaces s ON s.id=o.space_id WHERE j.id=?
          AND j.id='job_'||substr(o.op_id,4) AND o.kind=j.kind AND o.epoch=j.epoch AND j.epoch<=?
          AND o.state='failed' AND o.error_code IN ('maintenance','stale_epoch')
          AND o.principal_kind='user' AND o.principal_id=j.owner_id AND s.owner_id=j.owner_id
          AND o.credential_id=j.credential_id AND o.expected_steps=1
          AND json_extract(o.operands_json,'$.nodeId')=?
          AND json_extract(o.operands_json,'$.parentId')=?
          AND (j.kind='node.trash' OR json_extract(o.operands_json,'$.trashOpId')=?)`,
        [id, epoch, grant.rootNodeId, grant.parentId, grant.trashOpId],
      ),
      absent(`SELECT 1 FROM job_leases WHERE job_id=? AND (epoch<>? OR expires_at>${clock})`, [
        id,
        row.epoch,
      ]),
      assertExists(
        `SELECT 1 FROM operation_steps WHERE op_id=? AND step_no=1
        AND kind='node' AND affected_id=?`,
        [row.op_id, grant.rootNodeId],
      ),
      absent("SELECT 1 FROM operation_steps WHERE op_id=? AND step_no<>1", [row.op_id]),
      absent("SELECT 1 FROM outbox WHERE op_id=?", [row.op_id]),
      absent("SELECT 1 FROM nodes WHERE deleted_op_id=?", [row.op_id]),
    ];
    if (row.kind === "node.trash") {
      if (grant.trashOpId !== row.op_id) throw new Error("recovery_tree_job_provenance");
      statements.push(
        assertExists(
          `SELECT 1 FROM trash_ops WHERE op_id=? AND state='pending'
          AND actor_id=? AND space_id=? AND root_node_id=? AND epoch=? AND reason='node.trash'`,
          [row.op_id, row.owner_id, row.space_id, grant.rootNodeId, row.epoch],
        ),
        { sql: "DELETE FROM trash_members WHERE trash_op_id=?", values: [row.op_id] },
        { sql: "DELETE FROM trash_ops WHERE op_id=? AND state='pending'", values: [row.op_id] },
        assertOneChange,
      );
    } else {
      statements.push(
        assertExists(
          `SELECT 1 FROM trash_ops WHERE op_id=? AND state='trashed'
          AND actor_id=? AND space_id=? AND root_node_id=? AND epoch<=?`,
          [grant.trashOpId, row.owner_id, row.space_id, grant.rootNodeId, row.epoch],
        ),
      );
      if (row.kind === "node.purge")
        statements.push(
          { sql: "DELETE FROM purge_blobs WHERE purge_op_id=?", values: [row.op_id] },
          { sql: "DELETE FROM purge_members WHERE purge_op_id=?", values: [row.op_id] },
        );
    }
    statements.push(
      {
        sql: `DELETE FROM job_leases WHERE job_id=? AND epoch=? AND expires_at<=${clock}`,
        values: [id, row.epoch],
      },
      {
        sql: `UPDATE bulk_jobs SET state='failed',error_code=(SELECT error_code FROM operations WHERE op_id=bulk_jobs.op_id),
        checkpoint=?,dispatch_state='failed',dispatch_token=NULL,dispatch_expires_at=NULL,
        updated_at=MAX(updated_at,${clock}) WHERE id=? AND state IN ('pending','running')`,
        values: [JSON.stringify({ phase: "failed", cursor: checkpoint.cursor }), id],
      },
      assertOneChange,
    );
    await commitSystemMutation(env.DB, admission, row.owner_id, statements);
    reconciled++;
  }
  return reconciled;
}
