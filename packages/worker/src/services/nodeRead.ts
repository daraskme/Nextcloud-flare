import { authorizationAssertion, authorizeNode, type Principal } from "../auth/authorize";
import { NodeCursorTokens } from "../auth/nodeCursor";
import { assertExists, atomicBatch, primary, type SqlStatement } from "../db/primary";

const ID = /^[A-Za-z0-9_-]{1,128}$/;

interface ChildRow {
  id: string;
  name: string;
  nameCi: string;
  kind: "folder" | "file";
  revision: number;
  currentBlobId: string | null;
  updatedAt: number;
}

async function nodeProof(db: D1Database, principal: Principal, nodeId: string) {
  if (!ID.test(nodeId)) throw new Error("invalid_node_id");
  const spaceId = await primary(db)
    .prepare("SELECT space_id FROM nodes WHERE id=?")
    .bind(nodeId)
    .first<string>("space_id");
  if (!spaceId) throw new Error("node_unavailable");
  const proof = await authorizeNode(db, principal, {
    operation: "node.read",
    spaceId,
    nodeId,
  });
  if (proof.operation !== "node.read") throw new Error("node_unavailable");
  return proof;
}

/** Reassert current ancestry and credential immediately before returning metadata. */
export async function readNode(db: D1Database, principal: Principal, nodeId: string) {
  const proof = await nodeProof(db, principal, nodeId);
  await atomicBatch(db, [
    authorizationAssertion(proof),
    assertExists("SELECT 1 FROM control WHERE singleton=1 AND epoch=? AND maintenance=0", [
      principal.epoch,
    ]),
  ]);
  return Object.freeze({
    id: proof.node.id,
    spaceId: proof.node.space_id,
    ownerId: proof.node.owner_id,
    parentId: proof.node.parent_id,
    name: proof.node.name,
    kind: proof.node.kind,
    revision: proof.node.revision,
    currentBlobId: proof.node.current_blob_id,
    treeGeneration: proof.node.tree_generation,
  });
}

/** Parent proof and bounded keyset SELECT execute in one D1 transaction. */
export async function listNodeChildren(
  db: D1Database,
  principal: Principal,
  parentId: string,
  tokens: NodeCursorTokens,
  cursor?: string,
) {
  if (principal.kind !== "user") throw new Error("node_unavailable");
  const proof = await nodeProof(db, principal, parentId);
  const parent = proof.node;
  if (parent.kind === "file") throw new Error("node_not_folder");
  let lastNameCi: string | undefined;
  let lastId: string | undefined;
  if (cursor !== undefined) {
    const claims = await tokens.verify(cursor);
    if (
      claims.parentId !== parent.id ||
      claims.spaceId !== parent.space_id ||
      claims.ownerId !== parent.owner_id ||
      claims.userId !== principal.user_id ||
      claims.credentialId !== principal.credential_id ||
      claims.epoch !== principal.epoch ||
      claims.generation !== parent.tree_generation
    )
      throw new Error("invalid_node_cursor");
    lastNameCi = claims.lastNameCi;
    lastId = claims.lastId;
  }
  const statement: SqlStatement =
    lastNameCi === undefined
      ? {
          sql: `SELECT id,name,name_ci AS nameCi,kind,revision,
            current_blob_id AS currentBlobId,updated_at AS updatedAt
            FROM nodes INDEXED BY nodes_children_keyset
            WHERE parent_id=? AND deleted_at IS NULL AND space_id=? AND owner_id=?
            ORDER BY name_ci,id LIMIT 201`,
          values: [parent.id, parent.space_id, parent.owner_id],
        }
      : {
          sql: `SELECT id,name,name_ci AS nameCi,kind,revision,
            current_blob_id AS currentBlobId,updated_at AS updatedAt
            FROM nodes INDEXED BY nodes_children_keyset
            WHERE parent_id=? AND deleted_at IS NULL AND space_id=? AND owner_id=?
              AND (name_ci>? OR (name_ci=? AND id>?))
            ORDER BY name_ci,id LIMIT 201`,
          values: [
            parent.id,
            parent.space_id,
            parent.owner_id,
            lastNameCi,
            lastNameCi,
            lastId ?? "",
          ],
        };
  const result = await atomicBatch(db, [
    authorizationAssertion(proof),
    assertExists("SELECT 1 FROM control WHERE singleton=1 AND epoch=? AND maintenance=0", [
      principal.epoch,
    ]),
    statement,
  ]);
  const rows = (result[2]?.results ?? []) as ChildRow[];
  const page = rows.slice(0, 200);
  const last = page.at(-1);
  const nextCursor =
    rows.length > 200 && last
      ? await tokens.issue({
          parentId: parent.id,
          spaceId: parent.space_id,
          ownerId: parent.owner_id,
          userId: principal.user_id,
          credentialId: principal.credential_id,
          epoch: principal.epoch,
          generation: parent.tree_generation,
          lastNameCi: last.nameCi,
          lastId: last.id,
        })
      : null;
  return Object.freeze({
    parentId: parent.id,
    treeGeneration: parent.tree_generation,
    children: page.map(({ nameCi: _nameCi, ...node }) => node),
    nextCursor,
  });
}
