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
  size: number | null;
  mime: string | null;
}

interface PathRow {
  id: string;
  parentId: string | null;
  name: string;
  kind: "root" | "folder" | "file";
  revision: number;
  depth: number;
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

/** Return a root-first breadcrumb from the same snapshot as current authorization. */
export async function readNodePath(db: D1Database, principal: Principal, nodeId: string) {
  const proof = await nodeProof(db, principal, nodeId);
  const result = await atomicBatch(db, [
    authorizationAssertion(proof),
    assertExists("SELECT 1 FROM control WHERE singleton=1 AND epoch=? AND maintenance=0", [
      principal.epoch,
    ]),
    {
      sql: `WITH RECURSIVE p(id,parent_id,name,kind,revision,depth,seen) AS (
        SELECT id,parent_id,name,kind,revision,0,'/'||id||'/' FROM nodes
          WHERE id=? AND space_id=? AND owner_id=? AND deleted_at IS NULL
        UNION ALL
        SELECT n.id,n.parent_id,n.name,n.kind,n.revision,p.depth+1,p.seen||n.id||'/'
          FROM nodes n JOIN p ON n.id=p.parent_id
          WHERE p.depth<64 AND n.space_id=? AND n.owner_id=? AND n.deleted_at IS NULL
            AND instr(p.seen,'/'||n.id||'/')=0
      ) SELECT id,parent_id AS parentId,name,kind,revision,depth FROM p ORDER BY depth DESC`,
      values: [
        proof.node.id,
        proof.node.space_id,
        proof.node.owner_id,
        proof.node.space_id,
        proof.node.owner_id,
      ],
    },
  ]);
  const rows = (result[2]?.results ?? []) as PathRow[];
  const root = rows[0];
  const leaf = rows.at(-1);
  if (
    rows.length < 1 ||
    rows.length > 65 ||
    root?.kind !== "root" ||
    root.parentId !== null ||
    leaf?.id !== proof.node.id ||
    rows.some((row, index) => index > 0 && row.parentId !== rows[index - 1]?.id)
  )
    throw new Error("node_path_unavailable");
  return Object.freeze({
    nodeId: proof.node.id,
    treeGeneration: proof.node.tree_generation,
    path: rows.map(({ parentId: _parentId, depth: _depth, ...node }) => node),
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
          sql: `SELECT n.id,n.name,n.name_ci AS nameCi,n.kind,n.revision,
            n.current_blob_id AS currentBlobId,n.updated_at AS updatedAt,b.size,b.mime_sniffed AS mime
            FROM nodes n INDEXED BY nodes_children_keyset
            LEFT JOIN blobs b ON b.id=n.current_blob_id AND b.owner_id=n.owner_id
              AND b.state IN ('committed','gc_candidate')
            WHERE n.parent_id=? AND n.deleted_at IS NULL AND n.space_id=? AND n.owner_id=?
            ORDER BY n.name_ci,n.id LIMIT 201`,
          values: [parent.id, parent.space_id, parent.owner_id],
        }
      : {
          sql: `SELECT n.id,n.name,n.name_ci AS nameCi,n.kind,n.revision,
            n.current_blob_id AS currentBlobId,n.updated_at AS updatedAt,b.size,b.mime_sniffed AS mime
            FROM nodes n INDEXED BY nodes_children_keyset
            LEFT JOIN blobs b ON b.id=n.current_blob_id AND b.owner_id=n.owner_id
              AND b.state IN ('committed','gc_candidate')
            WHERE n.parent_id=? AND n.deleted_at IS NULL AND n.space_id=? AND n.owner_id=?
              AND (n.name_ci>? OR (n.name_ci=? AND n.id>?))
            ORDER BY n.name_ci,n.id LIMIT 201`,
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
