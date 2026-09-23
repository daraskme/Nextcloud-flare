import { authorizationAssertion, authorizeNode, type Principal } from "../auth/authorize";
import type { SearchCursorTokens } from "../auth/searchCursor";
import { assertExists, atomicBatch, primary } from "../db/primary";
import { searchQuery } from "../search/query";

interface SearchRow {
  id: string;
  parentId: string;
  name: string;
  nameCi: string;
  kind: "folder" | "file";
  revision: number;
  currentBlobId: string | null;
  updatedAt: number;
  size: number | null;
  mime: string | null;
}

/** Scope drives rowid-constrained FTS lookups, never an unbounded global hit scan. */
export function searchStatement(indexed: boolean): string {
  return `WITH RECURSIVE ancestors(id,parent_id,depth) AS (
    SELECT id,parent_id,0 FROM nodes WHERE id=?1
    UNION ALL
    SELECT n.id,n.parent_id,a.depth+1 FROM ancestors a JOIN nodes n ON n.id=a.parent_id
      WHERE a.depth<64 AND n.space_id=?2 AND n.owner_id=?3 AND n.deleted_at IS NULL
      LIMIT 65
  ), walk(id,parent_id,name_ci,kind,depth,entering,visited) AS MATERIALIZED (
    SELECT id,parent_id,name_ci,kind,(SELECT MAX(depth) FROM ancestors),1,1 FROM nodes
      WHERE id=?1 AND space_id=?2 AND owner_id=?3 AND deleted_at IS NULL
    UNION ALL
    SELECT n.id,n.parent_id,n.name_ci,n.kind,
      w.depth+CASE WHEN n.parent_id=w.id THEN 1 WHEN n.id=w.parent_id THEN -1 ELSE 0 END,
      n.id IS NOT w.parent_id,w.visited+(n.id IS NOT w.parent_id)
    FROM walk w JOIN nodes n ON n.id=COALESCE(
      CASE WHEN w.entering=1 AND w.kind IN ('root','folder') AND w.depth<64 THEN
        (SELECT c.id FROM nodes c INDEXED BY nodes_children_keyset WHERE c.parent_id=w.id
          AND c.deleted_at IS NULL AND c.space_id=?2 AND c.owner_id=?3
          ORDER BY c.name_ci,c.id LIMIT 1) END,
      CASE WHEN w.id<>?1 THEN
        (SELECT c.id FROM nodes c INDEXED BY nodes_children_keyset WHERE c.parent_id=w.parent_id
          AND c.deleted_at IS NULL AND c.space_id=?2 AND c.owner_id=?3
          AND (c.name_ci,c.id)>(w.name_ci,w.id) ORDER BY c.name_ci,c.id LIMIT 1) END,
      CASE WHEN w.id<>?1 THEN w.parent_id END)
      WHERE w.visited<10000 AND n.space_id=?2 AND n.owner_id=?3 AND n.deleted_at IS NULL
      LIMIT 20000
  ), scope AS MATERIALIZED (
    SELECT id FROM walk WHERE entering=1 LIMIT 10000
  ), eligible AS MATERIALIZED (
    SELECT n.id,n.parent_id,n.name,n.name_ci,n.kind,n.revision,n.current_blob_id,n.updated_at,
      si.rowid AS index_id,si.text_norm,si.normalization_version,si.revision AS index_revision
    FROM scope s CROSS JOIN nodes n ON n.id=s.id
      LEFT JOIN search_index si ON si.node_id=n.id AND si.space_id=?2
    WHERE s.id<>?1 AND n.kind IN ('folder','file')
  ), hits AS MATERIALIZED (
    SELECT e.* FROM eligible e WHERE e.index_id IS NOT NULL
      AND e.normalization_version=?4 AND e.index_revision<=e.revision
      ${indexed ? "AND EXISTS(SELECT 1 FROM search_fts WHERE rowid=e.index_id AND search_fts MATCH ?5)" : ""}
      LIMIT 10000
  ), page AS (
    SELECT h.*,b.size,b.mime_sniffed FROM hits h
      LEFT JOIN blobs b ON b.id=h.current_blob_id AND b.owner_id=?3 AND b.state IN ('committed','gc_candidate')
    WHERE h.text_norm LIKE ?6 ESCAPE '\\'
      AND (?7 IS NULL OR h.name_ci>?7 OR (h.name_ci=?7 AND h.id>?8))
    ORDER BY h.name_ci,h.id LIMIT 201
  ) SELECT (SELECT COUNT(*) FROM scope) AS scopeCount,
    (SELECT COUNT(*) FROM hits) AS hitCount,
    (SELECT COUNT(*) FROM eligible WHERE index_id IS NULL OR normalization_version<>?4 OR index_revision>revision) AS staleCount,
    (SELECT json_group_array(json_object('id',id,'parentId',parent_id,'name',name,'nameCi',name_ci,
      'kind',kind,'revision',revision,'currentBlobId',current_blob_id,'updatedAt',updated_at,
      'size',size,'mime',mime_sniffed)) FROM page) AS items`;
}

export async function searchNodes(
  db: D1Database,
  principal: Principal,
  scopeId: string,
  input: string,
  tokens: SearchCursorTokens,
  cursor?: string,
) {
  if (principal.kind !== "user" || !/^[A-Za-z0-9_-]{1,128}$/.test(scopeId))
    throw new Error("search_unavailable");
  const query = searchQuery(input);
  const spaceId = await primary(db)
    .prepare("SELECT space_id FROM nodes WHERE id=?")
    .bind(scopeId)
    .first<string>("space_id");
  if (!spaceId) throw new Error("search_unavailable");
  const proof = await authorizeNode(db, principal, {
    operation: "search.read",
    nodeId: scopeId,
    spaceId,
  });
  if (proof.operation !== "search.read") throw new Error("search_unavailable");
  const scope = proof.node;
  let lastName: string | null = null;
  let lastId: string | null = null;
  if (cursor !== undefined) {
    const claims = await tokens.verify(cursor);
    if (
      claims.scopeId !== scopeId ||
      claims.spaceId !== spaceId ||
      claims.ownerId !== scope.owner_id ||
      claims.userId !== principal.user_id ||
      claims.credentialId !== principal.credential_id ||
      claims.epoch !== principal.epoch ||
      claims.generation !== scope.tree_generation ||
      claims.query !== query.text ||
      claims.version !== query.version
    )
      throw new Error("invalid_search_cursor");
    lastName = claims.lastNameCi;
    lastId = claims.lastId;
  }
  const result = await atomicBatch(db, [
    authorizationAssertion(proof),
    assertExists("SELECT 1 FROM control WHERE singleton=1 AND epoch=? AND maintenance=0", [
      principal.epoch,
    ]),
    {
      sql: searchStatement(!!query.match),
      values: [
        scopeId,
        spaceId,
        scope.owner_id,
        query.version,
        query.match,
        query.pattern,
        lastName,
        lastId,
      ],
    },
  ]);
  const record = result[2]?.results[0] as
    | { scopeCount: number; hitCount: number; staleCount: number; items: string }
    | undefined;
  if (!record) throw new Error("search_unavailable");
  const rows = JSON.parse(record.items) as SearchRow[];
  const page = rows.slice(0, 200);
  const last = page.at(-1);
  const nextCursor =
    rows.length > 200 && last
      ? await tokens.issue({
          scopeId,
          spaceId,
          ownerId: scope.owner_id,
          userId: principal.user_id,
          credentialId: principal.credential_id,
          epoch: principal.epoch,
          generation: scope.tree_generation,
          query: query.text,
          version: query.version,
          lastNameCi: last.nameCi,
          lastId: last.id,
        })
      : null;
  return Object.freeze({
    scopeId,
    query: query.text,
    treeGeneration: scope.tree_generation,
    items: page.map(({ nameCi: _nameCi, ...node }) => node),
    nextCursor,
    truncated: record.scopeCount >= 10000 || record.hitCount >= 10000 || record.staleCount > 0,
  });
}
