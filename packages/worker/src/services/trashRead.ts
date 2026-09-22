import { authorizationAssertion, authorizeNode, type Principal } from "../auth/authorize";
import type { ListCursorTokens } from "../auth/listCursor";
import { assertExists, atomicBatch, primary, type SqlStatement } from "../db/primary";

const ID = /^[A-Za-z0-9_-]{1,128}$/;

interface TrashRow {
  opId: string;
  rootNodeId: string;
  name: string;
  kind: "folder" | "file";
  deletedAt: number;
  createdAt: number;
  purgeAfter: number | null;
  memberCount: number;
}

/** List an owner's trash with a current root proof and generation-bound keyset cursor. */
export async function listTrash(
  db: D1Database,
  principal: Principal,
  tokens: ListCursorTokens,
  spaceId: string,
  cursor?: string,
  limit = 200,
) {
  if (
    principal.kind !== "user" ||
    !ID.test(spaceId) ||
    !Number.isSafeInteger(limit) ||
    limit < 1 ||
    limit > 200
  )
    throw new Error("trash_unavailable");
  const rootId = await primary(db)
    .prepare("SELECT root_node_id FROM spaces WHERE id=? AND owner_id=?")
    .bind(spaceId, principal.user_id)
    .first<string>("root_node_id");
  if (!rootId) throw new Error("trash_unavailable");
  const proof = await authorizeNode(db, principal, {
    operation: "node.read",
    spaceId,
    nodeId: rootId,
  });
  if (
    proof.operation !== "node.read" ||
    proof.node.kind !== "root" ||
    proof.node.owner_id !== principal.user_id
  )
    throw new Error("trash_unavailable");

  let lastSort: number | undefined;
  let lastId: string | undefined;
  if (cursor !== undefined) {
    const claims = await tokens.verify(cursor);
    if (
      claims.scopeId !== spaceId ||
      claims.userId !== principal.user_id ||
      claims.credentialId !== principal.credential_id ||
      claims.epoch !== principal.epoch ||
      claims.generation !== proof.node.tree_generation
    )
      throw new Error("invalid_list_cursor");
    lastSort = claims.lastSort;
    lastId = claims.lastId;
  }
  const statement: SqlStatement =
    lastSort === undefined
      ? {
          sql: `SELECT t.op_id AS opId,t.root_node_id AS rootNodeId,n.name,n.kind,
            n.deleted_at AS deletedAt,t.created_at AS createdAt,t.purge_after AS purgeAfter,
            (SELECT COUNT(*) FROM trash_members tm WHERE tm.trash_op_id=t.op_id) AS memberCount
            FROM trash_ops t INDEXED BY trash_ops_space_created_keyset
            JOIN nodes n ON n.id=t.root_node_id AND n.space_id=t.space_id
              AND n.deleted_op_id=t.op_id AND n.deleted_at IS NOT NULL
            WHERE t.space_id=? AND t.actor_id=? AND t.state='trashed'
            ORDER BY t.created_at DESC,t.op_id DESC LIMIT ?`,
          values: [spaceId, principal.user_id, limit + 1],
        }
      : {
          sql: `SELECT t.op_id AS opId,t.root_node_id AS rootNodeId,n.name,n.kind,
            n.deleted_at AS deletedAt,t.created_at AS createdAt,t.purge_after AS purgeAfter,
            (SELECT COUNT(*) FROM trash_members tm WHERE tm.trash_op_id=t.op_id) AS memberCount
            FROM trash_ops t INDEXED BY trash_ops_space_created_keyset
            JOIN nodes n ON n.id=t.root_node_id AND n.space_id=t.space_id
              AND n.deleted_op_id=t.op_id AND n.deleted_at IS NOT NULL
            WHERE t.space_id=? AND t.actor_id=? AND t.state='trashed'
              AND (t.created_at<? OR (t.created_at=? AND t.op_id<?))
            ORDER BY t.created_at DESC,t.op_id DESC LIMIT ?`,
          values: [spaceId, principal.user_id, lastSort, lastSort, lastId ?? "", limit + 1],
        };
  const result = await atomicBatch(db, [
    authorizationAssertion(proof),
    assertExists("SELECT 1 FROM control WHERE singleton=1 AND epoch=? AND maintenance=0", [
      principal.epoch,
    ]),
    statement,
  ]);
  const rows = (result[2]?.results ?? []) as TrashRow[];
  if (
    rows.some(
      (row) =>
        !ID.test(row.opId) ||
        !ID.test(row.rootNodeId) ||
        !Number.isSafeInteger(row.memberCount) ||
        row.memberCount < 1 ||
        row.memberCount > 1_000,
    )
  )
    throw new Error("trash_unavailable");
  const page = rows.slice(0, limit);
  const last = page.at(-1);
  const nextCursor =
    rows.length > limit && last
      ? await tokens.issue({
          aud: "trash",
          scopeId: spaceId,
          userId: principal.user_id,
          credentialId: principal.credential_id,
          epoch: principal.epoch,
          generation: proof.node.tree_generation,
          lastSort: last.createdAt,
          lastId: last.opId,
        })
      : null;
  return Object.freeze({
    spaceId,
    treeGeneration: proof.node.tree_generation,
    items: page,
    nextCursor,
  });
}
