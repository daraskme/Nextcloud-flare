import { authorizationAssertion, authorizeNode, type Principal } from "../auth/authorize";
import { NodeCursorTokens } from "../auth/nodeCursor";
import { assertExists, atomicBatch, primary, type SqlStatement } from "../db/primary";
import { ENCRYPTION_COLUMNS, type EncryptionProjection, encryptionDto } from "./encryptionMarker";

const ID = /^[A-Za-z0-9_-]{1,128}$/;

interface ChildRow extends EncryptionProjection {
  id: string;
  parentId: string;
  ownerId: string;
  name: string;
  nameCi: string;
  kind: "folder" | "file";
  revision: number;
  currentBlobId: string | null;
  updatedAt: number;
  size: number | null;
  mime: string | null;
  starred: number;
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
  const result = await atomicBatch(db, [
    authorizationAssertion(proof),
    assertExists("SELECT 1 FROM control WHERE singleton=1 AND epoch=? AND maintenance=0", [
      principal.epoch,
    ]),
    {
      sql: `SELECT ${ENCRYPTION_COLUMNS} FROM nodes n
        JOIN blobs b ON b.id=n.current_blob_id AND b.owner_id=n.owner_id
          AND b.state IN ('committed','gc_candidate')
        LEFT JOIN blob_encryption be ON be.blob_id=b.id AND be.owner_id=n.owner_id
        WHERE n.id=? AND n.space_id=? AND n.owner_id=? AND n.deleted_at IS NULL`,
      values: [proof.node.id, proof.node.space_id, proof.node.owner_id],
    },
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
    encryption: encryptionDto((result[2]?.results?.[0] ?? null) as EncryptionProjection | null),
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
  // Share-bound principals see their share root as the mount root: ancestors
  // above it are outside their authority and stay hidden.
  const boundary = await pathShareBoundary(db, principal, proof.node.owner_id, rows);
  const view = boundary >= 0 ? rows.slice(boundary) : boundary === -2 ? rows.slice(-1) : rows;
  return Object.freeze({
    nodeId: proof.node.id,
    treeGeneration: proof.node.tree_generation,
    path: view.map(({ parentId: _parentId, depth: _depth, ...node }) => node),
  });
}

/**
 * Deepest share root covering this principal's read authority, as an index into
 * the root-first ancestor rows: -1 when the principal is unscoped, -2 when no
 * covering share root exists (leaf-only view), >=0 the slice boundary.
 */
async function pathShareBoundary(
  db: D1Database,
  principal: Principal,
  ownerId: string,
  rows: PathRow[],
): Promise<number> {
  const scoped =
    principal.kind === "link_share" ||
    ((principal.kind === "user" || principal.kind === "app_password") &&
      principal.user_id !== ownerId);
  if (!scoped || rows.length === 0) return -1;
  const ancestorIds = rows.map((row) => row.id);
  const inList = ancestorIds.map(() => "?").join(",");
  let roots: { root_id: string }[];
  if (principal.kind === "link_share") {
    const { results } = await primary(db)
      .prepare(
        `SELECT sh.root_node_id AS root_id FROM shares sh
          JOIN users owner ON owner.id=sh.owner_id AND owner.disabled_at IS NULL
          WHERE sh.id=? AND sh.version=? AND sh.kind='link' AND sh.disabled_at IS NULL
            AND (sh.expires_at IS NULL OR sh.expires_at>strftime('%s','now')*1000)
            AND sh.root_node_id IN (${inList})
            AND EXISTS(SELECT 1 FROM share_actions sa WHERE sa.share_id=sh.id AND sa.action='read')`,
      )
      .bind(principal.share_id, principal.share_version, ...ancestorIds)
      .all<{ root_id: string }>();
    roots = results ?? [];
  } else if (principal.kind === "user" || principal.kind === "app_password") {
    const bound = principal.internal_share?.share_id ?? null;
    const { results } = await primary(db)
      .prepare(
        `SELECT DISTINCT sh.root_node_id AS root_id FROM shares sh
          JOIN users owner ON owner.id=sh.owner_id AND owner.disabled_at IS NULL
          WHERE sh.kind='internal' AND sh.disabled_at IS NULL
            AND (sh.expires_at IS NULL OR sh.expires_at>strftime('%s','now')*1000)
            AND sh.owner_id=? AND sh.root_node_id IN (${inList})
            AND EXISTS(SELECT 1 FROM share_actions sa WHERE sa.share_id=sh.id AND sa.action='read')
            AND EXISTS(SELECT 1 FROM current_internal_shares c
              WHERE c.share_id=sh.id AND c.version=sh.version)
            AND (
              EXISTS(SELECT 1 FROM share_grants g WHERE g.share_id=sh.id AND g.user_id=?
                AND g.disabled_at IS NULL AND g.version=sh.version)
              OR (? IS NULL AND EXISTS(
                SELECT 1 FROM share_group_grants gg
                JOIN share_groups sg ON sg.id=gg.group_id AND sg.owner_id=sh.owner_id
                  AND sg.disabled_at IS NULL
                JOIN share_group_members gm ON gm.group_id=sg.id AND gm.user_id=?
                  AND gm.disabled_at IS NULL
                JOIN users member ON member.id=gm.user_id AND member.disabled_at IS NULL
                WHERE gg.share_id=sh.id))
              OR (? IS NOT NULL AND sh.id=?)
            )`,
      )
      .bind(ownerId, ...ancestorIds, principal.user_id, bound, principal.user_id, bound, bound)
      .all<{ root_id: string }>();
    roots = results ?? [];
  } else {
    return -1;
  }
  const covering = new Set(roots.map((row) => row.root_id));
  let index = -1;
  rows.forEach((row, position) => {
    if (covering.has(row.id)) index = position;
  });
  return index >= 0 ? index : -2;
}

/** Parent proof and bounded keyset SELECT execute in one D1 transaction. */
export async function listNodeChildren(
  db: D1Database,
  principal: Principal,
  parentId: string,
  tokens: NodeCursorTokens,
  cursor?: string,
) {
  const cursorSubject =
    principal.kind === "user" || principal.kind === "admin_read"
      ? principal.user_id
      : principal.kind === "link_share"
        ? principal.share_id
        : undefined;
  if (!cursorSubject) throw new Error("node_unavailable");
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
      claims.userId !== cursorSubject ||
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
          sql: `SELECT n.id,n.parent_id AS parentId,n.owner_id AS ownerId,n.name,
            n.name_ci AS nameCi,n.kind,n.revision,n.current_blob_id AS currentBlobId,
            n.updated_at AS updatedAt,b.size,b.mime_sniffed AS mime,COALESCE(s.starred,0) AS starred,
            ${ENCRYPTION_COLUMNS}
            FROM nodes n INDEXED BY nodes_children_keyset
            LEFT JOIN blobs b ON b.id=n.current_blob_id AND b.owner_id=n.owner_id
              AND b.state IN ('committed','gc_candidate')
            LEFT JOIN blob_encryption be ON be.blob_id=b.id AND be.owner_id=n.owner_id
            LEFT JOIN user_node_state s ON s.node_id=n.id AND s.user_id=?
            WHERE n.parent_id=? AND n.deleted_at IS NULL AND n.space_id=? AND n.owner_id=?
            ORDER BY n.name_ci,n.id LIMIT 201`,
          values: [
            principal.kind === "user" ? principal.user_id : "",
            parent.id,
            parent.space_id,
            parent.owner_id,
          ],
        }
      : {
          sql: `SELECT n.id,n.parent_id AS parentId,n.owner_id AS ownerId,n.name,
            n.name_ci AS nameCi,n.kind,n.revision,n.current_blob_id AS currentBlobId,
            n.updated_at AS updatedAt,b.size,b.mime_sniffed AS mime,COALESCE(s.starred,0) AS starred,
            ${ENCRYPTION_COLUMNS}
            FROM nodes n INDEXED BY nodes_children_keyset
            LEFT JOIN blobs b ON b.id=n.current_blob_id AND b.owner_id=n.owner_id
              AND b.state IN ('committed','gc_candidate')
            LEFT JOIN blob_encryption be ON be.blob_id=b.id AND be.owner_id=n.owner_id
            LEFT JOIN user_node_state s ON s.node_id=n.id AND s.user_id=?
            WHERE n.parent_id=? AND n.deleted_at IS NULL AND n.space_id=? AND n.owner_id=?
              AND (n.name_ci>? OR (n.name_ci=? AND n.id>?))
            ORDER BY n.name_ci,n.id LIMIT 201`,
          values: [
            principal.kind === "user" ? principal.user_id : "",
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
          userId: cursorSubject,
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
    children: page.map(({ nameCi: _nameCi, starred, ...node }) => {
      const encryption = encryptionDto(node);
      const {
        encBlobId: _encBlobId,
        encOwnerId: _encOwnerId,
        encHeaderSha256: _encHeaderSha256,
        encSignerRsaFingerprint: _encSignerRsaFingerprint,
        encSignerSigningFingerprint: _encSignerSigningFingerprint,
        encRequiredAdminFingerprint: _encRequiredAdminFingerprint,
        encCryptoId: _encCryptoId,
        encFormatVersion: _encFormatVersion,
        encOwnerSignature: _encOwnerSignature,
        encAttestedNodeId: _encAttestedNodeId,
        encAttestedRevision: _encAttestedRevision,
        encAdminReceiptState: _encAdminReceiptState,
        encAdminReceiptSignature: _encAdminReceiptSignature,
        encAdminAccountId: _encAdminAccountId,
        encAdminVerifiedAt: _encAdminVerifiedAt,
        ...visible
      } = node;
      return { ...visible, starred: starred === 1, encryption };
    }),
    nextCursor,
  });
}
